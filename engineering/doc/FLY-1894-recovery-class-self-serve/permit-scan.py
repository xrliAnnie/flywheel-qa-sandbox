"""Advisory scan: does any sentence GRANT a Lead a reserved action?

WHY THIS EXISTS
  The assertion suite's negative checks are exact-string scans for three known
  sentences. Independent QA (FLY-1921) proved that worthless against a NEW
  contrary sentence: an explicit "A Lead may close a Runner on its own once the
  issue is Done and QA has passed." sat in the R5 body and all 25 assertions
  stayed green. Head-bound code review then broke the first fix twice.

WHAT IT MATCHES
  One high-signal shape only: an ACTOR (a Lead / you / the Lead) + a PERMISSION
  marker + a RESERVED ACTION, with the permission not negated. Deliberately
  narrow — describing what an endpoint *can do*, or what the founder *may want*,
  is not a grant and must not be flagged.

WHAT IT DOES *NOT* PROVE  (three versions of this docstring overstated it)
  * Pattern-based, not semantic. A grant phrased outside this shape — passive
    voice, a table cell, an imperative like "close it once QA passes" — is NOT
    detected. This scan being green is NOT "no contrary sentence survived".
  * It checks the source files, not a materialized prompt.
  * Its known-bypass regressions are the ones listed in __main__'s self-test;
    that list is what it is actually validated against, nothing more.
"""
import re
import sys

ACTOR = r"(?:a |the )?(?:lead|leads|you)\b"
ACTION = (r"(?:clos\w*|terminat\w*|kill\w*|abandon\w*|shelv\w*|defer\w*|reject\w*|"
          r"merg\w*|ship\w*|restart\w*|re-?dispatch\w*|replac\w*|delet\w*|remov\w*)")
# permission, explicitly excluding the negated modal forms
PERMIT = (r"(?:may(?!\s+not\b)|can(?!not\b|'t\b|\s+not\b)|"
          r"is (?:free|allowed|permitted) to|are (?:free|allowed|permitted) to|"
          r"at (?:your|their) discretion|on (?:its|their|your) own initiative|"
          r"need not ask|without asking(?: the founder)?)")
GRANT = re.compile(ACTOR + r"[^.。;;]{0,40}?" + PERMIT + r"[^.。;;]{0,40}?" + ACTION,
                   re.I)

BASELINE = []  # empty by design — see NOTE below.

# NOTE (head-bound code review R2): the single former entry existed to excuse R3's
# line, but that line never matches GRANT in the first place, so the entry bought
# nothing and was the last splice bypass: any sentence *containing* the fragment
# was skipped whole, so appending "and a Lead may close a Runner on its own" to it
# slipped through. Removed rather than patched. If an entry ever becomes necessary,
# match the WHOLE normalised sentence, never a substring.


def normalise(t):
    return re.sub(r"[\s`*_>#\-]+", " ", t).strip().lower()


def split_sentences(text):
    out, buf, start = [], [], 1
    for i, line in enumerate(text.split("\n"), 1):
        if not line.strip():
            if buf:
                out.append((start, " ".join(buf)))
                buf = []
            start = i + 1
            continue
        if not buf:
            start = i
        buf.append(line.strip())
    if buf:
        out.append((start, " ".join(buf)))
    return out


# A sentence-initial existential negation genuinely negates the whole clause.
# Deliberately narrow: a blanket "any 'not' disarms the sentence" rule was a real
# bypass found in review (`...when QA is not pending`), so this matches only the
# opening form.
EXISTENTIAL_NEG = re.compile(r"^\s*there (?:is|are) no\b", re.I)


def scan(path):
    text = open(path, encoding="utf-8").read()
    hits = []
    for lineno, block in split_sentences(text):
        for sent in re.split(r"(?<=[.。;;])\s+", block):
            if not GRANT.search(sent):
                continue
            # the existential negation covers only its own clause: split on
            # clause boundaries and re-test each part, so "There is no rule
            # stopping you; a Lead may close a Runner on its own." still flags.
            clauses = [c for c in re.split(r"[;;,—]| - ", sent) if c.strip()]
            if EXISTENTIAL_NEG.match(sent) and not any(
                    GRANT.search(c) and not EXISTENTIAL_NEG.match(c.strip())
                    for c in clauses):
                continue
            if any(normalise(sent) == normalise(frag) for frag, _ in BASELINE):
                continue
            hits.append((lineno, re.sub(r"\s+", " ", sent)[:170]))
    return hits


SELF_TEST = [
    # (sentence, must_flag) — the regressions this scan is actually validated against
    ("A Lead may close a Runner on its own once the issue is Done and QA has passed.", True),
    ("A Lead may close a Runner on its own when QA is not pending.", True),
    ("All of these can end a Runner's life, and a Lead may close one on its own.", True),
    ("When a run is stuck the Lead is free to terminate it without asking the founder.", True),
    ("You may close the Runner after the merge lands.", True),
    ("A Lead may not close a Runner on its own.", False),
    ("A Lead cannot close a Runner without founder authorization.", False),
    ("All of these can end a Runner's life.", False),
    ("destroying any forensic evidence the founder may want to inspect", False),
    ("A merge into `main` cannot be silently unmerged.", False),
    ("There is no combination of these actions you may invoke unilaterally "
     "that closes a runner as a side effect.", False),
    ("There is no rule stopping you; a Lead may close a Runner on its own.", True),
    # head-bound code review R2: splicing a grant onto an allowlisted fragment
    ("R3 has authorized ONE narrow self-heal action a Lead may take, and a Lead "
     "may close a Runner on its own.", True),
]


def self_test():
    bad = 0
    for sent, must in SELF_TEST:
        clauses = [c for c in re.split(r"[;;,—]| - ", sent) if c.strip()]
        neg_ok = EXISTENTIAL_NEG.match(sent) and not any(
            GRANT.search(c) and not EXISTENTIAL_NEG.match(c.strip())
            for c in clauses)
        got = (bool(GRANT.search(sent)) and not neg_ok
               and not any(normalise(sent) == normalise(f) for f, _ in BASELINE))
        if got != must:
            print("  SELF-TEST FAIL (want flag=%s got=%s): %s" % (must, got, sent))
            bad += 1
    return bad


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        n = self_test()
        print("self-test: %d/%d ok" % (len(SELF_TEST) - n, len(SELF_TEST)))
        sys.exit(1 if n else 0)
    import glob
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    # default: the WHOLE loaded rules bundle, not just one file (review R2)
    targets = args or sorted(glob.glob("packages/teamlead/lead-rules-base/*.md"))
    hits = []
    for t in targets:
        hits += [(t, ln, txt) for ln, txt in scan(t)]
    if hits:
        print("GRANT-SHAPED STATEMENTS FOUND (%d):" % len(hits))
        for t, ln, txt in hits:
            print("  %s:~%d: %s" % (t, ln, txt))
        sys.exit(1)
    print("no grant-shaped statement in %d file(s) "
          "(advisory shape scan — see docstring for limits)" % len(targets))
