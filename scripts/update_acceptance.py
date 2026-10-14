#!/usr/bin/env python3
import argparse
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import signal
import ssl
import subprocess
import sys
import tarfile
import tempfile
from threading import Thread
import time

from scripts.install_support import digest


ROOT = Path(__file__).resolve().parents[1]
LOGO = "mods/first-party/omd_logo/index.ts"


def variant(archive, version, work):
    payload = work / "payload"
    with tarfile.open(archive, "r:xz") as packed:
        packed.extractall(work, filter="data")
    lock_script = payload / "scripts/lean_release_lock.py"
    lock_script.write_text(re.sub(r'VERSION = "[^"]+"', f'VERSION = "{version}"', lock_script.read_text(), count=1))
    with (payload / LOGO).open("a") as source:
        source.write(f"// {version}\n")
    for command in (["-m", "scripts.full_mods_lock", "--write"],
                    ["-m", "scripts.lean_release_lock", "--artifact-dir", "artifacts", "--write", "--package-mode"]):
        subprocess.run([sys.executable, *command], cwd=payload, check=True, capture_output=True)
    (payload / "package-manifest.json").unlink()
    files = {path.relative_to(payload).as_posix(): {"sha256": digest(path), "bytes": path.stat().st_size}
             for path in payload.rglob("*") if path.is_file() and "__pycache__" not in path.parts}
    (payload / "package-manifest.json").write_text(json.dumps({"schema": 1, "files": files}, indent=2, sort_keys=True) + "\n")
    output = work / f"oh-my-diff-{version}.tar.xz"
    with tarfile.open(output, "w:xz") as packed:
        for name in sorted([*files, "package-manifest.json"]):
            packed.add(payload / name, f"payload/{name}")
    return output


def manifest(archive, version, **changes):
    lock = json.loads(tarfile.open(archive, "r:xz").extractfile("payload/runtime/lean-release.lock.json").read())
    return {"schema": 1, "version": version, "target": lock["target"], "upstream_tag": lock["upstream_tag"], "mod_api": lock["mod_api"],
            "node": lock["node"], "archive": archive.name, "sha256": digest(archive), "bytes": archive.stat().st_size, **changes}


