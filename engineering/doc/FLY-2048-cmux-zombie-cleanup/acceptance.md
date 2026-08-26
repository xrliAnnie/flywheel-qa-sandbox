# FLY-2048 cmux 僵尸收敛 — 验收记录
Issue: FLY-2048 (https://linear.app/geoforge3d/issue/FLY-2048/cmux-展示错误信息历史死视图死-workspace-不被清理越攒越多founder-8-25-直令马上修)
日期: 2026-08-25
基于: plan.md

## 1. 当日真机分类账

首次诊断快照中，cmux 共有 78 个 workspace；Flywheel-managed runner 展示集为 60，
在世 tmux runner 集为 4，`missing=0`、`extra=56`。56 个存量僵尸按 ledger 状态分为：

- `committed` exact receipt：25；
- `prepared` exact receipt：31；
- 无账本 stock：0。

边界外 workspace 共 18 个：16 个 Lead-like workspace、1 个 Terminal workspace、1 个语音实况。
它们不属于 runner GC 的关闭域。验收前的后续快照因并发 runner 新增变为：cmux 总数 84，
managed 展示 66，在世 10，仍为 `missing=0`、`extra=56`；这证明存量差额稳定，而不是
活 runner 建立过程中的瞬时偏差。

另发现两条历史 attach helper incarnation；原 watcher 只为本轮 close request 铸造
`reapv1`，所以它们一直停留在 report-only observation，无法进入 TERM/KILL 状态机。

## 2. 根因与闭环

1. workspace orphan 枚举只接受 `committed` ledger；31 条合法五字段 `prepared` 收据永远
   进不了 exact close guard。
2. 历史 helper discovery 的第二轮只告警并删除 observation，不铸造已有的 bounded
   `reapv1`，因此历史载体不会被信号回收。
3. watcher 把 orphan 清理排在慢 refresh tail 之后，卡顿时本轮 cleanup 不可达。
4. `--once` 与 resident watcher 共用 mutator lease，冲突时却返回成功；人工无法判断是否
   真正执行了全量清理。

修复复用现有 receipt、WAL guard、ops handover 和 `reapv1` 状态机，没有新增另一套关闭或
信号协议。新人工入口为：

```sh
scripts/flywheel-cmux-sync.sh --converge-runners --handover
```

它在独占 lease 下做两个相隔至少 60 秒的完整 observation round；每轮重新读取 tmux、cmux、
process census 与 WAL guard。旧 `--once` / `--reap-orphan-pins` 无法 mutate 时改为非零退出并
指向该入口。

## 3. 自动化验收

| 验收项 | 结果 |
| --- | --- |
| `scripts/test-cmux-sync.sh` | 580 项：本 sandbox 579 passed、0 failed、1 条 `ps`/`exec -a` host-capability 阳性用例条件跳过；具备该能力的宿主为 580/580 |
| `scripts/__tests__/fly1944-helper-reap.test.sh` | 14 passed，0 failed（含真实 TERM/KILL 阳性对照） |
| `scripts/__tests__/fly2048-cmux-convergence.test.sh` | 14 passed，0 failed |
| `scripts/test-cmux-sync-hooks-integration.sh` | 12 passed，0 failed，real tmux 3.5a |
| `bash -n` changed shell files | passed |
| `shellcheck -S error` changed shell files | passed |
| `git diff --check` | passed |
| `pnpm lint` | passed；仅既有非本单 warning |
| `pnpm -r build` | passed |
| 非 GUI package tests | core 219/219；config 43 files / 661/661，含修复后 `feature-flags-drift` 13/13；本轮 teamlead 负载/缓存失败文件隔离单 worker 重跑 84/84 passed |

本轮 QA 机械修复的实现 head 为 `26285b6d1`；最终 exact-head code review 以 PR #959
review gate 记录的 `reviewHeadSha` 为准，避免在包含自身的文档 commit 内留下不可能自洽的 SHA。

原始 `pnpm test:packages:run` 仅有两条 Terminal.app AppleScript 真机 UI 测试因 Codex sandbox
无法连接 UI service 失败；非 GUI core 重跑 19 files / 219 tests 全通过。顺序化非 core 全包中，
`claude-runner` 的两个 5 秒 real-tmux 用例超时、一个 socket assertion 与并行 real-tmux 竞争；
三文件在单 worker 隔离重跑 4/4 通过。本轮 rework 的 teamlead 负载/缓存失败文件另在可写
npm cache 下单 worker 隔离重跑 84/84 通过。`scripts/test-cmux-sync.sh` 的唯一条件跳过是
宿主需能在 `ps` 中保留 `exec -a` argv 的阳性分支，不是功能失败。

最终 code review 的非阻塞 advisory 发现：两轮之间单次前台 `sleep 60` 会让 Bash 3.2
把 INT/TERM trap 延迟到 sleep 返回，在此期间继续占用 lease。新增 RED 在 3 秒预算后仍未退出，
强制清理进程组得到 `rc=137` 且无 release 记录；实现改为 60 个一秒片段后，同一测试在一秒内
以 `rc=143` 退出并记录 lease/claim release，完整 60 秒 observation 下限保持不变。

## 4. 假死阳性对照

隔离 fixture 启动了真实 helper root、真实阻塞 child 和无关 decoy，并通过生产
`reapv1` 推进函数发送真实信号；测试只快进 15 秒 deadline，未替换 TERM/KILL seam。推进后：

- helper root：不在世；
- helper child：不在世；
- unrelated decoy：仍在世；
- `reapv1` 的 delivery 先落盘再发信号，TERM 后两者仍在世，KILL 后才退出。

对应自动测试删掉第二轮 observation 或 mint 步骤会变红，证明阳性结果不是 fixture 自清理。

## 5. 宿主机对账与第一轮回授

Codex sandbox 禁止 process census（`ps` 返回 operation not permitted），生产脚本因此按安全契约
fail-closed。question gate `aabdbc51-d1ef-40b7-a985-23828e0deff5` 由 Lead 在宿主环境执行了
branch head `851484558`：

- handover 等待与两轮操作总耗时 744 秒；执行窗口负载约 40–70；
- 55 个 exact orphan workspace 被 guarded close，包含 FLY-1850、FLY-1851、FLY-2000、
  FLY-2018 等陈年条目；
- tmux window 数 `125 → 127`，增加 2 个正常新生窗口，没有活 tmux window 被终止；
- 原始日志：`/tmp/cmux-converge-live.log`；前后 tmux census：
  `/tmp/cmux-census-before.txt`、`/tmp/cmux-census-after.txt`。

第一轮同时发现三个验收缺口并已补 RED/GREEN：

1. `FLYWHEEL_CMUX_DRY_RUN=1` 仍发布 handover claim，且 guarded close 没有统一 dry-run seam；
   新实现会在 claim 之前返回，保证 claim/lease/state/signal/cmux mutation 全为零。
2. `flywheel_alert` dead-letter 的 rc=2 会在 `set -e` 下越过函数末尾的 `return 0`，覆盖已经完成的
   cleanup 结果；现在 alert sidecar 显式 `|| true`。
3. 55 条关闭后，精确对账仍为 managed cmux 11、live managed tmux 10：唯一 `extra` 是
   `workspace:48 / FLY-1934-qa-claude-Opus-self-ship-policy-merge-00-`。它持有当前 generation 的
   四字段 legacy `prepared`，既不属于 UUID-bound orphan path，也被 stock path 的
   `existing-ledger-authority` 拒绝。现在只有显式 handover 会在两轮 exact stock topology proof
   后提升并关闭这种 legacy receipt；resident watcher 与普通 one-shot 仍无此权威。

需在包含上述修补的新 branch head 上再跑一次 handover，并补齐最终 `extra=0 / missing=0`、
活 workspace 不变、边界项保留及 watcher resume 回执，才能把真机验收标为完成。

## 6. 第二轮真机回授：handover 长 pass 盲区

Lead 在 branch head `ab7e7a315` 上复跑：`rc=1`、总耗时 716 秒，其中 600 秒为 lease
等待；日志只有 claim 发布、等待超时与 rc 三类记录，`close=0`，因此本轮零 cmux mutation。
fail-loud 与 alert 不吞 rc 均按设计生效。

只读时间线排除了 launchd 重抢和“部署版不认识 ops claim”两个初始假设：部署 watcher 的 owner
PID 34451 在 15:30:45 已持锁，早于 15:36:53 的 claim 六分钟；部署脚本也已经包含
`CMUX_OPS_REBUILD_CLAIM` 与 `watcher_maintenance_checkpoint()`。`/tmp/flywheel-cmux-watcher.log`
显示 claim 到达后它仍在逐条处理庞大的 `CLEANUP_PENDING`，每条约两秒并打印
`Node-presence fence waiting...`。该循环已有安全 `watcher_mutation_latch_clear()`，但 latch 原来
只看 lease 丢失，不看 maintenance，因此 600 秒内从未走到 tick 间 checkpoint。

RED/GREEN 修补不新增信号或锁协议：watch pass 的既有 latch 现在同时观察 maintenance；命中后
停止本 pass 后续 mutation、保留持久队列未处理尾部，`watcher_finish_pass()` 立即复用既有
checkpoint 释放 lease 并停靠。专项回归为 9/9，全量 `scripts/test-cmux-sync.sh` 为 579/579。
第三轮必须让当前 branch watcher 实际持有生产 lease 后再发 claim，验证该安全边界的真机交接，
随后完成 `workspace:48`、集合差额、helper 与 watcher resume 的最终对账。

## 7. 第三轮真机回授：安全交棒与净收敛

Lead 在最终修补后的 branch watcher 上完成第三轮。branch watcher PID 33634 先以 exact owner
身份持有生产 lease；17:13:36 发布 handover claim 后，正在长 pass 内的 watcher 于
17:14:06 命中 maintenance latch，日志各出现一次：

- `maintenance requested during watcher pass; aborting remaining mutation at safe boundary`；
- `maintenance requested; watcher yielding mutator lease`；
- 收敛结束后 `maintenance cleared; watcher reacquired mutator lease`。

`--converge-runners --handover` 随后独占 lease 运行 3 分 59 秒，清理当时积累的 15 个 runner
orphan pin，并通过 stock-adoption guarded close 清掉历史四字段 legacy receipt
`workspace:48 / FLY-1934-qa-claude-Opus-self-ship-policy-merge-00-`。终态中 `workspace:48=[]`，
handover claim 已清除，branch watcher 同一 PID 恢复持锁；随后官方 launchd watcher PID 19257
由宿主生态自动接回，branch watcher 按监督语义无裂脑退出。官方 label、watch 状态与 lease owner
均恢复正常。

runner 关闭域的最终逐项对账为 `extra=0`、`missing=0`。全局 verifier 仍返回 rc=1，只因两个
验收前后保持同一 ref/UUID 的 Lead seat：`workspace:172 / flywheel-codex-infra-bot-lead` 与
`workspace:247 / growth-mufasa-lead`。它们按 plan §0.1 的既定 ownership 边界不属于 runner GC；
本次既未把它们计为 runner 成功，也未越权关闭。真实历史债务的阳性样本还包括一整队 FLY-560
陈年死视图，收敛后 `fly560_residue=0`。

生产 ADD 路也在真机证成：合成窗口在 53 秒内出现为 `workspace:294`。但其 REAP 计时对照没有
记为通过：顶班约 9.5 分钟后官方 `com.flywheel.cmux-watcher` 被宿主生态自动重挂，branch watcher
安全让锁，导致该原始 tmux 窗口（没有完整 Node classification/receipt authority）的观察窗中断；
Lead 已精确手工移除残影。因此“完整 Node-aware 合成样本在部署版上的限期 REAP”保留为
post-deploy 补验项。这里不以不完整 fixture 替代通过证据；自动化真实 helper TERM/KILL 对照和
上述生产历史债务大样本共同覆盖本 PR 的回收路径。

第三轮原始证据：`/tmp/fly2048-branch-watcher.log`、
`/tmp/fly2048-converge-live-r3.log`、`/tmp/fly2048-cmux-before-r3.json`、
`/tmp/fly2048-cmux-after-r3.json`、`/tmp/fly2048-tmux-before-r3.txt`、
`/tmp/fly2048-tmux-after-r3.txt`、`/tmp/fly2048-verify-after-r3.json`。
