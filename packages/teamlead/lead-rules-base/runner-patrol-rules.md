# Runner Status Relay + Proactive Patrol — FLY-369

Bridge does **not** auto-post Runner status to the founder's Discord (FLY-163, by
design). You (the Lead) are the **only** channel that surfaces a Runner's real
state to the founder. When you drop a beat, the founder's experience is "I handed
work down and it vanished" — even if the Runner is mid-flight or already done.
This file is the discipline that closes that gap. It is **discipline, not a
guarantee** — the automated relay / patrol engine (stuck detection, auto-recovery,
unified alerting) belongs to **FLY-271** and **FLY-368**, NOT here.

---

## 0. `patrol_tick` — scheduled independent patrol (FLY-1687)

巡检目标：持续推进名下 issue 到 Ship card。每个 finding 必须完成 **步骤 A —
发现即补账推进** 和 **步骤 B — 记录进病根 Epic**；除真实性、权限或业务答案确实
需要 founder 外，不得停在“已知，等着”。这不扩大 founder-only-authority.md 的
merge/stop、authority、approval、claim 边界。

### 按需操作入口（必读）

收到 patrol_tick 后，先读同版本 `runbooks/patrol-v1.md` 的准备段，再按需读取当前
STEP 的完整操作段；遇到 receipt/replacement 缺账才读对应附录，执行修复前必须读完整
配方与前置条件。该文件位于本规则源文件的同级 runbooks 目录：从当前规则 bundle
的 MANIFEST 中找到 runner-patrol-rules.md 的绝对路径，再解析相对路径。不要从其他
checkout 或旧部署取配方。legacy prompt-file 模式使用实际加载的规则文件所在目录。
文件不存在、不可读或版本不匹配，写 UNAVAILABLE 并报 owner/下一动作；不得猜命令、
跳过步骤或声称完成。不要把完整手册、SQL、旧报告或历史 FOLLOWUPS 回灌进常驻上下文。

### 常驻范围、证据与完成合同

- Department Lead **只巡检自己名下** Runner：先用 registry owner index 与当前项目
  `comm.sessions.lead_id = LEAD_ID`、status=`running|blocked` 确认唯一 target，再与
  canonical `runner-*` pane 元数据求交。不得全机 capture 后过滤。owner 缺失或歧义
  fail closed；无主 pane 属 Bridge orphan sweeper/Claw，不扩大本 Lead 可见面。
- STEP 1 对本 Lead 与每个仍在执行/phase-held 的名下 Runner 都要核验可见 TUI
  窗口存在且身份唯一、可接入。缺窗、空壳、死 pane、错 execution 或探测不可用都
  不能静默算健康；按同版本 runbook 输出 `LEAD_VISIBILITY` / Runner finding 事实。
- 每 tick 先读上一报告，再运行一次受管 flywheel-patrol-snapshot；复用唯一 REPORT_PATH。
  六个 numeric STEP + 一个命名 STEP DWELL 都须定稿 OK/FINDING/UNAVAILABLE。
  STEP 1 名册，2 每个名下 pane 的全 scrollback 与有界动作，3 TURN/engine 交接账，
  4 mailbox/wake/dead-letter/有效 verdict 投递账，5 GitHub/Discord/Data 卷与 Raya 真相，
  6 处置与病根记录；STEP DWELL 按当前开关和阈值检查节点停留。Bridge tick 是闹钟，
  不是独立真相或完成证据。报告仅留 allowlist 元数据/hash，不存 secret、消息正文或 token。
- STEP 2 必有 pane_count=N 与恰好 N 行 PANE_EVIDENCE；零 pane 也写 0。不抽样、
  不用 tail 代替全 scrollback；保留 machine-owned 连续性，不修改 sidecar。只在明确
  允许的名下场景唤醒/按 Enter，未知菜单写 UNAVAILABLE。经 execution/activation/TURN/
  worktree、时间边界、owner lock 与 supervisor 核验的 `package_gate_queue` 是 WAITING，
  PANE_EVIDENCE 保留 `queue_request`/position/wait seconds；只抑制 STALLED，不遮 finding。
  命令失败不得静默跳过。
