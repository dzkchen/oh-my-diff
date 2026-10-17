import json
import hashlib
from pathlib import Path
import tomllib

from scripts import install_support as support

ROOT = Path(__file__).resolve().parents[1]
RECORD = "build-provenance.json"
BINARIES = ("codex", "codex-code-mode-host", "omd-mod", "omd", "omd-contract", "omd-broker")
OVERRIDES = ("RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_BUILD_TARGET",
             "CARGO_BUILD_RUSTC", "CARGO_BUILD_RUSTC_WRAPPER", "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER")


def cargo_configs(tree, environment):
    if any(environment.get(key) for key in OVERRIDES):
        raise ValueError("build provenance refuses compiler or target overrides")
    paths = [parent / ".cargo" / name
             for parent in (tree / "codex-rs", *(tree / "codex-rs").parents)
             for name in ("config", "config.toml")]
    cargo_home = Path(environment.get("CARGO_HOME", Path.home() / ".cargo"))
    paths += [cargo_home / name for name in ("config", "config.toml")]
    config = {}
    for path in paths:
        if not path.is_file():
            continue
        value = tomllib.loads(path.read_text())
        if (set(value.get("build", {})) & {"rustc", "rustc-wrapper", "rustc-workspace-wrapper", "target"}
                or set(value.get("env", {})) & set(OVERRIDES)):
            raise ValueError(f"build provenance refuses compiler or target overrides: {path}")
        config[str(path)] = support.digest(path)
    return config


def identity():
    pin = json.loads((ROOT / "upstream.lock.json").read_text())
    manifest = json.loads((ROOT / "runtime/patches/manifest.json").read_text())
    if support.digest(ROOT / manifest["patch"]["path"]) != manifest["patch"]["sha256"]:
        raise ValueError("build provenance patch hash mismatch")
    dependency = manifest["files"].get("codex-rs/Cargo.lock", {})
    if dependency.get("before", pin["normalized_cargo_lock_sha256"]) != pin["normalized_cargo_lock_sha256"]:
        raise ValueError("build provenance dependency lock baseline differs")
    return {"upstream_commit": pin["commit"], "runtime_patch_sha256": manifest["patch"]["sha256"],
            "normalized_cargo_lock_sha256": pin["normalized_cargo_lock_sha256"],
            "cargo_lock_sha256": dependency.get("after", pin["normalized_cargo_lock_sha256"]),
            "rust_toolchain": pin["rust_toolchain"], "target": pin["verified_target"]}


def inputs(tree, arguments, environment):
    config = cargo_configs(tree, environment)
    if any(argument.startswith("--target") for argument in arguments):
        raise ValueError("build provenance refuses target overrides")
    expected = identity()
    git = lambda *args: support.output(["git", *args], cwd=tree)
    if git("rev-parse", "HEAD") != expected["upstream_commit"]:
        raise ValueError("build provenance requires the pinned checkout")
    manifest = json.loads((ROOT / "runtime/patches/manifest.json").read_text())
    changed = set(git("diff", "HEAD", "--name-only", "--", "codex-rs").splitlines())
    changed |= set(git("ls-files", "--others", "--exclude-standard", "--", "codex-rs").splitlines())
    if changed != set(manifest["files"]) | {"codex-rs/Cargo.lock"}:
        raise ValueError("build provenance source inventory differs from the patch")
    for name, hashes in manifest["files"].items():
        path = tree / name
        actual = support.digest(path) if path.is_file() else None
        if path.is_symlink() or actual != hashes["after"]:
            raise ValueError(f"build provenance source differs: {name}")
    if support.digest(tree / "codex-rs/Cargo.lock") != expected["cargo_lock_sha256"]:
        raise ValueError("build provenance dependency lock differs")
    compiler = support.output(["rustc", "-vV"], cwd=tree / "codex-rs", env=environment)
    if f"release: {expected['rust_toolchain']}" not in compiler or f"host: {expected['target']}" not in compiler:
        raise ValueError("build provenance compiler or target differs")
    variables = {key: value for key, value in environment.items()
                 if key.startswith(("CARGO_PROFILE_", "CARGO_TARGET_", "CARGO_BUILD_", "CARGO_ENCODED_RUSTFLAGS", "RUST", "CC", "CXX", "AR_", "CFLAGS", "CXXFLAGS"))
                 and key != "CARGO_TARGET_DIR"}
    for key in ("RUSTY_V8_ARCHIVE", "RUSTY_V8_SRC_BINDING_PATH"):
        if key in variables and Path(variables[key]).is_file():
            variables[key] = support.digest(Path(variables[key]))
    return {**expected, "configuration": {"cargo_arguments": list(arguments), "environment": variables,
                                         "environment_sha256": hashlib.sha256(json.dumps(
                                             dict(environment), sort_keys=True).encode()).hexdigest(),
                                         "cargo_configs": config, "compiler": compiler}}


def hashes(directory):
    return {name: support.digest(directory / name) for name in BINARIES}


def record_build(directory, before, after):
    if before != after:
        raise ValueError("build inputs changed during compilation")
    record = {"schema": 1, "inputs": before, "unsigned": hashes(directory)}
    support.atomic_text(directory / RECORD, json.dumps(record, indent=2, sort_keys=True) + "\n")
    return record


def verify(directory, signed=True, expected_inputs=None):
    try:
        record = json.loads((directory / RECORD).read_text())
    except (OSError, ValueError) as error:
        raise ValueError("missing or invalid artifact build provenance; rebuild binaries") from error
    expected = identity()
    if record.get("schema") != 1 or any(record.get("inputs", {}).get(key) != value for key, value in expected.items()):
        raise ValueError("artifact build provenance differs from pinned inputs")
    configuration = record["inputs"].get("configuration", {})
    arguments = configuration.get("cargo_arguments", [])
    compiler = configuration.get("compiler", "")
    if (not all(option in arguments for option in ("build", "--locked", "--release"))
            or f"release: {expected['rust_toolchain']}" not in compiler
            or f"host: {expected['target']}" not in compiler
            or not isinstance(configuration.get("environment"), dict)
            or not isinstance(configuration.get("cargo_configs"), dict)):
        raise ValueError("artifact build configuration is missing")
    if expected_inputs is not None and record["inputs"] != expected_inputs:
        raise ValueError("artifact build configuration changed; rebuild binaries")
    if set(record.get("unsigned", {})) != set(BINARIES):
        raise ValueError("artifact build provenance inventory differs")
    if record.get("signed" if signed else "unsigned") != hashes(directory):
        raise ValueError("artifact bytes differ from build provenance")
    return record


def record_signing(directory, unsigned):
    if unsigned.get("signed") is not None:
        raise ValueError("build provenance already signed")
    record = {**unsigned, "signed": hashes(directory)}
    support.atomic_text(directory / RECORD, json.dumps(record, indent=2, sort_keys=True) + "\n")
    return record
