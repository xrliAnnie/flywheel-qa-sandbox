# FLY-2688 Gemini 独立设计评审 R1（原文）
Issue: FLY-2688 (https://linear.app/geoforge3d/issue/FLY-2688/额度账号页-一条命令出账号额度一览htmlclaude-各号周额度-5h-fable-单独周额度-重置时刻-订阅到期日-codex)
日期: 2026-09-21
基于: plan.md 的「2026-09-21 返工」小节

> Codex companion R1 在 thread 01a0c79b 起来后立刻 `You've hit your usage limit … try again at Sep 27th, 2026 2:25 PM`，零评审产出。
> 按 FLY-2560 判例改跑 gemini-cli 0.60.0 API-key 通道（隔离 HOME）。以下为 stdout 原文，未删改。

```
I have completed the design review. I investigated the codebase extensively, tracing the `persistCodexCandidateCredential` guard logic, the `identifyCodexAuth` profile parsing, the `capacity-snapshot.ts` fallback behavior, and the Bridge `/api/accounts-page.html` route.

*(Note: Because I am operating in strict Plan Mode, my write permissions are restricted to the sandbox planning directory, and I was blocked from writing directly to `/Users/xiaorongli/Dev/flywheel-FLY-2688/engineering/doc/FLY-2688-account-quota-page/gemini-review-round1.md`. I have provided the review content below.)*

**Verdict:** APPROVED

Here is the design review output:

```markdown
# Design Review — plan.md (Round 1)

Date: 2026-09-21
Author: Gemini
Status: APPROVED

## Summary
The proposed rework elegantly satisfies the founder's requirement for real Codex usage data while respecting the strict constraints of the existing notification pipeline and credential safety. By introducing an on-demand, single-flight probe behind `?refresh=1` and leveraging isolated `CODEX_HOME` workspaces, it safely gathers data without blocking the 5-second `account_switched` deadline.

## What's Good (Keep)
1. **In-Use Guard:** Reusing the `CodexQuotaRuntime` in-use semantics to skip live profiles is the most critical safety feature. It perfectly avoids the shared refresh token hazard that would otherwise log out active leads.
2. **Honest Fallbacks:** Falling back to the last stored reading when a profile is in-use, and marking absent `windowDurationMins` or malformed data as "unknown", strictly adheres to the "no guessed values" mandate.
3. **Write-Back Generalization:** The `persistCodexProfileQuotaRefresh` design correctly isolates the identity check (`accountKey` matching before and after) rather than hardcoding profile names. This makes it robust for unregistered profiles while preventing cross-contamination.
4. **Decoupled Refresh:** Keeping `?refresh=1` strictly on the manual Bridge route and off the `--publish-only` notification path is excellent. It preserves the budget for crucial state transitions.

## Issues & Recommendations
1. **Sorting Ambiguity for Exhausted Accounts:** The plan states `sortByEarliestReset(rows)` takes the absolute minimum reset across windows. If an account is completely exhausted (e.g., both 5h and weekly hit 100%), its true recovery time is the *latest* of those resets. If sorted by the absolute earliest reset, a fully blocked account might theoretically appear at the top of the list. 
   **Recommendation:** Keep the current deterministic logic as it fulfills the literal "earliest reset first" request, but consider sorting *exhausted* accounts by their effective recovery time (the maximum of exhausted resets) if the founder's intent was "which account can I use soonest?". This is a product nuance and does not block implementation.
2. **Bridge Timeout Constraints:** The sequential or parallel spawning of up to 6 `app-server` instances could push against the Bridge's HTTP timeout limit. 
   **Recommendation:** Ensure the overall deadline passed to the observer (e.g., 20s per profile, bounded by a global timeout of say 45s) is strictly less than the Bridge's default HTTP route timeout (usually 60s), so the request doesn't drop ungracefully.

## Verdict
The technical design is extremely solid, well-isolated, and correctly identifies all the failure domains (credentials, timeouts, parsing). You are clear to proceed with implementation.
```
```
