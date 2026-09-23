import argparse
import hashlib
import json
from pathlib import Path


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def describe(path):
    requests = json.loads(path.read_text())
    rows = []
    for request in requests:
        body = request["body"]
        schemas = [entry for entry in body["input"] if entry.get("type") in ("additional_tools", "tool_search_output")]
        developer = [entry for entry in body["input"] if entry.get("role") == "developer" and entry.get("type") == "message"]
        tools = [tool.get("name") for entry in schemas for namespace in entry.get("tools", []) for tool in namespace.get("tools", [])]
        rows.append({
            "body_bytes": len(encoded(body)),
            "developer_bytes": sum(len(encoded(entry)) for entry in developer),
            "schema_bytes": sum(len(encoded(entry)) for entry in schemas),
            "schema_sha256": hashlib.sha256(encoded(schemas)).hexdigest(),
            "tool_count": len(tools),
            "mod_tools": [name for name in tools if isinstance(name, str) and name.startswith("mod_")],
            "cache_key": body.get("prompt_cache_key"),
        })
    for row in rows:
        row["cache_key_with_initial_equal"] = row.pop("cache_key") == requests[0]["body"].get("prompt_cache_key")
    return {"capture": str(path), "requests": len(rows), "rows": rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--static", type=Path)
    args = parser.parse_args()
    result = {"baseline": describe(args.baseline), "candidate": describe(args.candidate)}
    if args.static:
        result["static_all_checks"] = describe(args.static)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
