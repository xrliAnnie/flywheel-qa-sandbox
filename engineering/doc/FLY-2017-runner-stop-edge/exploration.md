# FLY-2017 RUNNER-STOPPED 改为状态沿申明 — 探索
Issue: FLY-2017 (https://linear.app/geoforge3d/issue/FLY-2017/bridgebug-停驻体-runner-stopped-申明是周期重发不是状态沿触发安静停驻的体每-3-分钟给-lead-灌一条同文)
日期: 2026-08-24
基于: 无

---

## 1. 问题与成功标准

FLY-2000 的 Codex 实现体已按 Lead 指令进入 `quiet-wait`：模型不轮询、不写代码，只等待 mailbox 唤醒。实际噪音来自 turn-end harness：每个 resident goal 周期结束都会得到新的 Codex `turn-id`，`runner-stop-notify.sh` 随即调用 `flywheel-comm runner-stopped`。当前去重键是 `(exec, source, session-or-exec, turn-id)`，因此相同的停驻状态在每个新 turn 都被当成新申明。

本单成功标准：

1. 同一 execution 的完整 canonical RUNNER-STOPPED content 未变化时，只产生一条 mailbox 申明；新 vendor turn 不能绕过去重。
2. 申明内容变化时产生新消息；若状态 A → B → A，第二次进入 A 仍产生新的沿事件，不能做成“该内容此生只发一次”。
3. 并发/重放 reporter 仍保持原子幂等；不能因两个 detached hook 同时看到旧状态而双写。
4. `rstop-*` 仍走现有 runner→Lead mailbox/`runner_question` 管线，不新增告警层，但 Lead 看到的是单向 lifecycle report：只 ACK mailbox batch/event，不运行 `respond`；CLI 也必须硬拒绝误回复。
5. 新状态沿到达后，上一条 rstop question 必须在同一事务退役；bootstrap 不能把当前或历史 rstop report 再列为待回答问题。
6. 普通 `flywheel-comm ask` 的提问/回复/唤醒语义保持不变；现有 gate、completion breadcrumb、reason precedence 也保持不变。

## 2. 已定约束与假设

- Issue 已给出可执行的期望语义，本节点不另开 brainstorm approval；最终架构判断仍走强制 `review_design` gate。
- 沿身份必须属于 CommDB 的权威状态，不能只依赖容易丢失或乱序的本地 marker 文件。
- 申明去重不等于吞掉状态变化；“content-addressed question id 永久唯一”不满足 A → B → A。
- 修法收敛现有 RUNNER-STOPPED 协议，不新增 timer、提醒器或告警类型，遵守 `feedback_no_new_alert_layers`。
- `rstop-*` 的 batch ACK 是传输回执，不是业务回复；二者必须在 Lead 指令里明确区分。

## 3. 方案比较

### 方案 A（推荐）：CommDB 当前沿账 + 原子 compare-and-insert

在 CommDB 增加每 execution 一行的 `runner_stop_declarations` 当前态账，保存最后成功申明的 canonical content hash、content 与 question id。`runnerStopped()` 完成既有 reason 推导后，调用一个 `BEGIN IMMEDIATE` 原语：

1. 当前 content 与账面相同 → 返回 `duplicate`，不 enqueue；
2. 不同 → 用当前 turn-derived `rstop-*` id enqueue 既有 `kind=report` question；enqueue 成功后在同一事务退役前一条 question，并更新当前态账；
3. 若同一 turn id 已存在，以既有 deterministic-id 冲突合同保留第一份内容，不退役旧行，也不推进到一个从未入队的新状态。

原语不按 hook ingress timestamp 排序。`ingressTs` 是 turn 边界时间，而 content 是 detached leg 实际执行时从 CommDB/runner state 重新推导的；用前者给后者排序会把尚未入队的 completion breadcrumb 判成 stale 并永久吞掉。改为在 content 推导完成、调用 DB 原语前立刻捕获 `derivedAtMs`，current ledger 只拒绝比 current 更早的不同 content；相同 content 的更新观察会推进 `derivedAtMs`，避免一个已在 `BEGIN IMMEDIATE` 等锁的旧推导随后回写。优点：跨进程并发有 SQLite 写锁；状态 A → B → A 自然形成三条沿；即使 mailbox 旧行被 retention 归档，当前态仍可继续抑制电平重发。代价是新增一张极小的单行-per-exec 状态表和窄 DB API。

### 方案 B：只比较最新 `rstop-*` mailbox 行

在插入前查询该 execution 最新的 RUNNER-STOPPED report，content 相同就跳过；查询与插入需放在同一事务。

优点是零新表；A → B → A 也正确。缺点是 mailbox retention/归档后会丢失当前状态，安静停驻体会在清理后重新申明；查询还把“当前协议状态”隐含绑定到历史消息保留策略。故不选。

### 方案 C：runner state dir 本地 JSON current-state marker

在 `${FLYWHEEL_RUNNER_STATE_DIR}` 写 `last-stop-declaration.json`，content hash 相同就跳过。

优点是改动面小。缺点是 detached reporter 跨进程竞态需要另造锁、崩溃恢复与 stale lock 协议；本地状态目录被清理后会重发；DB 入队与文件更新无法原子提交。故不选。

## 4. 推荐设计

### 4.1 申明沿

保留现有 vendor-turn marker 作为“同 turn 快速重放”防线，并在最终 canonical content 生成后增加 CommDB 状态沿防线。前者保护原有首内容不漂移合同，后者解决本单的跨 turn 同文风暴。

当前态 fingerprint 使用完整 canonical RUNNER-STOPPED content 的 SHA-256；账内同时保存 content 并双重比较，避免仅凭 digest 作正确性判定。question id 仍来自 turn hash，所以真正的 A → B → A 都有各自不可变事件 id。

### 4.2 单向 report 语义

不创建 `runner_report` 新 event type。Question admission 与 legacy GatePoller 只把现有 `kind=report` 元数据带入 HookPayload；两个 Lead runtime 只在以下三项同时成立时使用专用文案：`question_kind=report`、`question_id` 匹配 `rstop-` canonical id、未截断 summary 以 `RUNNER-STOPPED kind=runner_stopped ` 开头。

- 标为 `[REPORT] Runner lifecycle declaration`；
- 明写 `Do not respond`，因为 response 会唤醒停驻 Runner；
- 仍要求 ACK enclosing mailbox batch/event；
- 普通 `runner_question` 保持现有 `[ASK]` + `flywheel-comm respond` 文案。

`respond.ts` 使用同一个三项信任谓词硬拒绝这类 report，拒绝发生在 authorization、response write 与 marker retirement 之前，因此误操作不会写 response、不会清 marker、不会触发 wake。

Bootstrap 不把可信 rstop report 放进 `pendingRunnerQuestions`：它已经由可靠 mailbox batch/event 首次投递，bootstrap 的问题列表只恢复“仍需回答”的项目。筛选同样检查完整未截断 content 的三项谓词，不能只凭 `kind=report`。Lead rules 的 department/cos 主规则、消息规则与 patrol 规则同时增加同一窄例外，避免后文通用 `respond` 指令覆盖它。

### 4.3 错误与兼容

- DB transaction 失败时不更新 current-state 账，hook 仍按既有 best-effort 记录错误，下一次可重试。
- deterministic turn-id 冲突且内容不同仍保留第一内容，不把未入队的新内容写入 current-state。
- 新沿成功插入后，只有旧账 question 已有 `delivered_at`/`ACKED` 证据才在同一事务标记 `terminal_disposed/superseded`；未投递旧沿必须留在可靠队列，不能为了 current 收敛而撤销 Lead 尚未看见的事件。
- mailbox batch ACK 是 report 的消费点；ACK transaction 将可信 rstop row 标记 `terminal_disposed/report_ack`。因此当前末沿无需业务 response 也能退休，未 ACK 则保持可重投。
- `finalizeSession()` 删除该 execution 的 current-state 行；late terminal reporter 仍可依赖 receipt lineage 重建一次状态，随后再次进入沿去重。
- 旧数据库通过 `CREATE TABLE IF NOT EXISTS` 自动升级；无需数据回填，部署后的第一次当前状态会发一条，然后进入沿触发。
- 不改变 RUNNER-STOPPED wire text、reason precedence、question TTL、mailbox batch ACK 或普通 ask/gate 行为。

## 5. 验证重点

- RED：两个不同 Codex turn id、相同 parked content，目前产生两条 report；修复后应为一条。
- RED：A → B → A 必须产生三条，防止错误的永久 content hash 去重。
- RED：多个独立 OS process 同时写相同 content，只能一条 `sent`、其余 `duplicate`，无 `SQLITE_BUSY`，mailbox/current ledger 各一行。
- RED：A → B 后 A 行已 superseded 且不再 pending；B 是唯一 pending rstop。
- RED：completion breadcrumb 只有在同文已成功入队或本次成功入队时消费；deterministic-id 内容冲突不得消费。
- RED：较早 `derivedAtMs` 的不同 content 即使较晚取得 DB 锁也返回 `stale/contentMatched=false`，不能回写 current 或退役较新沿。
- RED：未投递 A 后产生 B 时，A/B 都仍可投递；ACK 后 rstop 自动 terminal disposed，无 response child。
- RED：两种 Lead runtime 对 rstop report 不得包含 `flywheel-comm respond`，必须包含 ACK/no-response 指引；普通 ask 仍包含 respond。
- RED：bootstrap 完全排除可信 rstop report；伪装的 `kind=report`、`rstop-*` 或 signature 单项/双项匹配仍按普通问题处理。
- RED：直接执行 `respond` 可信 rstop 时 fail closed，数据库无 response 且 marker 保留。
- RED：`flywheel-comm pending` 排除可信 rstop，near-match 与普通 ask 仍列出。
- 回归：原 `runner-stopped`、hook shell suite、TeamLead renderer/bootstrap tests、全仓 gates。
