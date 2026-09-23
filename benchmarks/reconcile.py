import argparse
import copy
from pathlib import Path
import shutil

from .compare import artifact, money, number, put, read, require, write


def reconcile(bundle, charges, output):
    original = read(bundle / "run.json")
    updates = read(charges)
    require(updates["currency"] == "USD", "charge export must state USD")
    require(updates["provenance"] and updates["units"], "empty charge export")
    by_unit = {e["billing_unit"]: e for e in original["ledger"]}
    require(len(by_unit) == len(original["ledger"]), "duplicate billing units")
    seen = set()
    for unit in updates["units"]:
        key = unit["billing_unit"]
        require(key in by_unit and key not in seen, "unknown/duplicate reconciled unit")
        seen.add(key)
        event = by_unit[key]
        require(event["basis"] != "subscription", "subscription usage is not metered API spending")
        require(unit["provider"] == event["provider"] and unit["account_alias"] == event["account_alias"], "charge account mismatch")
        require(event.get("request_id") and unit["request_id"] == event["request_id"], "charge request mismatch or unavailable provider ID")
        number(unit["usd"])
        artifact(charges.parent, unit["evidence"])
    require(not output.exists(), "reconciliation output exists")
    shutil.copytree(bundle, output)
    revised = copy.deepcopy(original)
    lookup = {e["billing_unit"]: e for e in revised["ledger"]}
    for index, unit in enumerate(updates["units"]):
        event = lookup[unit["billing_unit"]]
        proof = put(output, f"reconciliation/proof-{index}", artifact(charges.parent, unit["evidence"]).read_bytes())
        event["previous_billing"] = {k: event[k] for k in ("basis", "usd", "rate_card", "calculation") if k in event}
        event.update(basis="actual", usd=str(number(unit["usd"])), currency="USD",
                     billing_evidence=proof, billing_provenance=updates["provenance"])
        event.pop("rate_card", None)
        event.pop("calculation", None)
    money(revised["ledger"])

    (output / "run.json").unlink()
    write(output / "run.json", revised)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("charges", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    reconcile(args.bundle.resolve(), args.charges.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
