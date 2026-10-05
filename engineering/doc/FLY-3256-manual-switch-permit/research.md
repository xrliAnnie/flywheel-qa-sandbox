# FLY-3256 手动切号后解冻额度待命 — 调研
Issue: FLY-3256 (https://linear.app/geoforge3d/issue/FLY-3256/额度standby-撞墙进-codex-quota-standby-的体永远不解冻手动整机切号不产生-permitcapacity)
日期: 2026-10-05
基于: exploration.md

## 研究基线

当前 QA sandbox 的 `origin/main` 不含生产 FLY-2900 文件，但仓库对象中保留已合入实现提交 `5c16c19b`（“feat(FLY-2900): Codex quota standby…”）及其完整设计、源码和测试。本调研以该提交的实现事实与 issue 提供的 2026-10-04 生产现象为基线；实施节点必须先同步它所在的最新生产 main，再按本计划改动，不能把旧提交整包回灌。

## 代码事实

### permit 数据模型

`packages/teamlead/src/bridge/codex-quota-store.ts` 已定义：

- `codex_quota_standby`：execution 级 carrier，非终态为 `standby|resuming|fallback_prepared`；
- `codex_quota_capacity_permit`：`kind IN ('switch_committed','reading_confirmed')`，唯一键为 `(root_key,generation,kind,covers_signal_seq)`；
- `codex_quota_external_generation`：人工 canonical 变化或 reading-confirmed 同账号新 generation 的 provenance；
- 全局 causal sequence：wall signal 与 reading request 共用，避免只靠时间比较。

`eligiblePermitFor()` 要求 permit 对应 root 当前 generation/account/profile，覆盖 standby 的 `trigger_signal_seq`，且 permit 后没有相关新 wall。这一读取围栏可直接复用。

### 自动切号路径

`commitGeneration()` 在安装事务中：推进 root generation、将 incident 置 `committed`、写 installation material、调用 `insertPermit(kind='switch_committed')`。因此自动切号天然有 permit，且 crash replay 由唯一键收敛。

### 人工切号路径

`reconcileExternalRoot()` 在发现 account/profile 改变时：

1. 写 `codex_quota_external_generation`；
2. 更新 root account/profile/generation；
3. 把旧 incident 改为 `identity_uncertain`；
4. enqueue manual switch notification。

它没有 permit，也不应直接有，因为输入没有容量读数。

### reading-confirmed 路径

`issueReadingConfirmedPermit()` 已有大部分正确围栏：

- 只在存在未被 permit 覆盖的 standby 时工作；
- reading profile/account 必须等于 root，`activeAccount` 必须相同；
- `requestSeq > max(trigger_signal_seq)`；
- `observedAt` 新鲜；
- 5h/weekly 已知且都小于 100%；
- request 后若出现新 wall 则拒绝；
- 同账号本 generation 撞墙时推进一个 `reading_confirmed` generation；人工切号已推进 generation 时不重复推进；
- `coversSignalSeq` 只取 requestSeq 之前的相关 wall。

这说明正确修复不是发明新 permit，而是确保人工切号后的 canonical reconciliation 和 reading refresh/evaluation 构成可观测、可重放的一次操作。

### resume loop 的薄弱连接

`createCodexQuotaResumeLoop()` 仅在存在 standby 时周期执行：先 `reconcileCanonical()`，再跑 readiness，然后从 `readReadings()` 中按 `root.profile` 找 reading，调用 `issueReadingConfirmedPermit()`；缺/旧读数时异步触发 `requestReadingRefresh()`。

生产表为 0 行说明至少存在一个连接缺口需要在实现前用 RED 用例钉死：

- reconcile 观察到人工新号，但同 tick 读取的是切号前 snapshot；
- refresh 完成后没有保证下一次 evaluation 使用同一 canonical generation 的新 requestSeq；
- readiness 的自动切号前置条件误挡了只需读数确认的人工恢复；
- activeAccount/profile 命名或 identityKey 在整机切号后短暂不一致，只有 reason 留在 snapshot，没有持久诊断；
- refresh promise 被 fire-and-forget 后，失败/成功都不触发即时重评，只能等 tick，且 snapshot 不能区分是哪一道围栏拒绝。

实施应先把生产形状做成集成 RED，而不是猜一个分支补丁。

## 推荐状态流

1. standby loop 发现至少一个未覆盖 carrier。
2. reconcile canonical；若人工切号，持久化 external generation，得到稳定 `(root,generation,profile,account,digest)`。
3. 读取该 profile 的 snapshot。若缺失、身份不一致或 requestSeq 不晚于 wall，触发 single-flight refresh，并在 refresh 完成后的后续 tick重评。
4. readiness 只检查“在该 canonical 上安全启动 Codex”的共享凭据链；不得要求自动切号 authority。
5. `issueReadingConfirmedPermit()` 原子校验 root 尚未移动与 causal fences，写一张 permit。
6. resumer 对每个 eligible standby 做现有同 execution/thread 恢复；首个模型输出后才 settle incident。

关键点：人工切号 provenance 和容量证据是两个事实，必须在 permit 审计中同时可追溯，但不能合并成一个弱事实。

## 巡检研究

`scripts/lead-patrol-snapshot.sh` 的 `run_comm_index()` 查询固定为：

```sql
SELECT tmux_window, project_name, execution_id, lead_id
FROM sessions
WHERE status IN ('running','blocked');
```

后续 `OWNED_TARGET_ROWS`、pane attribution、continuity inventory 都只消费这份 index。额度 standby 的 CommDB row 若已 timeout，整条巡检链没有机会发现它。

补集不能简单把 CommDB `timeout` 全纳入，因为会把所有历史 runner 带回。安全来源是 TeamLeadDB 当前 carrier：

```sql
FROM codex_quota_standby s
JOIN workflow_run_node n ON n.run_id=s.run_id AND n.node_id=s.node_id
  AND n.attempt=s.attempt AND n.execution_id=s.execution_id
JOIN workflow_run r ON r.run_id=s.run_id AND r.status='active'
WHERE s.state IN ('standby','resuming','fallback_prepared')
```

再用 execution 的 CommDB 历史 identity 取 project/lead/tmux target；身份缺失或歧义时 fail-visible，不猜 owner。这样 standby 是 roster 的补集来源，不改变正常 session 的 status 语义。

## 时间研究

`standby-page.ts` 直接 `Date.parse(row.entered_at)`。ECMAScript 对 `YYYY-MM-DD HH:mm:ss` 没有跨平台 UTC 保证；在本机时区会解释成 local。随后 `Math.max(0, delta)` 把未来值伪装为 0。

设计一个纯函数 `parseDatabaseUtcTimestamp(value): number | null`：

- ISO UTC：`YYYY-MM-DDTHH:mm:ss(.sss)?Z` 原样解析；
- SQLite UTC：`YYYY-MM-DD HH:mm:ss(.sss)?` 把空格换 `T` 并补 `Z`；
- 其余返回 null；
- `buildCodexStandbyPageSection()` 选择“有效 epoch 最小”的 oldest，不按原字符串排序；
- formatter/writer 遇 null 或未来超容忍值时输出 unavailable/null，而不是 0。

## 与 FLY-2195 的合并边界

issue 交接指出后续实现分支会同时包含 FLY-2195 的“满载原地重试”和 FLY-3256 的“人工切号后 standby 原地续跑”，冲突文件是：

- `packages/teamlead/src/bridge/codex-quota-store.ts`
- `packages/teamlead/src/codex-quota/hotswap-candidate.ts`

语义合并原则：

- hotswap 没候选或候选当前满载时，不新建 execution，继续保留原 carrier；
- 只有因果有效 permit 才允许 standby resumer 启动同 execution；
- FLY-3256 不改变候选排序、满载重试次数或 fallback 阈值；
- 冲突解决后必须同时跑两张单的直接测试文件，不能用一边测试替代另一边。

## 查询与索引

不适用新增 schema：本设计不新增表或索引。

既有/修改查询的审查要求：

| 查询 | 预期索引/计划 | 最坏行数 | 热路径 |
|---|---|---:|---|
| eligible standby | `codex_quota_standby_state(state,trigger_signal_seq)` | 非终态 standby 数 | 每 maintenance tick |
| permit by root/generation | permit UNIQUE + root PK | 每 carrier 1 个候选窗口 | resumer claim |
| patrol standby 补集 | standby state index → workflow node PK → workflow run PK | 非终态 standby 数 | patrol snapshot（非 Bridge 热 tick） |
| newest execution identity | CommDB execution/index（实施时 EXPLAIN 核实） | 每 execution 历史行数 | patrol snapshot |

若 `EXPLAIN QUERY PLAN` 显示 patrol 从 workflow/event 大表全扫，实施必须改写查询；不为便利新增镜像 roster 表。

## 测试切面

- capacity permit：人工 A→B + B 后墙新读数；同 generation 重放；切号后读数仍是 A；B 满额；request 后再 wall；多个 carriers 同一 permit。
- resume loop：refresh 前旧 snapshot 拒绝、refresh 后重评发 permit；`codex_quota_auto_switch=off` 仍可 reading-confirmed；readiness 不依赖 authority；refresh 失败留 reason。
- hotswap：无 permit 保持原地、permit 后同 exec 恢复；FLY-2195 满载对照仍原地重试。
- patrol：CommDB timeout + active standby 纳入；timeout + closed 排除；owner 歧义 fail-visible。
- timestamp：ISO Z、SQLite UTC、DST 两侧、非法值、未来值。

