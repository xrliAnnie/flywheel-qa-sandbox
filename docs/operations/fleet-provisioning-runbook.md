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
