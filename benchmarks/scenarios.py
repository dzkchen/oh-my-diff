from .compare import require


def validate_scenarios(data):
    seen, coverage, families = set(), set(), {}
    for scenario in data["scenarios"]:
        require(scenario["id"] not in seen, "duplicate focused scenario")
        seen.add(scenario["id"])
        require(scenario["split"] in ("development", "validation", "held-out"), "invalid scenario split")
        require(scenario["initial_files"] and scenario["steps"] and scenario["assertions"], "incomplete scenario")
        family = scenario["family"]
        require(family not in families or families[family] == scenario["split"], "scenario family crosses splits")
        families[family] = scenario["split"]
        coverage.add((scenario["category"], scenario["split"]))
    expected = {(category, split) for category in ("diagnostics", "graph", "memory", "browser", "structural-edit", "recovery")
                for split in ("development", "validation", "held-out")}
    require(coverage == expected, "focused scenario coverage incomplete")
    return {"scenarios": len(seen), "coverage_cells": len(coverage)}


def score_scenario(scenario, observations):
    failures = []
    for assertion in scenario["assertions"]:
        value = observations
        try:
            for part in assertion["path"].split("."):
                value = value[part]
        except (KeyError, TypeError):
            failures.append({"path": assertion["path"], "reason": "missing evidence"})
            continue
        if value != assertion["equals"] or type(value) is not type(assertion["equals"]):
            failures.append({"path": assertion["path"], "reason": "assertion failed"})
    return {"accepted": not failures, "failures": failures}
