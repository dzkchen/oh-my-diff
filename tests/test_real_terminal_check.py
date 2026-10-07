import json
import sys
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest import mock

with mock.patch.object(sys, "path", [str(Path(__file__).resolve().parents[1] / "scripts"), *sys.path]):
    from scripts import real_terminal_check


class RealTerminalCheckTests(unittest.TestCase):
    @contextmanager
    def fixture(self, keep_open=True):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            base = Path(directory)
            terminal = real_terminal_check.Terminal(base, base / "run.sh")
            terminal.drives_keys = False
            terminal.start = mock.Mock(side_effect=lambda _: (base / "codex.pid").write_text("987"))
            terminal.pid = mock.Mock(return_value=321)
            terminal.bounds = mock.Mock(return_value={"id": 1})
            terminal.close = mock.Mock()
            server = mock.Mock()
            argv = ["real_terminal_check", "--binaries", str(base / "binaries"), "--terminal", "ghostty"]
            if keep_open:
                argv.append("--keep-open")
            stack.enter_context(mock.patch.object(sys, "argv", argv))
            for name, value in {
                "fresh": mock.Mock(return_value=base),
                "call": mock.Mock(),
                "git": mock.Mock(),
                "provider": mock.Mock(return_value=(server, "http://provider.invalid/v1")),
                "store_with": mock.Mock(),
                "environment": mock.Mock(return_value={"TERM": "xterm"}),
                "Ghostty": mock.Mock(return_value=terminal),
                "state": mock.Mock(return_value={"client": {"graphics": "kitty"}, "image": "probe.png"}),
            }.items():
                stack.enter_context(mock.patch.object(real_terminal_check, name, value))
            stack.enter_context(mock.patch.object(real_terminal_check.time, "sleep"))
            printed = stack.enter_context(mock.patch("builtins.print"))
            yield base, terminal, server, printed

    def test_keep_open_reports_results_and_keeps_the_provider_until_codex_exits(self):
        with self.fixture() as (base, terminal, server, printed):
            polls = 0

            def alive(pid, signal):
                nonlocal polls
                polls += 1
                self.assertEqual((pid, signal), (987, 0))
                self.assertEqual(json.loads((base / "results.json").read_text())["pid"], 321)
                self.assertEqual(printed.call_count, 2)
                self.assertTrue(all(call.kwargs["flush"] for call in printed.call_args_list))
                server.shutdown.assert_not_called()
                if polls == 2:
                    raise ProcessLookupError()

            with mock.patch.object(real_terminal_check.os, "kill", side_effect=alive):
                real_terminal_check.main()
            self.assertEqual(polls, 2)
            terminal.close.assert_not_called()
            server.shutdown.assert_called_once_with()

    def test_interrupted_keep_open_stops_the_provider(self):
        with self.fixture() as (_, _, server, _), \
             mock.patch.object(real_terminal_check.os, "kill", side_effect=KeyboardInterrupt), \
             self.assertRaises(KeyboardInterrupt):
            try:
                real_terminal_check.main()
            finally:
                server.shutdown.assert_called_once_with()

    def test_setup_and_terminal_cleanup_failures_still_stop_the_provider(self):
        with self.fixture() as (_, terminal, server, _):
            real_terminal_check.environment.side_effect = ValueError("setup failed")
            with self.assertRaisesRegex(ValueError, "setup failed"):
                real_terminal_check.main()
            terminal.start.assert_not_called()
            server.shutdown.assert_called_once_with()
        with self.fixture(keep_open=False) as (_, terminal, server, _):
            terminal.close.side_effect = ValueError("close failed")
            with self.assertRaisesRegex(ValueError, "close failed"):
                real_terminal_check.main()
            server.shutdown.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
