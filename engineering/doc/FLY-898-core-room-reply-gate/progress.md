---
issue: FLY-898
phase: implement
phaseCursor: 5/9
updated: 2026-07-06
nextStep: core-room-gate-cli.ts + apply-core-room-mention-gate.sh + launcher wiring
chunks: []
pointers:
  preflight_source: "check-discord-plugin.sh is ops-side (~/.flywheel/bin/, NOT repo-tracked). No installer source in repo. FLY-898 preflight is SELF-CONTAINED in the repo-tracked helper apply-core-room-mention-gate.sh (greps marketplace server.ts for the per-group marker) → no dependency on modifying the untracked ops script. Optionally the ops check-discord-plugin.sh can be extended too during rollout, but the helper's self-check is authoritative."
  plugin_fork_repo: "~/.flywheel/repos/claude-plugins-official (remote xrliAnnie/claude-plugins-official). server.ts at external_plugins/discord/server.ts. Synced to marketplace runtime via ~/.flywheel/bin/update-discord-plugin.sh. Separate PR."
---

# FLY-898 progress (implement)
**phase**: implement (1/9)
**next**: TDD core-room-gate.ts pure fn

## Implement plan (9 chunks, TDD each)
1. core-room-gate.ts pure fn (resolveCoreRoomGate) + table-driven test
2. mention-gate.ts: coreStrictChannelIds + isIdMentioned + reply-to-self (referencedAuthorId) + test
3. DiscordInboundMessage.referencedAuthorId + RestPoll mapping (referenced_message.author.id) + test
4. codex-lead-runtime.ts: coreMentionGated config + wiring + dry-run line + test
5. codex-lead-tui-runtime.ts: same wiring (shared dryRunReport) + test
6. core-room-gate-cli.ts node CLI (--lead-id/--project single + --all JSONL) + test
7. apply-core-room-mention-gate.sh (bash helper, mirror add-roundtable-allowfrom.sh + optimistic rebase + preflight self-check + --all) + test
8. claude-lead.sh startup patch + codex-lead.sh gateNonCoS env
9. cross-dept-channel-rules.md doc + plugin fork server.ts (separate repo)

## Decisions locked (implement)
- resolveCoreRoomGate(project, lead): gateNonCoS = generalChannel set AND some lead chat==core (projectHasCoS) AND this lead chat!=core. joycon (core-no-CoS) → projectHasCoS=false → gateNonCoS=false (fail-open).
- reply-to-self scoped to isIdMentioned (core id-only) ONLY — isMentioned (roundtable) stays byte-identical (①② then ③, no reply-to-self added).
- Codex: coreMentionGated env FLYWHEEL_LEAD_CORE_MENTION_GATED=1, EFFECTIVE only when coreChannelId set AND in channelIds (guardrail #1). Wired via coreStrictChannelIds → buildMentionGate. NOT into crossDeptChannelIds (avoid bridge-mode 403 throw + reply-routing).
- Preflight self-contained in helper (guardrail #2/#3): mention-required-only (requireMention:true only) vs id-only-core (+ mentionPatterns:[]). id-only fields written ONLY when marketplace server.ts has per-group marker.
