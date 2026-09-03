# 通用投递欠条

Issue: FLY-2248
日期: 2026-09-02

Flywheel 的跨节点交接统一投影成一份 delivery obligation。这个合同只描述欠条从铸出、送出、收到到被消费的生命周期，不绑定节点类型或某一条 DAG 边。

## 权威对象

- `workflow_delivery_attempt` 保存每份逻辑交接的阶段时钟和谱系。时钟只允许从空值写入一次，重启重放不会覆盖首次证据。
- `workflow_delivery_contract_episode` 保存阶段超时 episode。同一 logical root 同时最多一个 open episode；阶段推进会关闭旧 episode。
- `workflow_delivery_operation` 是为 FLY-2268 保留的跨存储收信操作收据，本任务不挂载 reroute、hold recovery 或其他 mutation owner。
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

本任务不做自动改派、不因投递失败冻结 run、不提供 hold resume API，也不以投递失败推断 actor 死亡。这些恢复动作属于后续工作；工人常驻收信 supervisor 属于 FLY-2268。

## 启动与排障

迁移保持纯加法：StateStore 新增三张 delivery 表；CommDB 只给 `runner_phase_wakes` 增加 `first_push_at`。数据库 reopen 必须通过 `integrity_check` 与 `foreign_key_check`。

排障顺序：

1. 查物理交接行是否已铸出；
2. 查 attempt 的当前阶段与首次时钟；
3. 查同 root 的 open episode；
4. 查 `delivery_contract_stalled:` 告警是否进入既有 outbox；
5. 不要因欠条超时或 transport 失败宣告 actor 死亡。
