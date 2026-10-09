import unittest
from unittest.mock import patch

from scripts import lean_profiles, lean_terminal_acceptance as acceptance
from scripts.lean_terminal_live_recovery import FIXTURE_ERROR, fixture_failed


class TerminalAcceptanceTests(unittest.TestCase):
    def test_zero_first_party_disables_all_defaults_and_rejects_loaded_mods(self):
        for remaining in ([], [{"id": "omd_plan_removal", "error": None}]):
            with self.subTest(remaining=remaining), patch.object(acceptance, "call") as call:
                call.return_value = {"mods": remaining, "rejected": [], "reload_error": None}
                if remaining:
                    with self.assertRaises(AssertionError):
                        acceptance.disable_first_party(["package"], "manager", "store", {})
                else:
                    acceptance.disable_first_party(["package"], "manager", "store", {})
                self.assertEqual([args.args[0][-1] for args in call.call_args_list[:-1]],
                                 list(lean_profiles.DEFAULT_ACTIVE))

    def test_broken_fixture_requires_the_expected_package_and_error(self):
        for identifier, error, expected in (
            ("omd_usage", FIXTURE_ERROR, True),
            ("omd_usage", "1 failed: unrelated error", False),
            ("omd_logo", FIXTURE_ERROR, False),
            ("omd_usage", None, False),
        ):
            with self.subTest(identifier=identifier, error=error):
                self.assertEqual(fixture_failed({"mods": [{"id": identifier, "error": error}]}), expected)

    def test_blossom_detection_counts_only_nonblank_braille(self):
        self.assertFalse(acceptance.native_blossom_visible(["\u2800" * 40, "1 failed"]))
        self.assertFalse(acceptance.native_blossom_visible(["\u2801" * 39]))
        self.assertTrue(acceptance.native_blossom_visible(["\u2801" * 20, "\u28ff" * 20]))
