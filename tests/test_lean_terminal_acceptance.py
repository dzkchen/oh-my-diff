import unittest
import itertools
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from scripts import lean_profiles, lean_terminal_acceptance as acceptance
from scripts.lean_terminal_live_recovery import FIXTURE_ERROR, fixture_failed


class TerminalAcceptanceTests(unittest.TestCase):
    def test_terminal_waits_through_incomplete_status_publication(self):
        screen = SimpleNamespace(display=["OpenAI Codex (vtest)"], columns=80, buffer={})
        pyte = SimpleNamespace(Screen=Mock(return_value=screen), ByteStream=Mock())
        clock = itertools.count(0, 0.1)
        with tempfile.TemporaryDirectory() as temporary:
            store = Path(temporary)
            (store / "mod-status.json").touch()
            status = json.dumps({"mods": [], "rejected": [], "reload_error": None})
            with patch.dict("sys.modules", pyte=pyte), \
                    patch.object(acceptance.pty, "openpty", return_value=(100, 101)), \
                    patch.object(acceptance.fcntl, "ioctl"), \
                    patch.object(acceptance.subprocess, "Popen"), \
                    patch.object(acceptance.os, "close"), \
                    patch.object(acceptance.select, "select", return_value=([], [], [])), \
                    patch.object(acceptance.time, "time_ns", return_value=0), \
                    patch.object(acceptance.time, "monotonic", side_effect=lambda: next(clock)), \
                    patch.object(Path, "read_text", side_effect=["{"] * 4 + [status]) as read:
                result = acceptance.terminal("fake", store, {"CODEX_HOME": temporary}, 80, "test",
                                             logo=False, check_first_paint=False, cache_store=store,
                                             zero_first_party=True)
            self.assertEqual(read.call_count, 5)
            self.assertIn("zero_first_party_publication", result["stages"])
            self.assertTrue(acceptance.zero_first_party_published(result["cache_events"]))

    def test_zero_first_party_waits_for_fresh_empty_status(self):
        events = []
        self.assertFalse(acceptance.zero_first_party_published(events))
        status = {"file": "mod-status.json", "modified_after_launch": False,
                  "mods": [], "rejected": [], "reload_error": None}
        events.append(status)
        self.assertFalse(acceptance.zero_first_party_published(events))
        events.append({**status, "modified_after_launch": True})
        self.assertTrue(acceptance.zero_first_party_published(events))
        for field, value in (("mods", [{"id": "unexpected"}]), ("rejected", ["bad"]),
                             ("reload_error", "failed")):
            events.append({**status, "modified_after_launch": True, field: value})
            self.assertFalse(acceptance.zero_first_party_published(events))

    def test_outside_author_requires_exactly_that_one_healthy_mod(self):
        status = {"file": "mod-status.json", "modified_after_launch": True,
                  "mods": [{"id": "outside_author", "error": None}], "rejected": [], "reload_error": None}
        self.assertTrue(acceptance.zero_first_party_published([status], ["outside_author"]))
        self.assertFalse(acceptance.zero_first_party_published([status]))
        for mods in ([], [{"id": "omd_logo", "error": None}],
                     [{"id": "outside_author", "error": None}, {"id": "omd_logo", "error": None}],
                     [{"id": "outside_author", "error": "failed"}]):
            self.assertFalse(acceptance.zero_first_party_published([{**status, "mods": mods}], ["outside_author"]))
        self.assertFalse(acceptance.zero_first_party_published(
            [{**status, "modified_after_launch": False}], ["outside_author"]))

    def test_recovery_uses_latest_observed_status(self):
        failed = {"file": "mod-status.json", "mods": [{"id": "omd_usage", "error": FIXTURE_ERROR}]}
        repaired = {"file": "mod-status.json", "mods": [{"id": "omd_usage", "error": None}]}
        self.assertEqual(acceptance.latest_status([]), {})
        self.assertTrue(fixture_failed(acceptance.latest_status([failed, {"file": "mod-view.json"}])))
        self.assertFalse(fixture_failed(acceptance.latest_status([failed, repaired])))

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
        self.assertTrue(acceptance.fixture_failed({"mods": [{"id": "omd_logo", "error": FIXTURE_ERROR}]}, "omd_logo"))

    def test_blossom_detection_counts_only_nonblank_braille(self):
        self.assertFalse(acceptance.native_blossom_visible(["\u2800" * 40, "1 failed"]))
        self.assertFalse(acceptance.native_blossom_visible(["\u2801" * 39]))
        self.assertTrue(acceptance.native_blossom_visible(["\u2801" * 20, "\u28ff" * 20]))