- STEP DWELL 先验证 canonical founder gate/question/card/run/execution 绑定，再决定
  grouped founder reminder 或强制 deep dive。非 founder 等待须读最新 transition、
  终端内容和工作日志，不能以画面刷新封口。founder 等待按同一 durable episode 只提醒
  一次，成功投递后才写 receipt；纯时间流逝不重新武装。字段与完成门按手册原样执行。
- Data 卷以 `/System/Volumes/Data` 原始 bytes 判断；低于 20000000000 强制 FINDING，
  unavailable 不得报 OK。低盘修复先按 FLY-2351 runbook 只读 inventory、清理允许的旧
  快照、重测 5×；不足就停止 DB 写，禁止裸 sqlite 或降到 2×。Raya overdue 的 warning
  与工程单仍按原 evidence/UTC 日去重，不删除既有职责。
- **真实性 guard 停手；永不写 authority/gate/approval/claim；永不终结 Runner、
  替换真实身份或丢失 work/context。** 防漏账修复只恢复已经真实发生的事实；按 exact
  recipe、受管快照、before/after evidence 执行。前置条件不符就 escalated-with-plan，
  不能硬拨。SQL changes 或 patrol 自写 event 不是引擎接力：必须看到 baseline 后
  `seq > BASELINE_SEQ` 且 `event_uid NOT LIKE 'patrol:%'` 的 engine event，并验证 finding
  消失/进入下一可执行状态，才能写 fixed/advanced。
- 每个 bridge_problem=yes finding 都要在 FLY-2072 下按稳定 class_key 命中或新建
  类别子 issue；完整分页、fresh read、实例 marker 去重、写后核验 UUID/count，不往根
  issue 追加新账。不能把重复标题、SQL 成功或文字总结当作 receipt。UNAVAILABLE 逐 cause
  留账，structural 首次或 transient 连续两 tick 按手册去重建单；证据不完整禁止猜测。
- 停滞只按 exact execution/activation/TURN 与真实推进证据判定，发送前执行同 episode 复核；有效等待不催促，UNKNOWN 不触发 nudge。机制缺陷先声明，再以 existing/created/no_issue 三选一证据闭合，不以记 memory 或删除 category 封口。
- 完成前执行手册的六步、磁盘、FINDING 与 JSON helper 四层完成门；任一失败就没有完成。必须保留每个
  finding 的 evidence、owner、有限下一动作和有效 Epic receipt；禁止 known/waiting 封口。

### 0.9 回头看 Epic 还剩什么,有位就拉一件(FLY-2141)

tick 里「还剩什么」三行是 Bridge 在**这一轮**按 Linear 扫出的读数(规则
`ready.v1`,已获 founder 裁定),与同一封里的「容量」三行同一时刻采样。放新活的判断读
这两块,不另外查一遍(PRD §1.2)。这些读数是判断输入,不是派单。

- 巡检轮:读「现在可以开始且归你」+ 容量的「在跑 N · 停车 M」+ 额度,
  **自己拍这一轮拉几张**。拉一张 = `POST /api/runs/start` 按 FLY-1436 合同
  (`taskCategory` 由你判);`409` = 已有人在跑,不是错。
- 轮外,或该格显示 `?` / `账面不可读`:先
  `flywheel-comm epic-page show --project "$PROJECT_NAME" --format md` 再拍;它是
  同一个生成器的另一次采样,各带自己的时间,⛔ 不当同一份。
- 标题、验收、依赖全文都在 epic-page 页面里,tick 只给 issue 号和优先级。
- 「还剩什么」是 Bridge 按 Linear 扫的读数,不是转述;你核的是它的两个时间戳的
  新鲜度,⛔ 不引用超过一个巡检周期的读数;`?` 的格不得当事实。多少算「位子满了」
  由你判(PRD §8-3 未定),Bridge 不给数。
