# FLY-2530 Lead 启动预检 — 实施验证
Issue: FLY-2530 (https://linear.app/geoforge3d/issue/FLY-2530/codex-lead-mufasa-wrapper-启动预检自锁codex-home-link-truth-lead-的-launchd)
日期: 2026-09-13
基于: progress.md

Lead ruling `d281fb3a-bad3-4802-9727-c688a6738b19` approves option 1 for both Mufasa and infra-bot, waives full DOC-FLOW and design review, and forbids production restart/deploy from this node. The short implementation plan is persisted in the progress ledger.

## Scope and causal evidence

Both TUI launchers passed `--lead` into the link-truth startup check. That flag invokes the offline launchd fence: a successful `launchctl print` refuses mutation with rc 3, even when the caller belongs to that job. Removing the flag at these two startup callers preserves the home/credential and active-Codex checks. The offline helper and cutover scripts are unchanged. A repository shell consumer sweep found exactly these two mutating TUI startup calls; other `--inspect --lead` consumers are readonly.

## TDD

- New `codex-lead-launchd-preflight.test.sh`: actual copied launchers and actual link-truth shell; synthetic HOME, process table, authority and launchctl; stub credential helper and runtime. A matching own launchd label/PID reproduces both rc 3 failures before the fix. Four negative cases already pass.
- After the two caller changes: six cases pass. Both startup paths reach link → ensure-home → runtime. Both active unrelated Codex cases refuse before mutation/runtime. Both offline `--lead` cases retain `lead-job-running` refusal.
- Existing home-rule test updated to the new invocation: 5 pass / 2 fail before fix; 7 pass after fix.
- New shell regression is explicitly registered in `.github/workflows/ci.yml`.
- RED/GREEN logs: `/tmp/fly2530-preflight-red.log`, `/tmp/fly2530-preflight-green.log`, `/tmp/fly2530-home-rule-red.log`.

## Verification receipts

Initial baseline failed because workspace dependencies and claude-runner dist were absent. `pnpm install --frozen-lockfile` completed, then baseline build passed and home-link suite passed 14/14. These setup failures were not behavior regressions.

- `pnpm lint`: exit 0, 16 warnings; no fixes applied.
- `pnpm -r build`: exit 0.
- `pnpm test:packages:run`: exit 1, stopped in config (816 passed, 2 failed): `drift-scan.test.ts` boolean census timed out at 5000ms; `fly1981-final-ledgers.test.ts` five Batch 6 ledgers timed out at 15000ms.
- Isolated rerun of those two files after build: 37 passed, 1 failed. The original two cases passed, but `fly1981-final-ledgers.test.ts:464` auxiliary tunings case timed out at 15000ms. Aggregate remains FAILED; no timeout settings or unrelated config code changed.
- Focused home-link 14/14 and credential-cutover 5/5 PASS; new startup regression 6/6 and home-rule 7/7 PASS.
- Logs: `/tmp/fly2530-lint.log`, `/tmp/fly2530-build.log`, `/tmp/fly2530-packages.log`, `/tmp/fly2530-config-timeouts-isolated.log`, `/tmp/fly2530-link-green.log`, `/tmp/fly2530-cutover-green.log`.
- Independent spec compliance and code quality reviews: PASS, no blocking findings.
- Required `codex:rescue` invoked through plugin companion `task --fresh --prompt-file` against implementation commit `a66a717c4`; exit 1 during thread initialization: `failed to load AGENTS.md instructions for environment local: Broken pipe (os error 32)`. No rescue review verdict obtained. Log `/tmp/fly2530-rescue.log`.
- Lead disposition requested in `2f305cef-2117-437b-95c1-7d527b997fe1`; workflow review remains required.

## Acceptance boundary

This is hermetic startup-preflight proof, not production TUI or inbox acceptance. The updater owns deployment. After deployment, authorized QA/operator acceptance must confirm both launchd jobs remain running, visible TUI panes appear, Lead inbox sockets exist, and Bridge capability probes stop reporting ENOENT. No production database, credentials, daemon, or service was changed by this implementation node.

## Review advisory disposition and test-only follow-up

Review `6ff736d4-3ddc-48e5-938c-05fe7bb8a7b5` approved `e11d6415b` with two MEDIUM advisories. Lead ruling `226adc37-aa02-413b-aaf6-ae5ef5eedf5b` requires the two existing package launcher suites to expect only the home argument, keeps them outside CI enumeration, and defers the startup registry-home cross-check to follow-up.

Updated only those two expected strings, descriptions and the Mufasa test comment. Infra-bot suite: before 18 passed / 1 failed (stale `--lead` expectation), after 19 passed / 0 failed. Mufasa suite: before and after 2 passed / 4 failed (dry-run env dump, explicit direct rollback, bridge missing-token guard, and real-branch pre-link exit rc1 with empty args). These pre-link failures remain unchanged and out of scope; the updated Mufasa assertion cannot be claimed exercised by that older fixture. The new isolated six-case suite independently proves startup for both launchers. Logs: `/tmp/fly2530-infra-contract-{red,updated}.log` and `/tmp/fly2530-mufasa-contract-{red,updated}.log`.

No runtime behavior changed in this follow-up. Per Lead ruling `2f305cef-2117-437b-95c1-7d527b997fe1`, aggregate/isolated config tests are not rerun; their failures and rescue initialization failure remain recorded. Fresh workflow review and exact-head CI are required after this test-only commit.
