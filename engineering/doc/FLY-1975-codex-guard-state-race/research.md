# FLY-1975 codex-guard state 竞态 — 调研
Issue: FLY-1975 (https://linear.app/geoforge3d/issue/FLY-1975/ci%E8%A7%A3%E5%A0%B5-codex-guard-%E6%B5%8B%E8%AF%95%E5%9C%A8-hosted-runner-%E7%A1%AE%E5%AE%9A%E6%80%A7%E7%AB%9E%E6%80%81%E7%BA%A2statepidjson-%E6%9C%AA%E8%90%BD%E7%9B%98%E5%8D%B3-grep-%E6%8C%A1%E4%BD%8F%E4%B8%80%E5%88%87%E5%90%8E%E7%BB%AD)
日期: 2026-08-21
基于: exploration.md

## 失败证据

PR #916 的 workflow run `32541897110` 在同一 head `f03a5f37e7b1fd911e1450fec0e2bc4acabec3da` 上重跑一次：

| attempt | Script Tests 2/2 job | 结果 | 失败证据 |
|---|---:|---|---|
| 1 | 96953413301 | failure | `state/65995.json: No such file or directory`，37/38 |
| 2 | 96956276976 | failure | 同一路径、同一断言，37/38 |

两次都在 active-record 段开始后约 64 ms 失败，随后约 2 秒时 normal-completion 断言通过。说明 wrapper 与清理流程仍在工作，失败只发生在观察 active record 的瞬间。

## 根因

两条 guard 路径都有相同注册顺序：

1. `_codex_guard_register_pid "${BASHPID:-$$}"` 同步原子写 pre-entry。
2. 后台启动受保护的命令。
3. `_codex_guard_register_pid "$child_pid"` 同步原子写 child-entry。
4. child-entry 成功后立即 `_codex_guard_forget_entry "$pre_entry"`。

测试的循环只要求 `find` 返回某个 `*.json`。hosted runner 稳定地在步骤 1 与步骤 4 之间取得 pre-entry 路径；循环随即结束，步骤 4 删除该路径，循环外 `grep` 打开旧路径便失败。这是测试的“发现路径”和“读取内容”分离导致的 TOCTOU，不是 JSON 写入异步或不原子。

## 方案比较

### A. 在既有循环内完成内容读取（采用）

每轮先找 candidate，再立刻 `grep` 完整 record；只在 `grep` 成功后保存 `active_entry` 并结束循环。文件在两条命令之间被替换时，静默重试；60 × 50 ms 的现有 3 秒上限不变。

优点：只动测试；复用现有工具和预算；成功条件直接等于断言所需的“曾读到完整活动记录”；无需再次打开可能已清理的文件。

### B. 让 fake Codex 额外写 PID，再等待精确 child-entry

hosted Ubuntu 存在 `/usr/bin/timeout`，external-timeout seam 注册的是 `timeout` 进程 PID，不是 nested fake Codex PID。测试若等待 fake Codex 自报 PID，要么永远匹配不到，要么必须像 interrupted-wrapper 用例一样故意破坏 `timeout` 来改测 pure-Bash seam；两者都会偏离本单真实失败环境。这比 fixture 多写一个 PID 更关键，因此不采用。

现有断言名称也略宽：瞬时 wrapper pre-entry 本身是完整 identity record，所以“活动调用 record”不保证一定是最终受保护 child 的 record。这是既有语义，不在本单扩张。

### C. 延长 `sleep 2` 或在 `find` 后固定 sleep

只改变时间窗口，不能消除 TOCTOU；更快或更慢的 runner 仍可能失败。

### D. 改生产 guard 发同步完成信号

违反本单“只动测试、零生产代码”，且生产写入已经同步。没有必要。

## TDD 与验证策略

- RED：run `32541897110` 的 attempt 1/2 是同一 head、同一 hosted 环境中的重复失败证据。
- 本地 smoke：`bash scripts/__tests__/codex-guard.test.sh` 在未修复的 macOS worktree 已经 38/38，且走 pure-Bash seam，不能判别 hosted external-timeout 竞态；只用于发现普通回归。
- 判别性 GREEN：推分支让 hosted `Script Tests 2/2` 连续两跑。n=2 是本单明确验收样本，不外推为统计意义上的“永不 flake”。
- 回归：运行全仓 lint、workspace build、package tests，并显式审计 `git diff` 确认生产文件零改动。
- 解堵：修复进入可被 #916 消费的基线后 rerun #916，要求该 shard 与汇总 `CI OK` 同时转绿。

## 会过期的结论

| 结论 | as-of | 重核方式 |
|---|---|---|
| #916 两次失败来自同一 workflow run 的 attempts 1/2 | 2026-08-21 | GitHub Actions API 查询 run 32541897110 的 attempts/jobs，并读取两份 job log |
| pre-entry 与 child-entry 的替换顺序相同 | `origin/main@772a116ed` | 重读 `_codex_guard_run_bash` 与 `_codex_guard_run_external` |
| 现有 bounded loop 为 60 × 50 ms | `origin/main@772a116ed` | 重读 `scripts/__tests__/codex-guard.test.sh` active-record 段 |
