#!/bin/sh
preferred=$OMD_PYTHON
OMD_PYTHON=
for candidate in "$preferred" python3.14 python3.13 python3.12 python3 /opt/homebrew/bin/python3 "$(command -v mise >/dev/null 2>&1 && mise which python3 2>/dev/null)"; do
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
exec "$OMD_PYTHON" -I - "$@" <<'PY'
import argparse
import codecs
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
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


RELEASES_URL = "https://api.github.com/repos/dzkchen/oh-my-diff/releases?per_page=20"
RELEASE_MANIFEST = "omd-release.json"
RELEASE_SIGNATURE = RELEASE_MANIFEST + ".sig"
RELEASE_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGhcSdBwdX2rgdAjg2JwbF7A1KCswnSZpwbdFsaLKo6G"
SIGNING_NAMESPACE = "oh-my-diff-release"
RELEASE_HOSTS = ("api.github.com", "localhost", "127.0.0.1")
TARGET = "aarch64-apple-darwin"
UPDATE_MOD = "omd_update"
CADENCES = {"daily": 86_400, "weekly": 604_800}
POLICY = {"checks": ("on", "off"), "auto": ("off", "on"), "channel": ("stable", "prerelease", "nightly"), "cadence": ("daily", "weekly")}
RELEASE_URL = ""
RELEASE_SHA256 = ""
LINKS = ("codex", "omd-package", "omd-mod-author", "omd", "omd-contract", "omd-mod")
UNINSTALL_JOURNAL = ".uninstall.json"
UPSTREAM_MINOR = "0.164"
PROFILE_LABELS = {"platform": "OMD Core", "full": "OMD+"}
MAX_UNPACKED_BYTES = 1_200_000_000
MAX_MEMBER_BYTES = 1_000_000_000
DOWNLOAD_WAIT = "Waiting for the background update check or download to finish…"
BROKER_DAEMON = Path("/Library/LaunchDaemons/dev.ohmydiff.broker.plist")
WEBSITE = "https://www.ohmydiff.me"
DOCS = "https://github.com/dzkchen/oh-my-diff/blob/main/docs/install.md"
MARK = ("╭─╮ ╭╮╭╮ ┌─╮", "│ │ │╰╯│ │ │", "╰─╯ ╵  ╵ └─╯")
MARK_ASCII = (".-. |\\/| |-.", "| | |  | | |", "'-' |  | |-'")
LIVE = sys.stderr.isatty() and os.environ.get("TERM") != "dumb"
COLOR = LIVE and not os.environ.get("NO_COLOR")
UNICODE = codecs.lookup(sys.stderr.encoding or "ascii").name == "utf-8"
ASCII = str.maketrans({"✓": "+", "✗": "x", "…": "...", "█": "#", "░": "-", "·": "-"})


def fail(message):
    raise ValueError(message)


def paint(text, code):
    return f"\033[{code}m{text}\033[0m" if COLOR and text else text


def say(line=""):
    print(("\r\033[K" if LIVE else "") + (line if UNICODE else line.translate(ASCII)), file=sys.stderr, flush=True)


def step(label, detail="", mark="✓"):
    say(f"  {paint(mark, {'✓': '32', '!': '33', '✗': '31'}[mark])} {label:<22}{paint(detail, '2')}".rstrip())


def pending(label, detail=""):
    if LIVE:
        line = f"\r\033[K  {paint('…', '2')} {label:<22}{paint(detail, '2')}"
        sys.stderr.write(line if UNICODE else line.translate(ASCII))
        sys.stderr.flush()


def tilde(path):
    path = Path(path)
    return f"~/{path.relative_to(Path.home())}" if path.is_relative_to(Path.home()) else str(path)


def megabytes(count):
    return f"{count / 1_000_000:.0f}"


def banner(manifest):
    version = f" {manifest['version']}" if manifest else ""
    minor = minor_of(manifest) if manifest else UPSTREAM_MINOR
    side = (paint(f"oh my diff{version}", "1") + paint(" · beta", "2"),
            paint(f"Codex {minor} with TypeScript mods", "2"), paint("Apple Silicon macOS", "2"))
    say()
    for mark, text in zip(MARK if UNICODE else MARK_ASCII, side):
        say(f"  {paint('+', '36')} {paint(mark, '1')}   {text}")
    say()


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


def package(generation, upstream, bin_dir, *arguments):
    return run([sys.executable, "-m", "scripts.profiles", "--prefix", generation / "prefix",
                "--bin-dir", generation / "bin", *arguments],
               cwd=generation / "prefix/management", env=environment(upstream, bin_dir))


def repin(active, other, upstream, bin_dir):
    if not broker_deployed():
        return None
    command = ["broker", "pin"]
    if other:
        command += ["--also", other / "prefix"]
    try:
        package(active, upstream, bin_dir, *command)
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


# An upstream upgrade (for example brew upgrade codex) keeps status, rollback and uninstall working: a recorded path that moved falls back to the codex on PATH, and --upstream overrides both.
def first_passing(candidates, accept):
    errors = []
    for candidate in candidates:
        try:
            return accept(candidate())
        except (OSError, ValueError) as error:
            errors.append(error)
    raise errors[0]


def upstream_binary(args, current, minor=None):
    def accept(path):
        if path.name != "codex" or not path.is_file() or not os.access(path, os.X_OK):
            fail("--upstream must name an executable called codex")
        if path == args.bin_dir / "codex":
            fail(f"{path} is replaced by the OMD launcher; move the upstream codex out of {args.bin_dir} and pass its new path with --upstream")
        version = run([path, "--version"]).strip()
        if minor and not re.fullmatch(rf"codex-cli {re.escape(minor)}\.\d+", version):
            fail(f"upstream Codex {minor}.x is required; found {version}")
        return {"path": str(path), "version": version}

    def found():
        located = shutil.which("codex", path=environment(Path("/nonexistent/codex"), args.bin_dir)["PATH"])
        if not located:
            fail(f"An upstream Codex {minor or UPSTREAM_MINOR}.x executable is required; pass --upstream /path/to/codex")
        return Path(located).resolve()

    if args.upstream:
        return first_passing([lambda: args.upstream.expanduser().resolve()], accept)
    recorded = Path(receipt(current)["upstream"]["path"]) if current else None
    return first_passing(([lambda: recorded] if recorded and recorded.is_file() else []) + [found], accept)


