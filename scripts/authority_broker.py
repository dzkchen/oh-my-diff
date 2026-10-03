#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys


LABEL = "dev.ohmydiff.broker"
DAEMON = Path("/Library/LaunchDaemons/dev.ohmydiff.broker.plist")
SOCKET = "/var/run/dev.ohmydiff.broker.sock"
ROOT = Path("/Library/Application Support/OhMyDiff/broker")
HELPER = Path("/Library/PrivilegedHelperTools/dev.ohmydiff.broker")
ACCOUNT = "_omdbroker"
RIGHTS = {
    "dev.ohmydiff.broker.grant": {
        "class": "user", "authenticate-user": True, "session-owner": True, "shared": False,
        "timeout": 0, "allow-root": False, "version": 1,
        "comment": "Change Oh My Diff mod grants or credentials held by the authority broker.",
        "default-prompt": {"": "Oh My Diff wants to change protected mod grants or credentials."},
    },
    "dev.ohmydiff.broker.policy": {
        "class": "user", "group": "admin", "authenticate-user": True, "shared": False,
        "timeout": 0, "allow-root": False, "version": 1,
        "comment": "Change Oh My Diff managed policy held by the authority broker.",
        "default-prompt": {"": "Oh My Diff wants to change managed policy."},
    },
}


def run(*arguments, stdin=None, check=True):
    return subprocess.run([str(item) for item in arguments], input=stdin, capture_output=True, check=check)


def cdhash(path):
    details = run("/usr/bin/codesign", "-d", "--verbose=4", path).stderr.decode()
    if not re.search(r"^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime", details, re.M):
        raise ValueError(f"{path} is not signed with the hardened runtime")
    match = re.search(r"^CDHash=([0-9a-f]{40})$", details, re.M)
    if not match:
        raise ValueError(f"{path} has no code directory hash")
    return match.group(1)


def deployed():
    return DAEMON.is_file() and DAEMON.stat().st_uid == 0


def free_identifier():
    used = set()
    for record, key in (("/Users", "UniqueID"), ("/Groups", "PrimaryGroupID")):
        for line in run("/usr/bin/dscl", ".", "-list", record, key).stdout.decode().splitlines():
            used.update(int(field) for field in line.split()[1:] if field.lstrip("-").isdigit())
    return next(number for number in range(300, 400) if number not in used)


def create_account():
    if run("/usr/bin/dscl", ".", "-read", f"/Users/{ACCOUNT}", check=False).returncode == 0:
        return
    number = str(free_identifier())
    group = f"/Groups/{ACCOUNT}"
    for key, value in (("PrimaryGroupID", number), ("RealName", "Oh My Diff authority broker"),
                       ("Password", "*")):
        run("/usr/bin/dscl", ".", "-create", group, key, value)
    user = f"/Users/{ACCOUNT}"
    for key, value in (("UniqueID", number), ("PrimaryGroupID", number), ("UserShell", "/usr/bin/false"),
                       ("NFSHomeDirectory", "/var/empty"), ("RealName", "Oh My Diff authority broker"),
                       ("Password", "*"), ("IsHidden", "1")):
        run("/usr/bin/dscl", ".", "-create", user, key, value)


def write_root(path, data, mode):
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    temporary.write_bytes(data)
    os.chown(temporary, 0, 0)
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def write_pins(binaries, add=False):
    pins = {cdhash(path) for path in binaries}
    if add:
        pins.update(json.loads((ROOT / "pins.json").read_text())["cdhashes"])
    pins = sorted(pins)
    write_root(ROOT / "pins.json", json.dumps({"cdhashes": pins}).encode(), 0o644)
    return pins


def install(helper, binaries):
    cdhash(helper)
    create_account()
    ROOT.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    shutil.chown(ROOT, ACCOUNT, ACCOUNT)
    os.chmod(ROOT, 0o700)
    HELPER.parent.mkdir(mode=0o755, exist_ok=True)
    write_root(HELPER, Path(helper).read_bytes(), 0o755)
    pins = write_pins(binaries)
    for name, rule in RIGHTS.items():
        run("/usr/bin/security", "authorizationdb", "write", name, stdin=plistlib.dumps(rule))
    daemon = {"Label": LABEL, "ProgramArguments": [str(HELPER)], "UserName": ACCOUNT, "GroupName": ACCOUNT,
              "Sockets": {"Listener": {"SockPathName": SOCKET, "SockPathMode": 0o666}}}
    write_root(DAEMON, plistlib.dumps(daemon), 0o644)
    run("/bin/launchctl", "bootout", f"system/{LABEL}", check=False)
    run("/bin/launchctl", "bootstrap", "system", DAEMON)
    return {"deployed": True, "pins": pins}


def reset():
    for grants in (ROOT / "stores").glob("*/grants.json"):
        grants.unlink()
    shutil.rmtree(ROOT / "anchors", ignore_errors=True)
    return {"reset": "grants and evidence anchors removed; credentials kept"}


def uninstall():
    run("/bin/launchctl", "bootout", f"system/{LABEL}", check=False)
    for path in (DAEMON, HELPER, Path(SOCKET)):
        path.unlink(missing_ok=True)
    for name in RIGHTS:
        run("/usr/bin/security", "authorizationdb", "remove", name, check=False)
    shutil.rmtree(ROOT, ignore_errors=True)
    if ROOT.parent.is_dir() and not any(ROOT.parent.iterdir()):
        ROOT.parent.rmdir()
    for record in (f"/Users/{ACCOUNT}", f"/Groups/{ACCOUNT}"):
        run("/usr/bin/dscl", ".", "-delete", record, check=False)
    return {"deployed": False}


def status():
    loaded = run("/bin/launchctl", "print", f"system/{LABEL}", check=False).returncode == 0
    return {"deployed": deployed(), "loaded": loaded, "socket": SOCKET,
            "authority": "protected (OS-separated broker)" if deployed() else "unprotected (same-user)"}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="authority_broker", description="Deploy the OS-separated OMD authority broker")
    commands = parser.add_subparsers(dest="command", required=True)
    install_parser = commands.add_parser("install", help="create the broker account, daemon and rights (sudo)")
    install_parser.add_argument("--helper", type=Path, required=True)
    pin_parser = commands.add_parser("pin", help="replace the pinned host binaries (sudo)")
    for command in (install_parser, pin_parser):
        command.add_argument("--pin", type=Path, action="append", required=True)
    pin_parser.add_argument("--add", action="store_true", help="keep the existing pins")
    commands.add_parser("status", help="show whether the broker is deployed")
    commands.add_parser("reset", help="remove grants and evidence anchors, keep credentials (sudo)")
    commands.add_parser("uninstall", help="remove the broker, its account and all broker state (sudo)")
    args = parser.parse_args(argv)
    if args.command == "status":
        return status()
    if os.geteuid() != 0:
        arguments = sys.argv[1:] if argv is None else argv
        elevated = subprocess.run(["/usr/bin/sudo", sys.executable, str(Path(__file__).resolve()),
                                   *map(str, arguments)], check=True, stdout=subprocess.PIPE)
        return json.loads(elevated.stdout)
    if args.command == "install":
        return install(args.helper.resolve(), [path.resolve() for path in args.pin])
    if args.command == "pin":
        return {"pins": write_pins([path.resolve() for path in args.pin], args.add)}
    return reset() if args.command == "reset" else uninstall()


if __name__ == "__main__":
    try:
        print(json.dumps(main(), indent=2, sort_keys=True))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
