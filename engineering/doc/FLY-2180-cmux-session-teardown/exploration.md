# FLY-2180 cmux/session teardown CI 偶发红 — 探索
Issue: FLY-2180 (https://linear.app/geoforge3d/issue/FLY-2180/ci红-main-script-tests-挂在-cmuxsession-testfly-1759-reap-first-worktree)
日期: 2026-08-30
基于: 无

## 1. 问题边界

main 的 CI run [`33293218319`](https://github.com/xrliAnnie/flywheel/actions/runs/33293218319) 在
`Script Tests 1/2 — cmux/session` 的 `Test — FLY-1759 reap-first worktree teardown` 步骤失败。
失败集中在 `scripts/__tests__/test-reap-worktree-lib.test.sh` 的真实 shell/sleep case；同一套件前三个
mock case 全绿，另一条 `test-worktree-removal-contract.test.sh` 因前一命令退出而未执行。

失败原文是：

```text
[reap-worktree] identity/path changed before TERM; refusing further signals
FAIL: real process closure did not converge
PASS=3 FAIL=1
```

这次范围只处理该真实进程 fixture 的确定性，不重设 FLY-1759 的生产安全模型，不改变 worktree
teardown 的 fail-open 审计语义，也不改 CI job 拆分或依赖安装。

## 2. 已确认事实

1. `3d8752475` 的失败 run 后，`b9070f30b` 的 CI run
   [`33295771120`](https://github.com/xrliAnnie/flywheel/actions/runs/33295771120) 用相同 reaper 与相同 shell
   test 字节通过，真实 case 输出 `PASS: real non-Node child and descendant both exit`。
2. 两个 head 在 `.claude/orchestrator/lib/reap-worktree.sh` 与
   `scripts/__tests__/test-reap-worktree-lib.test.sh` 上没有 diff；中间唯一 CI workflow diff 是另一套
   FLY-2121 测试的显式枚举。
3. fixture 的 child 由 `(cd / && /bin/sleep 300) &` 启动，父 shell 在写出 `$!` 后立即让测试调用
   reaper。写出 PID 只证明 fork 已发生，不证明 child 已完成从 shell 到 `/bin/sleep` 的 `exec`；而且
   shell 是否把该 subshell 优化成最后一条命令本身也跨平台不同：dash 会，macOS bash 3.2 不会。
4. shell reaper 会在首轮 census 捕获 `pid + lstart + command`，每次 TERM 前重新读取并要求三元组完全
   相等。command 在合法 `exec` 中变化时，它会按安全设计 fail closed，与失败日志完全一致。
5. 本机 Codex sandbox 禁止全局 `ps -axo pid=,ppid=`，因此真实 case 按既有能力守卫跳过；本机可执行
   mock/contract case，但 Linux 真进程判据必须由 PR exact-head CI 证明。
6. 用户提到的 05:15:35Z `Ship on :cool: Comment` run `33294296043` 的权威结论实际是 success；它等待
   exact-head CI 后合并了 PR。它不是第二个 teardown failure。

## 3. 最受证据支持的假设

最可能的根因是测试 fixture 的 pre-exec 调度竞态，而不是生产 teardown 回归：Linux runner 偶尔在 child PID
已写入、但 child 仍显示 shell command 时启动 reaper；identity capture 与 TERM 前复验跨过 `exec`，
于是 command 变化被正确地拒绝。调度稍快时 child 已是 `/bin/sleep 300`，同字节测试通过。

现有日志把 command mismatch、lstart mismatch、ps 不可读和中途路径 guard 失败合并成同一条
`identity/path changed`，所以它没有直接观测到 command 的前后值。本计划把这条结论保持为推断，并
让新 fixture timeout 日志输出最后观测 command 与 child census；若再发生，就能直接区分。

这个假设同时解释：

- 为什么只有真实 case 红，mock 身份栅栏 case 全绿；
- 为什么错误发生在第一发 TERM 前，而不是 TERM/KILL 收敛阶段；
- 为什么同一代码在一个多小时后的 main run 自愈；
- 为什么不能通过放松 command 栅栏修复——那会把 fixture race 变成生产误杀风险。

## 4. 方案比较

### A. fixture 等待 exec 后的稳定身份（推荐）

先把 child 写成 `(cd / && exec /bin/sleep 300) &`，使 `$!` 在 dash 与 macOS bash 3.2 上都对应
最终将被 sleep 替换的进程；读取 handshake PID 后再有界轮询 `ps -p <pid> -o command=`，只有看到
精确目标 `/bin/sleep 300` 才调用 reaper。把轮询做成可注入 `ps` 的小函数，用 hermetic mock 先写
一个会红的 readiness case，再接入真实 fixture。

- 优点：修复根因；生产安全栅栏零改动；失败时能明确区分“fixture 没准备好”和“reaper 没收敛”。
- 代价：真实 case 最多增加 100 次有界 probe；总时长含 ps 自身成本与 0.05 秒间隔，Linux 通常约
  6 秒上界、ps 较慢的 macOS 可到约 18 秒，但正常只需一个或少数轮询。

### B. 生产 reaper 允许同 PID/lstart 下 command 变化

把 command 从身份三元组删掉，或把 shell→sleep 当特殊合法转换。

- 优点：当前 fixture 无需同步。
- 缺点：破坏 FLY-1759 的 PID 复用防误杀合同；按进程类型特判也违反“不得枚举类型”。不采用。

### C. 对真实 case 或 reaper 整体重试

identity mismatch 时重新跑 case，或在测试层自动重试整套脚本。

- 优点：改动少。
- 缺点：掩盖不确定输入，不能证明实际测试了 teardown；也会让真实生产 identity drift 被误读成暂态。
  不采用。

## 5. 设计摘要

只修改 `scripts/__tests__/test-reap-worktree-lib.test.sh`：child 显式 `exec`；新增一个 Bash 3.2 兼容、
参数化 ps binary 的有界 command-readiness helper；mock ps 同时校验 argv、证明会等待 pre-exec command、
覆盖永不到达目标的 fail-closed 路径，再在真实 case 中等待 child 的 `/bin/sleep 300` 身份。timeout 打印
最后 command 与 descendant census；cleanup 已记录的 child PID 就是最终 sleep，不会因跳过 reaper 而泄漏。
生产 `.claude/orchestrator/lib/reap-worktree.sh` 保持逐字不变。

## 6. 成功标准

- hermetic readiness regression test 先红后绿；
- 现有 mock reaper cases 与 removal contract 全绿；
- PR exact-head Linux CI 的真实 shell/sleep case 全绿，且日志仍证明 child/descendant 都退出；
- `git diff` 证明生产 reaper 无改动；
- `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run` 与所有新增 shell suite 全绿。
