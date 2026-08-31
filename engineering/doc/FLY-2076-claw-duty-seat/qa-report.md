# FLY-2076 Claw 值守席位 — QA 报告

Issue: FLY-2076 (https://linear.app/geoforge3d/issue/FLY-2076/2073值守-claw-infrabot-值守上岗对整条队列负责-初审三去向宁转勿吞)
日期: 2026-08-27
基于: plan.md（含 §12 founder 返工补充）、PRD `product/doc/FLY-2060-alerts-duty/prd.md` R1/R2/Q3/§6

## 0. 结论

**功能验收 PASS。** 被验实现 `eaeb0f0d5` + 审查修复 `a32dfd776` / `a65b6c272` 同时落地了：

- Claw 原有 agent **拿到新的 alerts 全队列值守职责**，不是创建一个新 agent；
- 初审只有 ① 解决并立刻写 runbook、② 查 contact book 转负责人、③ 查不到转 Tadashi；
- 无 runbook 且不确定时只读排查，不以修改系统状态试错；压力可见时主动报告；收场保留 R8 根因线；
- store-managed、默认开启的总开关 `alert_system`。它在 `flag_values` 中逐次读取，修改后无需重启；OFF 时告警仍落既有 `lead_events`，但不进 Discord、不建工单、不投 Claw mailbox；OFF 审计身份不会占用正常投递去重槽，durable workflow/land outbox 与 founder `emit_alert` action 也不会在关闭期间消耗 attempt；
- 一个连续进程内的真实 Discord 验收链：ON 完成 `告警 → thread → 工单 → Claw 去向 ②`，热切 OFF 后只落账，热切回 ON 后**同一稳定 event ID** 立即恢复进入主管道。

产品结论绑定到上述三个实现提交；后续提交只更新 QA/进度文档。

全仓 lint/build 为 0 退出码。完整 package test 中与本改动直接相关的功能测试均通过，但默认并发命令仍被一个与本单无关的既有 real-tmux 时序用例挡住 0 退出码；该用例隔离复跑 1/1 通过。详见 §6，未伪报全绿。

## 1. founder 返工硬门：一条连续真实链

harness：`qa-e2e/real-discord-e2e.mjs`。使用编译后的真实 `StateStore`、`FlagStore`、`LeadAlertNotifier`、`AlertChannelHub`、`buildInfraAlertRouting`、duty router 与 `flywheel-comm alert-ticket` CLI；Discord API 不 mock。状态库、queue、claims 与 deadletter 全在临时目录，频道固定为隔离的 `#test-flywheel-alerts`（`1519421055805165842`），测试 mention 使用不可 ping 的假 snowflake。

审查修复后重跑结果：**11/11 PASS**，标记 `[QA2076-5823537]`，隔离目录 `qa-fly2076-POTo9C`。

| 连续步骤 | 真机证据 |
|---|---|
| 默认 ON | `storeAlertSystemEnabled()` 为 true；真实根消息 `1542645818626932836` 与 thread 建立，工单状态 NEW |
| Claw 初审 ② | 真 thread 留下 🧭 帖 `1542645822783619072`，写明只读排查、contact book 命中、去向 ②、R8「判不清 + 已知到哪一步」 |
| Claw 真 CLI 落账 | `flywheel-comm alert-ticket handoff --event-id ... --to flywheel-eng-lead` rc=0；账本变为 ESCALATED、`owner_ref=lead:flywheel-eng-lead`、`acked_at` 非空 |
| 真根消息重渲染 | 从 Discord 回读 owner Tadashi、状态 ESCALATED |
| 热切 OFF | 向 `flag_values.alert_system` 写 `0`；同一对象、同一进程下一次读取立即为 false |
| OFF 只落账 | 下一条事件写入既有 `lead_events`（seq=2）；返回 `skipped=disabled`；Discord 搜不到消息、`alert_threads` 无工单、Claw mailbox 数量不变 |
| 热切回 ON | 删除 override 后立即为 true；不重建对象、不重启进程，重放 OFF 时的**同一 event ID** 后建立根消息/thread（根消息 `1542645829393846353`） |

这条链没有拆成“上半段/下半段”分别验，也没有新增告警层。

## 2. 总开关边界与 failure path

`alert_system` 加入 `STORE_MANAGED_FLAGS`，类型为 bool、`default_on`、默认 true；普通 Bridge flag route 可对它写 `flag_values`。生产接线传入 call-time closure，不在启动时缓存值：

- `buildInfraAlertRouting` 在 enrichment、Discord、ticket/mailbox 前检查；OFF 只调用 `recordAlertSystemSuppression()` 写既有 `lead_events`；
- `LeadAlertNotifier.alert()` 在 validation、Discord、deadletter、queue 前检查；
- `LeadAlertNotifier.drainQueue()` 在 OFF 时不发送、不 deadletter、不消费排队项，避免关开关期间丢既有欠账；
- OFF 的 `lead_events` 审计行使用 `alert-system-suppressed:<eventId>` 身份，payload 保留原事件；热开启后原 event ID 仍可赢得正常投递槽；
- `WorkflowEngineDispatcher` 在 OFF 时不 claim workflow/legacy-land alert outbox，关闭期间即使多次 reconcile，row 仍为 `pending/attempt=0`，开启后从原 durable row 投递；
- founder action drain 在 OFF 时只暂停 `emit_alert` 分支，不调用 sink、不消耗 must-deliver row 的 bounded retry；非告警 notice/wake 不受影响；
- flag 关闭的是**整个告警系统的派送面**，不是关闭 Claw agent；
- 本单没有实现 flag 的 CI 拦截与存量迁移，也没有引入指标、考核、hard work limit 或噪音判断层。

新增/扩展测试的 RED → GREEN 证据：

| 测试面 | RED | GREEN |
|---|---|---|
| flag runtime | `storeAlertSystemEnabled is not a function` | 默认 ON；DB 写 0 后下一次读取 OFF，无重启 |
| routed intake | OFF 仍返回 queued | OFF 写 ledger，raw/ticket/fetch 均为 0 |
| direct notifier | OFF 仍尝试 Discord/queue | OFF 只落账，外部副作用为 0 |
| queue drain | OFF 仍 fetch/消费 | sent=0，backlog 原样保留 |
| 稳定 ID 恢复 | OFF 审计行占用正常去重槽，ON 后同 ID 返回 duplicate | OFF 审计与 delivery claim 分离，同 ID 热恢复成功 |
| workflow outbox | OFF 下每秒 reconcile 消耗 attempt，约 3 秒后 terminal failed | OFF 不 claim，4 次 reconcile 后仍 `pending/attempt=0`；ON 后 `sent/attempt=1` |
| founder alert action | OFF 下约 5 次 drain 后 must-deliver `emit_alert` terminal failed | OFF 下 5 次 drain 后仍 `pending/attempts=0`；ON 后同一 row `delivered` |
| registry drift | 缺 canonical import/call 与 identity | registry/readSite/STORE_MANAGED_FLAGS 闭环 |

## 3. 值守席位与接入机制

接入复用 FLY-2075 修复后的主管道：普通 alerts 经 durable Claw mailbox，`workflow_engine_escalation` 经既有 Hub/Discord；不新增告警层。角色文件把 Claw 定为 alerts 中唯一看全队列的席位，并明确 Cass 退出值守；“谁都不救自己”继续生效，Claude 侧 auth 问题仍转 Codex 侧。

角色/门控 shell harness：**19/19 PASS**：

- launch capability 5/5；
- `apply-alert-duty-gate` 8/8；
- `fly2076-identity-sentinel` 1/1；
- duty provision 5/5。

真实 Bridge mount：**9/9 PASS**。duty bearer 可访问 `/duty`，shared API bearer/无 bearer 被拒；duty bearer 不能访问 `/api`；seat probe late-bound；Hub 未接、token 未配置、token 碰撞均 fail-closed。

积压与无噪音层：**6/6 PASS**。60 条欠账可分三批完整排空；25 是一次读取的有界批次和可见压力信号，不是工作 hard limit；`since` cursor 与 legacy 行边界正确，查询不按 kind/severity 过滤。

flag truth shell：**3/3 PASS**，store-managed flag 的持久 env 行会被拒。

## 4. 定向测试与构建

| 命令/范围 | 结果 |
|---|---|
| config registry/store-policy/truth/final-ledgers | **97 passed** |
| config feature-flags drift | **13 passed** |
| 审查修复定向：notifier/dispatcher/founder action/router/flag runtime | **205 passed** |
| `pnpm --filter flywheel-teamlead typecheck` | PASS |
| config/teamlead/flywheel-comm build | PASS |
| `git diff --check` | PASS |

## 5. 全仓门禁

| 门禁 | 结果 |
|---|---|
| `pnpm lint` | `a65b6c272` 内容后重跑 exit 0；15 warnings / 0 errors，均在本 PR 未改文件；`StateStore.ts` 的 1.7 MiB max-size 提示为既有配置 |
| `pnpm -r build` | `a32dfd776` 后重跑 exit 0；22/22 workspace build 完成 |
| FLY-2076 harnesses | 37/37 PASS（9 Bridge + 6 backlog + 19 duty/identity/provision + 3 flag truth） |

## 6. 完整 package test 的诚实边界

`pnpm test:packages:run` 做了三轮：

1. 原样跑：唯一失败文件是 `packages/core/test/tmux-viewer.macos.test.ts` 的 2 个真实 Terminal.app/osascript 用例；resident 无 GUI session。core 其余 219 例通过。
2. 按该测试文件注释声明的 headless 路径，让不可用的 Terminal.app 用例 skip：claude-runner 只剩 `tmux-slot-routing.real-tmux.test.ts` 1 例失败，915 例通过、2 例 skip。
3. 同条件再跑：同一例以同一症状失败；没有出现 FLY-2076 代码相关失败。

失败形状：全套并发/高负载下 200ms probe pane 在 `onTmuxWindowCreated` 取 socket 前已退出，`openedSocket` 留空。随后隔离运行：

`pnpm --filter flywheel-claude-runner exec vitest run test/tmux-slot-routing.real-tmux.test.ts`

结果 **1/1 PASS（413ms）**。本单不顺手扩大范围修改 FLY-1999 的时序测试；review/CI 仍会看到这条宿主并发风险。

## 7. 未越界声称的部分

- 真链验证的是 Claw 使用的真实 duty CLI 与 ② 状态迁移，不是假实现；但没有把生产 resident Claw 模型拉进 QA 频道做一次自主判断。部署后首条生产告警仍需观察它是否按 identity 自主选对 ①/②/③。
- 没有部署或重启 Bridge/Lead；实现先进入 PR，正常部署由后续班车完成。
- FLY-2077 contact book 内容、FLY-2078 被 @ Lead 的必达性继续由各自 issue 负责。
- 真实 Discord 验收留下测试 thread/message 作为审计痕迹；没有修改生产 `teamlead.db`、claims、queue 或 access 配置。

## 8. 可重跑证据

- `qa-e2e/real-discord-e2e.mjs` —— 连续真实 Discord + hot OFF/ON（11 assertions）
- `qa-e2e/bridge-mount.mjs` —— 真 Bridge/capability 隔离（9 assertions）
- `qa-e2e/backlog-drain.mjs` —— 积压排空/无 hard limit/无噪音层（6 assertions）

三者都使用真实产品路径，并带阴性对照。
