# runner-msg-guard — Lead → Runner messages only through the Mailbox (FLY-3083)

Design: `engineering/doc/FLY-3083-lead-runner-mailbox-only/plan.md`.

## What it does

A PreToolUse hook (matcher `SendMessage`) in every Claude cos / dept Lead session.
When the recipient's native inbox file would be `runner-<8hex>` (the name is judged
after mirroring stock `sanitizePathComponent`, so `runner/42afa86c`,
`Runner-42AFA86C`, `runner 42afa86c` … count too) or the recipient is the broadcast
`*`, the call is **denied** and the reason carries a shell-safe
`flywheel-comm send --from <lead> --to runner-<8hex> -- <full body>` command.
Everything else passes untouched (fail-open on bad input).

`flywheel-comm send --to` accepts the `runner-<8hex>` short name (resolved against
the sending Lead's sessions, fail-closed on 0 or >1 matches) and `send --json`
reports `transport_write` (`ok` / `skipped` + reason / `error` + `wake_error`).

## Files

| Path | Role |
|---|---|
| `scripts/hooks/flywheel-runner-msg-guard.py` | hook source (stdlib only) |
| `scripts/hooks/install-runner-msg-guard.sh` | the ONE installer (install / converge / uninstall) |
| `<FLYWHEEL_STATE_DIR\|~/.flywheel>/bin/flywheel-runner-msg-guard.py` | stable copy the settings entry runs |
| `<LEAD_WORKSPACE>/.claude/settings.local.json` | where the entry lives (per Lead) |
| `<FLYWHEEL_STATE_DIR\|~/.flywheel>/logs/runner-msg-guard.log` | audit (one JSON line per deny, no message body) |

## Why Lead-local settings

- A Lead runs with `cd "$LEAD_WORKSPACE"`; project-local hooks merge with user hooks,
  and the hook still applies under `--permission-mode bypassPermissions`.
- The global `~/.claude/settings.json` depends on `CLAUDE_CONFIG_DIR` (a profile can
  land the entry in the wrong file) and has several unrelated writers without a
  shared lock.
- Each workspace has exactly one launcher writer, and the installer uses the same
  `<settings>.flywheel-lock` mkdir spinlock as `claude-lead.sh` (60s stale, 10s give-up
  → exit 3, nothing written).

## Install / converge / uninstall

- Automatic: `claude-lead.sh` converges the entry on every cos / dept Lead start,
  inside the settings.local lock (`--lock-held`). Companion and external Leads skip it.
  Failure is a non-fatal WARN.
- Manual:
  ```bash
  bash scripts/hooks/install-runner-msg-guard.sh --settings <lead-workspace>/.claude/settings.local.json
  bash scripts/hooks/install-runner-msg-guard.sh --settings <…> --uninstall
  ```
  `--settings` defaults to `$LEAD_WORKSPACE/.claude/settings.local.json`.
  Uninstall removes only that file's entry; the stable script stays (other Leads use it).
- Check: `jq '.hooks.PreToolUse' <lead-workspace>/.claude/settings.local.json`.

## Switch and rollback

- Per-session switch: `FLYWHEEL_RUNNER_MSG_GUARD=0` in the Lead's environment → the
  hook allows everything. There is no inline bypass syntax.
- Rollback order: uninstall the hook **before** reverting the `send` changes — the
  deny reason's command uses the short-name `--to` and the `--` separator.

## Boundaries

- Codex Leads have no `SendMessage` tool; their `codex queue --remote` / `codex resume`
  steering bypass is forbidden by the Runner channel contract text only (mechanical
  interception is a follow-up).
- Packaged (npm) Leads: the hook scripts are not in the payload (same as the restart
  guard); the launcher WARNs and the contract text still applies.
- The hook never reads the team roster: a Flywheel Lead session's broadcast is always
  denied (a roster exemption would race a Runner registering mid-send). Non-Runner
  teammates are messaged one by one.
