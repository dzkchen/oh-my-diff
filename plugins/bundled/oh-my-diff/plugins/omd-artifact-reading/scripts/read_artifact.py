#!/usr/bin/env python3
import argparse
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import time


MAX_FILE = 50 * 1024 * 1024
MAX_TEXT = 12000
MAX_IMAGE = 8 * 1024 * 1024
MAX_CELLS = 1000


def source(path):
    item = Path(path).expanduser().resolve(strict=True)
    if not item.is_file() or item.stat().st_size > MAX_FILE:
        raise ValueError("source must be a file of at most 50 MiB")
    return item, hashlib.sha256(item.read_bytes()).hexdigest()


def notebook(path):
    item, digest = source(path)
    if item.suffix != ".ipynb":
        raise ValueError("notebook source must end in .ipynb")
    value = json.loads(item.read_text(encoding="utf-8"))
    cells = value.get("cells") if isinstance(value, dict) else None
    if not isinstance(cells, list) or len(cells) > MAX_CELLS:
        raise ValueError("notebook must hold a cell list of at most 1000 cells")
    if any(not isinstance(cell, dict) for cell in cells):
        raise ValueError("notebook cells must be objects")
    return item, digest, cells


def bounded(value):
    return joined_text(value)[:MAX_TEXT]


def joined_text(value):
    if isinstance(value, list):
        return "".join(part for part in value if isinstance(part, str))
    return value if isinstance(value, str) else ""


def cell_record(index, cell):
    outputs = cell.get("outputs", [])
    if not isinstance(outputs, list):
        outputs = []
    outputs = [output for output in outputs if isinstance(output, dict)]
    record = {
        "index": index,
        "id": cell.get("id"),
        "type": cell.get("cell_type"),
        "execution_count": cell.get("execution_count"),
        "source": bounded(cell.get("source", "")),
        "source_truncated": len(joined_text(cell.get("source", ""))) > MAX_TEXT,
        "outputs": [],
    }
    for output in outputs[:20]:
        data = output.get("data", {})
        if not isinstance(data, dict):
            data = {}
        record["outputs"].append({
            "type": output.get("output_type"),
            "text": bounded(output.get("text", data.get("text/plain", ""))),
            "image_png": "image/png" in data,
            "error_name": output.get("ename"),
            "error_value": output.get("evalue"),
        })
    record["outputs_truncated"] = len(outputs) > 20
    return record


def ghostscript(args):
    executable = shutil.which("gs")
    if executable is None:
        raise ValueError("Ghostscript (gs) is required for PDF reading")
    process = subprocess.Popen([executable, "-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    chunks = []
    total = 0
    errors = bytearray()
    deadline = time.monotonic() + 30
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ, "output")
        selector.register(process.stderr, selectors.EVENT_READ, "error")
        try:
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("PDF extraction timed out")
                for key, _ in selector.select(remaining):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                    elif key.data == "output":
                        total += len(block)
                        if total > MAX_IMAGE:
                            raise ValueError("PDF extraction exceeds 8 MiB")
                        chunks.append(block)
                    else:
                        errors.extend(block[: max(0, 1000 - len(errors))])
            if process.wait(timeout=max(0.1, deadline - time.monotonic())):
                raise ValueError(errors.decode("utf-8", "replace") or "PDF rendering failed")
        except (ValueError, subprocess.TimeoutExpired):
            process.kill()
            process.wait()
            raise
    return b"".join(chunks)


def pdf_page(path, page, figure, output):
    item, digest = source(path)
    if item.suffix.lower() != ".pdf" or item.read_bytes()[:5] != b"%PDF-":
        raise ValueError("source must be a PDF")
    if page < 1 or page > 1000:
        raise ValueError("page must be from 1 to 1000")
    device = "png16m" if figure else "txtwrite"
    data = ghostscript([f"-sDEVICE={device}", f"-dFirstPage={page}", f"-dLastPage={page}", "-r96", "-sOutputFile=-", "-f", str(item)])
    if figure:
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > MAX_IMAGE:
            raise ValueError("rendered PDF page is empty or exceeds 8 MiB")
        destination = Path(output).expanduser().resolve()
        if not destination.parent.is_dir() or destination.exists():
            raise ValueError("output parent must exist and output must be new")
        destination.write_bytes(data)
        return {"source": str(item), "sha256": digest, "page": page, "image": str(destination)}
    value = data.decode("utf-8", "replace")
    return {"source": str(item), "sha256": digest, "page": page, "text": value[:MAX_TEXT], "truncated": len(value) > MAX_TEXT, "empty": not value.strip()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["pdf-page", "pdf-figure", "notebook", "notebook-cell", "notebook-image"])
    parser.add_argument("file")
    parser.add_argument("index", type=int, nargs="?")
    parser.add_argument("output", nargs="?")
    args = parser.parse_args()
    if args.command.startswith("pdf-"):
        if args.index is None or (args.command == "pdf-figure") != bool(args.output):
            raise ValueError("PDF command requires page and figure requires output")
        value = pdf_page(args.file, args.index, args.command == "pdf-figure", args.output)
    else:
        item, digest, cells = notebook(args.file)
        value = {"source": str(item), "sha256": digest, "cell_count": len(cells)}
        if args.command == "notebook":
            value["cells"] = [{"index": i, "id": cell.get("id"), "type": cell.get("cell_type"), "source_preview": bounded(cell.get("source", ""))[:160]} for i, cell in enumerate(cells[:100])]
            value["truncated"] = len(cells) > 100
        else:
            if args.index is None or args.index < 0 or args.index >= len(cells):
                raise ValueError("cell index is out of range")
            cell = cells[args.index]
            if args.command == "notebook-cell":
                value["cell"] = cell_record(args.index, cell)
            else:
                if not args.output:
                    raise ValueError("notebook-image requires an output path")
                images = [output["data"]["image/png"] for output in cell.get("outputs", []) if isinstance(output, dict) and isinstance(output.get("data"), dict) and "image/png" in output["data"]]
                if len(images) != 1:
                    raise ValueError("cell must have exactly one PNG output")
                data = base64.b64decode("".join(joined_text(images[0]).split()), validate=True)
                if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > MAX_IMAGE:
                    raise ValueError("notebook PNG is invalid or exceeds 8 MiB")
                destination = Path(args.output).expanduser().resolve()
                if not destination.parent.is_dir() or destination.exists():
                    raise ValueError("output parent must exist and output must be new")
                destination.write_bytes(data)
                value.update({"cell_index": args.index, "cell_id": cell.get("id"), "image": str(destination)})
    print(json.dumps(value, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, binascii.Error, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(2)
