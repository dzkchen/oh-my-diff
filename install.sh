#!/bin/sh
OMD_PYTHON=
for candidate in python3.14 python3.13 python3.12 python3 /opt/homebrew/bin/python3 "$(command -v mise >/dev/null 2>&1 && mise which python3 2>/dev/null)"; do
  if [ -n "$candidate" ] && command -v "$candidate" >/dev/null 2>&1 \
    && "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 12))' 2>/dev/null; then
    OMD_PYTHON=$candidate
    break
  fi
done
if [ -z "$OMD_PYTHON" ]; then
  echo "omd installer: Python 3.12 or newer is required (macOS ships 3.9); install one, for example with 'brew install python@3.12' or mise, and retry" >&2
  exit 1
fi
exec "$OMD_PYTHON" - "$@" <<'PY'
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import uuid


RELEASE_URL = ""
RELEASE_SHA256 = "dd4af10730de910ba2b2f71e834e616f369a14eb1f82c2e52477bdf6df24f939"
LINKS = ("codex", "omd-package", "omd-mod-author", "omd", "omd-contract", "omd-mod")
UPSTREAM_MINOR = "0.159"
PROFILE_LABELS = {"platform": "OMD Core", "full": "OMD+"}
MAX_UNPACKED_BYTES = 1_200_000_000
MAX_MEMBER_BYTES = 1_000_000_000
BROKER_DAEMON = Path("/Library/LaunchDaemons/dev.ohmydiff.broker.plist")


def fail(message):
    raise ValueError(message)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def run(arguments, *, cwd=None, env=None):
    result = subprocess.run([str(item) for item in arguments], cwd=cwd, env=env,
                            capture_output=True, text=True)
    if result.returncode:
        fail((result.stderr or result.stdout or "command failed").strip())
    return result.stdout


def broker_deployed():
    return BROKER_DAEMON.is_file() and BROKER_DAEMON.stat().st_uid == 0


def repin(active, other, upstream, bin_dir):
    if not broker_deployed():
        return None
    command = [active / "bin/omd-package", "broker", "pin"]
    if other:
        command += ["--also", other / "prefix"]
    try:
        run(command, env=environment(upstream, bin_dir))
    except ValueError as error:
        return f"failed: {error}; run omd-package broker pin"
    return "pinned the active and previous installations"


def atomic_symlink(path, target):
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}")
    try:
        temporary.symlink_to(target)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def pointer(root, name):
    link = root / name
    if not link.is_symlink():
        return None
    result = link.resolve()
    if result.parent != root / "releases" or not result.is_dir():
        fail(f"invalid {name} installation pointer")
    return result


def receipt(generation):
    record = json.loads((generation / "receipt.json").read_text())
    if record.get("schema") != 1 or record.get("generation") != generation.name:
        fail("unrecognized installation receipt")
    return record


def environment(upstream, bin_dir):
    values = os.environ.copy()
    current = [item for item in values.get("PATH", "").split(os.pathsep)
               if item and Path(item).expanduser().resolve() != bin_dir]
    values["PATH"] = os.pathsep.join((str(upstream.parent), *current))
    values["PYTHONDONTWRITEBYTECODE"] = "1"
    return values


# An upstream upgrade (for example brew upgrade codex) keeps status, rollback and uninstall working: a
# recorded path that moved falls back to the codex on PATH, and --upstream overrides both.
def upstream_binary(args, current, pinned=False):
    recorded = Path(receipt(current)["upstream"]["path"]) if current else None
    if args.upstream:
        path = args.upstream.expanduser().resolve()
    elif recorded and recorded.is_file():
        path = recorded
    else:
        filtered = environment(Path("/nonexistent/codex"), args.bin_dir)["PATH"]
        found = shutil.which("codex", path=filtered)
        if not found:
            fail(f"An upstream Codex {UPSTREAM_MINOR}.x executable is required; pass --upstream /path/to/codex")
        path = Path(found).resolve()
    if path.name != "codex" or not path.is_file() or not os.access(path, os.X_OK):
        fail("--upstream must name an executable called codex")
    if path == args.bin_dir / "codex":
        fail(f"{path} is replaced by the OMD launcher; move the upstream codex out of {args.bin_dir} and pass its new path with --upstream")
    version = run([path, "--version"]).strip()
    if pinned and not re.fullmatch(rf"codex-cli {re.escape(UPSTREAM_MINOR)}\.\d+", version):
        fail(f"upstream Codex {UPSTREAM_MINOR}.x is required; found {version}")
    return {"path": str(path), "sha256": digest(path), "version": version}


