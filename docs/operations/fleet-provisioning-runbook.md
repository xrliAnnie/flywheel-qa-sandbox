# Fleet Provisioning Runbook (FLY-519)

Provision a clean macOS (Apple Silicon) into a Flywheel fleet host, or migrate
the fleet to a new machine (interim MBP, Sept Studio, future nodes — FLY-517).

**Tools**
- `scripts/fleet-capture.sh` — snapshot the CURRENT host into a sanitized,
  committable artifact (`fleet/`). Zero secrets (see `fleet/README.md`).
- `scripts/provision-fleet-host.sh` — materialize on the NEW host. Phased,
  idempotent, **dry-run by default** (pass `--apply` to make changes).

**Scope (v1)**: stands up infrastructure + token placeholders + validation for a
single host. Multi-node orchestration → FLY-517. Real tokens / memory DBs / codex
auth / thread continuity are **Annie-handled** (Section C below), never scripted.

---

## A. On the OLD machine — capture (before migration)

```bash
cd ~/Dev/flywheel
git checkout -b fleet-capture-$(date +%Y%m%d)
bash scripts/fleet-capture.sh            # writes fleet/{projects.json,env.example,manifest.json}
```

Review for zero secrets, then commit:

```bash
bash -c 'source scripts/lib/fleet-sanitize.sh; scan_for_secrets fleet/'  # must print nothing, exit 0
pnpm exec biome check --write fleet/   # jq emits 2-space; biome wants tabs (CI gate)
git add fleet/ && git commit -m "chore: capture fleet topology for migration"
git push
```

> The capture redacts `~/.flywheel/.env` to key names and hard-aborts if any
> secret-looking value is detected. If it aborts, fix the source and re-run —
> do NOT hand-edit a secret into `fleet/`.

---

## B. On the NEW machine — provision

```bash
# 1. Get the checkout (the only manual bootstrap before the script can run).
git clone https://github.com/<owner>/flywheel.git ~/Dev/flywheel
cd ~/Dev/flywheel

# 2. DRY-RUN first — read the full plan, change nothing.
bash scripts/provision-fleet-host.sh

# 3. Apply through the home/token bootstrap, skipping the token gate for now.
bash scripts/provision-fleet-host.sh --apply --skip-token-check --only deps
bash scripts/provision-fleet-host.sh --apply --skip-token-check --from repos --only repos
bash scripts/provision-fleet-host.sh --apply --skip-token-check --only flywheel-home
bash scripts/provision-fleet-host.sh --apply --skip-token-check --only tokens
#    → writes placeholder ~/.flywheel/.env (real values are filled in Section C)

# 4. Do Section C (Annie fills real tokens + restores state).

# 5. Finish: re-run from tokens WITHOUT --skip-token-check so the gate enforces.
bash scripts/provision-fleet-host.sh --apply --from tokens

# 6. Validate.
bash scripts/provision-fleet-host.sh --apply --only validate
```

(Re-running any phase is safe — every phase is idempotent and converges.)

### Lead launchd bring-up (operator-run on the real host)

The `launchd` phase **narrates** the Bridge + lead bring-up rather than firing
it — the real activation is operator-run + verified on the real machine (this is
deliberate: it has irreversible launchd side effects). The correct clean-host
lead sequence is NOT `flywheel-fleet.sh apply` (that is a model/backend cutover
engine and reports `not-installed/no-carrier` on a clean host). Instead:

1. `~/.flywheel/projects.json` is in place (provision did this).
2. Bring up the Bridge + auxiliary jobs (cmux-watcher / daily-standup /
   skills-update / updater) — `restart-services.sh` does this idempotently.
3. Bring up each Lead — manifests do NOT exist yet on a clean host, and the
   launchd wrapper **exits if its manifest is missing** (it does NOT
   self-generate). So, per Lead:
   1. Run `claude-lead.sh` once (foreground/manual) to **generate that Lead's
      manifest**, then stop that manual process.
   2. `flywheel-daemon.sh install <lead>` — generate the plist + bootstrap from
      the now-existing manifest.
   (This mirrors the setup-new-project.sh cutover checklist.)
