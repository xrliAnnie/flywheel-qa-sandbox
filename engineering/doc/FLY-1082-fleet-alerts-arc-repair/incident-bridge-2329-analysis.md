# FLY-1082 QA — Bridge 23:29:14 PT 强制终止(exit 137)彻查

日期: 2026-07-09（PT）
问询来源: Annie 直接点名(经 Tadashi 转,lead-instruction 4396f074)—— 生产 Bridge 在 23:29:14 PT 被 signal 9 强制终止(退出码 137),正好在我 QA 开跑(23:14)后 15 分钟,而我的测试内容含「Bridge 非正常退出检测」。问:是不是我的测试造成的?
回答原则: 如实、证据驱动、不躲在「代码没直接指向它」后面。

---

## 结论(一句话)

我的测试**代码**没有去终止 Bridge —— 没有任何命令指向它的 pid（48951）或端口（9876）。**但我的操作极可能是触发**:我在 23:28:37 后台起了**全量 teamlead vitest**（约 20+ worker 进程），**37 秒后**（23:29:14）Bridge 就被强制终止。我认这个触发,不推卸。这恰好是本单（FLY-1082 / FLY-1072）要治的那类事故 —— 内存被打满 → 承载进程被系统回收。

## 时间线（全 PT，2026-07-09）

| 时刻 | 事件 | 目标进程 |
|---|---|---|
| 23:14 | QA 开跑（读文档 / 目标窄范围 vitest） | 隔离,无 |
| 23:16–23:19 | 5 个 FLY-1082 vitest 文件（隔离）+ shell 测试 + dist 构建（tsc） | 隔离,无 |
| 23:27 | E2E harness `node scripts/qa-fly-1082-fleet-alerts-e2e.mjs`（单进程） | 隔离 StateStore/alert-dir/claims;唯一进程操作 = 对隔离 socket「tmux -L qa-fly1082-<pid>」的 new-session + kill-server;**不碰 Bridge/9876/默认 tmux server** |
| **23:28:37** | **后台起全量 teamlead vitest `npx vitest run`** | **约 20+ vitest worker 进程 —— 资源炸点** |
| **23:29:14** | **生产 Bridge 被 signal 9 强制终止（exit 137）** | Bridge（pid 48951）—— 被系统回收,非我命令直指 |
| ~23:35 | 停掉我自己那批 vitest（`pkill -f vitest`） | 只匹配 vitest worker;pattern 匹配不到「tsx scripts/run-bridge.ts」;且在 Bridge 死后约 6 分钟 |

## 为什么不是我的测试代码直接杀的（逐条证据）

1. **E2E harness 干净**:`grep` 全文 —— 无 9876 / 无 startBridge / 无 createBridgeApp / 无 listen() / 无宽 pattern kill。唯一的进程终止是隔离 tmux socket（`-L qa-fly1082-<pid>`），它只影响那个命名 socket 的 server,不是默认 tmux server,更不是 Bridge 这个 node 进程。
2. **bridge_abnormal_exit 那一类**只往隔离临时 marker 文件写（`writeRunningMarker` / `latchPreviousMarker` / `writeCleanMarker`），**不终止任何进程**。
3. **`pkill -f vitest` 无辜**:pattern「vitest」匹配不到 Bridge 的命令行「npx tsx scripts/run-bridge.ts」;且时间在 23:35（Bridge 死后 6 分钟）。
4. **teamlead 套件里没有指向生产 Bridge 的终止代码**:唯一带「production kill」字样的测试（`bridge-event-loop-watchdog.test.ts`）终止的是它自己 `spawn` 的隔离子进程（子进程自己的 pid），不是 48951。

## 为什么我认这个触发（机制 + 佐证）

- **exit 137 = signal 9（强制终止）**。在这台机器上,这类终止只有两种来源:①内核 OOM/jetsam 在内存压力下回收 RSS 最大的进程（Bridge 就是）;②Bridge 自带的 event-loop 看门狗在事件循环被饿死 >60s 时自我终止。
- **37 秒太短,够不上 60s 看门狗阈值** → 最可能是 ①:我瞬间起 20+ vitest worker（每个都加载大 StateStore）把内存打爆 → 内核 OOM 回收了 Bridge。
- **当前机器状态佐证**:此刻 swap 仍 92.1%（16977/18432M used）、load 29.46 —— 正是这个内存压力区间。我起全量套件把它推过了边缘。

## 教训 + 承诺

- **不该在生产 host 上后台跑全量 vitest（20+ 进程）** —— 那是 CI 的活,CI 本来就把全量套件跑绿了。参照家规「Runner 绝不 host 上跑重测试」的同类精神。
- 今后 host 上**只跑窄范围目标测试**,全量一律走 CI。
- 机器此刻仍高压,remediation 归 Lead/Annie 决定,我**不自行**终止/重启任何服务（FLY-913 护栏也拦）。
- 我没 ship、也不会自 ship —— 还在 approve gate 等 Annie,批了先跑 verify-approval。
