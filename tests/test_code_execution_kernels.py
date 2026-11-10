import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest


PLUGIN = Path(__file__).resolve().parents[1] / "plugins/experimental/oh-my-diff-experimental/plugins/omd-code-execution"
DIGESTS = {name: hashlib.sha256((PLUGIN / "kernels" / name).read_bytes()).hexdigest() for name in ("python.py", "bun.mjs")}


class KernelInstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.config = self.home / "config.toml"

    def tearDown(self):
        self.temporary.cleanup()

    def run_script(self, *args, check=True):
        return subprocess.run([sys.executable, str(PLUGIN / "scripts/install_kernels.py"), *args], env={**os.environ, "CODEX_HOME": str(self.home)},
                              capture_output=True, text=True, check=check)

    def copy(self, file):
        return self.home / f"omd/kernels/{DIGESTS[file][:12]}-{file}"

    def entries(self):
        return {entry["name"]: entry for entry in tomllib.loads(self.config.read_text())["features"]["code_mode"]["kernels"]}

    def test_the_copy_lives_at_a_stable_path_and_current_entries_are_recognised(self):
        first = self.run_script().stdout
        self.assertIn(f'driver = "{self.copy("python.py")}"\ndriver_sha256 = "{DIGESTS["python.py"]}"', first)
        self.assertFalse(self.config.exists())
        self.run_script("--write")
        again = self.run_script().stdout
        self.assertEqual(again.count("config is current"), 2)

    def test_write_creates_a_fresh_config_and_a_second_run_changes_nothing(self):
        self.run_script("--write")
        parsed = tomllib.loads(self.config.read_text())
        self.assertEqual([parsed["features"]["code_mode"]["enabled"], parsed["features"]["code_mode_host"]],
                         [True, {"enabled": True, "disable_in_process_fallback": True}])
        self.assertEqual({name: entry["driver_sha256"] for name, entry in self.entries().items()},
                         {"python": DIGESTS["python.py"], "bun": DIGESTS["bun.mjs"]})
        text = self.config.read_text()
        second = self.run_script("--write").stdout
        self.assertEqual([self.config.read_text(), second.count("config is current")], [text, 2])
        self.assertFalse(self.config.with_name("config.toml.bak").exists())

    def test_write_replaces_stale_entries_and_keeps_everything_else(self):
        stale = (
            '# my settings\nmodel = "gpt"\n\n[features.code_mode]\nenabled = true\n\n# python\n'
            '[[features.code_mode.kernels]]\nname = "python"\ncommand = ["python3"]\ndriver = "/gone/python.py"\ndriver_sha256 = "' + "0" * 64 + '"\n\n'
            '[[features.code_mode.kernels]]\nname = "ruby"\ncommand = ["ruby"]\ndriver = "/x/r.rb"\ndriver_sha256 = "' + "1" * 64 + '"\n\n'
            '# tail comment\n[features.code_mode_host]\nenabled = false\n\n[tui]\ntheme = "dark"\n')
        self.config.write_text(stale)
        self.run_script("--write")
        text = self.config.read_text()
        for kept in ('# my settings\nmodel = "gpt"\n', "# python\n", 'name = "ruby"', "# tail comment\n[features.code_mode_host]\nenabled = false\n", '[tui]\ntheme = "dark"\n'):
            self.assertIn(kept, text)
        self.assertNotIn("/gone/python.py", text)
        self.assertEqual(self.entries()["python"]["driver"], str(self.copy("python.py")))
        self.assertEqual(self.entries()["bun"]["driver"], str(self.copy("bun.mjs")))
        self.assertEqual(self.entries()["ruby"]["driver"], "/x/r.rb")
        self.assertEqual(self.config.with_name("config.toml.bak").read_text(), stale)

    def test_write_refuses_an_unparsable_config_and_restores_one_it_cannot_extend(self):
        self.config.write_text("[features\nbroken")
        failed = self.run_script("--write", check=False)
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(self.config.read_text(), "[features\nbroken")
        conflicting = "[features]\ncode_mode = true\n"
        self.config.write_text(conflicting)
        failed = self.run_script("--write", check=False)
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(self.config.read_text(), conflicting)


if __name__ == "__main__":
    unittest.main()
