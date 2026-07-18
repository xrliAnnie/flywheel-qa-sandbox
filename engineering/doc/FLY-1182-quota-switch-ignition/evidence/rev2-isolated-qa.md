# FLY-1182 Rev 2 isolated QA evidence

Date: 2026-07-16

## Fixture provenance

- Archived PR #562 head is locally readable at
  `0baf6f8a1621f3e2b73e3aee3accd59c93aeff94`.
- The model-cap sentence in
  `packages/teamlead/src/__tests__/fixtures/lead-panes/model-limit-real.txt`
  is verbatim from that head's
  `packages/teamlead/src/__tests__/model-cap-detection.test.ts` and the
  2026-07-11 incident evidence. The surrounding managed-pane chrome is the
  repository's audited Lead-pane fixture shape, used only behind the two-key
  QA injection seam.
- No archived or live paid-choice prompt was available. The `quota_choice`
  detector/classifier/emitter is therefore not implemented; only its reserved
  alert contract exists. No synthetic wording was promoted into production.

## Real compiled daemon, hermetic machine seams

Command matrix:

```text
bash scripts/qa-fly-1256-quota-daemon-e2e.sh unmanaged-model
PASS: an unmarked shell rendering the real model-cap fixture produced no detection, switch, or keystroke

bash scripts/qa-fly-1256-quota-daemon-e2e.sh rate-limit
PASS: live HTTP 529 produced no switch, no generation change, and no pane keystroke

bash scripts/qa-fly-1256-quota-daemon-e2e.sh account
PASS: cache updated, school validated before backup, Keychain/store switched, quota pane revived, alert isolated
PASS: fake claude invocation count=0

bash scripts/qa-fly-1256-quota-daemon-e2e.sh model
PASS: real model-cap fixture detected, scratch Keychain/store switched, affected pane revived, crash/restart confirmation recovered
PASS: fake claude invocation count=0
```

The model scenario additionally proves:

- the real `flywheel-claude-profile` script sees a corrupted post-write
  read-back, restores the previous scratch credential, and leaves `.active`
  unchanged;
- a later valid switch commits Keychain, profile, account generation, and only
  the `Fable 5` model bench;
- the switch alert contains the affected pane and uses strict delivery;
- `continue` plus Enter is sent once through isolated tmux;
- killing the daemon after switch commit but before confirmation leaves a
  durable intent; a fresh daemon reclaims the stale pidfile, confirms the
  recovered pane, writes 0600 evidence, posts
  `quota_switch_confirmation`, and drains the outbox.

All mutable and credential-bearing seams are centrally asserted under one
scratch root before daemon start: HOME, pool, account store/lock, config,
state, cache, confirmation evidence, fake Keychain adapter/state, Claude
identity, alert sink, isolated tmux socket, loopback usage/OAuth endpoints, and
scratch Keychain service. No real Claude executable participates.

Boundary: the injected shell proves detector -> switch -> tmux keystroke ->
confirmation mechanics. It is not a real Claude TUI, so it does not prove that
a naturally capped Claude process accepts `continue`; that remains a first
natural-incident observation item.

## 40-pane bound

```text
bash scripts/qa-fly-1182-pane-scan-bench.sh
{"listedCount":40,"observedCount":40,"managedCount":40,"captureFailures":0,"omittedCount":0,"complete":true,"wallMs":416.99,"userCpuMs":28.83,"systemCpuMs":29.81}
PASS: bounded production scanner captured 40/40 isolated panes
```

This run used the production scanner, real isolated tmux, its 64-pane cap,
5-second per-pane timeout, and concurrency 4. The observed 40-pane wall time
was 0.417 seconds with 58.64 ms combined process CPU.

## Regression evidence

- Config feature-flag drift guard reproduced CI's three unclassified env vars,
  then passed after classifying the identity/evidence paths as plumbing and the
  two-key injection env as an internal QA-only safety lever; full config suite:
  27 files / 438 tests passed.
- Cross-family review found that model-cap parsing still consumed raw Discord
  echo lines. A new managed-pane negative test reproduced the false detection;
  the scanner now gives account and model classifiers the same echo-stripped
  recent live region. Quota/account/alert focus after the fix: 32 files / 314
  tests passed; model and unmanaged-model daemon E2E both passed.
- Teamlead quota/account/alert focus: 32 files, 396 tests passed.
- Full Teamlead run: 563 files / 7,947 tests passed; 4 files / 6 tests failed
  outside the FLY-1182 surfaces. Failures were the root-owned npm cache in the
  shell publish drift test, two launchctl/fleet hermetic probes reporting
  runtime-indeterminate, and two existing 5-second timing/preflight tests.
- `setup-quota-monitor.test.sh`: 11/11 passed, including legacy eight-key
  production config compatibility and CUTOVER safety.
- `quota-monitor-wrapper.test.sh`: 5/5 passed.
- `lead-alert-strict-delivery.test.sh`: 24/24 passed, including claim-written,
  active/stale lease, POST-without-receipt, replay, queue, and dead-letter
  windows. CI also exposed a Linux-only assertion bug: GNU `stat -f` succeeds
  with filesystem output instead of BSD permission output. The test now tries
  GNU `stat -c` first and falls back to BSD/macOS `stat -f`; 24/24 remains green
  locally.
- `lead-alert-fly927.test.sh`: 37/37 passed.
- `lead-alert-notify-digest-kind.test.sh`: 5/5 passed.
- Teamlead typecheck and build passed; both QA scripts pass `shellcheck`; `git
  diff --check` passed.
- Repository-wide `pnpm lint` is not a valid clean signal in this worktree: it
  scans the local ignored `.pnpm-store` and reports 611 formatting errors in
  package-cache JSON. The changed production TypeScript had already passed
  Biome before the QA-only shell/fixture commit; the new shell scripts are
  covered by `shellcheck`.
