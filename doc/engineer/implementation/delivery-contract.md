# 通用投递欠条

Issue: FLY-2248、FLY-2278
日期: 2026-09-03

Flywheel 的跨节点交接统一投影成一份 delivery obligation。这个合同只描述欠条从铸出、送出、收到到被消费的生命周期，不绑定节点类型或某一条 DAG 边。

## 权威对象

- `workflow_delivery_attempt` 保存每份逻辑交接的阶段时钟和谱系。时钟只允许从空值写入一次，重启重放不会覆盖首次证据。
- `workflow_delivery_contract_episode` 保存阶段超时 episode。同一 logical root 同时最多一个 open episode；阶段推进会关闭旧 episode。
- `workflow_delivery_operation` 是跨存储动作的可重放收据。`reroute` 由 delivery operations 把 StateStore staging、CommDB 物理改派和 StateStore projection 收敛到 `projected`；`hold_resume` 由同一 owner 收敛跨存储恢复或取消；`resident_expiry` 仍为 FLY-2268 保留，当前没有运行时 owner。
- mailbox、phase wake、turn wake、rework、carrier、launch、land 和 gate-holder 表仍是各自物理交接的权威存储。CommDB 不新增 delivery 表。

## 阶段与固定时限

| 阶段 | 时钟 | 固定超时 |
|---|---|---:|
| 铸出 | `minted_at` | 10 分钟 |
| 获准 | `granted_at` | 5 分钟 |
| 送出 | `sent_at` | 15 分钟 |
| 收到 | `received_at` | 30 分钟（仅 `launch` / `carrier`） |

没有独立消费事实的家族在 `received_at` 后不继续计时。消费事实写入 `consumed_at`，不另设通用超时。

watch 骑现有维护 tick，逐份读取当前 attempt。阶段超过固定期限时，它以 `delivery_contract_stalled:<attempt>:<stage>:<stage-entered-at>` 打开 episode，并通过既有 `workflow_alert_outbox` 升级给该项目解析出的 Lead。三倍期限仍未推进时，以相同 episode 的 `:severe` UID 再升级一次。阶段推进、重铸或终结会关闭旧 episode；确定性 UID 让重启和重放保持幂等。

## 投影与边界

Bridge 每轮先做一次 legacy baseline，再运行 CommDB projector，最后运行 deadline watch。baseline 只扫描 active/held run 上尚未完成的物理交接，因此不会把历史完成行重新铸成活欠条。

projector 只投影已有物理事实：

- mailbox: 创建、通知/送达、ACK；
- phase wake: 排队、首次 push、started；
- turn wake: 创建、首次 push、ACK；
- StateStore 原生交接: 各权威事务内写入对应时钟。

FLY-2278 在这个投影之上增加两条互斥的恢复路径：

- 收件体仍是合法非终态时，只有「超过固定阈值、session 仍非终态、近期无心跳/状态变化/出站消息」三项同时成立才冻结 run。任何一项不成立都不写 episode、event、alert 或 run 状态。
- 收件体已终态且物理交接尚未 ACK 时，先保留 live attempt 并进入 15 分钟 grace；出现同 run、同 node 的当前后继后自动改派。没有后继且缺少活性证据才进入 `delivery_undeliverable_no_recipient` 正门；超过自动改派上限只要求 operator 决策，不冻结 run。

所有 run/delivery hold 通过 `GET /api/runs/:runId/holds` 列出，先由 `POST /api/runs/:runId/resume/stage` 取得确认 token，再由 `POST /api/runs/:runId/resume` 执行。CLI 等价入口是 `flywheel-comm hold list` 与 `flywheel-comm hold resume`。恢复按 canonical digest、客户端 request id 和当前 hold 前置条件幂等；存在其他 run 级 hold 时不会提前把 run 改回 active。

这些恢复动作只消费权威物理状态和活性证据，仍不以投递失败本身推断 actor 死亡。工人常驻收信 supervisor 继续属于 FLY-2268。

## 启动与排障

FLY-2248 的首次迁移新增三张 delivery 表，CommDB 只给 `runner_phase_wakes` 增加 `first_push_at`。FLY-2278 不再增加表、列或索引；它只受控重建 `workflow_delivery_operation` 的 kind CHECK，并把 live rework/carrier attempt 的 JSON 引用补上物理版本。版本升级逐行保留 byte-exact `before`/`after` 事件，可先在只读快照上运行 `scripts/fly2278-rollback-attempt-versions.sh --db <snapshot>` 检查，再用 `--apply` 双 fence 还原。数据库 reopen 必须通过 `integrity_check` 与 `foreign_key_check`。

排障顺序：

1. 查物理交接行是否已铸出；
2. 查 attempt 的当前阶段与首次时钟；
3. 查同 root 的 open episode；
4. 查 `delivery_contract_stalled:` / `delivery_contract_frozen:` 告警是否进入既有 outbox；
5. 查 open hold 及其 `hold_resume` / `reroute` operation 是否停在 `staged`、`applied` 或 `projected`；
6. 不要因欠条超时或 transport 失败宣告 actor 死亡。
