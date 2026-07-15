# FLY-957 record_deployed_range 收尾 grep 杀死部署 — QA 报告

Issue: FLY-957 (https://linear.app/geoforge3d/issue/FLY-957/infradeploy-record-deployed-range-一行-grep-杀死部署收尾-无-pr-号-commit)
日期: 2026-07-07
基于: plan.md, exploration.md, research.md

## 结论:PASS ✅

三段式管线 QA 阶段。实现(commit `89e7dd98`,PR #487)独立验证通过,追加一条真实场景的边界测试(T6 空范围)。QA 阶段验的分支 HEAD = `acd5a4b9`,与 PR #487 head 逐字一致。

## 范围核对(重要)

原 issue 含两个 bug;**Annie 于 2026-07-07 经 lead-instruction a23bf30e 明确把 scope 收窄**:

- **bug ①**(`record_deployed_range` 收尾 grep 一行 bug)→ 本 issue / 本分支 / PR #487。
- **bug ②**($USER 未设置崩溃,provisioner 链)→ **移交 FLY-648 PR #477**。

已核实 **bug ② 不是被静默丢弃** —— FLY-648 PR #477 **已 MERGED**,在 `scripts/provision-fleet-host.sh:394-397` 用的正是 issue 要求的回退模式,注释直接标注了 `FLY-957②`:

```bash
# FLY-957②: $USER is unset in non-login shells (containers, systemd/CI
# invocations) and this script runs under `set -u` — fall back to id -un.
run loginctl enable-linger "${USER:-$(id -un)}"
```

故本分支只覆盖 bug ①,与已批 scope 一致;bug ② 在别处已合并修复。

## 验证矩阵(全部真机执行)

| 项 | 方法 | 结果 |
|----|------|------|
| RED 复现(buggy) | 把 `done \|\| true` 还原成裸 `done` 的脚本副本跑测试 | passed=1 failed=7, exit 1(bash 5.3 + 3.2 一致)—— 测试真能抓 bug,非套套逻辑 |
| GREEN(fixed) | 当前分支脚本跑测试 | passed=10 failed=0, exit 0(bash 5.3 + 3.2 一致) |
| 根因独立复现 | 直接跑 exploration 的最小复现(裸 `git log \| while` 在 `set -euo pipefail` 下被 grep no-match 杀死) | buggy → exit 1(循环体、循环后代码都不执行);`done \|\| true` → exit 0,循环体到达(`pr=[]`)、循环后代码到达 |
| FLY-20 既有回归 | `bash scripts/test-restart-services.sh` | 62 passed, 0 failed —— 无回归 |
| restart-services.sh diff | `git diff main...HEAD` | 恰好 1 处:`done` → `done \|\| true` + 5 行注释;函数内全文件唯一的 `done \|\| true` |
| ci.yml 接线 | `git diff` | 已加独立命名 step「Test — FLY-957 record_deployed_range best-effort」,带 hermetic 注释 |
| bug ② 归属 | `git grep origin/main` provisioner 链 | FLY-648 PR #477 MERGED,`${USER:-$(id -un)}` 回退到位 |
| shellcheck | `shellcheck -S warning` 测试文件 | clean |

## QA 追加覆盖:T6 空范围(old == new)

现有 T1–T5 覆盖了混合范围(有 issue+PR / 有 issue 无 PR / 全无 / PR 无 issue / git-log 失败),但**没有覆盖空范围**——updater 触发但无新 commit(`git log NEW..NEW` 为空,while 循环体从不执行)。这是每次部署周期都可能出现的真实形态。

追加 **T6**(2 条断言):空范围必须 exit 0、finalization 继续(FINALIZED 到达)、0 次上报。

诚实说明:T6 在 **buggy 脚本上也会 PASS**(空范围根本不触发 grep-kill),所以它**不是回归守卫**,而是空范围契约的边界守卫;回归本身由 T1(`exit 0 across PR-less/issue-less commits`)钉死。RED harness 上更新后的测试 = passed=3 failed=7(marker-less-skipped + T6 两条通过,7 条回归断言失败),验证 T6 的这一特性符合预期。

## 影响面与部署生效方式(复核 plan 声明,无异议)

- `record_deployed_range` 是纯 telemetry(deploy-events fallback 上报),行为变化只有"不再杀死部署收尾",上报内容不变。
- `restart-services.sh` 在 `classify_changes` 走 `*)` → "No services affected",脚本每次由 updater/self-ship 从磁盘新读 → merge 后下一次部署即用新版,无需重启 Bridge/Lead。

## 观察(非阻塞,不属 FLY-957)

`scripts/linux-preflight.sh:93` 仍有裸 `$USER`(`loginctl show-user "$USER"`)。这属 FLY-648 领域(已合并 + 已独立 review),且是 preflight **诊断**检查而非 provisioning 动作(真正执行 provisioning 的 `enable-linger` 已修)。如需彻底收口可在 FLY-648 follow-up 处理,与本 issue 无关。

## 交付

- 追加 `scripts/__tests__/restart-deployed-range.test.sh` T6(2 断言)。
- 本 QA 报告。
- 均提交到本分支,更新 PR #487(不另开 PR)。
