# Lead TUI Prompt Fixtures — FLY-83

Each `.txt` fixture in this directory contains raw bytes mimicking a Claude
Code TUI frame (ANSI colour escapes interleaved between words, Ink-style).
They feed `scripts/test-expect-prompts.sh`, which spawns the expect wrapper
from `claude-lead.sh` against `cat $fixture` and asserts the exit code.

| File | Purpose | Expected exit |
|------|---------|---------------|
| `rate-limit.ansi`       | "rate limit reached, try again" banner    | 100 |
| `usage-limit.ansi`      | "usage limit reset in 1h" banner           | 100 |
| `login-expired.ansi`    | "login expired, reauth required" prompt   | 101 |
| `permission-file.ansi`  | "permission required to write file /tmp"  | 102 |
| `normal-running.ansi`   | no blocked keywords — Claude idle output  | 0   |

Regenerate fixtures with `scripts/generate-lead-prompt-fixtures.sh`.

Because `cat` is not interactive, the dev-channels / compact *auto-confirm*
paths are **not** covered by these fixtures — those rely on a live child
that reads from stdin. Auto-confirm coverage comes from end-to-end runs on
real Claude Code under FLY-96 test slots.