def node_binary(args):
    if args.node:
        path = args.node.expanduser().resolve()
    else:
        if not shutil.which("mise"):
            fail("Node 24.18 or a later 24.x is required; install it with mise or pass --node /path/to/node")
        path = Path(run(["mise", "which", "node"]).strip()).resolve()
    found = re.fullmatch(r"v24\.(\d+)\.\d+", run([path, "--version"]).strip())
    if not found or int(found[1]) < 18:
        fail("Node 24.18 or a later 24.x is required; pass --node with a matching executable")
    return path


def profile_choice(args):
    if args.profile:
        return args.profile
    try:
        with open("/dev/tty", "r+") as terminal:
            terminal.write("Oh My Diff candidate\n"
                           "1) OMD Core: patched Codex, mod manager, typed author tools; the OMD logo is installed and active.\n"
                           "2) OMD+: the selected first-party collection and staged plugin sources.\n"
                           "   The inspector, logo, model picker and workspace mods are active on a fresh install. Other mods require your explicit activation.\n"
                           "   Updates preserve selections and add newly bundled mods disabled.\n"
                           "Choose 1 or 2: ")
            terminal.flush()
            choice = terminal.readline().strip()
    except OSError:
        fail("No terminal is available. Choose --profile platform or --profile full.")
    if choice not in ("1", "2"):
        fail("Choose 1 or 2, or pass --profile platform|full.")
    return "platform" if choice == "1" else "full"


def download(url, expected, destination):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        fail("release asset URL must use HTTPS without embedded credentials")
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        fail("release asset needs a pinned lowercase SHA-256")
    request = urllib.request.Request(url, headers={"User-Agent": "oh-my-diff-installer/1"})
    copied = 0
    with urllib.request.urlopen(request, timeout=60) as response, destination.open("xb") as output:
        if urllib.parse.urlparse(response.url).scheme != "https":
            fail("release asset redirected away from HTTPS")
        while chunk := response.read(1024 * 1024):
            copied += len(chunk)
            if copied > 150_000_000:
                fail("release asset exceeds the 150 MB download limit")
            output.write(chunk)
    if digest(destination) != expected:
        fail("release asset SHA-256 mismatch; no profile was activated")


def extract(archive_path, destination):
    with tarfile.open(archive_path, "r:xz") as archive:
        members = archive.getmembers()
        if not members or len(members) > 1000:
            fail("release archive has an invalid file count")
        if sum(item.size for item in members) > MAX_UNPACKED_BYTES:
            fail("release archive exceeds unpacked byte limit")
        if any(not item.isfile() or not item.name.startswith("payload/")
               or ".." in Path(item.name).parts for item in members):
            fail("release archive contains an unsafe member")
        if any(item.size > MAX_MEMBER_BYTES for item in members):
            fail("release archive member exceeds byte limit")
        archive.extractall(destination, filter="data")
    return destination / "payload"


def link_target(root, name):
    return root / "current" / "bin" / name


def managed(root, path, name):
    return path.is_symlink() and os.readlink(path) == str(link_target(root, name))


def check_links(root, bin_dir):
    for name in LINKS:
        path = bin_dir / name
        aside = path.with_name(f"{name}.before-omd")
        if (path.exists() or path.is_symlink()) and not managed(root, path, name) and (aside.exists() or aside.is_symlink()):
            fail(f"{path} is not managed by this installer and {aside} already exists; move one of them")


def set_links(root, bin_dir):
    bin_dir.mkdir(parents=True, exist_ok=True)
    check_links(root, bin_dir)
    displaced = []
    for name in LINKS:
        path = bin_dir / name
        if (path.exists() or path.is_symlink()) and not managed(root, path, name):
            os.rename(path, path.with_name(f"{name}.before-omd"))
            displaced.append(str(path))
        if not path.is_symlink():
            atomic_symlink(path, link_target(root, name))
    return displaced


def restore_displaced(bin_dir):
    for name in LINKS:
        aside = bin_dir / f"{name}.before-omd"
        if (aside.exists() or aside.is_symlink()) and not (bin_dir / name).exists() and not (bin_dir / name).is_symlink():
            os.rename(aside, bin_dir / name)


