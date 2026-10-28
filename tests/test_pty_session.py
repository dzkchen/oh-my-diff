import unittest

from scripts.pty_session import shows


class PtySessionTests(unittest.TestCase):
    def test_phrases_match_whole_words_across_redraw_gaps(self):
        self.assertTrue(shows("omd · 3 mods on", "mods on"))
        self.assertTrue(shows("3 modson ·", "mods on"))
        self.assertFalse(shows("this mod only works", "mod on"))
        self.assertFalse(shows("a mod once", "mod on"))
        self.assertTrue(shows("ran /plan: done", "/plan:"))


if __name__ == "__main__":
    unittest.main()
