#!/usr/bin/env python3
"""FLY-1929: does this panic report's panicString name the IVAC voucher panic?

Reads a bounded prefix of the report on stdin.

Exit codes are THREE-VALUED on purpose, because "no match" and "I could not
tell" must never be confused — collapsing them is how a recurrence gets lost
silently, which is the one failure this whole watcher exists to prevent:

    0  match      — a top-level panicString contains the marker (printed to stdout)
    1  no match   — a top-level panicString was read COMPLETELY and lacks it
    2  unknown    — no complete top-level panicString in the prefix

WHY A DEPTH-TRACKING SCANNER AND NOT json.loads / raw_decode
A real panic report is ~5 MB: a small one-line header object followed by a body
object holding the whole process census. `panicString` sits at byte ~442, but the
enclosing object does not close until megabytes later. Any approach that must
DECODE THE WHOLE OBJECT before reading a field therefore fails on the real
artifact — verified on the actual 2026-08-20 report (4,984,601 bytes): a
raw_decode version returned "unknown" on a 256 KB prefix and would never have
paged for a genuine recurrence.

So this walks the prefix as a stream, tracking string/escape state and brace
depth, and reads ONLY keys at depth 1 (top level of each object). That keeps the
structural guarantees that a plain text scan lacked:

    {"panicString":"unrelated","panicString":"<marker>"}            -> match  (all keys checked)
    {"panicString":"unrelated"}{"panicString":"<marker>"}           -> match  (per object)
    {"nested":{"panicString":"<marker>"},"panicString":"unrelated"} -> NO match (depth 2 ignored)
    {"note":"panicString","other":"<marker>"}                       -> NO match (that is a VALUE)

while still working when the object is truncated by the read bound.

The value itself is decoded with raw_decode, so \\uXXXX and other escapes are
handled properly rather than by hand.

THE ONE FORMAT ASSUMPTION, STATED PLAINLY
NO_MATCH is returned only after a COMPLETE depth-1 panicString has been read;
anything less is UNKNOWN. That makes NO_MATCH safe *for this format*, and only
for it: an Apple panic report carries its panicString in the body object near the
start (byte 442 in the real 4,984,601-byte 2026-08-20 report) and carries exactly
one, so once a complete one has been read there is no later one to miss.

This is a narrow, testable assumption, not a general claim about JSON. It is
deliberate: returning UNKNOWN for every capped input instead would leave every
large NON-voucher panic report permanently "undetermined" and emit a breadcrumb
on every tick forever — trading a correctness risk for a guaranteed noise
problem. If a document actually violates it by carrying more than one complete top-level
panicString, this returns UNKNOWN rather than a negative, because the reasoning
that made NO_MATCH safe no longer applies to that document.

Deliberately stateless. The caller re-checks every tick and lets lead-alert.sh's
permanent receipt deduplicate, so there is no "permanently classified as
not-a-match" record to get wrong.
"""

from __future__ import annotations

import json
import sys

MATCH = 0
NO_MATCH = 1
UNKNOWN = 2

KEY = "panicString"


def _skip_string(text: str, i: int) -> int:
    """Return the index just past the string literal starting at text[i] == '"'.

    Returns -1 if the literal runs off the end of the prefix.
    """
    i += 1
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch == '"':
            return i + 1
        i += 1
    return -1


def scan(prefix: str, marker: str) -> tuple[str, int]:
    decoder = json.JSONDecoder()
    n = len(prefix)
    i = 0
    depth = 0
    expect_key = False  # True only where a KEY may legally start
    complete_values = 0

    while i < n:
        ch = prefix[i]

        if ch == '"':
            end = _skip_string(prefix, i)
            if end < 0:
                break  # truncated inside a string
            # A key is a string at depth 1 in key position, immediately followed
            # (modulo whitespace) by a colon. Both conditions matter: the depth
            # test rejects nested objects, the position test rejects a value
            # that merely happens to read "panicString".
            if depth == 1 and expect_key:
                j = end
                while j < n and prefix[j] in " \t\r\n":
                    j += 1
                if j < n and prefix[j] == ":" and prefix[i:end] == json.dumps(KEY):
                    k = j + 1
                    while k < n and prefix[k] in " \t\r\n":
                        k += 1
                    if k >= n:
                        break  # value truncated away entirely
                    try:
                        value, vend = decoder.raw_decode(prefix, k)
                    except ValueError:
                        break  # value truncated mid-string
                    if isinstance(value, str):
                        complete_values += 1
                        if marker in value:
                            return value, MATCH
                    i = vend
                    expect_key = False
                    continue
            i = end
            expect_key = False
            continue

        if ch == "{":
            depth += 1
            expect_key = depth == 1
        elif ch == "}":
            depth -= 1
            expect_key = False
        elif ch == "[":
            depth += 1
            expect_key = False
        elif ch == "]":
            depth -= 1
            expect_key = False
        elif ch == ",":
            expect_key = depth == 1
        elif ch == ":":
            expect_key = False
        i += 1

    # NO_MATCH is only safe under the single-top-level-key assumption stated
    # above. If the document violates it by carrying MORE than one complete
    # top-level panicString, the assumption no longer licenses a negative — say
    # UNKNOWN rather than assert something this format reasoning cannot support.
    if complete_values == 1:
        return "", NO_MATCH
    return "", UNKNOWN


def main() -> int:
    marker = sys.argv[1] if len(sys.argv) > 1 else ""
    if not marker:
        sys.stderr.write("usage: voucher-panic-match.py <marker>\n")
        return UNKNOWN
    try:
        raw = sys.stdin.buffer.read()
    except OSError as exc:
        sys.stderr.write(f"read failed: {exc}\n")
        return UNKNOWN
    try:
        # STRICT: errors="replace" would turn undecodable bytes into a clean
        # NO_MATCH, i.e. "definitely not a recurrence" on evidence we could not
        # actually read. Undecodable input is UNKNOWN.
        prefix = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        sys.stderr.write(f"undecodable input: {exc}\n")
        return UNKNOWN
    try:
        value, status = scan(prefix, marker)
    except Exception as exc:  # noqa: BLE001 - any parser surprise is UNKNOWN, never NO_MATCH
        sys.stderr.write(f"scan failed: {exc}\n")
        return UNKNOWN
    if status == MATCH:
        try:
            sys.stdout.write(value[:400])
        except (UnicodeEncodeError, OSError) as exc:
            # An output failure must not exit 1 — the shell reads 1 as a clean
            # non-match, which would silently drop a real recurrence.
            sys.stderr.write(f"output failed: {exc}\n")
            return UNKNOWN
        return MATCH
    return status


if __name__ == "__main__":
    sys.exit(main())
