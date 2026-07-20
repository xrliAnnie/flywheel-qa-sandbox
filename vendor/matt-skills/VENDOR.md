# matt-skills — FLY-1356 B-arm frozen vendor

**Upstream**: https://github.com/mattpocock/skills
**Pinned commit**: `9603c1cc8118d08bc1b3bf34cf714f62178dea3b` (the FLY-1326 intel pin, PR #629 R6-approved)
**License**: MIT (upstream `LICENSE` preserved verbatim in this directory)
**Vendored**: 2026-07-20 (FLY-1356 implement)

The B arm (`skill_framework_mode=matt`) of the FLY-1356 three-way split. The
arm definition is FROZEN at this commit — do NOT track upstream; a B-arm
content change would invalidate the running eval. Post-eval adoption (if B
wins and Annie approves) moves to a proper FLY-216 machine-level vendor in a
separate issue.

## Vendored subset (FLY-1326 plan §2)

| Skill | Upstream path | Modification |
|---|---|---|
| `tdd` | `skills/engineering/tdd/` | verbatim (incl. `mocking.md`, `tests.md`) |
| `code-review` | `skills/engineering/code-review/` | verbatim |
| `grilling` | `skills/productivity/grilling/` | verbatim |
| `diagnosing-bugs` | `skills/engineering/diagnosing-bugs/` | verbatim (incl. `scripts/hitl-loop.template.sh`) |
| `to-spec` | `skills/engineering/to-spec/` | frontmatter: `disable-model-invocation: true` REMOVED |
| `to-tickets` | `skills/engineering/to-tickets/` | frontmatter: `disable-model-invocation: true` REMOVED |

Deliberately NOT vendored: `agents/openai.yaml` per skill (Codex-runner
metadata; the B arm only fires for claude-tmux — non-claude backends are
`noop_backend` by design), and every other upstream skill (out of the frozen
subset).

### Frontmatter diff (the ONLY content change)

`to-spec/SKILL.md` and `to-tickets/SKILL.md`: the single line
`disable-model-invocation: true` was removed from the YAML frontmatter.
Upstream marks these two slash-command-only; the B arm needs the model able to
invoke them from the four-step flow in `agents/generic-executor.matt.md`
(brainstorm→grilling, plan→to-spec/to-tickets, TDD→tdd, self-check→code-review).
Headless behavior of the flipped skills is a 529-derisk observation item
(FLY-1326 U4) — deliberately observed in the eval, not pre-fixed here.

## File integrity (sha256 of the vendored bytes, post-modification)

```
0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5  LICENSE
6a65cc61114f96db07ec41e3920e67c9c5bf70dd6e0901eb9460ebcb2bdc209f  skills/code-review/SKILL.md
7a0779480f323a66d109404646bcc1a14bf0232b45b3e3ea93b652a035718acb  skills/diagnosing-bugs/SKILL.md
b2932630950e5210075bcd6f850e5accf30c101c5367b29eac3a29b4dd8084c8  skills/diagnosing-bugs/scripts/hitl-loop.template.sh
44331dda57f461db4fec3f2efb6ddabe7aaaa0a57ae0f88a883bc61aed8a0587  skills/grilling/SKILL.md
5363bb2775679fe9311fbb67947f95359169c6e7f1fac77c0f25e190bca6cf2f  skills/tdd/SKILL.md
3ceb807fdf4a47d6a93d4d9a891e5ba6d362a6247bd08adc451feebfc17361ef  skills/tdd/mocking.md
859f9e592c188fda4fc7277dd180e4ce9c7a2e13f6efe1f6f29eccc9d28c106a  skills/tdd/tests.md
8fe699e2b6e3ab487609ed38f6236dd77820595549beee6d3c6e632fd9307e5f  skills/to-spec/SKILL.md
18510e4a001c22cfc22d86fe4dfdf839c5a66df62a341e3e81991ffb618f1af7  skills/to-tickets/SKILL.md
```

## Security review (FLY-1356 Task 7 checklist — every file read in full)

- [x] No network exfiltration instructions. The only network references are
  benign: `diagnosing-bugs` mentions curling a LOCAL dev server as a repro
  technique; `tdd/mocking.md` uses `fetch()` in mocking EXAMPLES.
- [x] No credential / secret / key handling anywhere in the six skills.
- [x] No destructive shell patterns (`rm -rf`, `sudo`, force-push, etc.).
  `diagnosing-bugs/scripts/hitl-loop.template.sh` was read line-by-line: a
  pure prompt/read loop (`step`/`capture` helpers) that echoes captured
  values — no side effects beyond stdout.
- [x] `to-spec`/`to-tickets` "publish to the issue tracker" sections retained
  as-is (arm definition); the matt executor variant explicitly wires them to
  our Linear conventions, and their headless behavior is a 529 observation
  item (FLY-1326 U4).

## Install (deployment surface — NOT executed at merge)

`scripts/setup-matt-skills.sh` — idempotent: local marketplace add + user-scope
install as `matt-skills@matt-skills` + machine-level default DISABLED. Runners
only ever see the plugin through Blueprint's per-launch `--settings` enable
(mode=matt). The Blueprint readiness probe never caches a negative, so running
the setup script mid-lifetime takes effect on the next matt-resolved run
without a Bridge restart.
