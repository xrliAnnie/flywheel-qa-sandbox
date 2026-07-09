# Flywheel Setup Notes

## macOS Automation Permission (First Run)

Flywheel spawns a per-Runner macOS Terminal.app viewer tab. The first time
the Bridge runs `osascript` to talk to Terminal, macOS will show:

> **"Flywheel" wants to control "Terminal"**
> *Allow* / *Don't Allow*

Click **Allow** once. macOS remembers the grant and won't ask again.

If you click *Don't Allow*, dead Runner tabs will not auto-close, but
Flywheel will still work — the `osascript` failure logs a warn and never
blocks the main flow.

To inspect or change the grant:

> System Settings → Privacy & Security → Automation → Flywheel → Terminal

## Why this exists (FLY-116)

Flywheel manages each Runner with a per-execution macOS Terminal tab whose
custom title encodes the runner's identity (`flywheel:runner:<sessionName>:
<projectName>:<executionId>:<windowId>[:<sessionRole>]`). When the runner
finishes successfully (or the user explicitly rejects/defers/shelves/
terminates), Flywheel closes that exact tab. Runners that crash (status
`failed` or `blocked`) keep their tab open so you can attach and inspect
scrollback.

A one-shot startup reaper also closes orphan tabs left over from prior
runs (e.g. after a macOS reboot restored Terminal tabs for runners whose
state had ended).

## Nightly Report Env (FLY-925 / FLY-1049)

Two env vars in `~/.flywheel/.env` are required for the nightly launchd jobs
and are easy to lose on a fresh machine — FLY-925 was exactly this failure
(both jobs failing silently every night):

- `FLYWHEEL_BRIDGE_URL=http://localhost:9876` — required by `flywheel-comm
  publish-report`. Without it the 00:30 token-usage report aggregates and
  renders fine but never delivers (`delivered:false` in
  `/tmp/flywheel-token-usage-daily.log`). The script sources `.env` on every
  run, so adding the line takes effect without any restart.
- `STANDUP_PROJECT_NAME=<projectName>` — required on multi-project setups.
  Must exactly match a `projects.json` `projectName` (production:
  `geoforge3d`, the project that carries `STANDUP_LEAD_ID=cos-lead`). Unset →
  the Bridge disables standup at boot and the 03:00 trigger fails with HTTP
  4xx (curl exit 22). Read at Bridge boot — needs a Bridge restart to take
  effect.

The full FLY-915 enable-window env table (alert routing/tickets, infra-bot
identities, account self-heal, notify digest) lives in
`engineering/doc/FLY-1049-fly915-alerts-closeout/enable-window-runbook.md` —
single source, not duplicated here. Runtime-switch index:
`doc/architecture/infra-alerts-spec.md` §11.
