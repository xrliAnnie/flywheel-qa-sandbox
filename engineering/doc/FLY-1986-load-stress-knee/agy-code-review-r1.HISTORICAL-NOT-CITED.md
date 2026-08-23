# Code Review — FLY-1986 PR #924 head 911bcf96c

Reviewer: **Antigravity (`agy` 1.1.18)** — cross-family
> ⛔ **历史留档 — 不再作为评审记录引用。**
> **founder 直令(2026-08-22 20:29Z)**:不要用 Antigravity,一次都不再碰。
> 本文件保留仅为**修复溯源**;其 4 项修复按 founder 指示**保留**(已由本仓独立复核 + 变异检验)。
> 评审记录本体待**真 Codex 轮**(见 plan §12.1)。
Date: 2026-08-22
Status: CHANGES REQUESTED → **all 4 findings verified and folded in**

> 通道说明:Codex 三个 profile(school / business / personal2)全部撞周额度,重置时刻同为
> Aug 26 11:26 PM(疑机器级,取证在 FLY-1995);gemini CLI 0.56.0 报 `IneligibleTierError`。
> Tadashi 指出 Antigravity CLI 本机可用且真 auth 过,遂用它补上跨家族缺口。
> 8/26 之后若 Codex 恢复且尚未 ship,机会性补跑一轮真 Codex 留档。

---

## Summary (reviewer's own words)

The Phase-0 load probe correctly implements the monotonic tick grid and adheres strictly to a
read-only profile. However, there are critical remaining flaws concerning process lifecycles,
user input validation, and A/A testing comparability. Most notably, a process leak can
inadvertently leave rogue probes running against the production server in the background, and a
command injection vulnerability exists in the token parsing logic.

## Issues

1. **HIGH — orphaned sentinel subshells keep probing production.**
   A targeted `kill <pid>` (rather than a process-group signal) runs only the parent's trap,
   which cleaned up the covariate sampler alone. The sentinel subshells are bounded solely by
   their own clock, so they keep hitting the production Bridge for the rest of the block.
   *Fix:* track the subshell pids and tear them down in the parent's trap.

2. **HIGH — command injection through `--token-env`.**
   `eval "token=\${$TOKEN_ENV:-}"` with a user-supplied, unvalidated `TOKEN_ENV`.
   *Fix:* indirect expansion `token="${!TOKEN_ENV:-}"` (supported on macOS bash 3.2, cannot
   execute anything), plus an identifier check on the argument.

3. **HIGH — the CSV-integrity assertion is vacuous.**
   It only asserted that the function signature appears once; it said nothing about the printf
   or the field count, so a completely corrupted body would still pass.
   *Fix:* assert the emitting printf's placeholder count and cross-check it against the header.

4. **MEDIUM — A/A mode relaxes its own timing rule for the sparse arm.**
   `late_limit` was derived from the interval *after* `SPARSE_FACTOR` scaling, inflating the
   sparse block's `timer_late` threshold 5× (0.4s → 2.0s). Scheduler lateness that counts as a
   violation in the full arm is silently tolerated in the sparse one, destroying the basis of the
   comparison.
   *Fix:* derive `late_limit` from the unscaled base interval.

## Verdict

CHANGES REQUESTED

---

## 本仓复核与处置(runner)

| # | 复核方式 | 结论 | 处置 |
|---|---|---|---|
| 2 | **实测注入**:`--token-env 'X}; touch /tmp/agy_pwned2; #'` → 文件**真的被建出来** | 成立(最严重) | 改 `${!TOKEN_ENV:-}` + 标识符校验;新增行为级注入测试 |
| 1 | 读 trap 定义:只覆盖 `cov_pid` | 成立 | 子壳 pid 入 trap;新增「真跑 → SIGTERM → 断言子进程归零」测试 |
| 4 | 读行序:`late_limit` 在 `SPARSE_FACTOR` 缩放**之后** | 成立 | 改用 `base_interval`;新增行序契约 + 变异检验 |
| 3 | 读断言:只 `grep -c "sample_covariates_once() {"` | 成立 | 改断言真 printf 的 `%s` 数,并与表头列数对齐 |

**零驳回。** 4 项均以变异检验证明可变红(`a1`–`a5` 五个变异体全部被抓)。

### 一条值得记的
第 4 条(A/A 偏置)**是我为了修上一轮发现而新引入的** —— A/A 本身就是上一轮才补的。
一个用来检验「探针有没有影响被测对象」的机制,自己带着 5 倍偏置。
⇒ **修 bug 会长新 bug;每修完一轮都要重新过评审。**

第 3 条是**第三层**的「检查永远不会变红」:
一层自匹配 → 二层扫描范围对 `main()` 失明 → 三层**断言的内容根本不是它宣称的属性**。