def profile_choice(args):
    if args.profile:
        return args.profile
    try:
        with open("/dev/tty", "w") as output, open("/dev/tty") as terminal:
            output.write(f"  {paint('Pick a profile', '1')}\n\n"
                         f"    {paint('1', '36')}  {paint('OMD+', '1')}       Core plus the first-party mod collection and bundled plugins.\n"
                         "                  Default mods start on; turn on the rest in /mods.\n"
                         "                  Among them: a prompt unanswered for two minutes is declined,\n"
                         "                  a large idle chat is compacted (losing detail and cancelling\n"
                         "                  a pending approval), and /plan is removed.\n\n"
                         f"    {paint('2', '36')}  {paint('OMD Core', '1')}   Patched Codex, mod manager, typed author tools,\n"
                         "                  and the logo, /mods and update mods.\n\n")
            while True:
                output.write("  Profile [1/2]: ")
                output.flush()
                line = terminal.readline()
                if not line:
                    fail("No profile was chosen. Pass --profile full or --profile platform.")
                if line.strip() in ("1", "2"):
                    output.write("\n")
                    return "full" if line.strip() == "1" else "platform"
    except OSError:
        fail("No terminal is available. Pass --profile full or --profile platform.")


def opened(url, timeout):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        fail("release URLs must use HTTPS without embedded credentials")
    request = urllib.request.Request(url, headers={"User-Agent": "oh-my-diff-installer/1",
                                                   "Accept": "application/vnd.github+json"})
    response = urllib.request.urlopen(request, timeout=timeout)
    if urllib.parse.urlparse(response.url).scheme != "https":
        response.close()
        fail("release URL redirected away from HTTPS")
    return response


def download(url, expected, destination, progress=None):
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        fail("release asset needs a pinned lowercase SHA-256")
    copied = 0
    with opened(url, 60) as response, destination.open("xb") as output:
        total = int(response.headers.get("Content-Length") or 0)
        while chunk := response.read(1024 * 1024):
            copied += len(chunk)
            if copied > 150_000_000:
                fail("release asset exceeds the 150 MB download limit")
            output.write(chunk)
            if progress:
                progress(copied, total)
    if digest(destination) != expected:
        fail("release asset SHA-256 mismatch; no profile was activated")
    return copied


