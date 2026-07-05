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
