from dataclasses import dataclass


@dataclass(frozen=True)
class Artifact:
    name: str
    crate: str
    hardened: bool


ARTIFACTS = (
    Artifact("codex", "codex-cli", True),
    Artifact("codex-code-mode-host", "codex-code-mode-host", False),
    Artifact("omd-mod", "codex-omd-extension", True),
    Artifact("omd", "codex-omd", True),
    Artifact("omd-contract", "codex-omd", True),
    Artifact("omd-broker", "codex-omd", True),
    Artifact("omd-runner", "codex-omd-runner", False),
)
BINARIES = tuple(artifact.name for artifact in ARTIFACTS)
BUILD = ["build", "--locked", "--release",
         *(flag for crate in dict.fromkeys(artifact.crate for artifact in ARTIFACTS) for flag in ("-p", crate)),
         *(flag for name in BINARIES for flag in ("--bin", name))]