4. Verify: `flywheel-daemon.sh status` — expect all leads loaded.

---

## C. Annie-handled manual steps (NOT scripted — secrets & state)

These touch real secrets / live state and stay in human hands by design.

1. **Real token values** — edit `~/.flywheel/.env` and fill every key that is
   still empty/placeholder (Discord bot tokens, `LINEAR_API_KEY`,
   `TEAMLEAD_INGEST_TOKEN`, etc.). The provisioner's token gate refuses to start
   launchd jobs until the secret-named keys are non-empty.
2. **Codex auth** — re-login each Codex profile / home: `codex login` (or the
   `/codex-relogin` skill). Restore `~/.flywheel/codex-homes/` per-Lead homes if
   carrying companion Leads.
3. **GitHub auth** — `gh auth login`.
4. **State migration (optional, for continuity)** — copy from the old host:
   `~/.flywheel/{teamlead.db,audit.db,cipher.db,memories,comm,manifests}` plus
   per-Lead memory and companion **thread-id** state (e.g. Mufasa thread
   `019eaf5d`) so conversations continue verbatim.
   > **FLY-663 (WAL):** `teamlead.db` is now WAL-mode. Either copy it AFTER the
   > Bridge has cleanly stopped (a clean `close()` checkpoints the WAL into the
   > main file), OR copy `teamlead.db`, `teamlead.db-wal`, AND `teamlead.db-shm`
   > **together** — the `-wal` sidecar can hold committed rows until a checkpoint.
   > Copying only `teamlead.db` while the `-wal` is non-empty loses recent state.
5. **macOS Automation permission** — first `osascript` → Terminal grant
   (see `SETUP.md`). Click **Allow** once.
6. **Discord bots / Linear team** — reuse existing if migrating; for a brand-new
   fleet, create them via the relevant setup skills and put tokens in
   `~/.flywheel/.env`.
7. **skills-sync** — install `~/.flywheel/bin/skills-sync.sh` + the
   `com.flywheel.skills-update.plist` launchd job and run one sync (global skills
   incl notion). The provisioner narrates this step; wiring is delegated.

---

## D. Validation — what "ready" means

`provision-fleet-host.sh --apply --only validate` checks:

- **Bridge up**: `curl -fsS $FLYWHEEL_BRIDGE_URL/api/runs/active` returns 2xx.
- **launchd loaded**: `launchctl print gui/<uid>/<label>` for every job in the
  manifest.
- **dispatcher smoke**: the Bridge read-only endpoint responds (HTTP 429 = the
  dispatch gate is rate-limiting, reported as a warning, not a failure).

**External (manual) checklist** — not automatable from the host:

- [ ] Every Lead bot shows **online (green)** in Discord.
- [ ] A test message to a Lead gets a reply (typing indicator → response).
- [ ] A test dispatch produces a Runner (or is correctly held by the memory gate
      per FLY-517 if the machine is capacity-constrained).

Troubleshooting Bridge/launchd: see `docs/operations/bridge-daemon-management.md`.

---

## E. Linux / WSL2 (FLY-650 — portable provisioning)

The SAME toolchain runs on Linux and WSL2. macOS keeps launchd (byte-identical to
above); Linux uses **systemd --user**. The core/host config (`host.json`) and
projects.json are physically separate (D2=B): a deployer edits the simple project
config and need not touch the core.

### E.1 Concepts (what changed vs macOS)

- **Supervisor**: `launchd` (macOS) ↔ **`systemd --user`** (Linux). The
  service-spec maps `service`→`.service`, `timer`→`.timer` (OnCalendar),
  `path`→`.path` (DirectoryNotEmpty); `cmux-watcher` is darwin-only (skipped).
- **Core/host config**: `~/.flywheel/host.json` carries platform/paths/skillsRepo.
  Missing host.json = today's defaults (byte-compat). The captured artifact's
  host.json carries only portable fields; the **target derives its platform from
  uname** (a macOS capture never pins macOS onto a Linux target).
- **Deps**: per-platform (`brew` on macOS, `apt`/`dnf` on Linux; node/pnpm are
  present-checked — install via nvm/corepack). A required dep with no Linux
  mapping fails loud (re-capture with FLY-650 or add `platforms.linux`).
