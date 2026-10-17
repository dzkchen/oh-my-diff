#!/usr/bin/env python3
import datetime as dt
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "mods/compatibility.json"
HOST = ROOT / "runtime/omd/src/mods.rs"
CARGO = ROOT / "runtime/omd/Cargo.toml"


def quoted_constant(source, name):
    match = re.search(rf'pub const {name}: &str = "([^"]+)";', source)
    if not match:
        raise ValueError(f"missing host constant {name}")
    return match.group(1)


def numeric_constant(source, name):
    match = re.search(rf"pub const {name}: u32 = (\d+);", source)
    if not match:
        raise ValueError(f"missing host constant {name}")
    return int(match.group(1))


def array_constant(source, name):
    match = re.search(rf"{name}: &\[[^]]*\] =\s*&\[(.*?)\];", source, re.S)
    if not match:
        raise ValueError(f"missing host constant {name}")
    return match.group(1)


def host_contract():
    source = HOST.read_text()
    cargo = CARGO.read_text()
    omd = re.search(r'^version = "([^"]+)"$', cargo, re.M).group(1)
    current_api = quoted_constant(source, "MOD_API_VERSION")
    supported = []
    for literal, constant, stability, until in re.findall(
        r'\((?:"([^"]+)"|(MOD_API_VERSION)), "([^"]+)", "([^"]+)"\)', source
    ):
        supported.append({
            "version": current_api if constant else literal,
            "stability": stability,
            "support_until": until,
        })
    return {
        "codex": quoted_constant(source, "CODEX_HOST_RELEASE"),
        "omd": omd,
        "current_api": current_api,
        "package_schemas": [numeric_constant(source, "MOD_PACKAGE_SCHEMA_VERSION")],
        "state_storage_schema": numeric_constant(source, "MOD_STATE_STORAGE_SCHEMA_VERSION"),
        "installed_contract_types": numeric_constant(source, "INSTALLED_CONTRACT_TYPES_VERSION"),
        "features": re.findall(r'"([^"]+)"', array_constant(source, "MOD_HOST_FEATURES")),
        "apis": supported,
    }


def check(matrix):
    problems = []
    host = host_contract()
    for field in ("codex", "omd", "current_api", "package_schemas", "state_storage_schema", "installed_contract_types", "features"):
        if matrix["host"][field] != host[field]:
            problems.append(f"host {field} differs: matrix={matrix['host'][field]!r} source={host[field]!r}")
    compact = [{key: row[key] for key in ("version", "stability", "support_until")} for row in matrix["apis"]]
    if compact != host["apis"]:
        problems.append("API rows differ from SUPPORTED_MOD_APIS")
    labels = {"stable", "deprecated", "experimental"}
    if any(row["stability"] not in labels for row in matrix["apis"]):
        problems.append("unknown API stability label")
    as_of = dt.date.fromisoformat(matrix["as_of"])
    if any(dt.date.fromisoformat(row["support_until"]) <= as_of for row in matrix["apis"]):
        problems.append("every supported API needs a future finite support date")
    policy = matrix["policy"]
    if not policy["stable_breaking_api_changes_require_major"]:
        problems.append("stable breaking API changes must require a major")
    if policy["stable_deprecation_notice_omd_releases"] < 1:
        problems.append("stable APIs need at least one stable OMD release of deprecation notice")
    if policy["pre_release_current_api_only"] and [row["version"] for row in host["apis"]] != [host["current_api"]]:
        problems.append("before public release the host supports only the current API")
    if not policy["urgent_security_exception_requires_advisory"]:
        problems.append("urgent security exceptions need a published advisory")
    service = matrix["service_contracts"]
    if not service["stable_breaking_changes_require_major"] or set(service["labels"]) != labels:
        problems.append("service-contract stability policy is incomplete")
    transition = matrix["transitions"]["real_supported_release"]
    if transition["available"] and not transition.get("evidence"):
        problems.append("an available real transition needs retained execution evidence")
    if not transition["available"] and not transition["reason"]:
        problems.append("an unavailable real transition needs a reason")
    if "arbitrary-version" not in matrix["interchange"]["sessions"] or "arbitrary-version" not in matrix["interchange"]["state"]:
        problems.append("session and state limits must reject arbitrary-version claims")
    return problems


def main():
    matrix = json.loads(MATRIX.read_text())
    problems = check(matrix)
    if problems:
        raise SystemExit("\n".join(problems))
    print(f"compatibility matrix {matrix['as_of']}: {len(matrix['apis'])} API rows match the host")


if __name__ == "__main__":
    main()
