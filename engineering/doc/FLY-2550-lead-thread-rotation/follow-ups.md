# FLY-2550 常驻 Lead 线程轮换 — Follow-ups(Codex R4 非阻塞项)
Issue: FLY-2550 (https://linear.app/geoforge3d/issue/FLY-2550/2355e-常驻-lead-记忆蒸馏真拦点-codex-threadsid-current-thread-id-排除常驻-lead-永不换)
日期: 2026-09-15
基于: plan.md(v4,Codex R4 APPROVED)

> Lead 裁定(`3e8fcad4`):R4 的新 LOW/MED 记在这里,不再开评审轮;实施 runner 在做对应 chunk 时**顺手收口**,QA 按此文件补判据。原文见 `codex-review/r4.md` §Follow-ups。

| # | 级别 | 内容 | 收口方式(实施时) | 落点 |
|---|---|---|---|---|
| F1 | MED | fence 解除路径写 `lastAttemptAt` 失败时只 warn,若磁盘持续不可写,due 仍成立 ⇒ 每分钟重复 kill/recreate pane | 该 transition 失败 ⇒ 恢复 router/pane 后置 `rotationDisabledThisGeneration = "ledger_write_failed"`(与 attempt-mark 二次写失败同一规则);C7 加测试「skip transition 写失败 ⇒ 本代不再 fence」 | plan §3.2 解除序列、§3.5 P1;C7 |
| F2 | MED | E4(c) 不能要求 history 必在(写序 `writeThreadId → history → ledger → receipt`,P5 允许 history 缺失);QA 分段把「pending 已消费」归到 (a),但 W2 reconcile 后 pending 也已清 | 真机判段先记 `$OLD` 快照,再用「`thread-id` 是否变化」「`lastAttemptOutcome === reconciled:pending_attempted`」「reconcile 回执」组合判定;(c) 只要求新 id 为真相且无第二次 `thread/start`,history 缺失记为 P5 事实 | plan §7 E4、§3.4;qa-runbook §4 |
| F3 | MED | `rotation_bootstrap` 「每个 to 至多一行」没有跨代耐久依据:readiness 结清前重启,后继代 rollout 已存在时可再写一行 `skipped_rollout_exists` | 二选一,实施时定:①删除运行时唯一性保证,E7 的 `S_boot` 按 `to` 去重且只计 `outcome=completed`;②append 前扫回执已有同 `to` 行。推荐 ①(零新状态) | plan §3.3 步 5、§4、§7 E7;qa-runbook §7 |
| F4 | LOW | readiness 结清写失败:§3.1 说对账写失败禁用本代且不结清,P7 说下一 tick 重试,两处文字冲突 | 定为:readiness-only transition 失败**不**设置 generation-wide disable,只留 `readinessPending` 供下一 tick 重试;对账(七键整体)写失败才禁用本代 | plan §3.1 末段、§3.5 P7 |
| F5 | LOW | `blocked_by_quota_gate` 在 `S === 0` 时也成立;`Q > S`(手工 startup / 日志重复)无出口 | 条件改为 `S > 0 ∧ Q === S`;`Q > S` 或无法归类 ⇒ 新结论 `measurement_inconsistent`(不判成功也不判失败,附 raw counts 上报) | plan §7 E7;qa-runbook §7 |

## 实施收口

2026-09-15:F1 禁用本代 + 故障测试;F2 修正 E4 分段和 history 缺失判据;F3 采用①,QA 按 completed 的 distinct to 计数;F4 readiness-only 写失败下一 tick 重试,集成测试覆盖;F5 增加 S>0 与 measurement_inconsistent。

## R1 code review LOW advisories（Lead 裁定仅记录）

评审 9ce3f664-34db-4385-b3c8-a8b1c8cac0dc，有效 APPROVED，HEAD c6c376f02；Lead 回答 b8bef3ea-a2bf-4cf4-a904-2c16c273da94 将以下三项留作后续，不包含在当前实现范围：

- `pane-killed-before-busy-probe`：founder 状态 unknown 时当前顺序先关闭 pane 再做权威 turns/list；建议未来考虑关闭前的预探测，减少关闭活动 pane/未发送草稿的机会。
- `p1b-stall-not-error-logged`：rebuild_refused 且 pending 清理失败的保留 fence 路径目前只有通用 warn/receipt；建议独立补 error 级告警。
- `rollout-timestamp-local-time`：rollout 文件名是本地时间，当前 seed 按 UTC 解释，有主机时区偏移；七天周期首次 seed 会有数小时误差。

## R2 code review advisories

HEAD cd769c4f70be97ac1006fd3076abd0fa274b55ed 有效 APPROVED（8d382a1a-ff83-471d-a209-cbf2ea79f948）。Lead 回复 78dacdf5-c82f-417e-9e83-74ed1a2e8cc5：仅修正并重新发布 founder HTML/template 和 d3 图的 SQLite 回滚说明；本次仅文档差异不重开评审，最终 HEAD CI 仍须通过。以下仅记录、不改代码：

- MEDIUM `kill-verify-treats-tmux-unreachable-as-dead`：当前 probe 将 tmux 不可达和 pane 不存在均视为不存活，尚不能区别 timeout/PATH/启动失败；可能留下短时仍连旧线程的 pane。后续可考虑可达性检查或三态结果；本次不新增。
- LOW `flag-read-coupled-to-maintenance-schema`：只读 StateStore.openForMaintenance 依赖额外 workflow schema；将来的 schema 不兼容会让本代轮换关闭。评审对当前生产 DB 的读取通过；后续可考虑更窄读取路径或明确的错误分类。
