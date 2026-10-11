import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "requires macOS Swift")
class MouseLookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        source = Path(os.environ.get("MOUSE_LOOK_SOURCE", ROOT / "scripts/mouse_look.swift")).read_text()
        implementation = source.split("let look = MouseLook()", 1)[0]
        implementation = "\n".join(line for line in implementation.splitlines() if not line.startswith("import "))
        fixture = (ROOT / "tests/fixtures/mouse_look.swift").read_text()
        swift = Path(cls.directory.name) / "main.swift"
        swift.write_text(fixture.replace("// INSERT_MOUSE_LOOK", implementation))
        cls.binary = Path(cls.directory.name) / "mouse-look-test"
        result = subprocess.run(["swiftc", str(swift), "-o", str(cls.binary)], capture_output=True, timeout=60)
        if result.returncode:
            raise AssertionError(result.stderr.decode())

    def run_scenario(self, scenario):
        result = subprocess.run([str(self.binary), scenario], capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return [json.loads(line) for line in result.stdout.splitlines()]

    def test_failed_acquisition_has_no_spurious_release(self):
        self.assertEqual(self.run_scenario("monitor"), [{"error": "mouse_monitor"}])
        self.assertEqual(self.run_scenario("local_monitor"), [{"error": "mouse_monitor"}])
        self.assertEqual(self.run_scenario("association"), [{"error": "cursor_association", "status": 1}])

    def test_activation_waits_and_timeout_cleans_without_cursor_calls(self):
        self.assertEqual(self.run_scenario("activation"), [{"error": "activation"}])

    def test_failed_hide_restores_association_monitors_and_focus(self):
        self.assertEqual(self.run_scenario("hide"), [{"error": "cursor_hide", "status": 1}])

    def test_motion_is_batched_without_warp_and_timer_is_lock_scoped(self):
        self.assertEqual(self.run_scenario("movement"), [
            {"locked": True}, {"dx": 4, "dy": -0.5}, {"locked": False, "reason": "input"}])

    def test_safety_releases_discard_pending_motion(self):
        for reason in ("focus", "command", "command_click", "escape", "timeout"):
            with self.subTest(reason=reason):
                self.assertEqual(self.run_scenario(reason), [
                    {"locked": True}, {"locked": False, "reason": reason.removesuffix("_click")}])

    def test_dead_or_stalled_reader_releases_without_blocking_or_sigpipe(self):
        for scenario in ("closed", "full"):
            with self.subTest(scenario=scenario):
                self.assertEqual(self.run_scenario(scenario), [{"locked": True}])
