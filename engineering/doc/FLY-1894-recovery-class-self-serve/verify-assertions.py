"""FLY-1894 — 25 static checks over the shipped rule files.

⚠️ THIS IS **NOT** plan §7's assertion set. Earlier docstrings said it was; head-bound
code review corrected that. §7 specifies semantic coverage this script does NOT
implement — notably:

  * the full activation manifest and its no-self-certification rule,
  * the operator-rework binding surface,
  * the four-way split and its decidable test,
  * the seven counter-example checks.

Those remain **unimplemented**. The count matching (25) is a coincidence of number,
not of coverage.

WHAT THE 25 CHECKS DO PROVE
  * positive checks: specific safety sentences are present in the shipped files;
  * negative checks: THREE SPECIFIC OLD SENTENCES are gone.

WHAT THEY DO NOT PROVE
  Not "no contrary sentence survived". Independent QA (FLY-1921) demonstrated this:
  with

      "A Lead may close a Runner on its own once the issue is Done and QA has passed."

  in the R5 body, all 25 stayed green, because the negative checks are exact-string
  scans. Shape-level detection lives in permit-scan.py — read its docstring for what
  it in turn cannot prove.
"""
import io
import re
import sys

B = 'packages/teamlead/lead-rules-base/'
FOA = io.open(B + 'founder-only-authority.md', encoding='utf-8').read()

ok, bad = [], []


def want(label, pat, text=FOA, flags=re.I):
    (ok if re.search(pat, text, flags) else bad).append(label)


def forbid(label, pat, text=FOA, flags=re.I):
    (bad if re.search(pat, text, flags) else ok).append(label)


# 1-7: core R5 semantics present
want("1  classification != authorization", r"Classification is not authorization")
want("2  registry ships empty", r"^\*\*None\.\*\*", flags=re.I | re.M)
want("3  no generic entry", r"no generic entry")
want("4  empty registry still needs founder", r"still go to the founder")
want("5  stored PR head prohibited", r"writing a stored PR head")
want("6  server success != authorization", r"do not route around it")
want("7  R5 never authorizes close/ship", r"Recovery is not termination")

# 8: per-instance binding scoped to the R5 candidate path only
want("8  R5 fence is scoped, not global", r"\*\*R5\*\* binds \*\*this run, this mechanism, and the current state")
forbid("8b no global run\\+mechanism\\+state mandate",
       r"AUTH-CANON[^\n]{0,80}(all rules|every rule)[^\n]{0,80}run, mechanism")

# 9: five R-headings present and ordered
heads = re.findall(r"^## (R[1-5]) —", FOA, re.M)
(ok if heads == ["R1", "R2", "R3", "R4", "R5"] else bad).append(
    "9  R1..R5 headings present and ordered (got %s)" % heads)

# 10: old wording gone except inside its own prohibition
occ = FOA.count("does invoking this end a live Runner's session")
(ok if occ == 0 else bad).append("10 live-session catch-all test removed (occurrences=%d)" % occ)
want("10b catch-all covers identity/context/worktree",
     r"end, replace, finalize or delete a Runner's\s*\n?\s*identity, context or worktree")
want("10c catch-all not conditioned on liveness", r"whether the process is still alive")

# 11: engine housekeeping is jurisdiction, not inheritance
PATROL = io.open(B + 'runner-patrol-rules.md', encoding='utf-8').read()
want("11 engine cleanup framed as outside the Lead contract",
     r"outside the Lead contract", PATROL)

# 12: post-ship three fences
want("12 post-ship provenance/target/causality", r"\*\*provenance\*\*[\s\S]{0,200}\*\*target\*\*[\s\S]{0,200}\*\*causality\*\*")

# 13: R1 controlled carryover survives, both directions
want("13a carryover exception still present", r"auto-rebinds the gate to the new head")
forbid("13b no blanket 'any head change voids it'",
       r"any (head|scope) change[^\n]{0,40}(void|invalidat)")

# 14: R3 grandfather is non-precedential and lives in AUTH-CANON only
want("14 R3 exception is non-precedential", r"non-precedential|不可外推|cannot be cited")

# 15: TL;DR excepts only R3, and says R5 authorizes nothing
tldr = FOA[FOA.index("## TL;DR"):]
want("15a TL;DR excepts the R3 rescue", r"complete R3 rescue", tldr)
want("15b TL;DR says R5 authorizes no mechanism", r"R5 authorizes no mechanism", tldr)

# 16: counter-examples — the negative scans
forbid("16a no 'Track 2 hard gate enforces this server-side'",
       r"Track 2 hard gate enforces this server-side")
forbid("16b no 'audit table captures .* how the founder ultimately resolved'",
       r"captures every\s*\n?\s*allow / deny \+ how the founder ultimately resolved")
forbid("16c no loosening via Track 2 configuration knobs",
       r"happens\s*\n?centrally via the Future autonomy roadmap section below, the Track 2\s*\nconfiguration knobs")
DEPT = io.open(B + 'department-lead-rules.md', encoding='utf-8').read()
forbid("16d dept no longer says 'close the Runner the normal way'",
       r"close the Runner the normal way", DEPT)
forbid("16e patrol no longer says bare 'wrap up \\+ close'",
       r"wrap up \+ close", PATROL)

print("PASS (%d):" % len(ok))
for x in ok:
    print("   +", x)
if bad:
    print("\nFAIL (%d):" % len(bad))
    for x in bad:
        print("   -", x)
    sys.exit(1)
print("\nall assertions green")