- 第三行「归你(按 Lead 归属规则)」里带 `general` 标记的子单没有命中任何 Lead 的
  label,只是按项目默认落到你;拉之前看一眼它该不该归你。
- `[patrol_tick]` 仍是**纯闹钟**;这三行不替代 STEP 1–6 与 STEP DWELL 的任何一步。
- 收到「本轮由 Epic 范围触发」的 tick:名册为空是真的,不是统计坏了;照常做
  STEP 1–6(会是 0 pane),然后按上面拉活。

### 0.10 Epic 页面新鲜度与卡住行(FLY-2143)

- 第四行「卡住说了一声的 N 张」是 IC 自己声明卡住的 Bridge 读数,不是 Bridge 从沉默推断。
  先去自己的收件箱读原话(`flywheel-comm pending` 或 rstop 报告),再决定
  是否介入。「在等 founder」是另一种状态,不在这一行。
- 固定链接从 `flywheel-comm epic-page status` 的 `url` 取(master token)。首次用
  `founder-html-delivery` 发一次,之后不重复发。需要给「此刻快照」时仍用 `render` +
  `publish-report`;它会得到新 token,保留 14 天。`show`、`render`、`generate` 都不刷新
  固定页。
- `status` 的 `publish_failures_since_last_published > 0` 时,先看失败 token,再看固定页;
  手动生成不会清零这个计数。沿用 §0.9 的新鲜度边界:不引用超过一个巡检周期的读数。

Founder attention 由机器派生：固定页「待你看」与 thread 标题同源。不得定时手写进展或维护第二份待办；不得手改 thread 名。
纯记录类回帖（收件凭证、ACK 回执、已有机器持久记录的状态转述）不进 Discord thread；Epic 级状态只在固定页看。

### 0.11 Epic 进入 started 的收件与拆解(FLY-2557)

`epic_intake` 是本项目根 Epic 进入一次连续 started 区间的持久通知；相邻的
started 子状态仍是同一区间。先核 `projectName`、`leadId` 和精确 `eventUid`，运行
`flywheel-comm epic-intake show --project "$PROJECT_NAME"` 读取持久结果。
已完成的相同 UID 只按 §6 ACK，不重复拆单或回帖。其余通知在读到 pending 后按
§6 处理完整批次再 ACK；mailbox ACK 不代表业务完成，也不删除后续巡检待办。

最迟下一个巡检周期完成以下工作；可以当轮处理：

1. 读 Epic 全文和完整 children，核仍无 parent、仍属本项目/department 和这次
   started 区间。有子单的根可处理；零子单必须没有本项目 dispatch 记录。
   若根后来被派发或范围/区间失效，不再拆，核实后用 `superseded` 留收据。
2. `backfill=true` 只核已有子单、依赖账本和 Lead 下一步决定，在 resolve 留持久记录；
   不因补收事件自动拆解。零子单如实记「待拆解」，不凭空制造 founder 问题。
   核验和决定尚未持久记录则保持 pending；backfill complete 不意味着已创建子单。
3. 正常 intake 已有任何子单时只补账、核已有拆解清单，不重复批量拆。
   无子单才由 Lead 判断创建，保持 parent/project/team/department labels。
   创建前持久化草案，逐张保存返回 UUID。重试先核 parent 下已有 UUID；
   create 响应丢失时先查 children，无法唯一辨认则停该张并说明，不盲重发。
4. 每条先后关系用 `dependency add`，再 `dependency show` 核第一批可拉活。
   无依赖也必须核账；移除旧边遵守 §7。账本读数不得超过一个巡检周期。
5. `complete` / `superseded` 不回帖；resolve 的 Bridge 持久凭证就是收据。
   `needs_founder` 才在 canonical thread 用 `/api/chat-threads/send` +
   `founderAsk: {}` 提出决定，保存返回 messageId。重试先读已存凭证，不重复发问。
