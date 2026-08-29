# FLY-77 Discord Channel Cleanup — Evidence

**Initial archive**: 2026-05-04 by worker-fly-77 via Chrome MCP
**Final pivot to delete**: 2026-05-05 by Annie via Discord UI (manual)
**Discord guild**: `1485787271192907816` (claude's server)

## Final state (2026-05-05)

All 3 per-Lead control channels are **permanently deleted**. Control category is empty (pending Annie's optional cleanup of the empty category container).

| Channel ID | Original name | Final state |
|---|---|---|
| `1486419006540742769` | `product-lead-control` | DELETED |
| `1486419059267342459` | `ops-lead-control` | DELETED |
| `1487340752995487865` | `cos-lead-control` | DELETED |

Verified via Chrome MCP (`mcp__claude-in-chrome__find` + page screenshot) on 2026-05-05: channel tree of `claude's server` no longer contains any channel matching `*-control` or `archived-*-control`. Control category remains as empty container.

`crosslink-control-room` listed in plan §4.1 was searched in the channel tree on 2026-05-04 — **does not exist** in this guild. Either it was already removed earlier, or the plan reference was speculative.

## Decision pivot — archive → delete

**2026-05-04 archive (worker-fly-77 via Chrome MCP)**:
1. Renamed each channel to `archived-{original-name}` (Save Changes via Discord channel settings → Overview)
2. From Permissions tab, removed all non-Annie members from the access list (each channel had `Private Channel` toggle = ON, so removing ClaudeBot + the corresponding Lead bot left Annie as the sole viewer)

**2026-05-05 pivot (Annie manual via Discord UI)**:
> Annie: "没用的东西留着干什么"

Annie reviewed the archived state and pivoted to permanent deletion. Per Claude's safety rules, agents are prohibited from permanent destructive actions (`<prohibited_actions>`: "Permanent deletions ... emails, files, or messages") even with explicit user authorization. So Annie performed the deletes herself via Discord's right-click → Delete Channel → name confirmation flow.

Result: history permanently lost (acceptable per Annie's call — the channels held only bot-emitted machine events from FLY-47 era, no human conversation worth preserving).

## Original archive details (kept for audit)

**[Superseded by 2026-05-05 delete pivot above. The following details describe the intermediate archive state that existed for ~24h.]**

All 3 per-Lead control channels archived following plan §4. Approach (per plan §1.2 audit): Discord has no native "Archive" — equivalent is rename + remove bot access (channel is already a Private Channel by default, so removing all members except Annie hides it from everyone except the owner).

| Original name | Channel ID | New name | State after |
|---|---|---|---|
| `product-lead-control` | `1486419006540742769` | `archived-product-lead-control` | Members: Annie only (ClaudeBot + Peter - Product Lead removed) |
| `ops-lead-control` | `1486419059267342459` | `archived-ops-lead-control` | Members: Annie only (ClaudeBot + Oliver - Ops Lead removed) |
| `cos-lead-control` | `1487340752995487865` | `archived-cos-lead-control` | Members: Annie only (ClaudeBot + Simba - Chief of Staff removed) |

Note: `crosslink-control-room` listed in plan §4.1 was searched in the channel tree — **does not exist** in this guild. Either it was already removed earlier, or the plan reference was speculative. Only the 3 numeric channel IDs from plan §2.3 / §4.1 corresponded to real channels.

## What was changed per channel

For each channel, two edits were made via Discord channel settings:

1. **Overview tab → Channel Name** changed to `archived-{original-name}` (e.g., `archived-product-lead-control`). Saved.
2. **Permissions tab → Members** — every entry except `Annie (Server Owner)` was removed (red ✕ + confirm "Delete Permission Settings" dialog). Channel was already toggled "Private Channel" so only listed members can view; removing the Lead bot + ClaudeBot leaves Annie as the sole viewer.

Result: history preserved, channel hidden from everyone except Annie, no bot has read/write access (including ClaudeBot which used to be the FLY-47 era control-channel transport).

## Verification

Final state from cos-lead-control archive completion:

- **Left sidebar** (Control category) now lists three channels in order:
  - `# archived-product-lead-control`
  - `# archived-ops-lead-control`
  - `# archived-cos-lead-control` (selected when screenshot taken)
- **Channel header** title bar reads `# archived-cos-lead-control`
- **Online sidebar** drops from "Online — 2" (which previously showed Annie + the Lead bot) to "Online — 1" (Annie only), confirming Lead bots no longer have view access on this channel
- **Message input placeholder** shows `Message #archived-cos-lead-control`, confirming rename took effect server-side

Visual evidence captured inline during the worker session via Chrome MCP screenshots; not persisted as JPEGs in this directory because the `save_to_disk` flag of the screenshot tool returns the image inline to the agent rather than writing to the project filesystem. Full visual proof is preserved in the worker session transcript.

## Operator-state cleanup script

Annie still needs to run `bash scripts/cleanup-fly-77-config.sh` (in this PR) before the first restart-services after merge. The script strips:
- `CLAUDEBOT_TOKEN` from `~/.flywheel/.env`
- Legacy `~/.flywheel/projects.json.bak{,2}`
- Per-Lead `access.json` group entries for control channel IDs + ClaudeBot user ID

The script is idempotent (per Codex Round 2 verification) and complements the Discord-side work captured here.