- **Viewer**: Linux has no cmux. `host.json.viewerBackend` defaults to
  `tmux-only` on Linux — leads run in tmux and the operator attaches with
  `tmux attach` (or Windows Terminal on WSL2). This is an **explicit, founder-
  acknowledged revision** of the macOS "never headless" rule for Linux hosts
  (tmux-only is visible-and-attachable, not truly headless).

### E.2 Steps (run on the NEW Linux / WSL2 host)

```bash
# 0. WSL2 only — enable systemd, then restart WSL from Windows:
#    sudo sh -c 'printf "[boot]\nsystemd=true\n" >> /etc/wsl.conf'   # then: wsl --shutdown
#    Install under the LINUX filesystem (e.g. ~/Dev), NOT /mnt/c.

# 1. Get the checkout.
git clone https://github.com/<owner>/flywheel.git ~/Dev/flywheel
cd ~/Dev/flywheel

# 2. PREFLIGHT — prints an evidence bundle; installs/changes nothing.
bash scripts/linux-preflight.sh
#    Resolve every [BLOCK] (systemctl --user, lingering) before continuing.

# 3. DRY-RUN, then apply through the home/token bootstrap (same phases as macOS).
bash scripts/provision-fleet-host.sh                       # full plan, no changes
bash scripts/provision-fleet-host.sh --apply --skip-token-check --only deps
bash scripts/provision-fleet-host.sh --apply --skip-token-check --only repos --from repos
bash scripts/provision-fleet-host.sh --apply --skip-token-check --only flywheel-home
bash scripts/provision-fleet-host.sh --apply --skip-token-check --only tokens

# 4. Section C (fill real tokens + restore state). gh/codex/claude auth too.

# 5. Enable lingering + finish with the token gate enforced.
loginctl enable-linger "$USER"
bash scripts/provision-fleet-host.sh --apply --from tokens

# 6. Bring up Bridge + aux units (systemd --user), then validate.
#    (Lead bring-up: materialize the manifest, then supervisor install — see the
#    provisioner's narrated supervisor phase. Verify with: systemctl --user status.)
bash scripts/provision-fleet-host.sh --apply --only validate
```

### E.3 D3=B real-machine acceptance (founder-run)

The runner cannot reach the founder's machines (same model as a migration). The
founder runs the steps above on her real Linux + Windows(WSL2) boxes; on any
failure she pastes back the evidence bundle (`linux-preflight.sh` output + the
section-11 `journalctl --user` / `systemctl --user status` commands). The runner
fixes and the founder re-runs until green. **The founder's real-machine green run
is the acceptance gate** — hermetic tests are only the correctness guardrail.

---

## F. Fresh instance — the one-command setup wizard (FLY-648)

Sections A–E move an EXISTING fleet (capture → provision). Section F stands up
a **brand-new instance on a new owner's machine** — their own Discord server,
their own Linear workspace, their own Claude subscription, their own project —
with **one command**:

```bash
git clone https://github.com/xrliAnnie/flywheel.git ~/Dev/flywheel
cd ~/Dev/flywheel && pnpm install && pnpm build   # the config gate runs the REAL loader
bash scripts/flywheel-setup.sh --project <name> \
  --cos-persona <CosName> --eng-persona <EngName> [--linear-team <KEY>]
```

The wizard is a **step-engine with a resumable journal**
(`~/.flywheel/setup-state.json`): interrupt it anywhere (most commonly while
creating Discord bots) and re-running resumes from the first incomplete step.
Every failure is fail-closed — it stops AT the failing step and says what to do.

### F.1 What it automates vs what stays in your hands