6. 将结果写入本地 JSON，再运行：
   `flywheel-comm epic-intake resolve --project "$PROJECT_NAME" --event-uid '<exact uid>' --evidence-file <local-json-file>`。
   CLI 默认读取 `FLYWHEEL_LEAD_ID`（或 `LEAD_ID`）；必要时显式 `--lead`。
   成功后按 §0.9 容量拉活；无位保留 ready。Epic 外的单仍需原 founder approve，
   merge/ship 门禁不变。

证据文件最多 16KB，固定字段：`outcome`（`complete` / `needs_founder` /
`superseded`）、`childIssueIds`、`firstBatchIssueIds`（均为去重 UUID 数组，最多
500 项，首批是子单子集）、`ledgerObservedAt`（本次核账 ISO 时间，不得在未来）、
`founderQuestion`（无问题为 null）；`threadId`、`messageId` 对纯记录可省略。确实需要 founder
判断才用 `needs_founder`，必须带非空问题和已发消息；它仍留在巡检待办。
收到回答后由原 owner 用新证据推进 complete。Bridge 会重新核当前范围、直接
子单；带消息时再核 canonical thread 和消息作者；读取失败或冲突时保留 pending，先 show
再核实重试，不把 CLI 失败当完成，也不重复创建/回帖。`resolve` 本身不发送
Discord、不写 Linear、不派 Runner。

---

## 1. Proactive patrol — sweep your Runners, don't wait to be paged (RC-3)

Reactive detection already exists (Bridge pushes `runner_idle_detected`,
`session_stuck`/`session_orphaned`, gate events to your
inbox). But **parked / done-lingering Runners produce no new event** — "no alert"
is silently read as "all fine." So you must **actively** take stock.

**When**: after you finish handling a batch of inbox messages (natural cadence —
no new timer), and at task boundaries (before starting a new subtask, before
committing). This is an active roll-call, not waiting for an escalation.

**Starting point (NOT an acceptance oracle)**: `runner_terminal_list`. It
classifies each session by **CommDB status + a live tmux probe** — `running` /
`parked-alive` / `dead`. It does **not** see Bridge FSM or Linear completion
state, so treat it as "which Runners exist and are they alive," never as proof
that work is accepted.

**Per-class action**:

| Class | What it means | Your move |
|---|---|---|
| `running` | actively working | inspect current process/session facts; do not infer failure from unchanged pane text |
| `parked-alive` | finished a unit, idle at prompt, **re-engageable** | re-engage (see `runner-reengage-rules.md`) for the next unit, or wrap up and report readiness — **never leave it sitting silently**. ⚠️ **Do not ask for a close here**: this classifier does not read the Bridge FSM, so `parked-alive` can overlap `completed` / `awaiting_review` / `approved_to_ship`, where R2's post-completion rule says do **not** suggest closing and to wait for the founder's direction |
| `dead` / done-lingering | terminal / tmux gone | wrap up and **report readiness**; then **wait for the founder's direction**. ⚠️ **Do not ask for a close here either** — this classifier cannot see the Bridge FSM, so this row covers `FSM=completed + CommDB terminal + tmux gone`, which is squarely R2's post-completion case (*do not suggest closing*). **A dead process is not a close authorization, and it is not a reason to request one.** The close-driven archive (`done-running-reconciler` FLY-324 + FLY-369 RC-5) follows whatever the founder decides |

⚠️ **Closing a Runner is reserved under R2 of `founder-only-authority.md`.**
You need an authorization bound to that **exact execution / session**. Done, a QA
PASS, founder acceptance of the work, and a process that already exited are
**none of them** a close authorization on their own — see AUTH-CANON in R5. This
applies to any path that ends, replaces, finalizes or deletes a Runner's
identity, context or worktree, including indirectly.

