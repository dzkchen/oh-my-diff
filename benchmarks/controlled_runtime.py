import hashlib
import json
from pathlib import Path
import subprocess

from .compare import artifact, read, require


GIT = "/Library/Developer/CommandLineTools/usr/bin/git"
SYSTEM_READS = ("/usr/bin", "/bin", "/usr/sbin", "/sbin", "/Library/Developer/CommandLineTools/usr")


def configure(root, runtime, workspace, home, evidence, gateway, limits, env, overrides):
    require(not (workspace / ".omd").exists(), "source occupies reserved runtime scratch")
    require(not (workspace / ".omd-tmp").exists(), "source occupies reserved tool scratch")
    reads = [*SYSTEM_READS, *(str(artifact(root, ref)) for ref in runtime.get("path_helpers", []))]
    filesystem = {":minimal": "read", str(workspace): "write", **{path: "read" for path in reads}}
    permissions = {"default_permissions": "experiment", "permissions.experiment.network.enabled": False,
                   "permissions.experiment.filesystem": filesystem}
    overrides.pop("sandbox_mode")
    overrides.update(permissions)
    overrides.update({"shell_environment_policy.inherit": "none", "shell_environment_policy.use_profile": False,
                      "shell_environment_policy.set.PATH": env["PATH"], "shell_environment_policy.set.HOME": str(workspace),
                      "shell_environment_policy.set.TMPDIR": str(workspace / ".omd-tmp"),
                      "shell_environment_policy.set.GIT_CONFIG_NOSYSTEM": "1",
                      "shell_environment_policy.set.GIT_CONFIG_GLOBAL": "/dev/null",
                      "features.skip_host_skill_discovery": True, "features.apps": False, "features.plugins": False,
                      "features.memories": False, "features.shell_snapshot": False, "features.code_mode": False,
                      "include_skill_instructions": False, "mcp_servers": {}})
    git_env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
    require(not (workspace / ".git").exists(), "benchmark source must have no repository metadata")
    for args in (["init", "-q"], ["add", "--force", "."], ["-c", "user.name=Experiment", "-c", "user.email=experiment@localhost", "commit", "-qm", "Frozen benchmark source"]):
        subprocess.run([GIT, *args], cwd=workspace, env=git_env, check=True, capture_output=True)
    (workspace / ".git/info/exclude").write_text(".omd/\n.omd-tmp/\n")
    if runtime.get("controlled"):
        policy = read(artifact(root, runtime["controlled"]))
        frozen_grant = artifact(root, policy["authorization"]).resolve()
        grant = Path(policy.get("revocation_authority", frozen_grant)).resolve()
        require(hashlib.sha256(grant.read_bytes()).hexdigest() == policy.get("authority_sha256", hashlib.sha256(frozen_grant.read_bytes()).hexdigest()), "Contributor authority was revoked or changed")
        require(runtime["task_identity"] in read(grant)["repositories"], "repository is outside Contributor authorization")
        rates = lambda subscription: {"input_microusd_per_million": 0 if subscription else 100000, "cached_microusd_per_million": 0 if subscription else 2000,
                                      "output_microusd_per_million": 0 if subscription else 200000, "max_output_tokens": 8192, "input_token_ceiling": 220000,
                                      "reservation_microusd": 0 if subscription else 25000, "included_subscription": subscription}
        route = lambda model, provider, effort: {"model": model, "provider": provider, "reasoning_effort": effort,
                                         "responses_url": f"http://127.0.0.1:{gateway.port}/{provider}/responses",
                                         "rates": rates(provider == "subscription")}
        manifest = {"repository": str(workspace), "scratch": str(workspace / ".omd"),
                    "evidence": str(evidence / "controlled-evidence"), "authorization": str(grant),
                    "authorization_sha256": hashlib.sha256(grant.read_bytes()).hexdigest(),
                    "repository_identity": runtime["task_identity"], "approved_untracked": [],
                    "limits": {"seconds": 900, "requests": 60, "exposure_microusd": 500000, "concurrent_workers": 2, "max_depth": 2, "max_reassessments": 1},
                    "worker_limits": {"seconds": 300, "requests": 20, "exposure_microusd": 500000},
                    "checkpoint": {"objective": runtime["task_identity"], "acceptance_criteria": ["configured executable check passes", "separate review approves the exact candidate", "accepted candidate is integrated without conflicting workspace change"], "max_no_progress_calls": 2},
                    "legitimate_wait_tools": ["wait_agent", "write_stdin", "wait"],
                    "lifecycle": {"explicit_resume": None},
                    "recovery": {"contributor_attempts": 2, "equivalent_failure_threshold": 2, "fallback_to_opposite_lead": True},
                    "lead_policy": {"mode": "fixed", "lead": "sol"},
                    "leads": {"sol": route("gpt-5.6-sol", "subscription", "high"), "astra": route("gpt-6-astra", "subscription", "high")},
                    "context_policy": {"mode": "focused_brief", "max_bytes": 65536},
                    "escalation": {"allowed_failure_classes": ["environment", "edit", "diagnosis", "model"],
                                   "max_attempts": 1, "evidence_bytes": 65536},
                    "worker": route("muse-spark-1.3-contributor", "contributor", "low"), "toolchain_reads": [Path(p).as_posix() for p in reads],
                    "check_command": [GIT, "diff", "--check"], "snapshot_bytes": limits["snapshot_bytes"],
                    "max_request_bytes": 220000}
        evidence.mkdir(parents=True, exist_ok=True)
        path = evidence / "controlled-manifest.json"
        path.write_text(json.dumps(manifest, indent=2))
        env["OMD_CONTROLLED_MANIFEST"] = str(path)
    return permissions
