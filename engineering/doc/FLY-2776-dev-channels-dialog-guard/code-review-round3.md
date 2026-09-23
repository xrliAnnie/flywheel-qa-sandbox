# Code Review — FLY-2776 (Round 3, scoped verification)
Date: 2026-09-23
Review target: 9d4fb582c35bba1e5d08eb7f6307b4c60bb0937d
**Status: APPROVED**

## Question 1 — composer veto load-bearing

Clean.

Static verification of `scripts/__tests__/fly1679-dev-channels-v2.test.sh`:

- P15's fixture renders the option row, exit row, modal footer, and wrapped body sentence unprefixed on their own lines, followed by a live composer containing `⏵⏵`.
- The fixture has zero `> `-prefixed dialog rows. Its line-anchored option row, squashed body sentence, modal footer, and composer indicator each independently match.
- P15b derives the no-composer variant from the same fixture by removing only the line containing `⏵⏵`, and requires `present`.
- P15c deletes the shipped composer's three-line veto, fails explicitly if the mutation does not change the predicate, and requires `mutant=present` plus `shipped=absent`.

Independent measurement, using `_dev_channels_squash_ws` and `_dev_channels_dialog_present` extracted directly from `packages/teamlead/scripts/claude-lead.sh`, P15's fixture extracted directly from the test, and the same `sed` mutation as P15c:

```text
shipped_p15=absent
mutant_p15=present
shipped_no_composer_variant=present
mutant_no_composer_variant=present
```

The mutation was not a silent no-op: the shipped predicate contained exactly one matching veto line, the mutant contained zero, and the mutant text differed from the shipped predicate. Deleting the veto alone flips P15 from `absent` to `present`; the composer veto is load-bearing.

## Question 2 — overview comment vs implementation

Clean. The overview above `_dev_channels_dialog_present` now says that all three independently checked evidence classes are required:

1. a line-anchored option row;
2. `MODALITY`, consisting of the modal footer being present and the `⏵⏵` composer indicator being absent;
3. one accepted body sentence after whitespace squashing.

That matches the implementation. The overview also accurately says the caret is optional and that line anchoring, rather than caret presence, is the relevant constraint; the regex implements the caret as the optional group `(❯[[:space:]]+)?`. The comment does not claim an additional predicate requirement or capability that the function lacks.

## Verification

- Confirmed `git rev-parse HEAD` is `9d4fb582c35bba1e5d08eb7f6307b4c60bb0937d`.
- Independently extracted and executed the shipped and mutated predicates against P15 and its no-composer variant; measured the four values recorded above.
- Confirmed the P15c mutation applies: source veto hits `1`, mutant veto hits `0`, predicate changed `yes`.
- Ran `FLY1679_SELFTEST_CHILD=1 /bin/bash scripts/__tests__/fly1679-dev-channels-v2.test.sh`: exit `0`, `48 passed, 0 failed`; P15, P15b, and P15c all reported `PASS`. The environment-denied raw-TTY E layer was explicitly skipped by the suite and is outside these two scoped questions.
- No repository file was modified.