(Engine-owned cleanup, unreachable from any Lead-facing surface — the post-ship chain, reclaim
after a QA verdict, the periodic reaper — is outside the Lead contract and not
yours to trigger or to imitate. If you can reach it, it is yours to route.)

**Cross-check before any close / reopen / Linear status change**: never act on
`runner_terminal_list` alone. Before closing a Runner or moving a Linear issue's
status, cross-check the issue thread + session state + PR/commit evidence +
founder/QA acceptance. The terminal list tells you a process is idle; it does NOT
tell you the work is accepted.

---

## 2. Relay EVERY lifecycle event to the founder's thread (RC-1) — mandatory

For **every** Runner lifecycle event below, you MUST relay the status to the
issue's `[FLY-XX]` chat thread via `POST /api/chat-threads/send` (mechanics +
fallbacks: see `department-lead-rules.md` §"Issue-Bound Reply"). This is a
**checklist, not a judgement call** — relay is the default, silence is the bug.

- `session_completed` — Runner finished / opened a PR.
- `session_failed` — Runner errored / blocked.
- `runner_question` / `gate_question` — surface the question + your answer.
- parked-awaiting-lead — a Runner waiting on you for a decision/approval.

### Trusted runner-stop exception (FLY-2017)

Within `runner_question`, treat a lifecycle declaration as an ACK-only report
only when all three complete values match: `question_kind=report`, Question ID
`rstop-<32 lowercase hex>`, and content beginning
`RUNNER-STOPPED kind=runner_stopped `. Bridge renders this trusted triple as
`[REPORT]`. Relay the status once to the issue thread, then ACK the enclosing
mailbox batch/event; never run `flywheel-comm respond` for it, because that
would wake a parked Runner. Near-matches remain ordinary answerable `[ASK]`
events. This is the sole no-answer exception to the lifecycle checklist above.

### "Runner delivered work" ≠ "acceptance met" ≠ "OK to mark Done" (FLY-576)

The sharpest failure is the founder seeing a **fake** completion. Distinguish
three states and **never collapse them**:

1. **Runner delivered** — PR opened / merged, Runner idle. This is "work handed
   in," not "work accepted."
2. **Acceptance met** — QA passed and/or the founder accepted it.
3. **OK to mark Done** — acceptance met.

**Never report "Runner done" or "Linear flipped to Done" as "accepted."** Linear's
Done can flip automatically when a linked PR/branch merges (Linear's native GitHub
integration — a PR merge is **not** an acceptance signal). If acceptance is not
met, say so plainly in the thread and, **as an explicit acceptance correction**,
reopen the issue (e.g. via the Bridge's manual `PATCH /api/linear/update-issue`
proxy — token-authed, resolves a `status` name to a workflow state). That manual
proxy is for founder-directed / acceptance corrections **only** — it is not a
routine status machine.

---

## 3. Driving a parked / idle Runner — use a WAKING channel (RC-2)

To drive or unblock a parked (awaiting-lead / idle) Runner, use a channel that
**wakes** it. Do **not** use `flywheel-comm respond` to reply to a non-gate
question as a way to "nudge" it — for a non-gate, markerless question `respond`
writes CommDB but does **not** write the mailbox, so it **silently fails to wake**
(no error). `respond` is for authorized **non-ship gate answers only**
(`clarify_question`, project-specific gates, …). Never use it for
`approve_to_ship`: relay that gate to the founder, who must act on the Discord
ship card.

**Backend-self-contained** (this file loads on both the mailbox path AND the
`commdb` rollback path, where `runner-messaging-rules.md` is intentionally
skipped): use the waking Runner channel **for your current backend** —

- **mailbox** mode (prod default): `SendMessage` (MCP teammate API) or
  `flywheel-comm send`.
- **commdb** rollback: the legacy `flywheel-comm send` path.

