#!/usr/bin/env python3
import hashlib
import json
import os
import re
import shutil
import sys
import tomllib
from pathlib import Path

KERNELS = {"python": ("python.py", '["python3", "-u", "-c"]'), "bun": ("bun.mjs", '["bun", "-e"]')}
TABLE = "[[features.code_mode.kernels]]"
HEADER = re.compile(r"^\s*\[\[?[^\[\]=]+\]\]?\s*(#.*)?$")
CODE_MODE = "[features.code_mode]\nenabled = true\n"
HOST = "[features.code_mode_host]\nenabled = true\ndisable_in_process_fallback = true\n"


def replace(text, name, block):
    lines = text.splitlines(keepends=True)
    heads = [index for index, line in enumerate(lines) if HEADER.match(line)] + [len(lines)]
    for start, stop in zip(heads, heads[1:]):
        if lines[start].split("#")[0].strip() != TABLE:
            continue
        if tomllib.loads("".join(lines[start:stop]))["features"]["code_mode"]["kernels"][0].get("name") != name:
            continue
        while lines[stop - 1].strip() == "" or lines[stop - 1].lstrip().startswith("#"):
            stop -= 1
        return "".join(lines[:start]) + block + "".join(lines[stop:])


def merged(text, features, blocks):
    new = text
    appended = [CODE_MODE] * ("code_mode" not in features) + [HOST] * ("code_mode_host" not in features)
    for name, block in blocks.items():
        replaced = replace(new, name, block)
        if replaced is None:
            appended.append(block)
        else:
            new = replaced
    if appended:
        new += ("\n" if new and not new.endswith("\n") else "") + ("\n" if new else "") + "\n".join(appended)
    return new


def write(config, new, wanted):
    backup = config.with_name(config.name + ".bak")
    existed = config.is_file()
    if existed:
        shutil.copy2(config, backup)
    temp = config.with_name(config.name + ".tmp")
    temp.write_text(new)
    if existed:
        shutil.copymode(config, temp)
    os.replace(temp, config)
    try:
        entries = tomllib.loads(config.read_text())["features"]["code_mode"]["kernels"]
        assert all(any(entry.get("name") == name and entry.get("driver") == driver and entry.get("driver_sha256") == digest for entry in entries)
                   for name, (driver, digest) in wanted.items())
    except Exception as error:
        shutil.copy2(backup, config) if existed else config.unlink()
        sys.exit(f"{config} would not read back correctly ({error!r}); {f'restored it from {backup.name}' if existed else 'removed it'}")


def main():
    apply = "--write" in sys.argv[1:]
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    target = home / "omd/kernels"
    target.mkdir(parents=True, exist_ok=True)
    config = home / "config.toml"
    text = config.read_text() if config.is_file() else ""
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        sys.exit(f"{config} is not valid TOML, so nothing was changed: {error}")
    code_mode = parsed.get("features", {}).get("code_mode")
    entries = code_mode.get("kernels", []) if isinstance(code_mode, dict) else []
    stale = {}
    for name, (file, command) in KERNELS.items():
        source = Path(__file__).resolve().parent.parent / "kernels" / file
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        copy = target / f"{digest[:12]}-{file}"
        if not copy.is_file():
            shutil.copyfile(source, copy)
        entry = next((item for item in entries if item.get("name") == name), {})
        if entry.get("driver") == str(copy) and entry.get("driver_sha256") == digest:
            print(f"{name}: config is current ({copy})")
            continue
        block = f'{TABLE}\nname = "{name}"\ncommand = {command}\ndriver = {json.dumps(str(copy))}\ndriver_sha256 = "{digest}"\n'
        stale[name] = (str(copy), digest, block)
        if not apply:
            print(f"{name}: put this in {config}, replacing any {name} kernel entry, or run again with --write\n\n{block}")
    if apply and stale:
        write(config, merged(text, parsed.get("features", {}), {name: block for name, (_, _, block) in stale.items()}),
              {name: (driver, digest) for name, (driver, digest, _) in stale.items()})
        print(f"{', '.join(stale)}: updated {config} (previous copy in {config.name}.bak)")


if __name__ == "__main__":
    main()
