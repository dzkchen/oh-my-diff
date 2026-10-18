#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile


LABEL = "dev.ohmydiff.broker"
DAEMON = Path("/Library/LaunchDaemons/dev.ohmydiff.broker.plist")
SOCKET = "/var/run/dev.ohmydiff.broker.sock"
ROOT = Path("/Library/Application Support/OhMyDiff/broker")
POLICY = ROOT.parent / "policy.json" if sys.platform == "darwin" else Path("/etc/oh-my-diff/policy.json")
HELPER = Path("/Library/PrivilegedHelperTools/dev.ohmydiff.broker")
TOOLS = ROOT.parent / "tools"
COPY = TOOLS / "authority_broker.py"
RELEASE_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGhcSdBwdX2rgdAjg2JwbF7A1KCswnSZpwbdFsaLKo6G"
SIGNING_NAMESPACE = "oh-my-diff-release"
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


def version_key(value):
    found = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?", value)
    if not found:
        raise ValueError(f"malformed release version {value!r}")
    pre = tuple((0, int(part), "") if part.isdigit() else (1, 0, part) for part in found[4].split(".")) if found[4] else ()
    return int(found[1]), int(found[2]), int(found[3]), not found[4], pre


def signed_releases(manifests):
    releases = []
    for manifest in map(Path, manifests):
        signature = Path(f"{manifest}.sig")
        if not manifest.is_file() or not signature.is_file():
            raise ValueError(f"{manifest.parent} has no signed omd-release.json; the authority broker accepts only "
                             "installs from a signed release")
        body = manifest.read_bytes()
        with tempfile.TemporaryDirectory(prefix="omd-signature-") as temporary:
            signers = Path(temporary) / "signers"
            signers.write_text(f'release namespaces="{SIGNING_NAMESPACE}" {RELEASE_KEY}\n')
            verified = RELEASE_KEY and run("/usr/bin/ssh-keygen", "-Y", "verify", "-f", signers, "-I", "release",
                                           "-n", SIGNING_NAMESPACE, "-s", signature, stdin=body,
                                           check=False).returncode == 0
        if not verified:
            raise ValueError(f"{manifest} is not signed by the Oh My Diff release key")
        release = json.loads(body)
        version_key(release["version"])
        releases.append(release)
    return releases


def signed_hashes(releases):
    hashes = {}
    for release in releases:
        for name, value in release["artifacts"].items():
            hashes.setdefault(name, set()).add(value)
    return hashes


def older(candidate, current):
    first, second = version_key(candidate), version_key(current)
    if first[:3] != second[:3]:
        return first[:3] < second[:3]
    return ("-nightly." in candidate) == ("-nightly." in current) and first < second


def newest(releases):
    return max(releases, key=lambda release: version_key(release["version"]))


def signed_bytes(path, hashes, role=None):
    data = Path(path).read_bytes()
    accepted = hashes.get(role, set()) if role else set().union(*hashes.values())
    if hashlib.sha256(data).hexdigest() not in accepted:
        raise ValueError(f"{path} is not listed{f' as {role}' if role else ''} in a signed Oh My Diff release manifest")
    return data


def signed_cdhashes(paths, hashes):
    with tempfile.TemporaryDirectory(prefix="omd-pins-") as temporary:
        copies = []
        for index, path in enumerate(paths):
            copy = Path(temporary) / str(index)
            copy.write_bytes(signed_bytes(path, hashes))
            copies.append(copy)
        return [cdhash(copy) for copy in copies]


def trusted(path):
    return all(item.exists() and item.stat().st_uid == 0 and not item.stat().st_mode & 0o022
               for item in (path, path.parent, path.parent.parent))


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


def write_pins(binaries, manifests, tooling, add=False):
    releases = signed_releases(manifests)
    latest, current = newest(releases), json.loads((ROOT / "pins.json").read_text())
    if older(latest["version"], current["version"]):
        raise ValueError(f"the authority broker pins {current['version']}; refusing the older {latest['version']}. "
                         "Reinstall the broker to pin an older release on purpose")
    pins = set(signed_cdhashes(binaries, signed_hashes(releases)))
    if add:
        pins.update(current["cdhashes"])
    tooling_data = Path(tooling).read_bytes()
    if hashlib.sha256(tooling_data).hexdigest() == latest["artifacts"].get("authority_broker.py"):
        write_root(COPY, tooling_data, 0o644)
    pins = sorted(pins)
    write_root(ROOT / "pins.json", json.dumps({"cdhashes": pins, "version": latest["version"]}).encode(), 0o644)
    return pins


