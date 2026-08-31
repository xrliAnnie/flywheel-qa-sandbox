# FLY-2139 retention registry 对账

Issue: FLY-2139 (https://linear.app/geoforge3d/issue/FLY-2139/bridge-稳定全方位定期清理-文件db-陈旧数据的机制化清理与-index-审计保证-bridge-常快founder-已令开工)
日期: 2026-08-29
基于: plan.md

## 现场结果

对生产 `teamlead.db` 与 `comm/flywheel/comm.db` 只读枚举 `sqlite_master`，再交给
`assertClassifiedSchema` 对账，发现四个 registry 后出生的表：

| DB | 表 | 分类 | 消费者依据 |
|---|---|---|---|
| teamlead | `flag_scan_scope_state` | `protectedCurrentOrReference` | `StateStore` 在每轮 flag retirement scan 读取、upsert、删除当前 scope 游标；它是活控制状态，不是历史事件。 |
| teamlead | `patrol_orphan_watch` | `protectedCurrentOrReference` | FLY-2118 的 patrol orphan watcher 持久化当前观察窗与告警状态；它是活巡检状态，不是可按时间删除的历史行。 |
| comm | `mailbox_archive` | `protectedCurrentOrAuthority` | FLY-2136 的 bounded archive 保留终态 mailbox 载荷；本单不二次删除或导出 archive。 |
| comm | `runner_stop_declarations` | `protectedCurrentOrAuthority` | `flywheel-comm` 的 stop declaration / finalize / race recovery 仍按 `execution_id` 读取和更新；只有原 owner 在明确生命周期点删除。 |

四表均不进入 `deleteTarget`。更新 registry 后，现场两库 `schema_unclassified` 归零。常驻守卫分两层：生产 schema fixture 继续做 registry 的精确缺表/多表对账；另一个测试实际调用 `StateStore.create()` 与 `new MailboxQueue()` 创建当前两类 DB，再枚举 `sqlite_master`，任何未来构造器新增但未分类的表都会在 CI 直接报 `schema_unclassified`。consumer gate 继续要求任何新增 reader 在删除族变更时显式评估。
