#!/usr/bin/env python3
"""Read commands and invoke the real pure scanner; never execute commands."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    runbook, scanner, output = map(Path, sys.argv[1:])
    raw = runbook.read_bytes()
    commands = re.findall(r"^```bash\n([\s\S]*?)\n```$", raw.decode(), re.M)
    if not commands:
        raise ValueError("no commands")
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("drill_restart_guard", scanner)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rows = [{"sha256": digest(command.encode()), "hit": module.scan_block(command)}
            for command in commands]
    receipt = {"schemaVersion": 1, "inputsDigest": digest(raw),
               "scannerSha256": digest(scanner.read_bytes()), "commands": rows}
    with output.open("x") as handle:
        json.dump(receipt, handle, ensure_ascii=False)
        handle.write("\n")
    return int(any(row["hit"] is not None for row in rows))


if __name__ == "__main__":
    sys.exit(main())
