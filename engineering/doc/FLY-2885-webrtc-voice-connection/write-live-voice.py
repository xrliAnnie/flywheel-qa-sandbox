"""FLY-2885 T9: set leads[].liveVoice in ~/.flywheel/projects.json from the
founder's FLY-2866 mapping — and nothing else.

Run under the projects config write lock:
  scripts/flywheel-config-lock.sh ~/.flywheel/projects.json.cfglock 10 \
    python3 write-live-voice.py <projects.json> <expected-pre-sha256> <live-voice-assignment.json> [--dry-run <out>]

Input: engineering/doc/FLY-2866-lead-voice-assignment/live-voice-assignment.json
(schema fly2866.live-voice-assignment.v1). Only rows with "chosen": true are
written; every other Lead stays absent and engine B defaults it to cove.

Refuses (exit 2, file untouched) when: the file's sha256 differs from the
expected pre-image; the mapping schema, field, default or allowed voices are not
the FLY-2885 contract; a Lead is missing or ambiguous; a Lead already has a
different liveVoice; or re-serialising the unmodified document does not
reproduce the file byte-for-byte (so the write could not be proven to change
only these fields). A Lead that already has the chosen voice is left as is.
Writes atomically (temp file in the same dir, fsync, chmod 0600, rename, dir
fsync) after a 0600 backup of the exact pre-image. With --dry-run the new
document goes to <out> instead and projects.json is not touched.
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone

VOICES = ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"]


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(2)


def serialise(doc, indent, trailing):
    return (json.dumps(doc, indent=indent, ensure_ascii=False) + trailing).encode()


def atomic_write(path, data):
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".projects.json.fly2885.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    dfd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def main():
    args = sys.argv[1:]
    dry_out = None
    if "--dry-run" in args:
        i = args.index("--dry-run")
        if i + 1 >= len(args):
            fail("--dry-run needs an output path")
        dry_out = args[i + 1]
        del args[i : i + 2]
    if len(args) != 3:
        fail("usage: write-live-voice.py <projects.json> <expected-pre-sha256> <mapping.json> [--dry-run <out>]")
    path, expected, mapping_path = args

    mapping = json.load(open(mapping_path, encoding="utf-8"))
    if (
        mapping.get("schema") != "fly2866.live-voice-assignment.v1"
        or mapping.get("field") != "leads[].liveVoice"
        or mapping.get("default") != "cove"
        or mapping.get("allowedVoices") != VOICES
    ):
        fail("mapping is not the FLY-2885 liveVoice contract")
    changes = []
    for row in mapping.get("leads", []):
        if row.get("chosen") is not True:
            continue
        project, lead, voice = row.get("projectName"), row.get("agentId"), row.get("liveVoice")
        if not (isinstance(project, str) and isinstance(lead, str) and project and lead):
            fail(f"bad mapping row: {row!r}")
        if voice not in VOICES:
            fail(f"{project}/{lead}: not a v3 voice: {voice!r}")
        changes.append((project, lead, voice))
    if not changes:
        fail("mapping has no chosen leads")

    raw = open(path, "rb").read()
    pre = hashlib.sha256(raw).hexdigest()
    if pre != expected:
        fail(f"pre-image sha256 mismatch: have {pre}, expected {expected}")
    doc = json.loads(raw)
    fmt = None
    for indent in (2, 4, "\t"):
        for trailing in ("\n", ""):
            if serialise(doc, indent, trailing) == raw:
                fmt = (indent, trailing)
    if fmt is None:
        fail("round-trip is not byte-identical; refusing to rewrite")

    applied, unchanged = [], []
    for project, lead, voice in changes:
        rows = [
            l
            for p in doc
            if p.get("projectName") == project
            for l in p.get("leads", [])
            if l.get("agentId") == lead
        ]
        if len(rows) != 1:
            fail(f"{project}/{lead}: expected exactly one lead, found {len(rows)}")
        current = rows[0].get("liveVoice")
        if current == voice:
            unchanged.append(f"{project}/{lead}: {voice}")
            continue
        if current is not None:
            fail(f"{project}/{lead}: already has liveVoice {current!r}, refusing to replace with {voice!r}")
        rows[0]["liveVoice"] = voice
        applied.append(f"{project}/{lead}: (absent) -> {voice}")

    new = serialise(doc, *fmt)
    backup = None
    if dry_out is not None:
        atomic_write(dry_out, new)
        post = hashlib.sha256(new).hexdigest()
    elif applied:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = f"{path}.bak-fly2885-livevoice-{stamp}"
        shutil.copyfile(path, backup)
        os.chmod(backup, 0o600)
        if hashlib.sha256(open(backup, "rb").read()).hexdigest() != pre:
            fail("backup does not match the pre-image")
        atomic_write(path, new)
        post = hashlib.sha256(open(path, "rb").read()).hexdigest()
    else:
        post = pre
    print(json.dumps({
        "ok": True,
        "dryRun": dry_out is not None,
        "preSha256": pre,
        "postSha256": post,
        "backup": backup,
        "applied": applied,
        "unchanged": unchanged,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
