# FLY-1975 codex-guard state 竞态 — 实施计划
Issue: FLY-1975 (https://linear.app/geoforge3d/issue/FLY-1975/ci%E8%A7%A3%E5%A0%B5-codex-guard-%E6%B5%8B%E8%AF%95%E5%9C%A8-hosted-runner-%E7%A1%AE%E5%AE%9A%E6%80%A7%E7%AB%9E%E6%80%81%E7%BA%A2statepidjson-%E6%9C%AA%E8%90%BD%E7%9B%98%E5%8D%B3-grep-%E6%8C%A1%E4%BD%8F%E4%B8%80%E5%88%87%E5%90%8E%E7%BB%AD)
日期: 2026-08-21
基于: research.md

## 目标与非目标

目标：让 active-record 断言在 3 秒有界窗口内等待到“可完整读取的 record”，不再把一个刚被 guard 替换掉的 pre-entry 路径带到循环外读取。

非目标：不改生产 guard、不延长 fake Codex 生命周期、不加依赖或 helper、不调整 CI shard、不顺手清理相邻测试。

## 实施步骤

1. 保留现有 `active_entry=""` 和 60 次 × 50 ms 的 bounded loop，并增加一个只用于失败诊断的 last-candidate 变量。
2. 每轮遍历当时全部 `state/*.json`，不让一个不匹配的 candidate 饥饿同轮其他有效 record。
3. 在同一轮用既有完整 JSON 正则读取每个 candidate；路径在检查与读取之间消失时静默重试。
4. 只有一次 `grep` 成功后才把 candidate 赋给 `active_entry` 并跳出两层循环。
5. 循环后的断言只检查“成功观察”的 sentinel，不再次打开文件；失败分支报告 last candidate；normal-completion 段继续独立证明最终清理。

预计只修改 `scripts/__tests__/codex-guard.test.sh` 的一小段控制流。Ponytail 决策停在“使用 Bash glob/条件与已有 grep”，不新增抽象。

## TDD 与验证

### RED

- 采用 GitHub hosted run `32541897110` attempts 1/2 的相同 37/38 失败作为修复前 RED；它直接覆盖本单要修的 hosted-runner 环境。

### 本地 smoke（非判别性）

- `bash scripts/__tests__/codex-guard.test.sh`
- 检查输出为 `passed=38 failed=0`。
- 未修复的 macOS worktree 已能通过该命令，并且它走 pure-Bash seam；因此这里只证明没有引入普通回归，不能证明 hosted external-timeout 竞态已修。

### Bash 直接门禁

- `bash -n scripts/__tests__/codex-guard.test.sh`
- `shellcheck scripts/__tests__/codex-guard.test.sh`

### Runner role 的全仓卫生门禁（不作为该 shell 竞态的判别器）

- `pnpm lint`
- `pnpm -r build`
- `pnpm test:packages:run`

这些命令不覆盖 shell 行为；执行它们是 runner role 的仓库卫生要求，不拿它们证明本修复正确。

### 判别性 GREEN

- CI 的 `Script Tests 2/2 — fleet/setup/packaging (shell suites)` 在 hosted Ubuntu 连续两次成功。
- n=2 是 issue 指定的验收样本；不把两跑绿夸大为概率归零。

### 完成审计

- `git diff --name-only origin/main...HEAD` 只包含该测试和 `engineering/doc/FLY-1975-codex-guard-state-race/`。
- `git diff -- scripts/lib/codex-guard.sh scripts/codex-with-fallback.sh` 为空，证明零生产代码改动。
- code review 绑定最终 head 并得到 `APPROVED` 后开 PR。
- implement 节点以 `complete --route needs_review --pr <number>` 交棒，不自行 merge、部署或触发重启。
- #916 的 rerun 需要在修复进入其基线后由后续 ship/Lead 流程执行；本节点不改写别人的 PR 分支。

## 风险与控制

| 风险 | 控制 |
|---|---|
| 循环误把“找到路径”当成功 | 只在完整 JSON `grep` 成功后设置 sentinel |
| 循环外再次产生 TOCTOU | 不二次读取路径；成功读取本身就是证据 |
| 无限等待拖死 CI | 保留 3 秒硬上限 |
| 错误吞掉真实超时 | 超时仍进入原 fail 分支，并打印最后一次发现的 candidate；从未发现文件才打印 `missing` |
| 修测试时误改生产语义 | diff 审计 + production-path zero-diff 断言 |

## 会过期的结论

| 结论 | as-of | 重核方式 |
|---|---|---|
| 修复预计只需约 5 行测试控制流 | 设计评审前 | 实施后看 `git diff --stat` / `git diff --check` |
| 本地全仓门禁命令仍为三条 | 2026-08-21 的 engineer role | 重读当前 dispatch prompt 与根 `package.json` scripts |
| #916 必须在修复进入其基线后 rerun | PR #916 head `f03a5f37...` | `gh pr view 916 --json headRefOid,mergeStateStatus,statusCheckRollup` |
