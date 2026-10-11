import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

with mock.patch.object(sys, "path", [str(Path(__file__).resolve().parents[1] / "scripts"), *sys.path]):
    from scripts import frame_rate_check


class FrameRateCheckTests(unittest.TestCase):
    def test_capture_includes_frozen_tail_and_partial_final_window(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            produced = [{"sequence": n + 1, "created_ns": n * 1e9 / 60,
                         "width": 10, "height": 10, "cpu_us": 1,
                         "generate_ms": 1, "encode_write_ms": 1} for n in range(1200)]
            samples = [{"sequence": min(n + 1, 600), "display_ns": n * 1e9 / 60,
                        "status": 0} for n in range(1231)]
            for name, rows in [("producer", produced), ("capture", samples)]:
                (base / f"{name}.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
            result = frame_rate_check.summarize(base)
            self.assertEqual(result["measured_seconds"], 17.5)
            self.assertEqual(result["shown_fps_windows"][-10:], [0] * 10)
            self.assertEqual(result["shown_fps_p50"], 0)
            (base / "capture.jsonl").write_text("".join(json.dumps(row) + "\n" for row in samples[:600])
                                               + json.dumps({"capture_end_ns": 20.5e9}) + "\n")
            result = frame_rate_check.summarize(base)
            self.assertEqual(result["measured_seconds"], 17.5)
            self.assertEqual(result["shown_fps_p50"], 0)
            (base / "capture.jsonl").write_text(json.dumps(samples[0]) + "\n"
                                               + json.dumps({"capture_end_ns": 20.5e9}) + "\n")
            result = frame_rate_check.summarize(base)
            self.assertEqual(result["shown_fps_p50"], 0)
            self.assertIsNone(result["latency_ms_p50"])
            self.assertIsNone(result["capture_interval_ms_p50"])

    def test_rejects_duration_that_can_wrap_marker_before_capture_ends(self):
        with mock.patch.object(sys, "argv", ["frame_rate_check", "--binaries", "/unused",
                                             "--terminal", "kitty", "--transport", "raw", "--seconds", "900"]), \
                mock.patch.object(frame_rate_check, "fresh", side_effect=AssertionError("unsafe duration accepted")) as fresh, \
                mock.patch("sys.stderr"):
            with self.assertRaises(SystemExit) as error:
                frame_rate_check.main()
            self.assertEqual(error.exception.code, 2)
            fresh.assert_not_called()

    def test_rejects_already_wrapped_producer_records(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "capture.jsonl").write_text('{"sequence": 1, "status": 0, "display_ns": 1}\n')
            (base / "producer.jsonl").write_text('{"sequence": 65537, "created_ns": 1}\n')
            with self.assertRaisesRegex(AssertionError, "16-bit"):
                frame_rate_check.summarize(base)
