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
