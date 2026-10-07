import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from scripts.mod_host_check import Host


ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / "mods/first-party/omd_minefield"


@unittest.skipUnless(os.environ.get("OMD_MOD_BIN"), "set OMD_MOD_BIN for native state validation")
class MinefieldPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="omd-minefield-", dir="/private/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name).resolve()
        node = subprocess.run(["mise", "which", "node"], check=True, capture_output=True, text=True).stdout.strip()
        self.host = Host(os.environ["OMD_MOD_BIN"], node, self.work)
        self.store, refused = self.host.store("store", [MOD], {})
        self.assertEqual(refused, {})
        self.thread = "minefield-persistence"
        self.path = self.store / "data/threads" / self.thread / ".state/state-omd_minefield.json"
        self.invoke({"action": "new", "seed": 6}, 1)

    def scenario(self, data, sequence, name):
        path = self.work / f"{name}.json"
        path.write_text(json.dumps({"schema": 1, "host_operations": {"packages.list": [{"generation": 1, "packages": [], "reload_error": None}]}, "steps": [{"type": "event", "event": "channel", "payload": {
            "publisher": "omd_minefield", "channel": "omd_minefield/play", "sequence": sequence, "data": data}}]}))
        return path

    def invoke(self, data, sequence):
        result, error = self.host.run("test", self.store, self.scenario(data, sequence, "invoke"), self.thread)
        self.assertIsNone(error)
        self.assertEqual(result["paid_requests"], 0)

    def state(self):
        return json.loads(self.path.read_text())["value"]

    def start(self, data, sequence):
        scenario = self.scenario(data, sequence, str(sequence))
        child = subprocess.Popen([self.host.omd_mod, "test", str(self.store), str(scenario), self.thread], cwd=self.host.repo,
                                 env=self.host.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        return child

    def wait_for_lock(self, children, lock):
        deadline = time.monotonic() + 1.4
        while time.monotonic() < deadline:
            result = subprocess.run(["/usr/sbin/lsof", "-F", "p", str(lock)], capture_output=True, text=True, timeout=1)
            holders = {int(line[1:]) for line in result.stdout.splitlines() if line.startswith("p")}
            if {child.pid for child in children} <= holders:
                return
            if any(child.poll() is not None for child in children):
                break
        self.fail("both native callbacks must reach the state-write lock before release")

    def test_concurrent_saves_replay_stale_input_without_overwriting_board_or_records(self):
        before = self.state()
        token = f'{before["board"]["id"]}_{before["revision"]}'
        lock = self.path.parent / ".lock"
        with lock.open("w") as barrier:
            fcntl.flock(barrier, fcntl.LOCK_EX)
            a = self.start({"action": "flag", "cell": 0, "token": token}, 2)
            b = self.start({"action": "flag", "cell": 1, "token": token}, 3)
            self.wait_for_lock([a, b], lock)
            fcntl.flock(barrier, fcntl.LOCK_UN)
        for child in (a, b):
            stdout, stderr = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, stderr)
            self.assertEqual(json.loads(stdout)["paid_requests"], 0)
        after = self.state()
        self.assertIn(after["board"]["flags"], [[0], [1]])
        self.assertEqual(after["revision"], before["revision"] + 1)
        self.assertEqual(after["board"]["id"], before["board"]["id"])
        self.assertEqual((after["wins"], after["best"]), (before["wins"], before["best"]))

    def test_crash_before_commit_preserves_snapshot_and_fresh_resume_pauses(self):
        before = self.state()
        lock = self.path.parent / ".lock"
        with lock.open("w") as barrier:
            fcntl.flock(barrier, fcntl.LOCK_EX)
            child = self.start({"action": "flag", "cell": 0}, 2)
            self.wait_for_lock([child], lock)
            child.kill()
            child.communicate(timeout=5)
            fcntl.flock(barrier, fcntl.LOCK_UN)
        self.assertEqual(self.state(), before)
        scenario = self.work / "resume.json"
        scenario.write_text(json.dumps({"schema": 1, "steps": [{"type": "event", "event": "resume", "payload": None}]}))
        self.host.run("test", self.store, scenario, self.thread)
        after = self.state()
        self.assertEqual(after["board"], before["board"])
        self.assertTrue(after["paused"])
        self.assertIsNone(after["clock"])
        self.assertIsNone(after["last"])

    def test_concurrent_final_reveals_settle_board_and_best_record_once(self):
        self.invoke({"action": "reveal", "cell": 40}, 2)
        board = self.state()["board"]
        remaining = [cell for cell in range(81) if cell not in board["mines"] and cell not in board["revealed"]]
        self.assertGreater(len(remaining), 1)
        self.invoke({"action": "flag", "cell": remaining[-1]}, 3)
        scenario = self.work / "almost-won.json"
        scenario.write_text(json.dumps({"schema": 1, "virtual_time_ms": 9000,
            "host_operations": {"packages.list": [{"generation": 1, "packages": [], "reload_error": None}] * 81}, "steps": [
            {"type": "event", "event": "channel", "payload": {"publisher": "omd_minefield", "channel": "omd_minefield/play",
             "sequence": index + 4, "data": {"action": "reveal", "cell": cell}}} for index, cell in enumerate(remaining[:-1])]}))
        self.host.run("test", self.store, scenario, self.thread)
        self.invoke({"action": "unflag", "cell": remaining[-1]}, 90)
        before = self.state()
        self.assertEqual(before["board"]["result"], "playing")
        token = f'{before["board"]["id"]}_{before["revision"]}'
        lock = self.path.parent / ".lock"
        with lock.open("w") as barrier:
            fcntl.flock(barrier, fcntl.LOCK_EX)
            a = self.start({"action": "reveal", "cell": remaining[-1], "token": token}, 100)
            b = self.start({"action": "reveal", "cell": remaining[-1], "token": token}, 101)
            self.wait_for_lock([a, b], lock)
            fcntl.flock(barrier, fcntl.LOCK_UN)
        successes = 0
        for child in (a, b):
            stdout, stderr = child.communicate(timeout=10)
            if child.returncode == 0:
                successes += 1
                self.assertEqual(json.loads(stdout)["paid_requests"], 0)
            else:
                self.assertIn("state_conflict", stderr)
        self.assertGreaterEqual(successes, 1)
        after = self.state()
        self.assertEqual(after["board"]["result"], "won")
        self.assertEqual((after["wins"], after["best"]), (1, 9000))
        self.assertEqual(after["board"]["elapsed_ms"], 9000)
        self.assertIsNone(after["clock"])
