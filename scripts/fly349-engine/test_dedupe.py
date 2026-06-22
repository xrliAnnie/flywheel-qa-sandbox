#!/usr/bin/env python3
"""Tests for FLY-349 engine dedupe. Run: python3 test_dedupe.py"""
import dedupe as D
ok = 0
def check(c, m):
    global ok
    assert c, "FAIL: " + m
    ok += 1

# Real provenance shapes seen in this collection's issues:
SPIKE_ISSUE = {  # my FLY-352 spike draft
  "identifier": "FLY-352", "title": "[XHS-draft] Flywheel ...",
  "description": "provenance: opId=`fly349:6a1828f7000000003502a0b3:issue` ... source=https://www.xiaohongshu.com/explore/6a1828f7000000003502a0b3",
}
MERGED_ISSUE = {  # FLY-353 comprehensive, covers 3 source notes
  "identifier": "FLY-353", "title": "架构进化",
  "description": "explore/6a2d1c16000000003502053e ... explore/6a1d35ab000000000803d1cf ... explore/6a0182c7000000000803c506",
}
PILOT_ISSUE = {  # FLY-286-scheme pilot issue (opId differs but noteId present)
  "identifier": "FLY-333", "title": "pilot learning",
  "description": "claude:6aaaaaaaaaaaaaaaaaaaaaaa:issue:6aaaaaaaaaaaaaaaaaaaaaaa source explore/6aaaaaaaaaaaaaaaaaaaaaaa",
}

def test_extract_url_and_bare():
    ids = D.extract_note_ids("see explore/6a1828f7000000003502a0b3 and bare 6a2d1c16000000003502053e")
    check("6a1828f7000000003502a0b3" in ids, "extracts URL noteId")
    check("6a2d1c16000000003502053e" in ids, "extracts bare noteId")

def test_extract_ignores_nonids():
    ids = D.extract_note_ids("FLY-352 some prose, short id abc123, runToken fly349-ff-202606191122")
    check("fly349-ff-202606191122" not in ids, "runToken not a noteId")
    check(all(len(i) == 24 for i in ids), "only 24-char ids extracted")

def test_covered_set_across_schemes():
    cov = D.covered_note_ids([SPIKE_ISSUE, MERGED_ISSUE, PILOT_ISSUE])
    check("6a1828f7000000003502a0b3" in cov, "spike note covered")
    check("6a2d1c16000000003502053e" in cov, "merged-issue note 1 covered")
    check("6a0182c7000000000803c506" in cov, "merged-issue note 3 covered")
    check("6aaaaaaaaaaaaaaaaaaaaaaa" in cov, "pilot-scheme note covered (by noteId, scheme-agnostic)")

def test_should_create_gate():
    cov = D.covered_note_ids([SPIKE_ISSUE])
    check(not D.should_create("6a1828f7000000003502a0b3", cov), "do NOT recreate covered note")
    check(D.should_create("6bfreshfreshfreshfresh01", cov), "create fresh uncovered note")

def test_partition_preserves_order():
    cov = {"6a1828f7000000003502a0b3"}
    to_create, dup = D.partition(["6bnewnewnewnewnewnewnew01", "6a1828f7000000003502a0b3", "6bnewnewnewnewnewnewnew02"], cov)
    check(to_create == ["6bnewnewnewnewnewnewnew01", "6bnewnewnewnewnewnewnew02"], "to_create order preserved, dup removed")
    check(dup == ["6a1828f7000000003502a0b3"], "dup captured")

def test_empty_inputs():
    check(D.covered_note_ids([]) == set(), "no issues -> empty covered")
    check(D.extract_note_ids("") == set(), "empty text -> empty")
    check(D.should_create("6bxxxxxxxxxxxxxxxxxxxxxx1", set()), "create when nothing covered")

for fn in list(globals().values()):
    if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
        fn()
print(f"✅ ALL DEDUPE TESTS PASSED ({ok} assertions)")