def run(archive, upstream, output, pty):
    with tempfile.TemporaryDirectory(prefix="omd-update-acceptance-", dir="/private/tmp") as temporary:
        base = Path(temporary).resolve()
        cert, key = base / "cert.pem", base / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert],
                       check=True, capture_output=True)
        newer = variant(archive, "0.1.0-alpha.2", base / "newer")
        assets = {newer.name: newer, archive.name: archive}
        releases, mode, hits = [], {"releases": "ok", "assets": "ok"}, {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits[self.path] = hits.get(self.path, 0) + 1
                if self.path == "/releases":
                    if mode["releases"] == "down":
                        return self.send_error(503)
                    body = b"{not json" if mode["releases"] == "malformed" else json.dumps(releases).encode()
                elif self.path.startswith("/assets/") and self.path.endswith(".json"):
                    body = json.dumps(next(item["manifest"] for item in releases if item["manifest_url"] == self.path)).encode()
                elif self.path.startswith("/assets/") and self.path[8:] in assets:
                    path = assets[self.path[8:]]
                    self.send_response(200)
                    self.send_header("Content-Length", str(path.stat().st_size))
                    self.end_headers()
                    if mode["assets"] == "truncated":
                        return self.wfile.write(b"interrupted transfer")
                    with path.open("rb") as source:
                        return shutil.copyfileobj(source, self.wfile)
                else:
                    return self.send_error(404)
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"https://localhost:{server.server_port}"

        def publish(version, archive_path, prerelease=False, **changes):
            record = manifest(archive_path, version, **changes)
            releases.insert(0, {"tag_name": f"v{version}", "draft": False, "prerelease": prerelease, "body": f"Notes for {version}",
                                "html_url": f"{url}/tag/{version}", "manifest_url": f"/assets/{version}.json", "manifest": record,
                                "assets": [{"name": "omd-release.json", "browser_download_url": f"{url}/assets/{version}.json"},
                                           {"name": archive_path.name, "browser_download_url": f"{url}/assets/{archive_path.name}",
                                            "digest": f"sha256:{record['sha256']}"}]})

        home = base / "codex-home"
        (home / "sessions").mkdir(parents=True)
        (home / "auth.json").write_text("preserve auth\n")
        root, bin_dir = base / "managed", base / "bin"
        node = Path(subprocess.check_output(["mise", "which", "node"], text=True).strip())
        env = {**os.environ, "CODEX_HOME": str(home), "CODEX_SQLITE_HOME": str(home), "SSL_CERT_FILE": str(cert),
               "PATH": f"{upstream.parent}{os.pathsep}{os.environ['PATH']}"}
        env.pop("OMD_PYTHON", None)
        fixed = ["--root", root, "--bin-dir", bin_dir, "--upstream", upstream, "--node", node]

        def installer(*arguments, ok=True):
            result = subprocess.run(["sh", ROOT / "install.sh", *map(str, arguments)], capture_output=True, text=True, env=env)
            assert (result.returncode == 0) == ok, result.stderr[-2000:]
            return json.loads(result.stdout) if ok and result.stdout.strip() else result.stderr

        def reinstall():
            return installer(*fixed, "--profile", "platform", "--asset-url", f"{url}/assets/{archive.name}", "--asset-sha256", digest(archive))

        def omd(*arguments, ok=True):
            result = subprocess.run([bin_dir / "omd", "update", *arguments], capture_output=True, text=True, env=env)
            assert (result.returncode == 0) == ok, result.stderr[-2000:]
            return json.loads(result.stdout) if ok else result.stderr

        def launch():
            result = subprocess.run([bin_dir / "codex", "--version"], capture_output=True, text=True, env=env)
            assert result.returncode == 0, result.stderr[-2000:]
            return result.stderr

        def installed():
            return json.loads((root / "current/receipt.json").read_text())["version"]

        def store_file(profile, name):
            return digest(root / "stores" / profile / "sources" / name)

        def manager():
            return root / "current/prefix/artifacts/omd-mod"

        def selected(profile, path):
            listed = json.loads(subprocess.check_output([manager(), "selection-status", root / "stores" / profile], text=True, env=env))
            return next(item for item in listed["selections"] if Path(item["path"]).resolve() == Path(path).resolve())

        def fake_session():
            codex = base / "fake/codex"
            codex.parent.mkdir(exist_ok=True)
            if not codex.exists():
                shutil.copyfile("/bin/sleep", codex)
                codex.chmod(0o755)
            process = subprocess.Popen([codex, "300"])
            (root / "sessions").mkdir(exist_ok=True)
            (root / "sessions" / str(process.pid)).touch()
            return process

        checks = []
        try:
            installer(*fixed, "--profile", "platform", "--asset-url", f"{url}/assets/{archive.name}",
                      "--asset-sha256", digest(archive), "--releases-url", f"{url}/releases")
            original = store_file("platform", "omd_logo/index.ts")
            assert json.loads((root / "update/state.json").read_text())["installed"] == "0.1.0-alpha.1"
            status = omd("status")
            assert status["installed"] == "0.1.0-alpha.1" and status["policy"]["checks"] == "on" and status["policy"]["auto"] == "off"
            checks.append("OMD Core install records version, release source and default policy")

            mode["releases"] = "down"
            assert "503" in omd("check")["error"] and installed() == "0.1.0-alpha.1"
            mode["releases"] = "malformed"
            assert "not JSON" in omd("check")["error"]
            mode["releases"] = "ok"
            assert omd("check")["available"] is None
            checks.append("offline and malformed release metadata leave the installation unchanged")

            publish("0.1.0-alpha.2", newer)
            publish("0.1.0-alpha.3", newer, upstream_tag="rust-v0.163.0")
            found = omd("check")
            assert found["available"]["version"] == "0.1.0-alpha.2" and found["blocked"]["version"] == "0.1.0-alpha.3"
            assert "0.163.x" in found["blocked"]["reasons"][0]
            (root / "update/next").unlink(missing_ok=True)
            checked = hits["/releases"]
            launch()
            for _ in range(300):
                if hits["/releases"] > checked:
                    break
                time.sleep(0.1)
            assert hits["/releases"] > checked
            with (root / "update/.stage.lock").open("a+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
            assert (root / "update/next").stat().st_mtime > time.time() + 80_000
            assert json.loads((root / "update/state.json").read_text())["available"]["version"] == "0.1.0-alpha.2"
            checks.append("background launch check finds the newest compatible release and reports the incompatible one")

            counter = base / "user-mods/counter"
            shutil.copytree(ROOT / "mods/examples/counter", counter)
            store = root / "stores/platform"
            package = json.loads(subprocess.check_output([manager(), "inspect", counter], text=True, env=env))
            subprocess.run([manager(), "trust-all", store, json.dumps([{"path": str(counter), "sha256": package["sha256"],
                                                                        "capabilities": ["tools", "commands", "store"]}])],
                           check=True, capture_output=True, env=env)
            subprocess.run([manager(), "enable", store, counter], check=True, capture_output=True, env=env)
            user_mod = {path.name: digest(path) for path in counter.iterdir()}
            assert omd("cadence", "weekly")["profiles"] == ["platform"]

            session = fake_session()
            staged = omd()
            assert staged["staged"] == "0.1.0-alpha.2" and installed() == "0.1.0-alpha.1"
            assert "installs when OMD starts" in launch() and installed() == "0.1.0-alpha.1"
            session.kill()
            session.wait()
            assert "is installed" in launch() and installed() == "0.1.0-alpha.2"
            assert store_file("platform", "omd_logo/index.ts") != original
            assert selected("platform", store / "sources/omd_logo")["selected"]
            assert selected("platform", counter)["effective"] and {path.name: digest(path) for path in counter.iterdir()} == user_mod
            assert omd("status")["policy"]["cadence"] == "weekly"
            assert json.loads((root / "update/state.json").read_text())["last"]["to"] == "0.1.0-alpha.2"
            checks.append("an update staged beside an open session installs at the next launch with no session open")
            checks.append("first-party store sources upgrade; user mods, enablement and update settings are preserved")

            restored = omd("rollback")
            assert restored["version"] == "0.1.0-alpha.1" and installed() == "0.1.0-alpha.1"
            assert store_file("platform", "omd_logo/index.ts") == original
            assert all(item["pinned_source_current"] for item in installer("status", *fixed)["profile"]["packages"])
            assert omd("enable")["auto"] == "on" and not (root / "update/next").exists()
            tick = ["sh", root / "current/prefix/management/install.sh", "tick", "--root", root]
            subprocess.run(tick, check=True, capture_output=True, env=env)
            held = omd("status")
            assert held["held"] == {"version": "0.1.0-alpha.2"} and held["available"]["version"] == "0.1.0-alpha.2"
            assert not (root / "update/ready.json").exists() and installed() == "0.1.0-alpha.1"
            checks.append("omd update rollback restores the previous version and its first-party sources; automatic updates skip it")

            if pty:
                from scripts import pty_session
                repo = base / "repo"
                repo.mkdir()
                pty_session.git(repo, "init", "-q")
                (base / "pty").mkdir()
                provider, provider_url = pty_session.provider()
                session_env = pty_session.environment(base / "pty", bin_dir, repo, store, provider_url, profile="platform")
                session_env["SSL_CERT_FILE"] = str(cert)
                assert omd("check")["available"]["version"] == "0.1.0-alpha.2"
                stamp = time.time() + 86_400
                os.utime(root / "update/next", (stamp, stamp))
                terminal = pty_session.Session(bin_dir / "codex", repo, session_env)
                try:
                    assert terminal.ready(90), terminal.text()[-1500:]
                    assert terminal.wait("is out; you have 0.1.0-alpha.1", 15), terminal.text()[-1500:]
                    assert terminal.command("/update", "Notes for 0.1.0-alpha.2", 30), terminal.text()[-1500:]
                    assert terminal.wait("omd update", 5) and terminal.wait("Skip this version", 5), terminal.text()[-1500:]
                    mark = terminal.keys(b"\r", settle=1.5)
                    assert terminal.wait("installs the next time OMD starts", 20, mark), terminal.text(mark)[-1500:]
                finally:
                    terminal.close(base / "pty-trace.bin")
                    provider.shutdown()
                assert "is installed" in launch() and installed() == "0.1.0-alpha.2"
                checks.append("PTY: the welcome notice and /update dialog render and Update now installs a held release at the next start")
            else:
                assert omd()["version"] == "0.1.0-alpha.2"
                checks.append("omd update installs a held release")
            assert reinstall()["version"] == "0.1.0-alpha.1"
            assert omd("status")["held"] is None and store_file("platform", "omd_logo/index.ts") == original

            mode["assets"] = "truncated"
            downloads = hits[f"/assets/{newer.name}"] + 1
            for _ in range(2):
                subprocess.run(tick, check=True, capture_output=True, env=env)
            saved = json.loads((root / "update/state.json").read_text())
            assert saved["failed"]["version"] == "0.1.0-alpha.2" and not (root / "update/ready.json").exists()
            assert hits[f"/assets/{newer.name}"] == downloads
            mode["assets"] = "ok"
            subprocess.run(tick, check=True, capture_output=True, env=env)
            assert hits[f"/assets/{newer.name}"] == downloads and installed() == "0.1.0-alpha.1"
            checks.append("a failed automatic download is recorded and not retried")

            interrupted = subprocess.Popen([bin_dir / "omd", "update"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           env=env, start_new_session=True)
            for _ in range(1200):
                if (root / "update/journal.json").exists() and any(root.glob("releases/*/prefix/sources")):
                    break
                time.sleep(0.05)
            os.killpg(interrupted.pid, signal.SIGKILL)
            interrupted.wait()
            assert (root / "update/journal.json").exists() and installed() == "0.1.0-alpha.1"
            (root / "stores/platform/sources/omd_logo/index.ts").write_text("// interrupted\n")
            omd("status")
            assert not (root / "update/journal.json").exists() and store_file("platform", "omd_logo/index.ts") == original
            assert all(item["pinned_source_current"] and not item["error"] for item in installer("status", *fixed)["profile"]["packages"])
            assert not [path for path in (root / "releases").iterdir() if not path.name.startswith("failed-")
                        and path.resolve() != (root / "current").resolve() and not (path / "receipt.json").is_file()]
            checks.append("an update killed mid-transaction is recovered by the next installer command")

            subprocess.run(tick, check=True, capture_output=True, env=env)
            assert installed() == "0.1.0-alpha.1"
            updated = omd()
            assert updated["version"] == "0.1.0-alpha.2" and json.loads((root / "update/state.json").read_text())["failed"] is None
            reinstall()
            (root / "update/next").unlink(missing_ok=True)
            subprocess.run(tick, check=True, capture_output=True, env=env)
            assert json.loads((root / "update/ready.json").read_text())["version"] == "0.1.0-alpha.2"
            assert "is installed" in launch() and installed() == "0.1.0-alpha.2"
            checks.append("manual update retries a failed release; automatic updates stage in the background and apply at launch")

            assert omd("pin", "0.1.0-alpha.2")["pin"] == "0.1.0-alpha.2"
            assert omd()["up_to_date"] == "0.1.0-alpha.2"
            omd("pin", "none")
            omd("disable")
            checks.append("an exact pin holds the installed version")

            installer(*fixed, "--profile", "full", "--asset-url", f"{url}/assets/{archive.name}", "--asset-sha256", digest(archive))
            full_logo = store_file("full", "omd_logo/index.ts")
            subprocess.run([bin_dir / "omd-package", "activate", "direct"], check=True, capture_output=True, env=env)
            routes = root / "stores/full/routes/profiles"
            routes.mkdir(parents=True)
            provider_record = {"id": "omd_profiles", "name": "OMD profiles", "env_key": "OMD_PROFILES_TOKEN",
                               "base_url": "http://127.0.0.1:9/v1", "token": str(routes / "local-token"),
                               "route": str(routes / "route.json"), "catalog": str(routes / "models.json")}
            record_path = root / "current/prefix/install.json"
            record = json.loads(record_path.read_text())
            record_path.write_text(json.dumps({**record, "providers": {"omd_profiles": provider_record}}, indent=2, sort_keys=True) + "\n")
            assert omd()["version"] == "0.1.0-alpha.2"
            profile = installer("status", *fixed)["profile"]
            assert profile["profile"] == "full" and profile["activation"] == "direct"
            assert json.loads((root / "current/prefix/install.json").read_text())["providers"] == {"omd_profiles": provider_record}
            subprocess.run([bin_dir / "omd-package", "activate", "full"], check=True, capture_output=True, env=env)
            assert "model_providers.omd_profiles.base_url" in (root / "current/bin/codex").read_text()
            assert store_file("full", "omd_logo/index.ts") != full_logo and all(not item["error"] for item in profile["packages"])
            checks.append("OMD+ updates keep the profile, activation choice and route setups")

            subprocess.run([manager(), "disable", store, counter], check=True, capture_output=True, env=env)
            assert installer("uninstall", *fixed)["uninstalled"] and (home / "auth.json").read_text() == "preserve auth\n"
            report = {"status": "pass", "archive_sha256": digest(archive), "newer_sha256": digest(newer), "checks": checks}
        finally:
            server.shutdown()
            thread.join()
            server.server_close()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Loopback acceptance of OMD update checks, automatic updates and recovery")
    parser.add_argument("--archive", type=Path, required=True, help="package built by lean_package pack from the current sources")
    parser.add_argument("--upstream", type=Path, required=True, help="upstream Codex executable of the pinned minor version")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pty", action="store_true", help="also drive the /update dialog in a PTY session with a mock provider")
    args = parser.parse_args()
    run(args.archive.resolve(), args.upstream.resolve(), args.output.resolve(), args.pty)


if __name__ == "__main__":
    main()