def download_progress(copied, total):
    if not total:
        return pending("Downloading", f"{megabytes(copied)} MB")
    filled = min(20, copied * 20 // total)
    pending("Downloading", f"{'█' * filled}{'░' * (20 - filled)}  {megabytes(copied)} / {megabytes(total)} MB")


def fetch_bytes(url, limit):
    with opened(url, 15) as response:
        body = response.read(limit + 1)
    if len(body) > limit:
        fail("release metadata exceeds its size limit")
    return body


def fetch_json(url, limit):
    body = fetch_bytes(url, limit)
    try:
        return json.loads(body)
    except ValueError:
        fail("release metadata is not JSON")


def extract(archive_path, destination):
    with tarfile.open(archive_path, "r:xz") as archive:
        members = archive.getmembers()
        if not members or len(members) > 1000:
            fail("release archive has an invalid file count")
        if sum(item.size for item in members) > MAX_UNPACKED_BYTES:
            fail("release archive exceeds unpacked byte limit")
        if any(not item.isfile() or not item.name.startswith("payload/")
               or any(part in ("", ".", "..") for part in item.name.split("/")) for item in members):
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


def shadowing_codex(bin_dir):
    located = shutil.which("codex")
    if located and Path(located).parent.resolve() == bin_dir:
        return None
    return located or "missing"


def shell_profile():
    shell = Path(os.environ.get("SHELL", "zsh")).name
    return {"zsh": "~/.zshrc", "bash": "~/.bash_profile"}.get(shell, "your shell profile")


def path_line(bin_dir):
    return f'export PATH="{bin_dir}:$PATH"'


def restore_displaced(bin_dir):
    for name in LINKS:
        aside = bin_dir / f"{name}.before-omd"
        if (aside.exists() or aside.is_symlink()) and not (bin_dir / name).exists() and not (bin_dir / name).is_symlink():
            os.rename(aside, bin_dir / name)


def restore_links(root, bin_dir):
    for name in LINKS:
        if managed(root, bin_dir / name, name):
            (bin_dir / name).unlink()
    restore_displaced(bin_dir)


def status(generation, upstream, bin_dir):
    details = receipt(generation)
    result = json.loads(package(generation, upstream, bin_dir, "status", "--json"))
    if result["profile"] != details["profile"]:
        fail("installed profile differs from its receipt")
    return result


def install(args, root, current):
    if bool(args.asset_url) != bool(args.asset_sha256):
        fail("Pass --asset-url and --asset-sha256 together; nothing was installed.")
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        fail("Oh My Diff supports Apple Silicon macOS only.")
    url = args.asset_url or RELEASE_URL
    expected = args.asset_sha256 or RELEASE_SHA256
    channel = args.channel or (policy(installation(root, current)[2])["channel"] if current else "stable")
    manifest = None
    if not url:
        pending(f"Finding the {channel} release")
        candidates = [item for item in releases(release_source(args.releases_url or RELEASES_URL), channel=channel) if on_channel(channel, item)]
        if not candidates:
            fail(f"No Oh My Diff {channel} release is published yet; nothing was installed.")
        manifest = release_manifest(candidates[0])
        if manifest["target"] != TARGET:
            fail(f"release is built for {manifest['target']}")
        url, expected = manifest["url"], manifest["sha256"]
    banner(manifest)
    profile = profile_choice(args)
    if manifest:
        step(f"Release {manifest['version']}", "signature verified")
    upstream = upstream_binary(args, current, minor_of(manifest) if manifest else UPSTREAM_MINOR)
    step(f"Codex {upstream['version'].removeprefix('codex-cli ')}", tilde(upstream["path"]))
    refuse_sessions(root, args.session)
    with tempfile.TemporaryDirectory(prefix="omd-https-install-") as temporary:
        archive = Path(temporary) / "package.tar.xz"
        size = download(url, expected, archive, download_progress)
        step(f"Downloaded {megabytes(size)} MB", "checksum matches")
        pending(f"Installing {PROFILE_LABELS[profile]}")
        result = transaction(args, root, current, archive, url, expected, profile, upstream, manifest)
        _, record, store = installation(root, pointer(root, "current"))
        if policy(store)["channel"] != channel:
            set_policy(root, record, "channel", channel)
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            installed(result)


def installed(result):
    step(f"Installed {result['profile_label']}")
    step("Linked commands", f"{tilde(result['bin_dir'])} ({', '.join(LINKS)})")
    for moved in result["moved_aside"]:
        step("Moved aside", moved, "!")
    for failure in result["prune_failures"]:
        step("Old install kept", failure, "!")
    broker = result.get("authority_broker")
    unpinned = bool(broker and broker.startswith("failed"))
    if broker:
        step("Authority broker", broker, "!" if unpinned else "✓")
    say()
    headline = f"Oh My Diff {result['version']} ({result['profile_label']}) is installed"
    headline += ", but codex can't start until the authority broker is pinned." if unpinned else "."
    say(f"  {paint('+', '36')} {paint(headline, '1')}")
    say()
    rows = [("Mods", "/mods and /omd inside codex"), ("Update", "omd update"), ("Website", WEBSITE), ("Docs", DOCS)]
    if unpinned:
        rows.insert(0, ("Fix", "omd-package broker pin, then open a new terminal and run codex"))
    elif shadowing := result.get("codex_on_path"):
        say(f"  {paint('!', '33')} codex on your PATH is {shadowing}, not OMD's.")
        say(f"    Add this line to the end of {shell_profile()}, then open a new terminal and run codex:")
        say()
        say(f"      {path_line(result['bin_dir'])}")
        say()
    else:
        # A shell that already looked up codex keeps running the old one until its command cache is cleared.
        rows.insert(0, ("Start", "open a new terminal and run codex, or hash -r && codex"))
    for label, text in rows:
        say(f"    {paint(f'{label:<9}', '2')}{text}")
    say()


class SessionsOpen(ValueError):
    pass


def refuse_sessions(root, own):
    if live := sessions(root, own):
        raise SessionsOpen(f"{len(live)} OMD session(s) are open (process {', '.join(map(str, live))}); close them and retry")


def journaled(root, generation, own, created=None):
    update_dir(root)
    write_json(root / "update/journal.json", {"generation": generation.name if generation else None, "created": created})
    try:
        refuse_sessions(root, own)
    except SessionsOpen:
        (root / "update/journal.json").unlink()
        raise


def transaction(args, root, current, archive, url, expected, profile, upstream, manifest=None):
    if manifest and not (signed(manifest.get("body", "").encode(), manifest.get("signature", "").encode())
                         and json.loads(manifest["body"]).get("sha256") == expected):
        fail("the release manifest no longer verifies; run omd update check")
    check_links(root, args.bin_dir)
    if current:
        status(current, Path(upstream["path"]), args.bin_dir)
    previous = receipt(current) if current else {}
    releases_url = release_source(args.releases_url or previous.get("releases_url") or RELEASES_URL)
    with tempfile.TemporaryDirectory(prefix="omd-https-install-") as temporary:
        payload = extract(archive, Path(temporary) / "unpacked")
        generation = root / "releases" / uuid.uuid4().hex
        store = root / "stores" / profile
        journaled(root, generation, args.session, None if store.exists() else profile)
        generation.mkdir(parents=True)
        if manifest:
            (generation / RELEASE_MANIFEST).write_text(manifest["body"])
            (generation / RELEASE_SIGNATURE).write_text(manifest["signature"])
        command = [sys.executable, "-m", "scripts.package", "install",
                   "--payload", payload, "--upstream", upstream["path"],
                   "--profile", profile, "--prefix", generation / "prefix",
                   "--bin-dir", generation / "bin", "--store", store]
        if store.exists():
            command.append("--attach-store")
        if current:
            command += ["--previous", current / "prefix"]
        try:
            run(command, cwd=payload, env=environment(Path(upstream["path"]), args.bin_dir))
            installed = json.loads((generation / "prefix/install.json").read_text())
            record = {"schema": 1, "generation": generation.name, "profile": profile, "version": installed["version"],
                      "asset_url": url, "asset_sha256": expected, "bin_dir": str(args.bin_dir),
                      "upstream": upstream | {"sha256": digest(Path(upstream["path"]))},
                      "releases_url": releases_url,
                      "previous": current.name if current else None}
            (generation / "receipt.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
            status(generation, Path(upstream["path"]), args.bin_dir)
        except BaseException:
            discard(generation, Path(upstream["path"]), args.bin_dir)
            abandon(root, current, Path(upstream["path"]), args.bin_dir)
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
                restore_links(root, args.bin_dir)
            discard(generation, Path(upstream["path"]), args.bin_dir)
            abandon(root, current, Path(upstream["path"]), args.bin_dir)
            raise
        (root / "update/journal.json").unlink(missing_ok=True)
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
                remove_generation(old, Path(upstream["path"]), args.bin_dir, "--keep-broker")
                pruned.append(old.name)
            except (OSError, ValueError) as error:
                failures.append(f"{old.name}: {error}")
        collect(root)
        pinned = repin(generation, current, Path(upstream["path"]), args.bin_dir)
        settled(root, record["version"], held=None)
        return {"installed": profile, "profile_label": PROFILE_LABELS[profile], "version": record["version"],
                "active": str(generation), "previous": str(current) if current else None,
                "upstream": upstream["path"], "bin_dir": str(args.bin_dir),
                "moved_aside": [f"{path} -> {path}.before-omd" for path in displaced],
                "pruned": pruned, "prune_failures": failures,
                **({"authority_broker": pinned} if pinned else {}),
                **({"codex_on_path": shadowing} if (shadowing := shadowing_codex(args.bin_dir)) else {})}


def collect(root):
    for path in (root / "objects").glob("*"):
        try:
            if path.stat().st_nlink == 1:
                path.unlink()
        except OSError:
            pass


def restore_store(generation, upstream, bin_dir):
    if generation:
        package(generation, upstream, bin_dir, "reconcile")


def abandon(root, generation, upstream, bin_dir):
    try:
        restore_store(generation, upstream, bin_dir)
        if not generation:
            restore_links(root, bin_dir)
    except (OSError, ValueError):
        return
    (root / "update/journal.json").unlink(missing_ok=True)


def recover(args, root, current):
    journal = root / "update/journal.json"
    if not journal.exists():
        return
    entry = read_json(journal, {})
    name, created = entry.get("generation"), entry.get("created")
    upstream = Path(upstream_binary(args, current)["path"]) if current else None
    interrupted = root / "releases" / name if isinstance(name, str) and re.fullmatch(r"[0-9a-f]{32}", name) else None
    if not current:
        restore_links(root, args.bin_dir)
    if interrupted and interrupted != current and interrupted.is_dir():
        discard(interrupted, upstream or Path("/nonexistent/codex"), args.bin_dir)
    if interrupted and interrupted != current and created in PROFILE_LABELS:
        shutil.rmtree(root / "stores" / created, ignore_errors=True)
    restore_store(current, upstream, args.bin_dir)
    if current:
        set_links(root, args.bin_dir)
    journal.unlink()


def removing(generation):
    prefix = generation / "prefix"
    return (prefix / UNINSTALL_JOURNAL).is_file() or not prefix.is_dir() or not any(prefix.iterdir())


# Once the package uninstall journals, the prefix holds only validated files and removal only rolls forward.
def remove_generation(generation, upstream, bin_dir, *flags):
    prefix = generation / "prefix"
    if not removing(generation):
        package(generation, upstream, bin_dir, "uninstall", *flags)
    if (prefix / UNINSTALL_JOURNAL).is_file():
        shutil.rmtree(prefix)
    elif prefix.is_dir():
        prefix.rmdir()
    for name in LINKS:
        (generation / "bin" / name).unlink(missing_ok=True)
    for name in ("receipt.json", RELEASE_MANIFEST, RELEASE_SIGNATURE):
        (generation / name).unlink(missing_ok=True)
    for directory in (generation / "bin", generation):
        if directory.is_dir():
            directory.rmdir()


def discard(generation, upstream, bin_dir):
    if (generation / "bin/omd-package").is_file():
        try:
            package(generation, upstream, bin_dir, "uninstall", "--keep-broker")
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
    status(previous, upstream, bin_dir)
    check_links(root, bin_dir)
    journaled(root, None, args.session)
    atomic_symlink(root / "previous", current)
    atomic_symlink(root / "current", previous)
    try:
        set_links(root, bin_dir)
        restore_store(previous, upstream, bin_dir)
        target = status(previous, upstream, bin_dir)
    except BaseException:
        atomic_symlink(root / "previous", previous)
        atomic_symlink(root / "current", current)
        abandon(root, current, upstream, bin_dir)
        raise
    (root / "update/journal.json").unlink()
    settled(root, receipt(previous)["version"], held={"version": receipt(current)["version"]})
    (root / "update/ready.json").unlink(missing_ok=True)
    pinned = repin(previous, current, upstream, bin_dir)
    print(json.dumps({"restored": str(previous), "version": receipt(previous).get("version"), "profile": target["profile"],
                      "profile_label": PROFILE_LABELS[target["profile"]],
                      **({"authority_broker": pinned} if pinned else {})}, indent=2))


def uninstall(args, root, bin_dir, current):
    if not current:
        fail("No managed OMD installation is active.")
    if broker_deployed():
        fail("The authority broker is deployed; run omd-package broker uninstall first (it removes protected credentials).")
    upstream = Path(upstream_binary(args, current)["path"])
    check_links(root, bin_dir)
    refuse_sessions(root, args.session)
    generations = sorted((root / "releases").iterdir())
    generations = [item for item in generations if (item / "receipt.json").is_file()]
    for generation in generations:
        if not removing(generation):
            status(generation, upstream, bin_dir)
    failures = []
    for generation in [item for item in generations if item != current]:
        try:
            remove_generation(generation, upstream, bin_dir, "--keep-broker")
        except (OSError, ValueError) as error:
            failures.append(f"{generation.name}: {error}")
    kept = (root / "previous").resolve()
    if not failures or not kept.is_dir() or removing(kept):
        (root / "previous").unlink(missing_ok=True)
    if failures:
        fail(f"Could not remove older installations; the current one is untouched, fix these and retry: {'; '.join(failures)}")
    write_json(update_dir(root) / "journal.json", {"uninstall": current.name, "bin_dir": str(bin_dir)})
    restore_links(root, bin_dir)
    try:
        remove_generation(current, upstream, bin_dir)
    except BaseException:
        if not removing(current):
            set_links(root, bin_dir)
            (root / "update/journal.json").unlink()
        raise
    print(json.dumps(uninstalled(root) | {"restored_upstream": str(upstream)}, indent=2))


def uninstalled(root):
    (root / "current").unlink(missing_ok=True)
    for leftover in [*(root / "releases").iterdir(), root / "update", root / "sessions", root / "objects"]:
        shutil.rmtree(leftover, ignore_errors=True)
    return {"uninstalled": True, "preserved_stores": str(root / "stores")}


def resume_uninstall(args, root):
    journal = root / "update/journal.json"
    name = read_json(journal, {}).get("uninstall") if journal.exists() else None
    if name is None:
        return None
    if not (isinstance(name, str) and re.fullmatch(r"[0-9a-f]{32}", name)):
        fail("unrecognized uninstall journal")
    generation = root / "releases" / name
    if not removing(generation):
        set_links(root, args.bin_dir)
        journal.unlink()
        return None
    restore_links(root, args.bin_dir)
    remove_generation(generation, None, args.bin_dir)
    return uninstalled(root)


def update_dir(root):
    (root / "update").mkdir(exist_ok=True)
    return root / "update"


def write_json(path, value):
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}")
    temporary.write_text(json.dumps(value, sort_keys=True) + "\n")
    os.replace(temporary, path)


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def stamp(path, at):
    path.touch()
    os.utime(path, (at, at))


def text(value, limit):
    return value[:limit] if isinstance(value, str) else ""


def sessions(root, own):
    live = []
    for marker in (root / "sessions").iterdir() if (root / "sessions").is_dir() else ():
        pid = int(marker.name) if marker.name.isdigit() else 0
        if not pid or pid == own:
            continue
        name = subprocess.run(["ps", "-o", "comm=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        if name and (Path(name).name == "codex" or time.time() - marker.stat().st_mtime < 60):
            live.append(pid)
        else:
            marker.unlink(missing_ok=True)
    return live


def version_key(value):
    found = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?", value) if isinstance(value, str) else None
    if not found:
        return None
    pre = tuple((0, int(part), "") if part.isdigit() else (1, 0, part) for part in found[4].split(".")) if found[4] else ()
    return int(found[1]), int(found[2]), int(found[3]), not found[4], pre


def releases(url, channel="stable", pin=""):
    if pin and not version_key(pin):
        fail("pinned version is malformed")
    parsed = urllib.parse.urlsplit(url)
    if re.fullmatch(r"/repos/[^/]+/[^/]+/releases/?", parsed.path):
        base = urllib.parse.urlunsplit(parsed._replace(path=parsed.path.rstrip("/"), query="", fragment=""))
        versions = [pin] if pin else []
        if not pin:
            refs = fetch_json(base.removesuffix("/releases") + "/git/matching-refs/tags/v", 2_000_000)
            if not isinstance(refs, list):
                fail("release tags are malformed")
            for item in refs:
                tag = item.get("ref") if isinstance(item, dict) else None
                version = tag.removeprefix("refs/tags/v") if isinstance(tag, str) and tag.startswith("refs/tags/v") else None
                if version_key(version) and on_channel(channel, {"version": version, "prerelease": "-" in version}):
                    versions.append(version)
        listed = []
        for version in sorted(set(versions), key=version_key, reverse=True)[:5]:
            try:
                listed.append(fetch_json(base + "/tags/v" + urllib.parse.quote(version, safe=""), 2_000_000))
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
                error.close()
    else:
        listed = fetch_json(url, 2_000_000)
        if not isinstance(listed, list):
            fail("release list is malformed")
    found = []
    for item in listed:
        tag = item.get("tag_name") if isinstance(item, dict) else None
        version = tag[1:] if isinstance(tag, str) and tag.startswith("v") else None
        if not version_key(version) or item.get("draft"):
            continue
        assets = {asset.get("name"): asset for asset in item.get("assets") or [] if isinstance(asset, dict)}
        if RELEASE_MANIFEST in assets:
            found.append({"version": version, "prerelease": bool(item.get("prerelease")), "notes": text(item.get("body"), 1500),
                          "page": text(item.get("html_url"), 300), "assets": assets})
    return sorted(found, key=lambda item: version_key(item["version"]), reverse=True)


def on_channel(channel, item):
    is_nightly = "-nightly." in item["version"]
    return is_nightly if channel == "nightly" else not is_nightly and (channel == "prerelease" or not item.get("prerelease"))


def channel_newer(channel, version, installed):
    candidate, current = version_key(version), version_key(installed)
    if candidate[:3] != current[:3]:
        return candidate[:3] > current[:3]
    if (channel == "nightly" and "-nightly." not in installed
            or channel == "prerelease" and "-nightly." in installed):
        return version != installed
    return candidate > current


def signed(body, signature):
    if not RELEASE_KEY:
        return False
    with tempfile.TemporaryDirectory(prefix="omd-signature-") as temporary:
        signers, detached = Path(temporary) / "signers", Path(temporary) / "manifest.sig"
        signers.write_text(f'release namespaces="{SIGNING_NAMESPACE}" {RELEASE_KEY}\n')
        detached.write_bytes(signature)
        return subprocess.run(["/usr/bin/ssh-keygen", "-Y", "verify", "-f", signers, "-I", "release",
                               "-n", SIGNING_NAMESPACE, "-s", detached], input=body, capture_output=True).returncode == 0


def release_manifest(release):
    if RELEASE_SIGNATURE not in release["assets"]:
        fail(f"release {release['version']} is unsigned")
    body = fetch_bytes(str(release["assets"][RELEASE_MANIFEST].get("browser_download_url")), 65_536)
    signature = fetch_bytes(str(release["assets"][RELEASE_SIGNATURE].get("browser_download_url")), 4096)
    if not signed(body, signature):
        fail(f"release {release['version']} manifest signature does not verify against the Oh My Diff release key")
    try:
        record = json.loads(body)
    except ValueError:
        fail(f"release {release['version']} has a malformed {RELEASE_MANIFEST}")
    archive = release["assets"].get(record.get("archive")) if isinstance(record, dict) else None
    if (not archive or record.get("schema") != 1 or record.get("version") != release["version"]
            or not re.fullmatch(r"[0-9a-f]{64}", str(record.get("sha256")))
            or not all(isinstance(record.get(name), str) for name in ("target", "upstream_tag", "mod_api"))
            or not isinstance(record.get("artifacts"), dict)):
        fail(f"release {release['version']} has a malformed {RELEASE_MANIFEST}")
    if archive.get("digest") not in (None, f"sha256:{record['sha256']}"):
        fail(f"release {release['version']} archive digest disagrees with its manifest")
    return {key: record[key] for key in ("version", "target", "upstream_tag", "mod_api", "sha256")} | {
        "url": str(archive.get("browser_download_url")), "body": body.decode(), "signature": signature.decode()}


def release_source(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in RELEASE_HOSTS or (
            parsed.hostname == "api.github.com" and not re.fullmatch(r"/repos/[^/]+/[^/]+/releases/?", parsed.path)):
        fail("--releases-url must be the GitHub releases API or a loopback test server")
    return url


def minor_of(manifest):
    return manifest["upstream_tag"].removeprefix("rust-v").rsplit(".", 1)[0]


def installation(root, current):
    if not current:
        fail("No managed OMD installation is active.")
    record = json.loads((current / "prefix/install.json").read_text())
    return receipt(current), record, Path(record["store"])


def selected_settings(store):
    source = (store / "sources" / UPDATE_MOD).resolve()
    entries = json.loads((store / "mods.json").read_text()).get("mods", [])
    return source, next((item for item in entries if Path(item.get("path", "")).resolve() == source), {})


def policy(store):
    source, entry = selected_settings(store)
    schema = json.loads((source / "mod.json").read_text())["settings_schema"]["properties"]
    settings = {name: spec.get("default") for name, spec in schema.items()} | (entry.get("settings") or {})
    return settings if entry.get("enabled") else settings | {"checks": "off", "auto": "off"}


def set_policy(root, record, name, value):
    changed = []
    for store in sorted((root / "stores").iterdir()):
        if (store / "sources" / UPDATE_MOD).is_dir():
            source, entry = selected_settings(store)
            run([record["manager"]["installed_path"], "settings", store, source, json.dumps((entry.get("settings") or {}) | {name: value})])
            run([record["manager"]["installed_path"], "reload", store])
            changed.append(store.name)
    (update_dir(root) / "next").unlink(missing_ok=True)
    return {name: value, "profiles": changed}


def state(root):
    return read_json(root / "update/state.json", {})


def save(root, **changes):
    write_json(update_dir(root) / "state.json", state(root) | changes)


def blockers(args, current, manifest):
    reasons = [] if manifest["target"] == TARGET else [f"built for {manifest['target']}"]
    try:
        upstream_binary(args, current, minor_of(manifest))
    except (OSError, ValueError) as error:
        reasons.append(str(error))
    return reasons


def user_mods(record, store, mod_api):
    first_party = {(store / "sources" / name).resolve() for name in record["packages"]}
    listed = json.loads(run([record["manager"]["installed_path"], "selection-status", store]))["selections"]
    return sorted(item.get("id") or item["path"] for item in listed
                  if item.get("effective") and item.get("path") and Path(item["path"]).resolve() not in first_party
                  and read_json(Path(item["path"]) / "mod.json", {}).get("api") != mod_api)


def probe(args, root, current):
    details, record, store = installation(root, current)
    settings = policy(store)
    result = {"available": None, "blocked": None, "error": None}
    try:
        pin = str(settings.get("pin") or "").strip()
        listed = releases(release_source(details.get("releases_url") or RELEASES_URL), channel=settings["channel"], pin=pin)
        if pin and not any(item["version"] == pin for item in listed):
            result["error"] = f"pinned version {pin} is not published"
        candidates = ([item for item in listed if item["version"] == pin != record["version"]] if pin else
                      [item for item in listed if on_channel(settings["channel"], item)
                       and channel_newer(settings["channel"], item["version"], record["version"])])
        for item in candidates[:5]:
            try:
                manifest = release_manifest(item)
            except ValueError as error:
                result["error"] = result["error"] or text(str(error), 300)
                continue
            if reasons := blockers(args, current, manifest):
                result["blocked"] = result["blocked"] or {"version": item["version"], "reasons": reasons}
                continue
            result["available"] = {key: item[key] for key in ("version", "prerelease", "notes", "page")} | {
                "manifest": manifest, "user_mods": user_mods(record, store, manifest["mod_api"])}
            break
    except (OSError, ValueError) as error:
        return {"error": text(str(error), 300)}
    return result


def eligible(settings, available, installed):
    if not available or not version_key(available.get("version")):
        return False
    pin = str(settings.get("pin") or "").strip()
    return (available["version"] == pin != installed if pin else
            on_channel(settings["channel"], available)
            and channel_newer(settings["channel"], available["version"], installed))


def recorded_check(root, version, result, settings):
    if "available" not in result:
        saved = state(root)
        cached = saved.get("available")
        result = result | {"available": cached if eligible(settings, cached, version) else None, "blocked": saved.get("blocked")}
    save(root, schema=1, installed=version, checked_at=int(time.time()), command="omd update", **result)
    return state(root)


def check(args, root, current):
    _, record, store = installation(root, current)
    return recorded_check(root, record["version"], probe(args, root, current), policy(store))


def newer(known, version):
    return known if known and (version_key(known.get("version")) or ()) > version_key(version) else None


def settled(root, version, **changes):
    save(root, schema=1, command="omd update", installed=version, available=newer(state(root).get("available"), version),
         pending=None, **changes)


def flocked(path, waiting=None):
    lock = path.open("a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        if not waiting:
            lock.close()
            return None
        say(waiting)
        fcntl.flock(lock, fcntl.LOCK_EX)
    return lock


def staged(root, manifest):
    archive = update_dir(root) / "staged" / f"{manifest['sha256']}.tar.xz"
    return archive if archive.is_file() and digest(archive) == manifest["sha256"] else None


def stage(root, available):
    manifest = available["manifest"]
    if archive := staged(root, manifest):
        return archive
    folder = update_dir(root) / "staged"
    folder.mkdir(exist_ok=True)
    partial = folder / f"{manifest['sha256']}.part"
    partial.unlink(missing_ok=True)
    download(manifest["url"], manifest["sha256"], partial)
    archive = folder / f"{manifest['sha256']}.tar.xz"
    os.replace(partial, archive)
    return archive


def pend(root, available, automatic=False):
    write_json(update_dir(root) / "ready.json", {"version": available["version"], "automatic": automatic})
    save(root, pending={"version": available["version"]})


def apply(args, root, current, available):
    details, record, _ = installation(root, current)
    manifest = available["manifest"]
    try:
        if not (archive := staged(root, manifest)):
            with flocked(update_dir(root) / ".stage.lock", DOWNLOAD_WAIT):
                archive = stage(root, available)
        upstream = upstream_binary(args, current, minor_of(manifest))
        result = transaction(args, root, current, archive, manifest["url"], manifest["sha256"], details["profile"], upstream, manifest)
    except SessionsOpen:
        raise
    except BaseException as error:
        (root / "update/ready.json").unlink(missing_ok=True)
        save(root, pending=None, failed={"version": available["version"], "error": text(str(error), 300), "at": int(time.time())})
        raise
    archive.unlink(missing_ok=True)
    if lock := flocked(update_dir(root) / ".stage.lock"):
        with lock:
            shutil.rmtree(update_dir(root) / "staged", ignore_errors=True)
    (root / "update/ready.json").unlink(missing_ok=True)
    save(root, installed=result["version"], available=None, pending=None, failed=None,
         last={"from": record["version"], "to": result["version"], "at": int(time.time())})
    return result


def confirmed(args, available):
    if args.yes:
        return True
    try:
        with open("/dev/tty", "w") as output, open("/dev/tty") as terminal:
            output.write(f"These enabled mods do not support mod API {available['manifest']['mod_api']} and will stop loading: "
                         f"{', '.join(available['user_mods'])}\nUpdate to {available['version']} anyway? [y/N] ")
            output.flush()
            return terminal.readline().strip().lower() in ("y", "yes")
    except OSError:
        fail("Incompatible mods are enabled; pass --yes to update anyway.")


def deferred(root, available):
    with flocked(update_dir(root) / ".stage.lock", DOWNLOAD_WAIT):
        stage(root, available)
    pend(root, available)
    return {"staged": available["version"], "applies": "the next time OMD starts while no other OMD session is open"}


def manual(args, root, current):
    details, record, store = installation(root, current)
    action, value = args.action or "now", args.value
    if action in ("enable", "disable"):
        return set_policy(root, record, "auto", "on" if action == "enable" else "off")
    if action in POLICY:
        if value not in POLICY[action]:
            fail(f"omd update {action} takes {' or '.join(POLICY[action])}")
        return set_policy(root, record, action, value)
    if action == "pin":
        if value != "none" and not version_key(value):
            fail("omd update pin takes an exact version such as 0.2.0 or 0.2.0-rc.1, or none")
        return set_policy(root, record, "pin", "" if value == "none" else value)
    if action == "status":
        saved = state(root)
        available = saved.get("available")
        return {"installed": record["version"], "profile": details["profile"], "policy": policy(store),
                "open_sessions": len(sessions(root, None))} | {
            key: saved.get(key) for key in ("checked_at", "blocked", "error", "pending", "failed", "held", "last")} | {
            "available": available and available | {"manifest": {key: value for key, value in available["manifest"].items()
                                                                 if key not in ("body", "signature")}}}
    result = check(args, root, current)
    if action == "check":
        return result
    available = result["available"]
    if not available:
        return {"up_to_date": record["version"], "blocked": result["blocked"], "error": result["error"]}
    if available["user_mods"] and not confirmed(args, available):
        fail("Update cancelled; nothing changed.")
    if sessions(root, None):
        return deferred(root, available)
    try:
        return apply(args, root, current, available)
    except SessionsOpen:
        return deferred(root, available)


def committed(root, current, action):
    lock = flocked(root / ".install.lock")
    if not lock:
        return None
    with lock:
        return action() if pointer(root, "current") == current and not (root / "update/journal.json").exists() else None


def tick(args, root, current):
    lock = flocked(update_dir(root) / ".stage.lock")
    if not lock:
        return
    with lock:
        sessions(root, None)
        _, record, store = installation(root, current)
        settings = policy(store)
        result = probe(args, root, current) if settings["checks"] == "on" else None

        def checked():
            stamp(root / "update/next", time.time() + CADENCES.get(settings["cadence"], CADENCES["daily"]))
            return recorded_check(root, record["version"], result, policy(store)) if result else None
        saved = committed(root, current, checked)
        available = (saved or {}).get("available")
        if (settings["auto"] != "on" or not available or available["user_mods"]
                or available["version"] in ((saved.get("failed") or {}).get("version"), (saved.get("held") or {}).get("version"))):
            return
        try:
            stage(root, available)
        except (OSError, ValueError) as error:
            committed(root, current, lambda: save(root, failed={"version": available["version"], "error": text(str(error), 300),
                                                                "at": int(time.time())}))
            return
        committed(root, current, lambda: pend(root, available, automatic=True))


def mod_request(record, store):
    exported = subprocess.run([record["tools"]["omd"]["installed_path"], "store", "export", "--mod", UPDATE_MOD,
                               "--store", store, "--scope", "user"], capture_output=True, text=True)
    try:
        value = json.loads(exported.stdout)["entries"]["request"]["value"] if exported.returncode == 0 else None
    except (ValueError, KeyError, TypeError):
        return None
    return value if isinstance(value, dict) and isinstance(value.get("id"), str) else None


def launch(args, root, current):
    stamp(update_dir(root) / "seen", time.time())
    _, record, store = installation(root, current)
    saved = state(root)
    available = saved.get("available") or {}
    staged = read_json(root / "update/ready.json", {})
    ready = staged.get("version")
    request = mod_request(record, store)
    requested = None
    if request and request["id"] != saved.get("request_done"):
        save(root, request_done=request["id"])
        requested = request.get("version")
    automatic = staged.get("automatic", True) and requested != available.get("version")
    settings = policy(store)
    allowed = eligible(settings, available, record["version"])
    if allowed:
        allowed = (not blockers(args, current, available["manifest"])
                   and (not automatic or settings["auto"] == "on"
                        and available["version"] not in ((saved.get("failed") or {}).get("version"),
                                                          (saved.get("held") or {}).get("version"))
                        and not user_mods(record, store, available["manifest"]["mod_api"])))
    if not allowed or available["version"] not in (ready, requested):
        (root / "update/ready.json").unlink(missing_ok=True)
        save(root, pending=None)
        if requested:
            print(f"Oh My Diff {requested} was not installed because it is no longer the newest release for your settings; "
                  "open /update or run omd update.", file=sys.stderr)
        return
    ready = available["version"]
    if sessions(root, args.session):
        pend(root, available, automatic=automatic)
        print(f"Oh My Diff {ready} is ready and installs when OMD starts while no other session is open.", file=sys.stderr)
        return
    say(f"Updating Oh My Diff {record['version']} to {ready}…")
    try:
        apply(args, root, current, available)
    except SessionsOpen:
        pend(root, available, automatic=automatic)
        print("Another OMD session opened; the update waits for the next start.", file=sys.stderr)
        return
    except (OSError, ValueError, RuntimeError, tarfile.TarError) as error:
        print(f"Oh My Diff update failed; {record['version']} stays installed: {error}", file=sys.stderr)
        return
    print(f"Oh My Diff {ready} is installed.", file=sys.stderr)


def update_summary(status):
    rules = status["policy"]
    checks = f"{rules['cadence']} checks" if rules["checks"] == "on" else "update checks off"
    found = status["available"]
    latest = (f"{found['version']} is available: run omd update" if found else
              f"the last check failed: {status['error']}" if status["error"] else
              "up to date" if status["checked_at"] else "not checked yet")
    pinned = f", pinned to {rules['pin']}" if rules["pin"] else ""
    return (f"Oh My Diff {status['installed']} ({PROFILE_LABELS[status['profile']]}), {rules['channel']} channel, "
            f"{checks}{pinned}: {latest}")


def main():
    if sys.version_info < (3, 12):
        fail("Python 3.12 or newer is required for verified archive extraction")
    parser = argparse.ArgumentParser(
        prog="install.sh",
        description="Install, update and roll back Oh My Diff on Apple Silicon macOS",
        epilog="omd update [now|status|check|enable|disable|rollback], omd update checks on|off, "
               "omd update channel stable|prerelease|nightly, omd update cadence daily|weekly, omd update pin VERSION|none")
    parser.add_argument("command", nargs="?", choices=("install", "status", "rollback", "uninstall", "update", "tick", "launch"),
                        default="install")
    parser.add_argument("action", nargs="?", choices=("now", "status", "check", "enable", "disable", "rollback", "pin", *POLICY),
                        help="update action")
    parser.add_argument("value", nargs="?", help="value for checks, channel, cadence or pin")
    parser.add_argument("--profile", choices=PROFILE_LABELS, help="platform: OMD Core; full: OMD+")
    parser.add_argument("--asset-url")
    parser.add_argument("--asset-sha256")
    parser.add_argument("--releases-url", help="release list to check for updates (GitHub releases API format)")
    parser.add_argument("--channel", choices=POLICY["channel"], help="release channel for installation (saved policy or stable)")
    parser.add_argument("--yes", action="store_true", help="update even when enabled mods do not support the new mod API")
    parser.add_argument("--json", action="store_true", help="print the install result as JSON")
    parser.add_argument("--upstream", type=Path)
    parser.add_argument("--root", type=Path, default=Path.home() / ".local/share/oh-my-diff")
    parser.add_argument("--bin-dir", type=Path)
    parser.add_argument("--session", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.action and args.command != "update":
        parser.error("only update takes an action")
    args.root = args.root.expanduser().resolve()
    root = args.root
    journal = read_json(root / "update/journal.json", {}) if root.is_dir() else {}
    active = None if "uninstall" in journal or not root.is_dir() else pointer(root, "current")
    recorded = journal.get("bin_dir") if "uninstall" in journal else receipt(active).get("bin_dir") if active else None
    args.bin_dir = Path(args.bin_dir or recorded or Path.home() / ".local/bin").expanduser().resolve()
    if root == Path(root.anchor) or args.bin_dir == Path(args.bin_dir.anchor):
        fail("installation paths must not be filesystem roots")
    home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser().resolve()
    sqlite = Path(os.environ.get("CODEX_SQLITE_HOME", home)).expanduser().resolve()
    for shared in (home, sqlite):
        if (root == shared or root in shared.parents or shared in root.parents
                or args.bin_dir == shared or args.bin_dir in shared.parents or shared in args.bin_dir.parents):
            fail("installation paths must remain outside shared Codex state")
    if args.command == "tick":
        return tick(args, root, active)
    root.mkdir(parents=True, exist_ok=True)
    with flocked(root / ".install.lock", "Waiting for another Oh My Diff install or update to finish…"):
        finished = resume_uninstall(args, root)
        current = pointer(root, "current")
        recover(args, root, current)
        if args.command == "uninstall" and finished:
            print(json.dumps(finished, indent=2))
        elif args.command == "launch":
            if current:
                launch(args, root, current)
        elif args.command == "update" and args.action != "rollback":
            result = manual(args, root, current)
            print(json.dumps(result, indent=2))
            if args.action == "status":
                print(update_summary(result), file=sys.stderr)
        elif args.command == "install":
            install(args, root, current)
        elif args.command == "status":
            if not current:
                fail("No managed OMD installation is active.")
            upstream = Path(upstream_binary(args, current)["path"])
            print(json.dumps({"active": str(current), "previous": str(pointer(root, "previous")),
                              "profile": status(current, upstream, args.bin_dir)}, indent=2))
        elif args.command in ("rollback", "update"):
            rollback(args, root, args.bin_dir, current)
        else:
            uninstall(args, root, args.bin_dir, current)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, tarfile.TarError) as error:
        say(f"  {paint('✗', '31')} {error}")
        raise SystemExit(1) from error
PY
