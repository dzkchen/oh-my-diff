import argparse
import hashlib
import json
from pathlib import Path


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def describe(path):
    requests = json.loads(path.read_text())
    if not requests:
        raise ValueError(f"empty request capture: {path}")
    bodies = [request["body"] for request in requests]
    initial = bodies[0]
    entries = initial["input"]
    schema = [entry for entry in entries if entry.get("type") == "additional_tools"]
    developer = [entry for entry in entries if entry.get("role") == "developer" and entry.get("type") == "message"]
    tools = [tool for entry in schema for namespace in entry.get("tools", []) for tool in namespace.get("tools", [])]
    prefix = 0
    if len(bodies) > 1:
        for left, right in zip(bodies[0]["input"], bodies[1]["input"]):
            if encoded(left) != encoded(right):
                break
            prefix += 1
    return {
        "capture": str(path),
        "requests": len(requests),
        "initial_model": initial["model"],
        "initial_body_bytes": len(encoded(initial)),
        "initial_developer_message_bytes": sum(len(encoded(entry)) for entry in developer),
        "initial_developer_message_sizes": [len(encoded(entry)) for entry in developer],
        "initial_tool_schema_bytes": sum(len(encoded(entry)) for entry in schema),
        "initial_tool_count": len(tools),
        "initial_tool_names": [tool.get("name") for tool in tools],
        "initial_input_items": len(entries),
        "first_two_common_input_items": prefix,
        "first_two_common_input_bytes": sum(len(encoded(entry)) for entry in entries[:prefix]),
        "first_two_cache_key_equal": len(bodies) > 1 and bodies[0].get("prompt_cache_key") == bodies[1].get("prompt_cache_key"),
        "first_two_schema_equal": len(bodies) > 1 and digest(schema) == digest([entry for entry in bodies[1]["input"] if entry.get("type") == "additional_tools"]),
        "initial_schema_sha256": digest(schema),
        "initial_developer_sha256": digest(developer),
        "model_sequence": [body["model"] for body in bodies],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--omd-direct", type=Path, required=True)
    parser.add_argument("--enabled", type=Path, required=True)
    parser.add_argument("--workspace-only", type=Path)
    parser.add_argument("--matched-direct", type=Path)
    args = parser.parse_args()
    captures = {
        "upstream": args.upstream,
        "omd_direct": args.omd_direct,
        "enabled_candidate": args.enabled,
    }
    if args.workspace_only:
        captures["workspace_only"] = args.workspace_only
    if args.matched_direct:
        captures["matched_direct"] = args.matched_direct
    print(json.dumps({name: describe(path) for name, path in captures.items()}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
