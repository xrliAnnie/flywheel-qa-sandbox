# Lead MCP Setup — Operator Guide (FLY-143+)

**Audience**: Annie + future operators rolling out Lead daemons.
**Last updated**: 2026-05-06 (FLY-143 v1.26.0 ship)

This guide covers the MCP servers a Lead daemon (Peter / Oliver / Simba / test slots) gets at startup, the env vars required for each, and the per-Lead opt-in/out controls.

## Where MCP servers come from

A Lead session ends up with the union of three independent sources:

1. **Flywheel-infra MCP** — written by `claude-lead.sh` into `<workspace>/.mcp.json`. Always 3 servers: `flywheel-terminal`, `flywheel-inbox`, `gbrain`. Same-name collisions with user-scope servers are won by these (see §"Reserved names" below).
2. **Inherited user-scope MCP** — same `.mcp.json`, populated by FLY-143's helper from the **top-level** `~/.claude.json.mcpServers` (never `.projects[*].mcpServers`).
3. **Plugin-bundled MCP + claude-in-chrome** — loaded by Claude Code itself based on installed plugins under `~/.claude/plugins/` and the `--chrome` CLI flag.

Final file mode is **0600** (atomic write via mktemp + chmod + mv) — both old and new fields.

## Required env vars (per server)

The helper scans each user-scope server's config for `${VAR}` placeholders and **skips that server** if any required var (no `:-default`) is unset. Other servers continue to load.

| Server | Required env | Where to set |
|--------|--------------|--------------|
| `linear-api` | `LINEAR_API_KEY` (Linear PAT) | `~/.flywheel/.env` (chmod 600) |
| `bambu-h2d` | (literal in config — no env needed today) | n/a |
| `xiaohongshu-mcp` | none | n/a |
| `pencil` | none | n/a |
| `audible` | personal token in config | n/a (default-skipped — see §"Blacklist") |

> **Important**: missing `LINEAR_API_KEY` will **only** skip `linear-api`, not break the other servers. Pre-FLY-143 it could break the entire MCP config parse.

> **Env propagation note**: `claude-lead.sh` scans the generated `.mcp.json` for `${VAR}` placeholders and forwards each one through `tmux new-window -e` so the Lead's Claude process actually sees the value. (Without this, tmux silently inherits an empty environment for any var not explicitly listed, so Claude marks the server "needs authentication" even when `LINEAR_API_KEY` is exported in the launcher's shell.) New user-MCP servers needing env vars don't require launcher changes — the scan picks them up automatically.

## First-time `~/.flywheel/.env` setup

```bash
# Add Linear PAT (Lead-dedicated, read-only is safest)
echo 'export LINEAR_API_KEY="lin_api_xxxxxxxx"' >> ~/.flywheel/.env

# Lock down permissions (not just for FLY-143 — also protects OPENAI_API_KEY etc)
chmod 600 ~/.flywheel/.env
```

After editing `~/.flywheel/.env`, restart the affected Lead via `restart-services.sh` or the per-Lead launchctl reload.

## Blacklist (default-skipped servers)

Class-deny: personal media / personal account MCPs. v1 list:

- `audible` (Annie's listening history)

The blacklist lives in `claude-lead.sh` as `LEAD_USER_MCP_BLACKLIST` (defaults to `audible`, override with the `FLYWHEEL_LEAD_MCP_BLACKLIST` env var if you ever need to test). Future personal/account MCPs should be added here, not selectively excluded per-Lead.

## Per-Lead exclude (manifest)

Some Leads should not see all user-scope MCPs even if they're inherited globally. Add an `mcpExclude` field (comma-separated) to the Lead's manifest at `~/.flywheel/manifests/<project>-<lead>.json`:

```json
{
  "leadId": "cos-lead",
  "projectName": "geoforge3d",
  "mcpExclude": "bambu-h2d,xiaohongshu-mcp,pencil",
  "...other fields...": "..."
}
```

Whitespace around commas is tolerated. Recommended starting points:

| Lead | `mcpExclude` |
|------|--------------|
| Simba (cos-lead) | `bambu-h2d,xiaohongshu-mcp,pencil` (triage only — no ops/publishing/design) |
| Oliver (ops-lead) | `pencil,figma` (ops focus — no design tools) |
| Peter (product-lead) | `bambu-h2d` (product/design — does not control printer) |
| flywheel-test-N | (empty — test framework needs full inheritance) |

After editing, restart that Lead.

## Reserved names

These three names always belong to Flywheel infra. Annie's user-scope MCP with the same name is **logged + skipped** (never silently overridden):

- `flywheel-terminal`
- `flywheel-inbox`
- `gbrain`

You'll see a warning in the Lead startup log if there's a collision.

## Claude in Chrome (`--chrome`)

**Default OFF**. Enabling gives a Lead access to Annie's logged-in Chrome session via the Chrome extension + native messaging path.

⚠️ **Security boundary**: `--chrome` + `--permission-mode bypassPermissions` together set `CLAUDE_CHROME_PERMISSION_MODE=skip_all_permission_checks` (verified in upstream `setup.ts:101-104`). The Lead operates in your real Chrome session without per-site prompts.

To enable for a specific Lead:

```json
{
  "leadId": "product-lead",
  "chromeEnabled": true,
  "...other fields...": "..."
}
```

Or for one-off testing without touching the manifest:

```bash
FLYWHEEL_LEAD_CHROME_ENABLED=true ./packages/teamlead/scripts/claude-lead.sh ...
```

Recommended rollout: start with one test slot (`flywheel-test-1`), confirm Chrome behavior matches expectation, then enable per-Lead based on actual need (Peter most likely; Simba almost certainly not).

## Verifying after a restart

In the Lead's Discord channel:

```
/mcp
```

Expected: `flywheel-terminal`, `flywheel-inbox`, `gbrain`, plus inherited user-scope servers (depending on env + per-Lead exclude). Any server that failed env gate or got blacklisted shows up in the Lead daemon log under `[lead]` lines, not in `/mcp`.

To smoke-test Linear access:

```
mcp__linear-api__get_issue("FLY-143")
```

Should return the real Linear issue body. 401 means LINEAR_API_KEY is wrong scope; "no such tool" means linear-api didn't load (check `~/.flywheel/.env` and tail `/tmp/flywheel-lead-<project>-<lead>.log`).

## Runner inheritance (FLY-143b — follow-up)

The same broader-inherit story is needed for Runners. FLY-143 main PR ships Lead-only; Runner inheritance lands in FLY-143b once the Runner spawn path is audited. For now, Runners only see whatever auto-discovery their CWD provides.

## Troubleshooting

- **Lead `/mcp` shows fewer servers than expected** → tail `/tmp/flywheel-lead-<project>-<lead>.log` for `User MCP skipped (...)` and `WARNING: ... requires env ... — skip` lines.
- **`.mcp.json` mode is not 0600** → confirm you're running the FLY-143 build (`grep "mode 0600, atomic" /tmp/flywheel-lead-*.log`); pre-FLY-143 the file was 0644.
- **Collision warning unexpectedly** → Annie has a top-level `mcpServers` entry whose name matches `flywheel-terminal` / `flywheel-inbox` / `gbrain`. Rename hers in `~/.claude.json` to anything else.
- **Chrome flag unexpectedly active** → check `~/.flywheel/manifests/<...>.json` for `chromeEnabled: true` or the wrapper env. The launch log will say `Claude in Chrome: ENABLED`.
