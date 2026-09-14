# @flywheel-ai/onboard

One command to install and start Flywheel. You'll need a license key.

## Install

```
npx @flywheel-ai/onboard
```

You'll be asked to paste your license key (it won't show on screen — that's
normal). The installer downloads the packaged runtime, verifies it, and starts
the guided setup. No source code or repository access is required.

## Update

```
npx @flywheel-ai/onboard update
```

## Change your license key

```
npx @flywheel-ai/onboard license set
```

---

Requires Node.js 20+. This package is distributed to licensed Flywheel
customers.

## Automatic updates

After installation, Flywheel checks for releases every six hours. It installs
updates during a local time window starting at 03:00 and lasting two hours.
Updates restart Flywheel services; this version does not detect active meetings
or other ongoing work. Choose a quiet installation window.

```sh
npx @flywheel-ai/onboard auto-update status
npx @flywheel-ai/onboard auto-update off
npx @flywheel-ai/onboard auto-update on
```

`on` installs the update timer and runs a first check. On an older installation,
run `update` first if the command says automatic updates are not supported yet.
If enabling fails, automatic updates stay off. `status --json` provides a
machine-readable summary.

To change the schedule, create `~/.flywheel/auto-update.json`:

```json
{"schemaVersion":1,"checkEveryHours":6,"applyHour":3,"applyGraceHours":2}
```

`checkEveryHours` accepts 1, 2, 3, 4, 6, 8, 12, or 24; `applyHour` accepts 0–23;
`applyGraceHours` accepts 1–6. Run `auto-update on` after editing the schedule to
refresh the timer. Invalid settings fall back to the defaults.

If an update fails its immediate restart check, Flywheel restores the previous
local version when available. An unhealthy version may be retried once after
one hour; after two failed attempts, automatic installation stays paused for
that version. If no working previous version exists, the command reports a
recovery failure. It does not report a successful rollback.

A centrally withdrawn release cannot be downloaded again. If a replacement
release is available, an enabled updater can move away from a withdrawn version
outside the usual installation window. If releases are paused centrally, your
current installation stays in place.

## Roll back or choose a version

```sh
npx @flywheel-ai/onboard rollback
npx @flywheel-ai/onboard install 1.2.3
```

`rollback` uses a verified previous local version without downloading it. The
version you moved away from is held so automatic updates do not immediately
reinstall it. The command reports when no usable local version is available.

`install VERSION` requires that version to remain available for your license.
A successful explicit installation clears its local hold. It cannot override a
central withdrawal or an expired download.
