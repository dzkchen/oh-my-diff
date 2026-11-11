import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("omd_dev_build", ROOT / ".github/scripts/build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class DeveloperBuildTests(unittest.TestCase):
    def test_compiler_probe_uses_the_scratch_toolchain(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                build, "run", return_value=b"host: aarch64-apple-darwin\n") as run:
            environment = build.cargo_env(Path("/scratch"))
        self.assertEqual(run.call_args.kwargs["cwd"], Path("/scratch/codex/codex-rs"))
        self.assertIn("aarch64-apple-darwin", environment["RUSTY_V8_ARCHIVE"])

    def test_setup_reuses_verified_downloads_and_preserves_native_edits(self):
        with tempfile.TemporaryDirectory() as temporary:
            work, cache = Path(temporary) / "work", Path(temporary) / "cache"
            tree = work / "codex"
            (tree / "codex-rs").mkdir(parents=True)
            (tree / "codex-rs/Cargo.lock").write_text('[[package]]\nname = "v8"\nversion = "1.2.3"\n')
            edited = tree / "codex-rs/edited.rs"
            edited.write_text("local edits")
            target = "aarch64-apple-darwin"
            names = [f"librusty_v8_ptrcomp_sandbox_release_{target}.a.gz",
                     f"src_binding_ptrcomp_sandbox_release_{target}.rs"]
            cache.mkdir()
            for name in names:
                (cache / name).write_bytes(name.encode())
            manifest = cache / f"rusty_v8_ptrcomp_sandbox_release_{target}.sha256"
            manifest.write_text("".join(f"{build.sha((cache / name).read_bytes())}  {name}\n" for name in names))
            pinned = tree / "third_party/v8/rusty_v8_1_2_3_release_manifests.sha256"
            pinned.parent.mkdir(parents=True)
            pinned.write_text(f"{build.sha(manifest.read_bytes())}  {manifest.name}\n")
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(build, "work_dir", return_value=work), \
                    mock.patch.object(build, "V8", cache), mock.patch.object(
                        build, "run", return_value=f"host: {target}\n".encode()), mock.patch.object(
                        build.urllib.request, "urlopen", side_effect=AssertionError("downloaded cached V8")), \
                    contextlib.redirect_stdout(io.StringIO()):
                build.dev_setup(argparse.Namespace(name="reuse"))
                build.dev_setup(argparse.Namespace(name="reuse"))
            self.assertEqual(edited.read_text(), "local edits")
            self.assertEqual((tree / "mods").resolve(), ROOT / "mods")

    @unittest.skipUnless(shutil.which("cargo") and shutil.which("rustc"), "requires a local Rust toolchain")
    def test_mod_build_avoids_app_and_unused_binary_targets(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            workspace = work / "codex/codex-rs"
            workspace.mkdir(parents=True)
            packages = {"codex-omd-extension": "omd-mod", "codex-omd-runner": "omd-runner", "codex-cli": "codex"}
            (workspace / "Cargo.toml").write_text('[workspace]\nresolver = "2"\nmembers = ["*"]\n')
            for package, binary in packages.items():
                directory = workspace / package
                (directory / "src/bin").mkdir(parents=True)
                (directory / "Cargo.toml").write_text(f'[package]\nname = "{package}"\nversion = "0.1.0"\n')
                (directory / f"src/bin/{binary}.rs").write_text(
                    'compile_error!("app must not compile");' if package == "codex-cli" else 'fn main() { println!("ready"); }')
                (directory / "src/bin/unused.rs").write_text('compile_error!("unused binary must not compile");')
            environment = {key: value for key, value in os.environ.items()
                           if not key.startswith(("CARGO_", "RUSTC", "RUSTDOC", "RUSTFLAGS", "OMD_", "SCCACHE_"))}
            environment["CARGO_HOME"] = str(work / "cargo-home")
            subprocess.run(["cargo", "generate-lockfile", "--offline"], cwd=workspace, env=environment,
                           check=True, capture_output=True)
            output = io.StringIO()
            with mock.patch.dict(os.environ, environment, clear=True), mock.patch.object(build, "work_dir", return_value=work), \
                    contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as status:
                build.dev_mods(argparse.Namespace(name="mods"))
            self.assertEqual(status.exception.code, 0)
            for binary in ("omd-mod", "omd-runner"):
                result = subprocess.run([work / "target/debug" / binary], capture_output=True, text=True, check=True)
                self.assertEqual(result.stdout.strip(), "ready")
            self.assertFalse((work / "target/debug/codex").exists())
            self.assertIn("Finished", output.getvalue())
            self.assertIn("Timing report", output.getvalue())
            self.assertIn("exit=0 elapsed_s=", output.getvalue())
            self.assertTrue((work / "target/cargo-timings/cargo-timing.html").is_file())

    def test_refresh_replaces_an_unedited_trees_patch_in_place_and_keeps_native_edits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, work = Path(temporary) / "root", Path(temporary) / "work"
            tree = work / "codex"
            (tree / "codex-rs").mkdir(parents=True)
            (root / "scripts").mkdir(parents=True)
            (root / "runtime/patches").mkdir(parents=True)
            (tree / "codex-rs/kept.rs").write_text("upstream")
            (tree / "codex-rs/changed.rs").write_text("upstream")
            git = lambda *args: subprocess.run(["git", "-c", "user.name=omd", "-c", "user.email=omd@example.invalid", *args],
                                               cwd=tree, check=True, capture_output=True, text=True).stdout.strip()
            for args in (["init", "-q"], ["add", "."], ["commit", "-qm", "pin"], ["tag", "base"]):
                git(*args)
            (root / "scripts/normalize_upstream_lock.py").write_text("")
            apply = root / "scripts/apply_runtime_patch.py"

            def patch(files):
                apply.write_text("import json, sys\nfrom pathlib import Path\n"
                                 f"for name, text in json.loads({json.dumps(json.dumps(files))}).items():\n"
                                 "    Path(sys.argv[1], name).write_text(text)\n")
                (root / "runtime/patches/manifest.json").write_text(json.dumps({"files": {
                    name: {"after": build.sha(text.encode())} for name, text in files.items()}}))

            first = {"codex-rs/kept.rs": "patched", "codex-rs/changed.rs": "first", "codex-rs/dropped.rs": "first"}
            for name, text in first.items():
                (tree / name).write_text(text)
            patch(first)
            with mock.patch.object(build, "ROOT", root), mock.patch.object(build, "base_tag", return_value="base"), \
                    mock.patch.object(build, "pin", return_value={"commit": git("rev-parse", "HEAD")}):
                self.assertEqual(build.refresh(work), "current")
                kept = (tree / "codex-rs/kept.rs").stat().st_mtime_ns
                patch({"codex-rs/kept.rs": "patched", "codex-rs/changed.rs": "second", "codex-rs/added.rs": "second"})
                self.assertEqual(build.refresh(work), "refreshed")
                self.assertEqual((tree / "codex-rs/changed.rs").read_text(), "second")
                self.assertEqual((tree / "codex-rs/added.rs").read_text(), "second")
                self.assertFalse((tree / "codex-rs/dropped.rs").exists())
                self.assertEqual((tree / "codex-rs/kept.rs").stat().st_mtime_ns, kept)
                (tree / "codex-rs/changed.rs").write_text("native edit")
                patch({"codex-rs/kept.rs": "patched", "codex-rs/changed.rs": "third"})
                self.assertEqual(build.refresh(work), "edited")
                self.assertEqual((tree / "codex-rs/changed.rs").read_text(), "native edit")

    def test_failed_build_reports_elapsed_time_and_keeps_diagnostics(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(build, "cargo_env", return_value={}):
            work = Path(temporary)
            output = io.StringIO()
            def failure(*args, **kwargs):
                kwargs["stdout"].write("error: compilation failed\n")
                return subprocess.CompletedProcess(args, 9)
            with mock.patch.object(build.subprocess, "run", side_effect=failure), contextlib.redirect_stdout(output):
                self.assertEqual(build.cargo_run(work, work / "failed.log", ["check"]), 9)
            self.assertIn("error: compilation failed", output.getvalue())
            self.assertIn("exit=9 elapsed_s=", (work / "failed.log").read_text())


if __name__ == "__main__":
    unittest.main()
