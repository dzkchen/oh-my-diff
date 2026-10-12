import os
import pty
import socket
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from terminal_capture import Capture


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.master, self.slave = pty.openpty()
        self.capture = Capture(self.master)
        self.writer = None

    def tearDown(self):
        if self.writer and self.writer.poll() is None:
            self.writer.kill()
            self.writer.wait()
        if self.capture:
            self.capture.close()
        os.close(self.master)
        if self.slave is not None:
            os.close(self.slave)

    def write(self, size):
        self.writer = subprocess.Popen(
            [sys.executable, "-c", f"import os; data=b'x'*{size}; n=0\nwhile n<len(data): n+=os.write(1,data[n:])"],
            stdin=subprocess.DEVNULL, stdout=self.slave, stderr=subprocess.DEVNULL,
        )

    def test_slow_observer_does_not_block_output_and_receipts_stay_ordered(self):
        size = 1024 * 1024
        self.write(size)
        # The producer must finish before this process consumes any output.
        self.writer.wait(timeout=5)
        producer_finished = time.perf_counter_ns()
        received = bytearray()
        previous = 0
        first = None
        while len(received) < size:
            kind, timestamp, data = self.capture.read(5)
            self.assertEqual(kind, b"D")
            self.assertLessEqual(previous, timestamp)
            previous = timestamp
            if first is None:
                first = timestamp
            received.extend(data)
        self.assertEqual(received, b"x" * size)
        self.assertLess(first, producer_finished)

    def test_eof_fails_observation(self):
        os.close(self.slave)
        self.slave = None
        with self.assertRaisesRegex(RuntimeError, "closed before observation"):
            self.capture.read(5)

    def test_queue_overflow_fails_instead_of_dropping_records(self):
        self.write(12 * 1024 * 1024)
        self.assertNotEqual(self.capture.process.wait(timeout=5), 0)
        error = self.capture.close()
        self.capture = None
        self.assertIn("queue limit exceeded", error)

    def test_silent_reader_crash_is_not_accepted(self):
        self.capture.process.kill()
        self.capture.process.wait()
        error = self.capture.close()
        self.capture = None
        self.assertIn("exited with status -", error)

    def test_failed_reader_spawn_closes_both_sockets(self):
        pair = socket.socketpair()
        with patch("terminal_capture.socket.socketpair", return_value=pair), patch(
            "terminal_capture.subprocess.Popen", side_effect=OSError("fixture spawn failure")
        ):
            with self.assertRaisesRegex(OSError, "fixture spawn failure"):
                Capture(self.master)
        self.assertTrue(all(channel.fileno() == -1 for channel in pair))


if __name__ == "__main__":
    unittest.main()