def install(helper, tooling, binaries, manifests):
    releases = signed_releases(manifests)
    hashes = signed_hashes(releases)
    helper_data, tooling_data = signed_bytes(helper, hashes, "omd-broker"), signed_bytes(tooling, hashes, "authority_broker.py")
    signed_cdhashes([helper], hashes)
    pins = sorted(set(signed_cdhashes(binaries, hashes)))
    create_account()
    ROOT.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    TOOLS.mkdir(mode=0o755, exist_ok=True)
    os.chown(TOOLS, 0, 0)
    os.chmod(TOOLS, 0o755)
    write_root(COPY, tooling_data, 0o644)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    shutil.chown(ROOT, ACCOUNT, ACCOUNT)
    os.chmod(ROOT, 0o700)
    HELPER.parent.mkdir(mode=0o755, exist_ok=True)
    write_root(HELPER, helper_data, 0o755)
    write_root(ROOT / "pins.json", json.dumps({"cdhashes": pins, "version": newest(releases)["version"]}).encode(), 0o644)
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
    shutil.rmtree(TOOLS, ignore_errors=True)
    for name in RIGHTS:
        run("/usr/bin/security", "authorizationdb", "remove", name, check=False)
    shutil.rmtree(ROOT, ignore_errors=True)
    if ROOT.parent.is_dir() and not any(ROOT.parent.iterdir()):
        ROOT.parent.rmdir()
    for record in (f"/Users/{ACCOUNT}", f"/Groups/{ACCOUNT}"):
        run("/usr/bin/dscl", ".", "-delete", record, check=False)
    return {"deployed": False}


def policy(action, source=None):
    previous = POLICY.with_name("policy.json.previous")
    current = POLICY.read_bytes() if POLICY.is_file() else None
    if action == "policy-install":
        data = Path(source).read_bytes()
        json.loads(data)
        POLICY.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        os.chown(POLICY.parent, 0, 0)
        os.chmod(POLICY.parent, 0o755)
    elif action == "policy-rollback":
        if not previous.is_file():
            raise ValueError("no previous administrator policy file")
        data = previous.read_bytes()
    else:
        data = None
    if current is not None:
        write_root(previous, current, 0o644)
    elif action == "policy-rollback":
        previous.unlink()
    if data is None:
        POLICY.unlink(missing_ok=True)
    else:
        write_root(POLICY, data, 0o644)
    return {"policy": str(POLICY), "installed": data is not None}


def status():
    loaded = run("/bin/launchctl", "print", f"system/{LABEL}", check=False).returncode == 0
    return {"deployed": deployed(), "loaded": loaded, "socket": SOCKET,
            "authority": "protected (OS-separated broker)" if deployed() else "unprotected (same-user)"}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="authority_broker", description="Deploy the OS-separated OMD authority broker")
    commands = parser.add_subparsers(dest="command", required=True)
    install_parser = commands.add_parser("install", help="create the broker account, daemon and rights (sudo)")
    install_parser.add_argument("--helper", type=Path, required=True)
    pin_parser = commands.add_parser("pin", help="replace the pinned host binaries; refreshes the root-owned tooling (sudo)")
    for command in (install_parser, pin_parser):
        command.add_argument("--tooling", type=Path, default=Path(__file__).resolve(),
                             help="authority_broker.py for the root-owned copy; must be in the newest signed manifest")
        command.add_argument("--pin", type=Path, action="append", required=True)
        command.add_argument("--manifest", type=Path, action="append", required=True,
                             help="signed omd-release.json listing the helper and pinned binaries")
    pin_parser.add_argument("--add", action="store_true", help="keep the existing pins")
    commands.add_parser("status", help="show whether the broker is deployed")
    commands.add_parser("reset", help="remove grants and evidence anchors, keep credentials (sudo)")
    commands.add_parser("uninstall", help="remove the broker, its account and all broker state (sudo)")
    commands.add_parser("policy-install", help="install the root-owned administrator policy file (sudo)").add_argument(
        "source", type=Path)
    commands.add_parser("policy-rollback", help="swap the administrator policy file with the one it replaced (sudo)")
    commands.add_parser("policy-remove", help="remove the administrator policy file, keeping it as previous (sudo)")
    args = parser.parse_args(argv)
    if args.command == "status":
        return status()
    if os.geteuid() != 0:
        arguments = [*(sys.argv[1:] if argv is None else argv)]
        if args.command in ("install", "pin"):
            arguments.append(f"--tooling={args.tooling}")
        script = COPY if trusted(COPY) else Path(__file__).resolve()
        elevated = subprocess.run(["/usr/bin/sudo", "/usr/bin/python3", "-I", str(script), *map(str, arguments)],
                                  stdout=subprocess.PIPE)
        if elevated.returncode:
            raise ValueError(f"privileged broker step failed (exit {elevated.returncode}); it runs /usr/bin/python3, "
                             "which needs the Xcode Command Line Tools (xcode-select --install)")
        return json.loads(elevated.stdout)
    if args.command == "install":
        return install(args.helper.resolve(), args.tooling.resolve(), [path.resolve() for path in args.pin], args.manifest)
    if args.command == "pin":
        return {"pins": write_pins([path.resolve() for path in args.pin], args.manifest, args.tooling.resolve(), args.add)}
    if args.command.startswith("policy-"):
        return policy(args.command, getattr(args, "source", None))
    return reset() if args.command == "reset" else uninstall()


if __name__ == "__main__":
    try:
        print(json.dumps(main(), indent=2, sort_keys=True))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
