#!/bin/sh
exec python3 - "$@" <<'PY'
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
LINKS = ("codex", "omd-package", "omd-mod-author", "omd-graph", "omd-health", "omd-lsp")
BASE_LINKS = LINKS[:3]


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


def upstream_binary(args, current):
    if args.upstream:
        path = args.upstream.expanduser().resolve()
    elif current:
        path = Path(receipt(current)["upstream"]["path"])
    else:
        filtered = environment(Path("/nonexistent/codex"), args.bin_dir)["PATH"]
        found = shutil.which("codex", path=filtered)
        if not found:
            fail("A pinned upstream Codex 0.156.1 executable is required; pass --upstream /path/to/codex")
        path = Path(found).resolve()
    if path.name != "codex" or not path.is_file() or not os.access(path, os.X_OK):
        fail("--upstream must name an executable called codex")
    version = run([path, "--version"]).strip()
    if version != "codex-cli 0.156.1":
        fail(f"upstream Codex 0.156.1 is required; found {version}")
    identity = {"path": str(path), "sha256": digest(path), "version": version}
    if current and receipt(current)["upstream"] != identity:
        fail("upstream fallback changed; the current installation remains active")
    return identity


def node_binary(args):
    if args.node:
        path = args.node.expanduser().resolve()
    else:
        if not shutil.which("mise"):
            fail("Node 24.18.0 is required; install it with mise or pass --node /path/to/node")
        path = Path(run(["mise", "which", "node"]).strip()).resolve()
    if run([path, "--version"]).strip() != "v24.18.0":
        fail("Node 24.18.0 is required; pass --node with the matching executable")
    return path


def profile_choice(args):
    if args.profile:
        return args.profile
    try:
        with open("/dev/tty", "r+") as terminal:
            terminal.write("Oh My Diff 0.156.1 candidate\n"
                           "1) Modding platform only: patched Codex, mod manager, typed author tools; no first-party mods installed or active.\n"
                           "2) Full OMD: adds coordination, recovery and workspace mods; graph, health and LSP tools; six staged plugin sources.\n"
                           "   Only the workspace mod is active by default. Other behavior requires your explicit activation.\n"
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
        if not members or len(members) > 1000 or sum(item.size for item in members) > 600_000_000:
            fail("release archive has an invalid inventory")
        if any(not item.isfile() or not item.name.startswith("payload/")
               or any(part in ("", ".", "..") for part in Path(item.name).parts)
               or item.size > 500_000_000 for item in members):
            fail("release archive contains an unsafe member")
        archive.extractall(destination, filter="data")
    return destination / "payload"


def installed_names(profile):
    return LINKS if profile == "full" else BASE_LINKS


def link_target(root, name):
    return root / "current" / "bin" / name


def check_links(root, bin_dir):
    for name in LINKS:
        path = bin_dir / name
        if path.exists() or path.is_symlink():
            if not path.is_symlink() or os.readlink(path) != str(link_target(root, name)):
                fail(f"existing launcher is not managed by this installer: {path}")


def set_links(root, bin_dir, profile):
    bin_dir.mkdir(parents=True, exist_ok=True)
    check_links(root, bin_dir)
    names = installed_names(profile)
    for name in names:
        path = bin_dir / name
        if not path.is_symlink():
            atomic_symlink(path, link_target(root, name))
    for name in set(LINKS) - set(names):
        (bin_dir / name).unlink(missing_ok=True)


def status(generation, upstream, bin_dir):
    details = receipt(generation)
    output = run([generation / "bin/omd-package", "status"], env=environment(upstream, bin_dir))
    result = json.loads(output)
    if result["profile"] != details["profile"]:
        fail("installed profile differs from its receipt")
    return result


def install(args, root, current):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        fail("This release candidate supports Apple Silicon macOS only.")
    profile = profile_choice(args)
    url = args.asset_url or RELEASE_URL
    expected = args.asset_sha256 or RELEASE_SHA256
    if not url:
        fail("No supported HTTPS release asset is published yet; the current local package remains a candidate.")
    upstream = upstream_binary(args, current)
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
            if not (generation / "prefix").exists():
                shutil.rmtree(generation)
            raise
        if current:
            atomic_symlink(root / "previous", current)
        atomic_symlink(root / "current", generation)
        try:
            set_links(root, args.bin_dir, profile)
        except BaseException:
            if current:
                atomic_symlink(root / "current", current)
            else:
                (root / "current").unlink()
            raise
        print(json.dumps({"installed": profile, "active": str(generation),
                          "previous": str(current) if current else None,
                          "upstream": upstream["path"], "bin_dir": str(args.bin_dir)}, indent=2))


def rollback(root, bin_dir, current):
    previous = pointer(root, "previous")
    if previous == current and current:
        prior_name = receipt(current).get("previous")
        if isinstance(prior_name, str) and re.fullmatch(r"[0-9a-f]{32}", prior_name):
            prior = root / "releases" / prior_name
            if prior.is_dir() and prior.parent == root / "releases":
                previous = prior
    if not current or not previous:
        fail("No previous installation is available for rollback.")
    upstream = Path(upstream_binary(argparse.Namespace(upstream=None, bin_dir=bin_dir), current)["path"])
    status(current, upstream, bin_dir)
    target = status(previous, upstream, bin_dir)
    check_links(root, bin_dir)
    atomic_symlink(root / "previous", current)
    atomic_symlink(root / "current", previous)
    try:
        set_links(root, bin_dir, target["profile"])
    except BaseException:
        atomic_symlink(root / "current", current)
        raise
    print(json.dumps({"restored": str(previous), "profile": target["profile"]}, indent=2))


def uninstall(root, bin_dir, current):
    if not current:
        fail("No managed OMD installation is active.")
    upstream = Path(upstream_binary(argparse.Namespace(upstream=None, bin_dir=bin_dir), current)["path"])
    check_links(root, bin_dir)
    generations = sorted((root / "releases").iterdir())
    generations = [item for item in generations if (item / "receipt.json").is_file()]
    for generation in generations:
        status(generation, upstream, bin_dir)
    for name in LINKS:
        (bin_dir / name).unlink(missing_ok=True)
    try:
        run([current / "bin/omd-package", "uninstall"], env=environment(upstream, bin_dir))
    except BaseException:
        set_links(root, bin_dir, receipt(current)["profile"])
        raise
    (current / "receipt.json").unlink()
    (current / "bin").rmdir()
    current.rmdir()
    (root / "current").unlink()
    (root / "previous").unlink(missing_ok=True)
    for generation in [item for item in generations if item != current]:
        run([generation / "bin/omd-package", "uninstall"], env=environment(upstream, bin_dir))
        (generation / "receipt.json").unlink()
        (generation / "bin").rmdir()
        generation.rmdir()
    print(json.dumps({"uninstalled": True, "restored_upstream": str(upstream),
                      "preserved_stores": str(root / "stores")}, indent=2))


def main():
    if sys.version_info < (3, 12):
        fail("Python 3.12 or newer is required for verified archive extraction")
    parser = argparse.ArgumentParser(description="Install the Apple Silicon Oh My Diff release candidate")
    parser.add_argument("command", nargs="?", choices=("install", "status", "rollback", "uninstall"), default="install")
    parser.add_argument("--profile", choices=("platform", "full"))
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
            rollback(root, args.bin_dir, current)
        else:
            uninstall(root, args.bin_dir, current)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, tarfile.TarError) as error:
        print(f"omd installer: {error}", file=sys.stderr)
        raise SystemExit(1) from error
PY
