# FLY-2656 cmux cleanup 队列剪枝与镜像优先级 — 探索
Issue: FLY-2656 (https://linear.app/geoforge3d/issue/FLY-2656/修复-cmux-镜像同步器cleanup-pending-队列剪枝夹具窗不入队-ttl-过期-新窗镜像优先于清理-查-watcher)
日期: 2026-09-18
基于: 无

## 1. 问题边界

本单只收敛 `scripts/flywheel-cmux-sync.sh --watch` 已有 cadence 上相互放大的四个缺口：

1. cleanup-pending 接受了 QA 夹具名和没有 node owner 的名字；
2. 永远得不到分类的旧 marker 每个 tick 都重复跑昂贵的 pane/node fence；
3. 周期性补镜像排在 pending cleanup 之后；durable linked-view preflight 可被无实体残留的 `claim_intent` WAL 永久阻断；tmux 3.7c 又会把 `-F` 模板中的 tab 变成 `_`，使 exec/node inventory 永久解析失败；
4. 旧 watcher stdout 会被覆盖，下一次重启事故缺少启动原因与上次退出结果的耐久诊断。

不重新设计 cmux 镜像模型，不新增 scheduler、daemon、数据库或审计文件；不放宽任何 workspace/pin 的销毁权威。特别是「canonical runner 窗口仍活、`cmux-<title>` 链接 session 丢失」必须走既有 `rebind_missing_runner_view` 重建路径，不能被当成 orphan pin 清掉。

## 2. 已有安全边界

- `mark_for_cleanup` 是 event 与 conservative fallback 的共同入队口，适合集中做 owner admission。
- `process_pending_cleanups` 只有在 pane 确认死亡、delay 到期、node freshness 允许后才调用 `cleanup_workspace_for`；TTL 只能丢弃陈旧队列 marker，不能借 TTL 获得 workspace 销毁权威。
- `orphan_pin_refs` 与最终 close guard 都会重新确认同名 canonical 窗口不存在。活窗口缺 linked session 不满足 orphan 条件；`reconcile_existing_workspaces` 已有专用 rebind 状态机。首次 1645 行 registry 补账还会重新启用 terminal transaction，因此 `pane_dead=0` 必须成为 teardown 的明确否决条件。
- `cmux-log-episodes` 已提供 kind/target episode 去重、原子重写与 1 MiB 形状校验。复用它时必须扩展双白名单，并让 lifecycle kind 不被 active-title GC 误删，同时继续有明确保留上限。
- 当前 generation 的 `claim_intent` WAL 在 canonical 与 staging session 都不存在时，没有任何 tmux 实体可再恢复或销毁；保留 WAL 只会令所有无关 view fail closed。只有这个双缺失状态允许 retire，canonical 冲突或任何不可读状态仍必须保留。
- `read_runner_tmux_exec_inventory` 与 `read_runner_tmux_node_inventory` 的 Python parser 已拒绝字段内 `|`；改用与 Team Lead `TMUX_IDENTITY_SEPARATOR` 相同的 printable `|` 不会引入歧义，并绕开 tmux 3.7c 对 tab 的格式替换。

## 3. 方案比较

### A. 批量重写 cleanup/node 分类器

一次读取 tmux、registry 和 snapshot，按集合处理全部 marker，理论上最快。但会重写多年累积的 tri-state/freshness/TOCTOU 边界，超出本单「只做减法」范围，回归面过大，不选。

### B. 只调顺序与队列 TTL

能减少 watcher 被旧名字拖住的时间，但生产现场证明 `sync_additive` 已在执行，却被两个无实体 `claim_intent` WAL 卡在 `prepare_linked_view_state pre`。只调顺序仍无法重建缺失镜像，不选。

### C. 安全收敛 WAL + admission/预剪枝 + 顺序调整（选择）

- WAL：当前 generation、合法 `claim_intent` 且 canonical/staging 都确证不存在时删掉 WAL；其余 recovery 状态不变。preflight 对每个失败步骤写明 `step`，结束静默失败。
- inventory：两份 `list-windows -F` 输出改用 `|`，parser 同步按 `|` 拆分；在隔离的真实 tmux 3.7c server 上验证，不让 shell mock 的真 tab 掩盖生产行为。
- admission：输入需有界且 node registry 中存在精确 `last_mirror` owner；`*-realtest-*` 始终拒绝。`issue-<epoch>` 不能单凭名字拒绝，因为生产 `TmuxAdapter` 也用它作 fallback；ownerless 的该类名字仍会因无 owner 被拒绝。
- pre-prune：每 pass 只验证/读取 registry 一次，在任何 pane/node probe 前原子改写 pending 文件。年龄达到固定 7 天的 marker 直接删并记 episode；TTL 不依赖已冻结的 cleanup snapshot，因为删的只是 marker。未过期但 fixture/ownerless 的 marker 也直接删。
- conservative fallback：同一份 owner snapshot 先过滤不合格 linked session；不写入/反复清空 `STALE_STATE`，避免每五分钟重新制造同一个无权威候选。
- priority：健康 tick 仍先 drain hook events；第四 tick 把 `sync_additive` 提到 pending cleanup 前。WAL 收敛后，既有 rebind/create 与 `reconcile_node_presence` 可继续，并发布新 cleanup snapshot。
- startup evidence：supervised wrapper 通过 5 秒 `bounded-run.sh` 读取 `launchctl print` 的 `immediate reason`、`last exit code`、`last terminating signal`；读不到写 `unknown`。持 lease 的 watcher 再做一次边界清洗并写 `watcher-started`。

这个方案保持 destructive gate 不变，只收敛无实体状态、减少无权威工作，并调整同一 cadence 内的先后顺序。

## 4. 验收映射

| 验收 | 可执行证据 |
|---|---|
| 无实体 WAL 不再冻结镜像 | 当前 generation `claim_intent` + canonical/stage 双缺失先 RED 后 GREEN；冲突/不可读仍保留；preflight 失败日志带 step |
| node/rebind inventory 在 3.7c 可解析 | 真实 3.7c server 给窗口写 `@flywheel_exec_id`，两份 inventory 均返回 `ok` 与精确 `@id`/title/session；字段含 `|` 仍拒绝 |
| 夹具/无 owner 不入队 | 表驱动 admission 覆盖 realtest、ownerless issue、owned issue fallback、registry 不可读、合法 owner |
| 旧垃圾不再重复 fence | 独立 pre-prune 原子落盘；测试断言 registry 每 pass 只读一次且 pane/node/destructive probe 为 0 |
| 新 runner ≤60 秒先有镜像 | 第 4 tick `sync_additive` 先于 cleanup；WAL 与 3.7c inventory 两个 barrier 均解除；已有 rebind/create 与 snapshot publish 可达 |
| 活 pin 不误清 | 现有 rebind/orphan guard 回归；三轮 terminal catch-up 对 `pane_dead=0` 保持零 kill/close marker，`pane_dead=1` 仍收敛；活 canonical 丢 linked session 走 rebind |
| 有耐久事件与上限 | 新 kind 写入、lifecycle 固定 30 天 GC、target ≤255、五字段 schema 不变 |
| 重启原因可查 | hermetic autostart 覆盖三个 launchctl 字段、5 秒 bound、unknown fallback、watcher 二次清洗 |

## 5. 风险与回滚

- registry 暂时不可读时 admission 不新增 marker、pre-prune 只执行与 registry 无关的 TTL；未过期行原样保留，属于 fail-closed preservation。
- TTL 删除 active 或 owner-valid marker也不会触碰 workspace/pin；未来真实 exit event 可重新入队。把 TTL 定义成 marker 寿命，避免用已冻结 snapshot 对时间事实作权威判断。
- `watcher-started` 是“最近一次分类 + 相同 evidence 的 suppression 计数”，不是逐次启动审计；逐次启动时间继续由现有 append-only restart ledger 承担，两者相关联诊断，不伪称完整账本。
- `cmux-log-episodes` 新 kind 仍受 1 MiB 校验和 30 天固定保留约束；回滚时删除两个 kind、GC 分支与调用点即可，不迁移状态格式。
