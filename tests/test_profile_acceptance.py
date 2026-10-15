import unittest
from unittest.mock import patch
from pathlib import Path

from scripts.profile_acceptance import isolated_environment, expected_defaults
from scripts import profiles


class ProfileAcceptanceTests(unittest.TestCase):
    def test_expected_defaults_do_not_follow_installer_drift(self):
        expected = expected_defaults()
        with patch.object(profiles, "DEFAULT_ACTIVE", ()):
            self.assertEqual(expected_defaults(), expected)
            self.assertNotEqual(expected_defaults(), list(profiles.DEFAULT_ACTIVE))

    def test_environment_uses_scratch_state_without_provider_credentials(self):
        source = {"PATH": "/usr/bin", "OPENAI_API_KEY": "private", "ANTHROPIC_API_KEY": "private",
                  "OMD_MODE": "enabled", "OMD_MOD_STORE": "/tmp/ambient-mods",
                  "CODEX_HOME": "/tmp/ambient-home", "CODEX_SQLITE_HOME": "/tmp/ambient-sqlite",
                  "LANG": "en_US.UTF-8"}
        base = Path("/tmp/omd-acceptance")
        home = base / "home"
        env = isolated_environment(base, home, base / "upstream/codex", source)
        self.assertEqual(env["HOME"], str(home))
        self.assertEqual(env["CODEX_HOME"], str(home))
        self.assertEqual(env["CODEX_SQLITE_HOME"], str(home))
        self.assertEqual(env["TMPDIR"], str(base))
        self.assertEqual(env["PATH"], str(base / "upstream") + ":/usr/bin")
        self.assertEqual(env["LANG"], "en_US.UTF-8")
        for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OMD_MODE", "OMD_MOD_STORE"):
            self.assertNotIn(name, env)


if __name__ == "__main__":
    unittest.main()
