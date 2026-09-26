"""FLY-2866: set leads[].realtimeVoice for named leads in ~/.flywheel/projects.json — and nothing else.

Run under the projects config write lock:
  scripts/flywheel-config-lock.sh ~/.flywheel/projects.json.cfglock 10 \
    python3 write-voices.py <projects.json> <expected-pre-sha256> <project>/<lead>=<from>:<to> ...

Refuses (exit 2, file untouched) when: the file's sha256 differs from the expected pre-image; a
lead is missing or ambiguous; its current voice is not <from>; <to> is not a Realtime v2 voice;
or re-serialising the unmodified document does not reproduce the file byte-for-byte (so the write
could not be proven to change only these fields).
Writes atomically (temp file in the same dir, fsync, chmod 0600, rename, dir fsync).
"""

import hashlib
import json
import os
import sys
import tempfile

VOICES = {"alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"}


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(2)


def serialise(doc, indent, trailing):
    return (json.dumps(doc, indent=indent, ensure_ascii=False) + trailing).encode()


def main():
    path, expected = sys.argv[1], sys.argv[2]
    changes = []
    for spec in sys.argv[3:]:
        target, _, move = spec.partition("=")
        project, _, lead = target.partition("/")
        src, _, dst = move.partition(":")
        if not (project and lead and src and dst):
            fail(f"bad change spec: {spec}")
        if dst not in VOICES:
            fail(f"not a Realtime v2 voice: {dst}")
        changes.append((project, lead, src, dst))
    if not changes:
        fail("no changes given")

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

    for project, lead, src, dst in changes:
        rows = [
            l
            for p in doc
            if p.get("projectName") == project
            for l in p.get("leads", [])
            if l.get("agentId") == lead
        ]
        if len(rows) != 1:
            fail(f"{project}/{lead}: expected exactly one lead, found {len(rows)}")
        if rows[0].get("realtimeVoice") != src:
            fail(f"{project}/{lead}: current voice {rows[0].get('realtimeVoice')!r} != {src!r}")
        rows[0]["realtimeVoice"] = dst

    new = serialise(doc, *fmt)
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".projects.json.fly2866.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(new)
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
    print(json.dumps({
        "ok": True,
        "preSha256": pre,
        "postSha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
        "changes": [f"{p}/{l}: {s} -> {d}" for p, l, s, d in changes],
    }))


if __name__ == "__main__":
    main()
