# Design Review — plan.md (Round 1)
Date: 2026-09-22
Author: Gemini (API-key independent review)
Status: APPROVED

## Summary

The proposed implementation plan for **FLY-2758 (Raya Cutover EIO)** is highly feasible, complete, and correct. It surgically targets the root cause of the deployment blockages by introducing a non-blocking wait-for-unload check and bounded bootstrap retries directly in the supervisor layer (`supervisor.sh:_sup_darwin_install`). Additionally, it introduces a clean recovery path in `updater-raya-deploy.sh` for the P4b cutover phase to restore the standard Lead if the candidate installation fails. 

The plan strictly respects system constraints:
- It **does not modify the state machine semantics (P0–P7)**.
- It **does not alter the v2 receipt key structure**, avoiding schema breaks.
- It **completely avoids touching production launchd** during development, relying on stateful stubs under existing test suites.
- It **avoids unwanted side effects** on other Leads, as the supervisor changes represent a universal hardening of `install` lifecycle actions under launchd.

---

## What's Good (Keep)

1. **Spot-on Root Cause Analysis**:
   - The analysis correctly identifies that `launchctl bootout` operates asynchronously. Attempting `launchctl bootstrap` immediately afterward without waiting for the label to be dropped from the domain produces an EIO (Input/output error) on modern macOS versions.
   - The plan's proposed fix aligns perfectly with how the platform's `restart-services.sh` is already implemented.

2. **Universal Hardening at the Supervisor Layer**:
   - By fixing the bootout/bootstrap race condition in `_sup_darwin_install`, *all* Leads that use `flywheel-lead.sh install` will benefit from this timing protection, not just Raya. This prevents similar race conditions across the fleet.

3. **Zero-risk Receipt Schema and Shuttle Observation Compatibility**:
   - The receipt structure remains completely compatible with standard key validation schemas (`raya_receipt_keys_valid`).
   - Reporting `state=rolled_back` on recovery and `failed` when recovery is impossible is fully supported by `raya_write_standard_receipt`.
   - The shuttle's `updater_observation_record_raya` fallback mechanism correctly classifies `rolled_back` with `detail=cutover-failed` as a `failed` deploy, ensuring no metrics or downstream dashboards are broken.

4. **Realistic, Stateful Testing Strategy**:
   - Updating both `supervisor.test.sh` (where S8–S11 are already specified) and `flywheel-lead.test.sh` to use stateful stubs is the correct way to model asynchronous launchd behavior. It ensures that the wait loop logic is fully exercised in CI.

5. **Elegant Retryability Architecture**:
   - Keeping the candidate's `lead_restart_installed_at` ledger key as `null` after a failed/restored installation guarantees that subsequent 12-hour scheduler windows can cleanly retry the candidate cutover without getting stuck.

---

## Issues & Recommendations

### 1. Test Environment Variable Mismatch (`FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL`)
* **Issue**:
  - The existing test suite in `supervisor.test.sh` (line 204) passes `FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL=0` to ensure that unit tests execute instantly and don't sleep.
  - The implementation plan proposes `FLYWHEEL_SUPERVISOR_BOOTOUT_WAIT_INTERVAL` (defaulting to 1s) as the polling interval for the wait loop. If `supervisor.sh` only reads this new variable, the tests will fallback to the default `1s` sleep, which will slow down S8–S11 or cause timeouts.
* **Why it matters**:
  - Unit tests in CI must be extremely fast. Introducing multi-second real sleeps into the test loops degrades developer experience and risks CI shard timeouts.
* **Suggested Fix**:
  - Update the private helper implementation in `supervisor.sh` to check `FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL` as a fallback or primary variable for test compatibility.
  - In `_sup_darwin_wait_unloaded`:
    ```bash
    local interval="${FLYWHEEL_SUPERVISOR_BOOTOUT_WAIT_INTERVAL:-${FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL:-1}}"
    ```
  - In `_sup_darwin_bootstrap_retry`:
    ```bash
    local interval="${FLYWHEEL_SUPERVISOR_BOOTSTRAP_INTERVAL:-${FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL:-2}}"
    ```
  - This guarantees that when tests configure `FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL=0`, all waits instantly drop to 0s, preserving rapid unit test execution.

### 2. Robustness of PID Extraction in `_sup_launchd_pid`
* **Issue**:
  - `launchctl print` can output different lines depending on service state. If the service is loaded but not running (e.g. standard idle or a scheduled timer), it won't have a `pid = ` line in its dictionary.
* **Why it matters**:
  - If the regex isn't robust, `_sup_launchd_pid` could return malformed output or print warnings.
* **Suggested Fix**:
  - Strictly validate and sanitize the PID extraction matching existing patterns in `lead-restart-lifecycle.sh`:
    ```bash
    _sup_launchd_pid() {
      local target="$1" out
      out="$(launchctl print "$target" 2>/dev/null)" || return 0
      local pid
      pid="$(printf '%s\n' "$out" | grep -m1 'pid =' | awk '{print $NF}' || true)"
      case "$pid" in ''|*[!0-9]*) pid="" ;; esac
      printf '%s' "$pid"
    }
    ```

### 3. Log Visibility of Recovery Outcome
* **Issue**:
  - When an install failure occurs and recovery runs, `/tmp/flywheel-updater.log` should clearly indicate whether Raya was successfully restored to standard Lead or left offline.
* **Why it matters**:
  - On-call engineers reading log trails in production need immediate high-visibility summaries to determine if manual interventions are required.
* **Suggested Fix**:
  - Add an explicit `raya_log` statement summarizing the recovery outcome inside `raya_fail`:
    ```bash
    raya_log "Raya cutover failed. Recovery state: $RAYA_RESTORE_STATE. Detail: $detail"
    ```

---

## Verdict

**APPROVED**

The plan is elegant, robust, and represents the best engineering approach to resolve the bootstrap race condition. Once the minor environment variable fallbacks are integrated to protect test execution speed, the implementation is safe to proceed.
