# tidal-echo — cutover runbook (LIVE, founder-gated)

**Issue**: FLY-284 (Onboard a brand-new project from scratch via Flywheel)
**日期**: 2026-06-17
**基于**: `doc/engineer/plan/inprogress/v1.49.0-FLY-284-from-scratch-onboard.md`

> ⚠️ Everything here is **LIVE / irreversible** and must be run **with Annie
> present and approving** (FLY-175 founder-only-authority). NONE of it is done by
> `setup-new-project.sh` — that script only writes the filesystem scaffold and
> prints these steps. Order matters (FLY-270: projects.json-first → manifest →
> install plist).

## What was already decided (locked with Annie)

- Project = **tidal-echo** · CoS = **Triton** · Content Lead = **Ariel** ·
  2-layer from day one.
- Linear = **dedicated team `TIDE`** (issue keys `TIDE-NN`).
- GitHub repo = **Runner runs `gh repo create`** at cutover (Annie's gh is logged in).

## Files in this package → destination at cutover

| This package file | Destination |
|---|---|
| `config.yaml` | `~/Dev/tidal-echo/.flywheel/config.yaml` |
| `registry.yaml` | `~/Dev/tidal-echo/.flywheel/agents/registry.yaml` |
| `content.md` | `~/Dev/tidal-echo/.flywheel/agents/nodes/content.md` |
| `cos-lead.identity.md` (Triton) | `~/Dev/tidal-echo/.lead/tidal-echo-cos-lead/identity.md` |
| `content-lead.identity.md` (Ariel) | `~/Dev/tidal-echo/.lead/tidal-echo-content-lead/identity.md` |
| projects.json entry (inline below) | merge into `~/.flywheel/projects.json` |

> `config.yaml` + `registry.yaml` + `content.md` are exactly what `setup-new-project.sh
> tidal-echo content --team TIDE --two-layer --cos-persona Triton --dept-persona
> Ariel` generates. The two `*.identity.md` files here are the **bespoke**
> tidal-echo Leads (richer than the script's skeleton) — use these.

### projects.json entry (DRAFT — machine-local, added by hand at cutover)

Mirrors the canonical 2-layer CoS+dept shape (flywheel's own Aunt Cass + Tadashi
entry). NOT written by any script. Fill every `<…>` placeholder after the Discord
bots/channels exist. `memoryAllowedUsers` is required (memory validation is
fail-closed).

```jsonc
{
  "projectName": "tidal-echo",
  "projectRoot": "/Users/xiaorongli/Dev/tidal-echo",
  "projectRepo": "xrliAnnie/tidal-echo",
  "memoryAllowedUsers": ["annie", "tidal-echo-cos-lead", "tidal-echo-content-lead", "tidal-echo"],
  "leads": [
    {
      // Triton — Chief of Staff. canSpawnRunners:false. Launchd plist MUST set
      // FLYWHEEL_LEAD_ROLE=cos (separate from this file).
      "agentId": "tidal-echo-cos-lead",
      "chatChannel": "<#tidal-echo-core channel id>",
      "match": { "labels": ["Tidal-Echo-Triage"] },
      "botTokenEnv": "TRITON_BOT_TOKEN",
      "canSpawnRunners": false,
      "alertFallbackToCore": true
    },
    {
      // Ariel — Content Lead. Spawns content Runners.
      "agentId": "tidal-echo-content-lead",
      "chatChannel": "<#tidal-echo channel id>",
      "alertChannel": "<#tidal-echo channel id>",
      "match": { "labels": ["Tidal-Echo"] },
      "botTokenEnv": "ARIEL_BOT_TOKEN",
      "department": "content",
      "canSpawnRunners": true
    }
  ],
  // Core channel = CoS channel (reply-guard exempt; alert fallback target).
  "generalChannel": "<#tidal-echo-core channel id>"
}
```

## Annie-manual (only Annie can do)

1. **Create 2 Discord bots** (Triton, Ariel): developer portal → app → enable
   Server Members + Message Content intents → record token → invite to the
   server (2FA). Follow `/setup-discord-lead` (I can write the exact click-by-click
   checklist and sit with you).
2. **Create channels**: `#tidal-echo-core` (CoS/core) + `#tidal-echo` (content).
   Record both channel ids.
3. **Tokens → `~/.flywheel/.env`**: `TRITON_BOT_TOKEN`, `ARIEL_BOT_TOKEN`.
4. **Approve** the live cutover sequence below.

## Cutover sequence (LIVE — §7 order)

1. `bash flywheel/scripts/setup-new-project.sh tidal-echo content --team TIDE \`
   `  --two-layer --cos-persona Triton --dept-persona Ariel`
   (creates `~/Dev/tidal-echo` + scaffold; safe, filesystem-only). Then drop in
   the two bespoke `*.identity.md` files from this package.
2. `gh repo create xrliAnnie/tidal-echo --private` → initial commit → push.
3. **Linear**: create team `TIDE` + labels `Tidal-Echo` (content) and
   `Tidal-Echo-Triage` (CoS). (Optional: a "Tidal Echo" project for grouping.)
4. Fill bot ids / channel ids into the two identity files; fill channel ids into
   the projects.json entry; confirm tokens are in `~/.flywheel/.env`.
5. **Edit live `~/.flywheel/projects.json`** — add the tidal-echo entry
   (`projects.json-entry.jsonc`), incl. `memoryAllowedUsers` (fail-closed).
6. Run `claude-lead.sh` once per Lead to generate + validate the manifest, then
   stop that manual process.
7. Install/reload the 2 launchd plists. The **CoS plist MUST set
   `FLYWHEEL_LEAD_ROLE=cos`** (verify: `launchctl print … | grep FLYWHEEL_LEAD_ROLE`).
8. **Restart the Bridge** (batch with any in-flight Bridge PRs — ask team-lead
   first).
9. **Verify**: both bots show online + reply in their channels + Annie has a real
   chat with Triton in `#tidal-echo-core` and with Ariel in `#tidal-echo`.

## Rollback

Each step is independently reversible before the Bridge restart: delete the
projects.json entry / unload the plists / delete the repo+team. After restart,
bots can be taken offline by unloading the plists and removing the projects.json
entry, then restarting the Bridge.