| Step | Kind | What happens |
|---|---|---|
| 1 preflight | AUTO | Linux/WSL2: `linux-preflight.sh --check` (hard blockers stop here) + platform-keyed deps |
| 2 skeleton | AUTO | project repo scaffold (`setup-new-project.sh`, local `git init` — **no GitHub create/push**) |
| 3 model key | GUIDED | Claude Code login with YOUR subscription (CLI login; API-key path is explicit opt-in) |
| 4 bots | GUIDED (seam) | **C1 (default): you create 2 Discord bots** in the Developer Portal, step-by-step, invite URL printed (permissions incl. channel-create); tokens are read HIDDEN and validated immediately. **C2 (`--bot-path c2`): Flywheel-pool bots** — you only click 2 invite links (honestly annotated: semi-managed) |
| 5 channels | AUTO | the validated bot creates `#cos-chat` `#eng-chat` `#general` (403 → you create them, it verifies), probes read+post per bot, captures guild/channel IDs, gets YOUR user id (paste, or type `read` to let the bot read it from a #general message) |
| 6 linear | GUIDED+AUTO | API key hidden-read + validated → team/label/project find-or-create (existing team is only adopted with your explicit consent; no create permission → you create in the UI, it verifies) |
| 7 config | AUTO | writes `projects.json`/`host.json`/`.env` (0600) — gated by the REAL config loader before landing; the token gate enforces every required secret |
| 8 services | AUTO | the UNCHANGED provisioner: Linux = linger + lead manifests + systemd --user units via the supervisor seam; macOS = narrated operator bring-up (§B) |
| 9 finish | AUTO | Bridge health check + "go say hi to your manager in Discord" |
| 10 digest | AUTO | FLY-727 deploy-report hook pointer (skip with `--no-digest`) |

**Secrets red line**: tokens/keys are read via hidden TTY, validated in memory,
and written ONLY to `~/.flywheel/.env` (atomic, 0600). They never appear in
chat, argv, shell history, logs, or the journal.

**Honest notes printed up-front** (boundary table F): Discord bot creation
cannot be API-automated; account sign-ups are yours; the machine should stay on
24/7; model usage runs on your subscription/keys.

### F.2 WSL2-specific notes

- **systemd**: `sudo sh -c 'printf "[boot]\nsystemd=true\n" >> /etc/wsl.conf'`
  then `wsl --shutdown` from Windows (§E.2 step 0). `linux-preflight.sh --check`
  blocks until this works.
- **Memory**: a fleet is a memory game — set `C:\Users\<you>\.wslconfig`
  (`[wsl2]` / `memory=12GB` or most of the machine) before first bring-up.
- **`gh` is NOT in Ubuntu's default apt sources** (or is ancient): add the
  GitHub CLI apt repo first — https://github.com/cli/cli/blob/trunk/docs/install_linux.md
- **node/pnpm are present-checked, not auto-installed**: nvm → LTS node →
  `corepack enable` BEFORE running the wizard.
- **Install under the Linux filesystem** (`~/Dev`), never `/mnt/c`
  (`--check` blocks this).
- **Claude login loopback**: run `claude` INSIDE the WSL shell; if the Windows
  browser can't reach the localhost callback, use the copy-paste code flow.

### F.3 Minimal-instance feature surface (what's ON/OFF after the wizard)

| Feature | State | To enable |
|---|---|---|
| CoS + Eng Lead chat, Runner dispatch, PR flow | ON | — |
| Founder gates (brainstorm/approve, FLY-175 — founder = the instance owner) | ON | — |
| Cross-dept roundtable | OFF | create the channel + set `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` |
| Operator alerts (LeadWatchdog) | **skipped** (no `alertChannel`/`alertFallbackToCore`) | set `"alertFallbackToCore": true` on a lead, or a dedicated `alertChannel` |
| Skills sync (flywheel-skills) | OFF until repo access (provision skills phase degrades safely) | grant access + wire skills-sync |
| Notion / Xiaohongshu / extra model keys | OFF | add the env keys later |
| cmux viewer | N/A on Linux/WSL2 — tmux-only (§E.1) | — |

### F.4 Real-machine acceptance (founder-run loop)

Same D3=B model as §E.3: the runner cannot reach the target machine. The
operator runs the wizard on the real WSL2 box and pastes back the evidence on
any failure (`linux-preflight.sh` output, the failing step's message,
`systemctl --user status flywheel-*`, `journalctl --user -u flywheel-bridge`).
Green = every step done + `systemctl --user is-active` green + Bridge
`/api/runs/active` 2xx + **@CoS answers in Discord**. Potholes found in the
loop get folded back into the wizard + this section.
