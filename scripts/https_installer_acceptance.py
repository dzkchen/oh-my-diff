#!/usr/bin/env python3
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import tomllib
from threading import Thread


ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(archive, upstream, output):
    with tempfile.TemporaryDirectory(prefix="omd-https-acceptance-") as temporary:
        base = Path(temporary)
        cert = base / "cert.pem"
        key = base / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-days", "1", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
                        "-keyout", key, "-out", cert], check=True, capture_output=True)

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/truncated":
                    self.send_response(200)
                    self.send_header("Content-Length", str(archive.stat().st_size))
                    self.end_headers()
                    self.wfile.write(b"interrupted transfer")
                    return
                path = {"/install.sh": ROOT / "install.sh", "/package.tar.xz": archive}.get(self.path)
                if path is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(path.stat().st_size))
                self.end_headers()
                with path.open("rb") as source:
                    shutil.copyfileobj(source, self.wfile)

            def log_message(self, format, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"https://localhost:{server.server_port}"
        home = base / "codex-home"
        home.mkdir()
        sentinels = (home / "auth.json", home / "config.toml", home / "sessions/example.jsonl")
        for path in sentinels:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('model = "preserve-user-choice"\n' if path.name == "config.toml"
                            else f"preserve {path.name}\n")
        initial = {str(path): digest(path) for path in sentinels}
        install_root = base / "managed"
        bin_dir = base / "bin"
        node = Path(subprocess.check_output(["mise", "which", "node"], text=True).strip())
        env = os.environ.copy()
        env.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home), SSL_CERT_FILE=str(cert),
                   PATH=f"{upstream.parent}{os.pathsep}{env['PATH']}")
        fixed = ["--root", str(install_root), "--bin-dir", str(bin_dir),
                 "--upstream", str(upstream), "--node", str(node)]
        asset = ["--asset-url", f"{url}/package.tar.xz", "--asset-sha256", digest(archive)]

        def command(*arguments, ok=True, detached=False):
            curl = subprocess.Popen(["curl", "--proto", "=https", "--tlsv1.2", "-fsSL",
                                     "--cacert", str(cert), f"{url}/install.sh"], stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, env=env)
            try:
                result = subprocess.run(["sh", "-s", "--", *map(str, arguments)], stdin=curl.stdout,
                                        capture_output=True, text=True, env=env,
                                        start_new_session=detached)
            finally:
                curl.stdout.close()
            curl_error = curl.communicate()[1].decode()
            assert curl.returncode == 0, curl_error
            assert (result.returncode == 0) == ok, result.stderr[-1500:]
            return json.loads(result.stdout) if ok else result.stderr

        try:
            no_choice = command(*fixed, *asset, ok=False, detached=True)
            assert "Choose --profile platform or --profile full" in no_choice
            bad_hash = command(*fixed, "--profile", "platform", *asset[:-1], "0" * 64, ok=False)
            assert "SHA-256 mismatch" in bad_hash and not (install_root / "current").exists()
            platform = command(*fixed, "--profile", "platform", *asset)
            assert platform["installed"] == "platform"
            first = command("status", *fixed)
            assert first["profile"]["profile"] == "platform"
            assert first["profile"]["installed_tools"] == ["omd", "omd-contract", "omd-mod"]
            assert [item["id"] for item in first["profile"]["packages"] if item["installed"]] == ["omd_logo", "omd_mods", "omd_update"]
            assert (bin_dir / "codex").is_symlink()
            version = json.loads((ROOT / "upstream.lock.json").read_text())["tag"].removeprefix("rust-v")
            assert subprocess.check_output([bin_dir / "codex", "--version"], env=env, text=True).strip() == f"codex-cli {version}"
            unavailable = command(*fixed, "--profile", "full", "--asset-url", f"{url}/missing",
                                  "--asset-sha256", digest(archive), ok=False)
            assert "404" in unavailable
            assert command("status", *fixed)["profile"]["profile"] == "platform"
            interrupted = command(*fixed, "--profile", "full", "--asset-url", f"{url}/truncated",
                                  "--asset-sha256", digest(archive), ok=False)
            assert "SHA-256 mismatch" in interrupted
            assert command("status", *fixed)["profile"]["profile"] == "platform"
            full = command(*fixed, "--profile", "full", *asset)
            assert full["installed"] == "full"
            full_status = command("status", *fixed)["profile"]
            assert full_status["profile"] == "full"
            assert {item["id"] for item in full_status["packages"] if item["loaded_by_profile"]} == {"omd_inspector", "omd_logo", "omd_model_picker", "omd_mods", "omd_update", "omd_workspace"}
            assert not full_status["plugin_bundle"]["installed_by_candidate"]
            assert len(full_status["plugin_bundle"]["plugins"]) == 10
            registered = json.loads(subprocess.check_output([bin_dir / "omd-package", "plugins"], env=env, text=True))
            assert registered["source"] == str(install_root.resolve() / "current/prefix/bundles/oh-my-diff")
            registered_generation = Path(registered["source"]).resolve()
            previous_link = install_root / "previous"
            previous_link.unlink()
            previous_link.symlink_to((install_root / "current").resolve())
            prior = command("rollback", *fixed)
            assert prior["profile"] == "platform"
            assert command("status", *fixed)["profile"]["profile"] == "platform"
            again = command("rollback", *fixed)
            assert again["profile"] == "full"
            assert command("status", *fixed)["profile"]["profile"] == "full"
            subprocess.run([bin_dir / "omd-package", "mod", "disable", "omd_workspace"],
                           check=True, capture_output=True, env=env)
            command(*fixed, "--profile", "full", *asset)
            repeated = command("status", *fixed)["profile"]
            assert Path(registered["source"]).resolve() != registered_generation
            available = subprocess.check_output([bin_dir / "codex", "plugin", "list"], env=env, text=True)
            assert all(f"{name}@oh-my-diff" in available for name in registered["plugins"])
            assert not next(item for item in repeated["packages"] if item["id"] == "omd_workspace")["enabled_in_store"]
            restored = command("rollback", *fixed)
            assert restored["profile"] == "full"
            assert command("status", *fixed)["profile"]["profile"] == "full"
            subprocess.run([bin_dir / "codex", "plugin", "marketplace", "remove", "oh-my-diff"],
                           check=True, capture_output=True, env=env)
            removed = command("uninstall", *fixed)
            assert removed["uninstalled"] and (install_root / "stores/platform").is_dir()
            assert (install_root / "stores/full").is_dir()
            assert not (bin_dir / "codex").exists() and not (bin_dir / "codex").is_symlink()
            assert shutil.which("codex", path=env["PATH"]) == str(upstream)
            config = tomllib.loads((home / "config.toml").read_text())
            assert config["model"] == "preserve-user-choice" and not config.get("marketplaces")
            assert {name: value for name, value in initial.items() if not name.endswith("config.toml")} == {
                str(path): digest(path) for path in sentinels if path.name != "config.toml"}
            report = {"status": "pass", "archive_sha256": digest(archive),
                      "checks": ["HTTPS curl pipe", "no-TTY choice", "bad hash", "OMD Core",
                                 "failed and interrupted download", "OMD+", "interrupted pointer recovery",
                                 "profile switch rollback",
                                 "reinstall with selection retention", "rollback",
                                 "plugin marketplace survives updates",
                                 "uninstall with upstream restoration", "shared state"]}
        finally:
            server.shutdown()
            thread.join()
            server.server_close()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run(args.archive.resolve(), args.upstream.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
