#!/usr/bin/env python3
"""FLY-349 v2 engine — dedupe: never recreate an issue for a note already covered.

Two issue-creation schemes exist in the wild for this collection:
  - FLY-332 pilot (FLY-333..348/370): the FLY-286 skill's opId scheme.
  - FLY-349 spike/full-flow (FLY-352..358): `fly349:<noteId>:issue` markers.
So we dedupe by **source noteId**, which is scheme-agnostic: every XHS-origin issue's
description references its source note (either `explore/<noteId>` URL or an opId/marker
containing the noteId). The orchestrator scans existing FLY issues once, extracts the
set of covered noteIds via `covered_note_ids()`, then `should_create()` gates creation.

Pure logic + regex; the Linear scan (I/O) is the orchestrator's job.
"""
from __future__ import annotations
import re

# A xiaohongshu noteId is a 24-char lowercase hex-ish token (e.g. 6a1828f7000000003502a0b3).
NOTEID_RE = re.compile(r"\b([0-9a-f]{24})\b")
# explore/<id> or discovery/item/<id> URL forms.
URL_NOTEID_RE = re.compile(r"(?:explore|discovery/item)/([0-9a-f]{24})")


def extract_note_ids(text: str) -> set[str]:
    """All candidate noteIds referenced in an issue's title+description (URLs + bare ids)."""
    if not text:
        return set()
    ids = set(URL_NOTEID_RE.findall(text))
    ids |= set(NOTEID_RE.findall(text))
    return ids


def covered_note_ids(existing_issues: list[dict]) -> set[str]:
    """Given existing XHS issues [{identifier, title, description}], return the set of
    source noteIds they already cover. A merged/duplicate issue still counts as covering
    its source notes (so we don't recreate them)."""
    covered: set[str] = set()
    for iss in existing_issues:
        blob = (iss.get("title") or "") + "\n" + (iss.get("description") or "")
        covered |= extract_note_ids(blob)
    return covered


def should_create(note_id: str, covered: set[str]) -> bool:
    """Create an issue for this note only if no existing issue already covers it."""
    return note_id not in covered


def partition(note_ids: list[str], covered: set[str]) -> tuple[list[str], list[str]]:
    """Split candidate noteIds into (to_create, already_covered) preserving order."""
    to_create, dup = [], []
    for nid in note_ids:
        (dup if nid in covered else to_create).append(nid)
    return to_create, dup
