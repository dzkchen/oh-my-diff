import base64
import json
import os
import posixpath
from pathlib import Path, PurePosixPath
import resource
import signal
import subprocess
import time

from .compare import require


SYSTEM_READS = ("/System", "/usr", "/bin", "/sbin", "/Library/Apple",
                "/private/preboot", "/private/var/db/dyld", "/private/var/db/timezone", "/dev")


def profile(reads, writes, port=None):
    require(os.uname().sysname == "Darwin", "native backend requires macOS seatbelt; no unsandboxed fallback")
    lines = ["(version 1)", "(deny default)", "(allow process-exec process-fork)",
             "(allow signal (target same-sandbox))", "(allow process-info* (target same-sandbox))",
             "(allow file-read-metadata file-test-existence)", "(allow file-map-executable)",
             "(allow sysctl-read)", "(allow system-mac-syscall)",
             '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
             '(allow file-read* (literal "/"))',
             '(allow file-write-data (literal "/dev/null") (subpath "/dev/fd"))']
    for path in list(SYSTEM_READS) + [str(Path(p).resolve()) for p in reads]:
        lines.append(f"(allow file-read* (subpath {json.dumps(path)}))")
    for path in writes:
        lines.append(f"(allow file-read* file-write* (subpath {json.dumps(str(Path(path).resolve()))}))")
    if port is not None:
        require(type(port) is int and 0 < port < 65536, "invalid gateway port")
        lines.append(f'(allow network-outbound (remote ip "localhost:{port}"))')
        lines.append('(allow network-bind (local ip "localhost:*"))')
    return "\n".join(lines) + "\n"


def restore(snapshot, destination, max_bytes):
    require(snapshot["format"] == "tree-v1" and isinstance(snapshot["files"], dict), "invalid tree snapshot")
    total = 0
    links = []
    for name, item in snapshot["files"].items():
        path = PurePosixPath(name)
        require(name and not path.is_absolute() and ".." not in path.parts and ".git" not in path.parts,
                "unsafe snapshot path")
        require(str(path) == name and "\\" not in name, "noncanonical snapshot path")
        require(not any(str(path).startswith(other + "/") for other, value in snapshot["files"].items() if "symlink" in value), "snapshot path below symlink")
        if "symlink" in item:
            target = item["symlink"]
            require(isinstance(target, str) and target and not PurePosixPath(target).is_absolute(), "unsafe symlink")
            resolved = posixpath.normpath(str(path.parent / target))
            require(resolved != ".." and not resolved.startswith("../"), "symlink escapes snapshot")
            require(resolved in snapshot["files"] and "symlink" not in snapshot["files"][resolved] or any(n.startswith(resolved + "/") for n in snapshot["files"]), "symlink target missing or chained")
            links.append((path, target))
            continue
        data = base64.b64decode(item["base64"], validate=True)
        total += len(data)
        require(total <= max_bytes, "snapshot size limit")
        require(item["mode"] in (0o644, 0o755), "unsafe file mode")
        target = Path(destination) / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as stream:
            stream.write(data)
        target.chmod(item["mode"])
    for path, link in links:
        target = Path(destination) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(link)


def snapshot(root, max_bytes, excluded_roots=()):
    files, total = {}, 0
    for parent, directories, names in os.walk(root, followlinks=False):
        directories[:] = sorted(d for d in directories if d != ".git" and not (Path(parent) == Path(root) and d in excluded_roots))
        for name in list(directories) + names:
            path = Path(parent) / name
            if path.is_symlink():
                target = os.readlink(path)
                require(not Path(target).is_absolute() and path.resolve().is_relative_to(Path(root).resolve()) and path.exists(), "candidate symlink rejected")
                relative = str(path.relative_to(root))
                files[relative] = {"symlink": target}
                if name in directories:
                    directories.remove(name)
        for name in sorted(names):
            if (Path(parent) / name).is_symlink():
                continue
            path = Path(parent) / name
            require(path.is_file(), "candidate special file rejected")
            require(path.stat().st_nlink == 1, "candidate hardlink rejected")
            total += path.stat().st_size
            require(total <= max_bytes, "candidate size limit")
            files[str(path.relative_to(root))] = {"base64": base64.b64encode(path.read_bytes()).decode(),
                                                 "mode": 0o755 if path.stat().st_mode & 0o111 else 0o644}
    return {"format": "tree-v1", "files": files}


def process_table():
    result = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,rss="], capture_output=True, text=True, timeout=3)
    require(result.returncode == 0, "process census unavailable")
    return {int(pid): (int(parent), int(rss)) for pid, parent, rss in
            (line.split() for line in result.stdout.splitlines() if line.strip())}


def launch(argv, cwd, env, sandbox, output, limits, port=None, reads=(), seconds=None, native_permissions=None):
    output.mkdir(parents=True, exist_ok=True)
    if native_permissions is None:
        sb = output / "sandbox.sb"
        sb.write_text(profile(reads, sandbox, port))
        command = ["/usr/bin/sandbox-exec", "-f", str(sb), *map(str, argv)]
    else:
        require(native_permissions.get("default_permissions") == "experiment", "native permission profile required")
        require(native_permissions.get("permissions.experiment.network.enabled") is False, "native tool networking must be disabled")
        sb = output / "native-permissions.json"
        sb.write_text(json.dumps(native_permissions, indent=2))
        command = list(map(str, argv))
    started = time.monotonic()
    timeout = min(limits["process_seconds"], seconds if seconds is not None else limits["process_seconds"])
    require(timeout > 0, "no runtime remaining")

    def constrain():
        resource.setrlimit(resource.RLIMIT_CPU, (limits["cpu_seconds"], limits["cpu_seconds"]))
        resource.setrlimit(resource.RLIMIT_FSIZE, (limits["file_bytes"], limits["file_bytes"]))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))

    tracked, peak_rss, reason = set(), 0, None
    with (output / "stdout").open("wb") as stdout, (output / "stderr").open("wb") as stderr:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                   start_new_session=True, preexec_fn=constrain)
        tracked.add(process.pid)
        try:
            while True:
                table = process_table()
                changed = True
                while changed:
                    added = {pid for pid, (parent, _) in table.items() if parent in tracked} - tracked
                    tracked.update(added)
                    changed = bool(added)
                rss = sum(table.get(pid, (0, 0))[1] for pid in tracked)
                peak_rss = max(peak_rss, rss)
                if time.monotonic() - started > timeout:
                    reason = "wall_limit"
                if rss * 1024 > limits["rss_bytes"]:
                    reason = "sampled_tree_rss_limit"
                if len(tracked & table.keys()) > limits["processes"]:
                    reason = "sampled_tree_process_limit"
                if reason or process.poll() is not None:
                    break
                time.sleep(0.05)
        except BaseException:
            reason = "interrupted"
            raise
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass

            table = process_table()
            for _ in range(len(table) + 1):
                added = {pid for pid, (parent, _) in table.items() if parent in tracked} - tracked
                if not added:
                    break
                tracked.update(added)
            for pid in reversed(sorted(tracked)):
                if pid in table:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            process.wait(timeout=3)
    return {"command": command, "exit_code": process.returncode, "stop_reason": reason,
            "wall_seconds": time.monotonic() - started, "peak_tree_rss_bytes_sampled": peak_rss * 1024,
            "observed_pids": sorted(tracked), "sandbox": sb.read_text()}
