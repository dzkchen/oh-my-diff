import json
import os
from pathlib import Path
import statistics
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def main():
    node = subprocess.run(("mise", "which", "node"), check=True, capture_output=True, text=True).stdout.strip()
    command = (node, str(ROOT / "mods/author/cli.mjs"), "test", str(ROOT / "mods/first-party/omd_verification_gate"))
    environment = {**os.environ, "OMD_MOD_BIN": str(ROOT / "runtime/omd/target/debug/omd-mod"), "OMD_MOD_NODE": node}
    samples = []
    for _ in range(8):
        result = subprocess.run(command, cwd=ROOT, env=environment, check=True, capture_output=True, text=True)
        receipt = json.loads(result.stdout)
        samples.append(receipt["steps"][1]["value"]["mods"][0]["telemetry"]["last_micros"] / 1000)
    ordered = sorted(samples)
    print(json.dumps({"samples_ms": samples, "median_ms": statistics.median(samples), "p95_ms": ordered[round((len(ordered) - 1) * 0.95)], "paid_requests": 0}, indent=2))


if __name__ == "__main__":
    main()