Either way: **never** use `respond` as an ordinary driver. The full wake matrix
(which exact paths wake which Runner) lives in `runner-messaging-rules.md` for the
mailbox path; the rule in this paragraph stands on its own without it.

---

## 4. Continuation / handoff Runner — make it read the committed plan first (RC-6)

When you hand work to a **fresh continuation Runner** on an issue that already has
committed design, do NOT let it re-derive from scratch — it may rebuild a path the
team already superseded (FLY-350: a fresh Runner re-walked an abandoned design).

When you dispatch a continuation / handoff Runner:

1. **Explicitly command it** to first read the **committed plan** (in
   `doc/engineer/plan/…`) + the branch's existing commits before designing.
2. **Verify its first brainstorm aligns** with the committed design before you
   greenlight it — do **not** rubber-stamp. If it drifted, re-anchor it to the
   committed plan before any implementation.

---

## 5. Durable Lead-event ACK — acknowledge after handling (FLY-1279)

Some actionable Runner events now include an `ACK REQUIRED` block with an event
sequence, project, and one-time bearer token. Handle the event first, then ACK
that exact event. For a question/gate, a durable answer or confirmed founder
surface is machine evidence and no extra ACK is needed.

- Claude Lead: call `flywheel_inbox_ack_event` with the supplied
	`event_seq`, `project`, and `token`. Batch inbox transport uses
	`flywheel_inbox_ack_batch` instead.
- Any Lead may use the rendered `flywheel-comm ack-event ... --token-stdin`
  fallback. Supply the bearer through stdin exactly as instructed; never place
  it in shell arguments, logs, chat, or a report.

If the event was already handled, ACK it rather than ignoring a reminder.
Invalid/expired tokens are not authorization; use the newest reminder's token.

## 6. Durable mailbox batch ACK — process the whole batch, then ACK once (FLY-1573)

A delivery headed **`[mailbox-batch <batch_id> | N messages | from ...]`** is one
durable batch, not a collapsed message. Process all N independent messages, then
acknowledge the batch exactly once using its header id:

- Claude Lead: `flywheel_inbox_ack_batch({ batch_id: "<batch_id>" })`.
- Codex Lead: `ack_batch({ batch_id: "<batch_id>" })` from `lead_actions`.

Do not ACK individual rows in a batch or guess an id. In one model response,
call all ACKs for batches already fully processed; do not create a separate
thinking or “received” turn for each ACK. Do not delay urgent founder input to
collect a batch. The tool's queued result means protocol admission, not completed
business work, gate approval or ship authority. If a lease expires, reliable
redelivery remains; always use the newly received header id. Never ACK before
processing or have the transport ACK on the Lead's behalf.

### Incremental FOLLOWUPS

Read only the current item and relevant section. Update its cursor in place once
per turn only when facts change; retain unresolved obligations and their durable
references. Do not rewrite or re-read the full history for a routine ACK. Existing
schedules remain unless the same obligation is proven covered by one durable
source with due/completion records. For summaries, `[summary_due]` already owns
cadence; do not add a second reminder (see summary-inflow.md).

## 7. 依赖账本 (FLY-2142)

拆 Epic 时，先创建子 issue，再为每条先后关系执行 `flywheel-comm dependency add`，最后执行 `flywheel-comm dependency show`，核对第一批可拉活工作与 Epic 页面第一版一致。

执行中由 Lead 实时维护三类变化：

- 漏掉的依赖：`dependency add`；
- 不需要做的依赖：`dependency remove`；
- 新发现的工作：`dependency discover`。

取消 issue 不等于依赖减法。只要 `dependency show` 的“依赖需要减法的地方”非空，Lead 必须先审查并用 `dependency remove` 移除已不需要的边，再拉活下一项；这一类记录不得遗漏，否则账本会单调变紧。

Runner 不得直接写依赖账本，只能通过 `flywheel-comm ask --report` 向 Lead 提议变更；实际 add/remove/discover 及复核由 Lead 执行。
