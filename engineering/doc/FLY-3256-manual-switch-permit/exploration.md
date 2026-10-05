# FLY-3256 手动切号后解冻额度待命 — 探索
Issue: FLY-3256 (https://linear.app/geoforge3d/issue/FLY-3256/额度standby-撞墙进-codex-quota-standby-的体永远不解冻手动整机切号不产生-permitcapacity)
日期: 2026-10-05
基于: 无

## 一句话

FLY-2900 已把 Codex 撞墙改成“同一 execution 原 thread 待命后续跑”，但放行证据没有覆盖人工整机切号的真实路径；本单只补齐这个证据闭环，并让巡检与待命时长诚实显示这些仍持有 TURN 的 execution。

## 现场现象与不可接受结果

2026-10-04，`personal1` 撞墙后 4 个 execution 进入 `codex_quota_standby`。自动切号因 `authority_unavailable` 没有执行，Lead 随后人工把整机切到 `shopping` 并刷新读数。两小时后：

- 4 个 execution 仍在 standby；
- `codex_quota_capacity_permit` 仍为 0 行；
- hotswap 返回 `hotswap_no_candidate`；
- 现有唯一出口是 `codex_quota_fallback`，会换 Claude、换 execution，并丢失 QA 房间等原载体身份；
- Lead 巡检名册漏掉这 4 个仍持 TURN 的 execution；
- `CODEX_STANDBY oldest=0m`，掩盖真实滞留时间。

成功状态必须是：Lead 人工切到一个有额度的 Codex 账号后，系统用新鲜读数确认该账号可用，铸造一次可重放 permit，原 execution 在原模型、原 thread 上续跑；不依赖自动切号 authority，不制造替身体。

## 现有设计为何没接住

### 1. permit 的两个入口不对称

FLY-2900 的 `codex_quota_capacity_permit` 只有两类：

- `switch_committed`：自动 probe/install/commit 成功时，在 `commitGeneration()` 事务内铸造；
- `reading_confirmed`：resume loop 看到 canonical 账号的后墙新鲜读数时铸造。

人工切号走 `reconcileExternalRoot()`：它写 `codex_quota_external_generation`、推进 root generation、把旧 incident 改为 `identity_uncertain` 并发通知，但不铸造 permit。理论上的下一步依赖 resume loop 再走 `reading_confirmed`；生产事实证明这条隐式接力没有形成 permit，因此不能继续把人工切号当成“只推进 generation，等别处碰巧补证据”。

### 2. 人工切号本身不是容量证明

“active profile 变了”只能证明凭据身份改变，不能证明新号有额度。安全放行必须同时具备：

1. canonical root 已稳定指向人工切换后的 profile/account/auth digest；
2. 该 profile 的读数请求发生在待命 wall 之后；
3. 读数身份与 canonical 一致，且 `activeAccount` 一致；
4. 5h 与 weekly 两个窗口均已知且 `<100%`；
5. 请求之后没有新的相关 wall；
6. permit 只覆盖读数 request sequence 之前的 wall。

所以本单不是“人工切号直接发 permit”，而是把“人工 generation + 新鲜读数”做成明确、幂等、可审计的 `reading_confirmed` 路径。

### 3. 巡检把 CommDB 状态当成唯一 roster

`lead-patrol-snapshot.sh` 的 owner index 只选择 CommDB `sessions.status IN ('running','blocked')`。额度待命 execution 在 TeamLeadDB 里仍是 workflow node 的当前载体并持 TURN，但 CommDB session 可已超时，因此从 roster 输入阶段就消失。巡检随后即使能看到 tmux，也无法把 pane 归属回 execution。

权威关系应是两源合并：CommDB 提供正常 live session；TeamLeadDB 的非终态 `codex_quota_standby` 行提供额度待命补集。补集仍必须通过 workflow run/node 当前性、project、lead 归属与 operator close fence，不能把历史或已释放行重新列入。

### 4. SQLite UTC 文本被当成本地时间

`entered_at` 可能来自 SQLite `datetime('now')`，形如 `YYYY-MM-DD HH:MM:SS`，语义是 UTC，但 JavaScript `Date.parse()` 会按本地时间解释无时区字符串。在 America/Los_Angeles，真实已等待数小时的 UTC 时间可能被解析到未来，随后 `Math.max(0, …)` 把结果压成 `0m`。

修复应在一个边界函数里规范化数据库时间：严格接受 ISO `...Z` 或 SQLite UTC `YYYY-MM-DD HH:MM:SS[.sss]`，后者显式转成 `...Z`；非法值不得显示为 0，而应让摘要标为 unavailable/`oldest=null`。

## 方案比较

### A. 推荐：显式“人工 generation + 读数确认”闭环

保留 `reading_confirmed` 作为唯一非自动切号 permit 类型。`reconcileExternalRoot()` 只记录身份变化；resume loop 在同一次受控评估中完成 reconcile、读取/刷新新账号读数、调用现有因果围栏铸造 permit。把人工切号 provenance 作为 evidence ref/audit detail，而不是新增第三种 permit。

优点：一个容量真相源；不把“切过号”误当“有额度”；沿用 FLY-2900 的输出证明与 incident settle 安全门。缺点：要把当前分散在 reconcile 与 reading evaluation 的状态连接明确化，并补生产交错测试。

### B. 在 `reconcileExternalRoot()` 直接铸造 permit

优点是路径短。拒绝，因为该函数只有凭据身份，没有可信容量读数，会把一个同样满额的新号当成可用容量；也破坏 `requestSeq > wall` 的因果围栏。

### C. 人工切号后直接放开 pause，让 workflow 重试

实现最少。拒绝，因为绕过 standby carrier 与 permit，重新引入 FLY-2900 已消除的盲换体；并且不能保证同 execution、同 thread、同模型。

## 设计边界

本单做：

- 人工整机切号后，用新 canonical 的后墙新鲜读数铸造 `reading_confirmed` permit；
- “读取确认别的号有额度”也走相同 canonical + reading 证据闭环；
- standby execution 作为 patrol roster 的权威补集；
- UTC 时间规范化，修正 oldest；
- 与 FLY-2195 的“满载时原地重试”语义共存：没有 permit 就继续原地 standby，有 permit 才恢复，不新开功能分支。

本单不做：

- 自动切号 authority 的修复；
- 改变 Claude fallback 的阈值或策略；
- OpenAI 服务故障与额度耗尽的分类；
- 复活已 terminal/released 的历史 execution；
- 修改同厂商评审规则或 TURN 所有权模型。

## 不变量与负向守卫

1. 仅凭 profile/generation 变化绝不发 permit。
2. 旧读数、错误身份、非 active 账号、任一窗口未知/满额、读数请求后又撞墙均拒绝。
3. 同一 root/generation/kind/covers sequence 最多一张 permit；重放返回已有证据。
4. permit 只使当前 standby row 可 claim；run/node 不再当前、operator close、cancel/terminate、released/closed 均不可恢复。
5. 巡检补集只包括 `standby|resuming|fallback_prepared` 的当前节点载体；不把 `released|closed` 列回 roster。
6. 时间非法时 fail visible，不把未知时长显示成 `0m`。
7. 不修改 FLY-2195 的 hotswap 满载原地重试决策，只确保 standby permit 恢复与其不冲突。

## 查询与索引

不新增表或索引。修改只复用既有查询：

- permit eligibility 继续命中 `codex_quota_standby_state(state, trigger_signal_seq)` 与 `codex_quota_capacity_permit` 的唯一键；最坏扫描为当前非终态 standby 数，生产量级为个位到几十行，resume tick 热路径命中。
- patrol roster 补集按 `codex_quota_standby.state` 过滤，并 join `workflow_run_node` / `workflow_run` / CommDB identity。实现前用 `EXPLAIN QUERY PLAN` 证明以 `codex_quota_standby_state` 起表、workflow 主键查找；最坏行数为所有非终态 standby，不允许从 `sessions` 或事件表全扫。
- oldest 从已经读取的 standby rows 计算，不增加 SQL 热查询。

## 验收证据

- 单元：人工 profile A→B 后，B 的后墙新鲜非满读数发一张 `reading_confirmed` permit；所有负例不发。
- 集成：4 个 standby 同一人工切号 generation 被同一 permit 覆盖，resumer ≤2 并发逐个恢复，同 execution/thread/model 不变。
- 回归：没有新读数时仍 `hotswap_no_candidate`/原地等待，不产生替身体；FLY-2195 满载原地重试用例保持通过。
- 巡检：CommDB status=timeout 但 TeamLeadDB 当前 standby 的 execution 出现在 roster；released/closed 对照不出现。
- 时间：`2026-10-04 11:24:00` 在 PDT 主机按 UTC 计算，不能是 0m；非法时间输出 unavailable。

