# Design Review — plan.md (v4 independent confirmation round)

Date: 2026-09-14
Author: Gemini (Staff Engineer)
Status: APPROVED

## Summary
The implementation plan (v4) for **FLY-1948: slot Lead Discord 通道活连接** is exceptionally well-conceived, technically rigorous, and fully complete. This round of review has independently validated all of the assumptions, architectural patterns, script interfaces, and configuration schemas against the live workspace files. 

All three crucial findings from the previous Codex rounds have been thoroughly addressed and closed:
1. **Gateway Evidence Cutoff:** Securely bound to the current adapter process generation (`max(effective since, adapter.startedAt)`), eliminating any possibility of old/stale ready indicators from leaking into the new generation assessment.
2. **Canonical Log Merge Order:** The reading order across the rotated `gateway-health.log` and `gateway-health.log.1` pair is explicitly defined as `gateway-health.log.1` (older) first, followed by `gateway-health.log` (newer), with robust inode/size mutation retry logic to prevent race conditions during rotations.
3. **Three-Way Provenance for `body.startedAt` Adoption:** Before adopting the high-precision millisecond-based UTC `body-status.json` `startedAt`, the plan mandates checking:
   - (i) `body-status.json` integrity (`schemaVersion==1`, size ≤ 64KB, regular file).
   - (ii) `carrierPid` in `body-status.json` matches `.pid` in `manifest.json`.
   - (iii) `carrierPid` matches the live PID returned by the injectable `FLYWHEEL_QA_LAUNCHD_PID_CMD` seam.
   If any of these fail, it safely falls back to second-precision UTC `claude.startedAt`.

## What's Good (Keep)
* **Surgical Precision on Sourcing (Assumption A2/A7):** The plan avoids sourcing `reap-orphan-adapters.sh` inside the liveness library, avoiding issues with fallback loggers and destructive processes. It also correctly utilizes `createRequire` pointed at `packages/teamlead/package.json` to resolve `better-sqlite3`, matching the codebase standard while respecting the fact that root `package.json` does not contain it.
* **Flawless Export and Package Integration (Assumption A10):** By identifying that `packages/flywheel-comm/package.json` does not export `chat-delivery-envelope.ts` but does export `./discord-chat-ingest`, and proposing to re-export `parseChatDeliveryEnvelope` from `./discord-chat-ingest`, the plan solves potential `ERR_MODULE_NOT_FOUND` issues beautifully without restructuring packages.
* **Extensibility of `room-info.json` (Assumption A5):** Checked against `scripts/lib/qa-generalized-e2e-lib.mjs:140-174`, which confirms that the `validateRoomInfo` function only asserts the exact properties inside its whitelist, meaning appending the new `lead` object will not break any existing readers or the reown exclusion predicates.
* **Seams-Based Design for Testability (Assumption A6):** The design of `scripts/lib/qa-discord-liveness.sh` with fully injectable CMD environment variables ensures complete testability on Linux (Ubuntu CI) and macOS without depending on system-specific process formats.
* **Strict Fail-Closed and Redacting Rules (§3.4):** Implementing `qa_discord_redact_line` with pattern matching on continuous alphanumeric values (疑似 JWT/token) prevents accidental leak of real tokens into liveness/failure reports.

## Issues & Recommendations

### 1. Hardcoded Argument choices in `qa-lead-diagnostics.py`
* **Why it matters:** The plan proposes calling `qa-lead-diagnostics.py snapshot --phase channel`, but `scripts/lib/qa-lead-diagnostics.py:667` explicitly defines `--phase` with choices restricted to `choices=("bootstrap", "topology")`. Failing to modify the choices option inside `parser()` will cause `argparse` to immediately crash on execution with a validation error.
* **Suggested fix:** During implementation, ensure that `"channel"` is added to the choices tuple in `scripts/lib/qa-lead-diagnostics.py`:
  ```python
  command.add_argument("--phase", choices=("bootstrap", "topology", "channel"), required=True)
  ```
* **Severity:** LOW (Minor implementation detail, already implied in C2 but needs literal verification in python).

### 2. Time-Zone Agnostic `ps -o lstart=` parsing
* **Why it matters:** On different target systems or under different locales, `ps -o lstart=` output can vary slightly in white spacing or format.
* **Suggested fix:** Ensure the parsing logic in `qa_discord_liveness.sh` handles extra leading/trailing whitespace robustly and uses `TZ=UTC LC_ALL=C` uniformly, mirroring the implementation in `scripts/lib/qa-launchd-lead.sh:970-979`.
* **Severity:** LOW (Robustness guardrail).

## Verdict
APPROVED — ready to implement