def status(generation, upstream, bin_dir):
    details = receipt(generation)
    output = run([generation / "bin/omd-package", "status", "--json"], env=environment(upstream, bin_dir))
    result = json.loads(output)
    if result["profile"] != details["profile"]:
        fail("installed profile differs from its receipt")
    return result


def install(args, root, current):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        fail("This release candidate supports Apple Silicon macOS only.")
    url = args.asset_url or RELEASE_URL
    expected = args.asset_sha256 or RELEASE_SHA256
    if not url:
        fail("No Oh My Diff release is published yet; nothing was installed. Pass --asset-url and --asset-sha256 for a local package.")
    profile = profile_choice(args)
    upstream = upstream_binary(args, current, pinned=True)
    node = node_binary(args)
    check_links(root, args.bin_dir)
    if current:
        status(current, Path(upstream["path"]), args.bin_dir)
    with tempfile.TemporaryDirectory(prefix="omd-https-install-") as temporary:
        archive = Path(temporary) / "package.tar.xz"
        download(url, expected, archive)
        payload = extract(archive, Path(temporary) / "unpacked")
        generation = root / "releases" / uuid.uuid4().hex
        generation.mkdir(parents=True)
        store = root / "stores" / profile
        command = [sys.executable, "-m", "scripts.lean_package", "install",
                   "--archive", archive, "--sha256", expected, "--upstream", upstream["path"],
                   "--profile", profile, "--prefix", generation / "prefix",
                   "--bin-dir", generation / "bin", "--store", store, "--node", node]
        if store.exists():
            command.append("--attach-store")
        try:
            run(command, cwd=payload, env=environment(Path(upstream["path"]), args.bin_dir))
            record = {"schema": 1, "generation": generation.name, "profile": profile,
                      "asset_url": url, "asset_sha256": expected, "upstream": upstream,
                      "previous": current.name if current else None}
            (generation / "receipt.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
            status(generation, Path(upstream["path"]), args.bin_dir)
        except BaseException:
            discard(generation, Path(upstream["path"]), args.bin_dir)
            raise
        if current:
            atomic_symlink(root / "previous", current)
        atomic_symlink(root / "current", generation)
        try:
            displaced = set_links(root, args.bin_dir)
        except BaseException:
            if current:
                atomic_symlink(root / "current", current)
            else:
                (root / "current").unlink()
            raise
        kept = {generation, current} - {None}
        pruned, failures = [], []
        for old in sorted((root / "releases").iterdir()):
            if old.name.startswith("failed-"):
                shutil.rmtree(old, ignore_errors=True)
                pruned.append(old.name)
                continue
            if old in kept or not (old / "receipt.json").is_file():
                continue
            try:
                remove_generation(old, Path(upstream["path"]), args.bin_dir)
                pruned.append(old.name)
            except (OSError, ValueError) as error:
                failures.append(f"{old.name}: {error}")
        pinned = repin(generation, current, Path(upstream["path"]), args.bin_dir)
        print(json.dumps({"installed": profile, "profile_label": PROFILE_LABELS[profile], "active": str(generation),
                          "previous": str(current) if current else None,
                          "upstream": upstream["path"], "bin_dir": str(args.bin_dir),
                          "moved_aside": [f"{path} -> {path}.before-omd" for path in displaced],
                          "pruned": pruned, "prune_failures": failures,
                          **({"authority_broker": pinned} if pinned else {})}, indent=2))


def remove_generation(generation, upstream, bin_dir):
    run([generation / "bin/omd-package", "uninstall", "--keep-broker"], env=environment(upstream, bin_dir))
    (generation / "receipt.json").unlink()
    (generation / "bin").rmdir()
    generation.rmdir()


def discard(generation, upstream, bin_dir):
    if (generation / "bin/omd-package").is_file():
        try:
            run([generation / "bin/omd-package", "uninstall", "--keep-broker"],
                env=environment(upstream, bin_dir))
        except (OSError, ValueError):
            pass
    (generation / "receipt.json").unlink(missing_ok=True)
    if (generation / "prefix").exists():
        generation.rename(generation.with_name(f"failed-{generation.name}"))
    else:
        shutil.rmtree(generation)


def rollback(args, root, bin_dir, current):
    previous = pointer(root, "previous")
    if previous == current and current:
        prior_name = receipt(current).get("previous")
        if isinstance(prior_name, str) and re.fullmatch(r"[0-9a-f]{32}", prior_name):
            prior = root / "releases" / prior_name
            if prior.is_dir():
                previous = prior
    if not current or not previous:
        fail("No previous installation is available for rollback.")
    upstream = Path(upstream_binary(args, current)["path"])
    status(current, upstream, bin_dir)
    target = status(previous, upstream, bin_dir)
    check_links(root, bin_dir)
    atomic_symlink(root / "previous", current)
    atomic_symlink(root / "current", previous)
    try:
        set_links(root, bin_dir)
    except BaseException:
        atomic_symlink(root / "current", current)
        raise
    pinned = repin(previous, current, upstream, bin_dir)
    print(json.dumps({"restored": str(previous), "profile": target["profile"],
                      "profile_label": PROFILE_LABELS[target["profile"]],
                      **({"authority_broker": pinned} if pinned else {})}, indent=2))


def uninstall(args, root, bin_dir, current):
    if not current:
        fail("No managed OMD installation is active.")
    if broker_deployed():
        fail("The authority broker is deployed; run omd-package broker uninstall first (it removes protected credentials).")
    upstream = Path(upstream_binary(args, current)["path"])
    check_links(root, bin_dir)
    generations = sorted((root / "releases").iterdir())
    generations = [item for item in generations if (item / "receipt.json").is_file()]
    for generation in generations:
        status(generation, upstream, bin_dir)
    for name in LINKS:
        if managed(root, bin_dir / name, name):
            (bin_dir / name).unlink()
    restore_displaced(bin_dir)
    try:
        run([current / "bin/omd-package", "uninstall"], env=environment(upstream, bin_dir))
    except BaseException:
        set_links(root, bin_dir)
        raise
    (current / "receipt.json").unlink()
    (current / "bin").rmdir()
    current.rmdir()
    (root / "current").unlink()
    (root / "previous").unlink(missing_ok=True)
    for generation in [item for item in generations if item != current]:
        remove_generation(generation, upstream, bin_dir)
    print(json.dumps({"uninstalled": True, "restored_upstream": str(upstream),
                      "preserved_stores": str(root / "stores")}, indent=2))


def main():
    if sys.version_info < (3, 12):
        fail("Python 3.12 or newer is required for verified archive extraction")
    parser = argparse.ArgumentParser(description="Install the Apple Silicon Oh My Diff release candidate")
    parser.add_argument("command", nargs="?", choices=("install", "status", "rollback", "uninstall"), default="install")
    parser.add_argument("--profile", choices=PROFILE_LABELS, help="platform: OMD Core; full: OMD+")
    parser.add_argument("--asset-url")
    parser.add_argument("--asset-sha256")
    parser.add_argument("--upstream", type=Path)
    parser.add_argument("--node", type=Path)
    parser.add_argument("--root", type=Path, default=Path.home() / ".local/share/oh-my-diff")
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local/bin")
    args = parser.parse_args()
    args.root = args.root.expanduser().resolve()
    args.bin_dir = args.bin_dir.expanduser().resolve()
    root = args.root
    if root == Path(root.anchor) or args.bin_dir == Path(args.bin_dir.anchor):
        fail("installation paths must not be filesystem roots")
    home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser().resolve()
    sqlite = Path(os.environ.get("CODEX_SQLITE_HOME", home)).expanduser().resolve()
    for state in (home, sqlite):
        if (root == state or root in state.parents or state in root.parents
                or args.bin_dir == state or args.bin_dir in state.parents or state in args.bin_dir.parents):
            fail("installation paths must remain outside shared Codex state")
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".install.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = pointer(root, "current")
        if args.command == "install":
            install(args, root, current)
        elif args.command == "status":
            if not current:
                fail("No managed OMD installation is active.")
            upstream = Path(upstream_binary(args, current)["path"])
            print(json.dumps({"active": str(current), "previous": str(pointer(root, "previous")),
                              "profile": status(current, upstream, args.bin_dir)}, indent=2))
        elif args.command == "rollback":
            rollback(args, root, args.bin_dir, current)
        else:
            uninstall(args, root, args.bin_dir, current)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, tarfile.TarError) as error:
        print(f"omd installer: {error}", file=sys.stderr)
        raise SystemExit(1) from error
PY
