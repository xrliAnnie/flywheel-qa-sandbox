# FLY-957 record_deployed_range 收尾 grep 杀死部署 — 实施计划

Issue: FLY-957 (https://linear.app/geoforge3d/issue/FLY-957/infradeploy-record-deployed-range-一行-grep-杀死部署收尾-无-pr-号-commit)
日期: 2026-07-07
基于: exploration.md, research.md

## 目标

`record_deployed_range` 不得让 git-log / subject 解析 / 上报环节的非零退出逃逸出函数、杀死部署收尾(方案 A,brainstorm gate 已批)。交付 = 1 行修 + 注释 + CI 单测。**Scope 收窄(lead-instruction a23bf30e):只做 bug ①;不碰 provision-fleet-host.sh / linux-preflight.sh(bug ② 归 FLY-648 PR #477)。**

## 变更清单(共 3 个文件)

### 1. `scripts/restart-services.sh` — 一行修 + 注释

`record_deployed_range()` 内(现 line 58),`done` → `done || true`,上方加注释:

```diff
             FLYWHEEL_BRIDGE_URL="${FLYWHEEL_BRIDGE_URL:-${BRIDGE_URL:-http://localhost:9876}}" \
                 node "$comm" report-deployed "${args[@]}" >/dev/null 2>&1 || true
-    done
+    # FLY-957: `|| true` runs the pipeline in an -e-ignored context (bash
+    # extends that suppression into the loop subshell), so a no-match grep —
+    # commit subject without an issue/PR marker — leaves the var empty and the
+    # range keeps processing instead of killing the whole deploy finalization
+    # under set -euo pipefail. Also swallows git-log failures (contract above).
+    done || true
     return 0
 }
```

其余一字不动(上报参数、dedup 键、`node … || true` 全保留)。

### 2. 新增 `scripts/__tests__/restart-deployed-range.test.sh`

完整内容(实现时照抄,允许微调措辞):

```bash
#!/usr/bin/env bash
# FLY-957: record_deployed_range must never kill the deploy finalization.
#
# Regression: under set -euo pipefail, a commit subject without a PR number
# (or without an issue id) made the issue/pr grep exit 1, killing the while
# subshell and then the whole script BEFORE deployed-sha was written —
# deployed-sha never advanced, ✅ never announced (2026-07-06, twice).
#
# Hermetic: extracts the function from scripts/restart-services.sh (no
# copy-paste drift), runs it under production strictness (set -euo pipefail)
# against a throwaway git repo, with a PATH-shim node capturing
# report-deployed argv. No real ~/.flywheel, no network.
#
# BASH_UNDER_TEST selects the interpreter the function runs under (default:
# `bash` from PATH). Local 3.2 check: BASH_UNDER_TEST=/bin/bash bash <this>.
set -uo pipefail
BASH_UNDER_TEST="${BASH_UNDER_TEST:-bash}"

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RS="$REPO_ROOT/scripts/restart-services.sh"
[ -f "$RS" ] || { echo "ERROR: $RS not found"; exit 1; }

# ── extract the function under test (guard against sed anchor drift) ──────
FN_SRC="$(sed -n '/^record_deployed_range()/,/^}/p' "$RS")"
[ -n "$FN_SRC" ] || { echo "ERROR: extraction came back empty"; exit 1; }

SANDBOX="$(mktemp -d -t fly957-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# ── fake FLYWHEEL_DIR: real git repo + comm dist marker ───────────────────
FD="$SANDBOX/flywheel"
mkdir -p "$FD/packages/flywheel-comm/dist"
: > "$FD/packages/flywheel-comm/dist/index.js"
git init -q "$FD"
G() { git -C "$FD" -c user.name=t -c user.email=t@t "$@"; }
c() { G commit -q --allow-empty -m "$1"; }
c "init"
OLD="$(G rev-parse HEAD)"
c "bump version (#99)"                       # PR, no issue (line-46 kill shape)
c "feat(FLY-901): with pr (#465)"            # issue + PR (full report shape)
c "docs: no markers at all"                  # neither → must be skipped
NOMARK_SHA="$(G rev-parse HEAD)"             # subjects never appear in argv → assert by SHA
c "chore(progress): FLY-913 implement 1/5"   # issue, no PR — the incident shape;
NEW="$(G rev-parse HEAD)"                    # newest = read FIRST (git log order)

# ── PATH-shim node: capture report-deployed argv, exit 0 ─────────────────
CAPTURE="$SANDBOX/calls.log"; : > "$CAPTURE"
mkdir -p "$SANDBOX/shim"
cat > "$SANDBOX/shim/node" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CAPTURE"
exit 0
EOF
chmod +x "$SANDBOX/shim/node"

# ── wrapper: production strictness + extracted function ──────────────────
WRAPPER="$SANDBOX/wrapper.sh"
{
  echo 'set -euo pipefail'
  printf 'FLYWHEEL_DIR=%q\n' "$FD"
  printf '%s\n' "$FN_SRC"
  echo 'record_deployed_range "$1" "$2"'
  echo 'echo FINALIZED'
} > "$WRAPPER"
run_fn() { env PATH="$SANDBOX/shim:$PATH" "$BASH_UNDER_TEST" "$WRAPPER" "$1" "$2" 2>&1; }

# T1 — THE regression: survives PR-less / marker-less commits in the range
OUT="$(run_fn "$OLD" "$NEW")"; RC=$?
[ "$RC" -eq 0 ] && pass "exit 0 across PR-less/issue-less commits" \
                || fail "exit $RC — finalization killed"
grep -q FINALIZED <<<"$OUT" && pass "code after the call still runs" \
                            || fail "FINALIZED never reached"

# T2 — keeps processing commits AFTER the killer one (newest-first order)
grep -q -- "--issue FLY-901" "$CAPTURE" && grep -q -- "--pr 465" "$CAPTURE" \
  && pass "issue+PR commit reported after killer commit" \
  || fail "older issue+PR commit lost"
grep -q -- "--pr 99" "$CAPTURE" && pass "PR-only commit reported" \
                                || fail "PR-only commit lost"

# T3 — incident shape reported with issue and WITHOUT a --pr flag
# (note the trailing space: plain "--pr" would substring-match "--project")
grep -- "--issue FLY-913" "$CAPTURE" | grep -qv -- "--pr " \
  && pass "issue-only commit reported without --pr" \
  || fail "issue-only commit wrong or missing"

# T4 — marker-less commit is skipped, not reported (assert by its SHA — the
# report-deployed argv never contains commit subjects, so a subject grep
# would be a false signal), and exactly the other 3 commits are reported
grep -q -- "--merge-sha $NOMARK_SHA" "$CAPTURE" \
  && fail "marker-less commit was reported" || pass "marker-less commit skipped"
CALLS="$(grep -c -- "report-deployed" "$CAPTURE" || true)"
[ "$CALLS" -eq 3 ] && pass "exactly 3 commits reported" \
                   || fail "expected 3 report calls, got $CALLS"

# T5 — contract: git-log failure (unknown 40-hex old) must not escape
: > "$CAPTURE"
OUT="$(run_fn "ffffffffffffffffffffffffffffffffffffffff" "$NEW")"; RC=$?
{ [ "$RC" -eq 0 ] && grep -q FINALIZED <<<"$OUT"; } \
  && pass "git-log failure swallowed (best-effort contract)" \
  || fail "git-log failure escaped the function"

echo
echo "[TEST] passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
```

要点(review 时盯这些):

- 函数源码 **sed 提取**,不复制粘贴 → 测的永远是当前脚本;提取为空时硬失败。
- wrapper 用 `printf %q` 注入沙箱路径、`printf '%s\n'` 注入函数源码 → 无二次展开风险。
- T3 的 `--pr `(带尾随空格)是刻意的:裸 `--pr` 会子串匹配到 `--project`。
- hermetic:唯一被触碰的"外部"是沙箱内的假 FLYWHEEL_DIR 与 shim node;不读写 `~/.flywheel`、无网络(shim 拦下所有 node 调用)。

### 3. `.github/workflows/ci.yml` — 新增独立命名 step

放在 FLY-913 step 之后(块尾),照仓内惯例带 hermetic 注释:

```yaml
      # FLY-957: record_deployed_range must never kill deploy finalization.
      # Hermetic — extracts the function from restart-services.sh, runs it under
      # set -euo pipefail against a throwaway git repo + a PATH-shim node; no
      # real ~/.flywheel, no network.
      - name: Test — FLY-957 record_deployed_range best-effort
        run: bash scripts/__tests__/restart-deployed-range.test.sh
```

## TDD 步骤(implement 阶段照此执行)

1. **RED**:先建测试文件(变更 2),`bash scripts/__tests__/restart-deployed-range.test.sh` —— 预期:8 断言中 7 个失败(passed=1 failed=7;仅"marker-less skipped"的缺席断言因捕获为空而空过,配套的 count 断言 got 0 会红)、exit 1。把失败输出留档(commit message 或 PR 描述引用)。
2. **GREEN**:应用变更 1(一行修 + 注释),重跑测试 —— 预期 8 断言全过(passed=8 failed=0)、exit 0;再跑一遍 `BASH_UNDER_TEST=/bin/bash bash scripts/__tests__/restart-deployed-range.test.sh` 让被测函数真跑在 bash 3.2 下,同样 passed=8 failed=0。

> 设计阶段已在 scratchpad 对本配方(含 Codex R1 修订:SHA 缺席断言 + count=3 + BASH_UNDER_TEST)做过端到端预验证:未修真实脚本 → passed=1 failed=7 exit 1;一行修副本 → PATH bash 与 BASH_UNDER_TEST=/bin/bash(3.2)均 passed=8 failed=0 exit 0。implement 阶段照抄即可,预期输出以上述为准。
3. 回归:`bash scripts/test-restart-services.sh`(FLY-20 既有本地测试)仍全绿;`git diff` 确认 restart-services.sh 只动了那一处。
4. 接线:变更 3 进 ci.yml。
5. 全仓 `pnpm lint` 干净(push 前惯例)。

## 验收标准

- [ ] 新测试修复前红(passed=1 failed=7)、修复后绿(passed=8 failed=0),且 `BASH_UNDER_TEST=/bin/bash` 下也绿(被测函数真跑 bash 3.2;CI 用 ubuntu bash)。
- [ ] `scripts/restart-services.sh` diff 恰好一处:`done` → `done || true` + 注释。
- [ ] ci.yml 有独立 FLY-957 step。
- [ ] `bash scripts/test-restart-services.sh` 无回归。
- [ ] PR 关联 FLY-957,描述含变更摘要 + 测试计划;走 codex code review → approve gate → :cool: ship(标准流程)。

## 部署生效方式(ship 注意)

`scripts/restart-services.sh` 在 `classify_changes` 里落 `*)` → 不触发任何服务重启("No services affected"路径)。脚本每次由 updater/self-ship 从磁盘新读 → **merge 后下一次部署即用新版**,无需重启 Bridge/Lead。生产验证:下一个包含无 PR 号 commit 的部署范围,deployed-sha 正常推进 + ✅ 播报出现(此前必死)。

## Out of scope

- bug ②($USER 未设置崩溃)→ FLY-648 PR #477(lead-instruction a23bf30e)。
- `scripts/test-restart-services.sh` 不接 CI、不改造(与本 bug 无关的既有 gap)。
- 不重构 `record_deployed_range` 的解析逻辑(grep 提取方式保持原样)。
