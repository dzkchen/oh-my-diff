from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import acceptance_environment, pty_session
from scripts.pty_session import shows


class PtySessionTests(unittest.TestCase):
    def test_acceptance_environment_replaces_user_state_and_excludes_provider_credentials(self):
        inherited = {"HOME": "/user", "PATH": "/usr/bin", "KEEP": "yes", "CODEX_HOME": "/shared",
                     "CODEX_SQLITE_HOME": "/shared-db", "OMD_MOD_STORE": "/shared-mods",
                     "OPENAI_API_KEY": "secret", "ANTHROPIC_API_KEY": "secret", "AWS_PROFILE": "user"}
        environment = acceptance_environment.isolated_environment(
            Path("/fixture"), Path("/fixture/home"), Path("/upstream/bin/codex"), inherited)
        self.assertEqual(environment, {
            "HOME": "/fixture/home", "PATH": "/upstream/bin:/usr/bin", "KEEP": "yes",
            "CODEX_HOME": "/fixture/home", "CODEX_SQLITE_HOME": "/fixture/home", "TMPDIR": "/fixture",
            "XDG_CONFIG_HOME": "/fixture/xdg-config", "XDG_DATA_HOME": "/fixture/xdg-data",
            "XDG_CACHE_HOME": "/fixture/xdg-cache"})
        self.assertEqual(inherited["HOME"], "/user")

    def test_pty_environment_excludes_inherited_credentials_and_terminal_hosts(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            inherited = {"OPENAI_API_KEY": "secret", "GOOGLE_API_KEY": "secret", "TERM_PROGRAM": "host",
                         "LC_TERMINAL": "host", "TMUX": "host", "COLORTERM": "host", "KEEP": "yes",
                         "CODEX_HOME": "/user", "OMD_MOD_STORE": "/user"}
            with mock.patch.dict(pty_session.os.environ, inherited, clear=True), \
                    mock.patch.object(pty_session, "call", return_value=mock.Mock(stdout="/node/bin/node")):
                environment = pty_session.environment(base, "/binaries", base / "repo", base / "store", "http://fixture")
            self.assertEqual(environment["KEEP"], "yes")
            self.assertEqual(environment["CODEX_HOME"], str(base / "codex-home-main"))
            self.assertEqual(environment["OMD_MOD_STORE"], str(base / "store"))
            self.assertEqual(environment["TERM"], "xterm-256color")
            self.assertTrue((base / "codex-home-main/config.toml").is_file())
            for name in ("OPENAI_API_KEY", "GOOGLE_API_KEY", "TERM_PROGRAM", "LC_TERMINAL", "TMUX", "COLORTERM"):
                self.assertNotIn(name, environment)

    def test_phrases_match_whole_words_across_redraw_gaps(self):
        self.assertTrue(shows("omd · 3 mods on", "mods on"))
        self.assertTrue(shows("3 modson ·", "mods on"))
        self.assertFalse(shows("this mod only works", "mod on"))
        self.assertFalse(shows("a mod once", "mod on"))
        self.assertTrue(shows("ran /plan: done", "/plan:"))
        self.assertTrue(shows("x Rel oad y", "Reload"))
        self.assertFalse(shows("Reloaded", "Reload"))


if __name__ == "__main__":
    unittest.main()
