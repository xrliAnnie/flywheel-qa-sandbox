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

**范围合同**:检测范围 = **整机**(默认共享 socket 的全部 canonical Runner pane +
当前项目主仓的外部真相);处置权限 = **只覆盖你名下 Runner**。canonical Runner
pane 的唯一口径是:session name 以 `runner-` 开头且 window name 以 Linear
identifier 开头;`cmux-*` 显示镜像不重复计算。这个操作化口径尚待 founder 追认,
但不得按 Lead、项目或前 N 个抽样。tick 名册只是 Bridge 对「你名下」的
**待核声明**,不是巡检边界也不是结论。别家 Lead 的 Runner、无主窗口、全仓
停摆都记入报告并在第 6 步上报,不得越权处置。

**产出物合同**:每条 tick 必产一份六步报告:
`~/.flywheel/patrol-reports/<leadId>/<UTC>-tickNA.md`。先运行快照;它会原子
落下含六段的候选骨架并在最后打印 `REPORT_PATH=<absolute path>`。骨架里的
`LEAD-JUDGMENT-REQUIRED` / `*-CANDIDATE` 不是完成;每一行都定稿为
`OK | FINDING | UNAVAILABLE(<稳定原因>)` 才算巡完。「全部健康」也必须六行
齐全。第 2 步还必须无条件含 `pane_count=N` 和恰好 N 行 `PANE_EVIDENCE`;
零 pane 或 tmux unavailable 也写 `pane_count=0`。自动骨架本身不是巡检完成证据。

**UNAVAILABLE 出口**:命令失败、对象不存在、或无法理解要求时,该步必须写
`UNAVAILABLE(transient|structural: <稳定 token>)`;禁止静默跳过。structural
首次出现就走第 6 步建工程单;`sqlite_busy` 等 transient 连续两个 tick 才建。

`[patrol_tick]` 仍是**纯闹钟**。本巡检用以下**独立信源**,不采信 Bridge
单方转述。第 0 步必须先读上一报告,再启动新快照,run:
`PATROL_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/patrol-reports/${LEAD_ID:?LEAD_ID required}"; PREVIOUS_REPORT="$(find "$PATROL_DIR" -maxdepth 1 -type f -name '*-tick*.md' -print 2>/dev/null | sort | tail -1)"; test -z "$PREVIOUS_REPORT" || sed -n '1,260p' "$PREVIOUS_REPORT"`。
若上一份有未建单 UNAVAILABLE,先在第 6 步补账。然后 run:
`SNAPSHOT_BIN="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/bin/flywheel-patrol-snapshot"; SNAPSHOT_OUTPUT="$("$SNAPSHOT_BIN" --project "${PROJECT_NAME:?PROJECT_NAME required}" --lead "${LEAD_ID:?LEAD_ID required}")"; SNAPSHOT_RC=$?; printf '%s\n' "$SNAPSHOT_OUTPUT"; test "$SNAPSHOT_RC" -eq 0 || exit "$SNAPSHOT_RC"; REPORT_PATH="$(printf '%s\n' "$SNAPSHOT_OUTPUT" | sed -n 's/^REPORT_PATH=//p' | tail -1)"; test -n "$REPORT_PATH" && test -f "$REPORT_PATH"`。
后续六步共用这一个 `REPORT_PATH`,不得重跑快照制造第二份报告。

1. **名册核对(ground truth)** — run:
   `awk '/^## STEP 1$/{show=1; next} /^## STEP 2$/{show=0} show' "$REPORT_PATH"`。
   快照段来自 `TMUX= tmux list-windows -a` 与
   `TMUX= tmux list-panes -a -F '<pane_id> <session_name> <target> <window_name> ...'`;
   与 tick 名册对账。脚本对每个 `runner-*` session + Linear identifier window
   生成一条 canonical Runner pane;多了少了都是 finding。忽略正常 `zsh`
   scaffolds、`cmux-*` 镜像、Codex Lead TUI;Claude Lead 在私有 socket。若第 2 步的
   live pane 与快照不一致,run: `TMUX= tmux list-windows -a`,并在报告注明采用
   快照时刻还是复核时刻读数。
2. **pane 实况** — run:
   `awk '/^## STEP 2$/{show=1; next} /^## STEP 3$/{show=0} show' "$REPORT_PATH"`。
   快照对第 1 步的**每一个** canonical Runner pane 用 5s 有界
   `TMUX= tmux capture-pane -p -S - -t <pane_id>` 读完整 scrollback;零抽样、零
   `tail -40`。原文可能含 secret,所以报告只存 SHA-256/行数/字节数/最后非空状态行
   SHA-256,并逐 pane 写:
   `PANE_EVIDENCE ... owner=owned|cross-boundary|foreign-registry|unknown exec=<id|none> ... last_change_epoch=<epoch> findings=<csv|none> action=<none|REQUIRED> result=<clear|UNSET>`。
   owner 来自 projects registry 全项目只读 `comm.sessions.tmux_window` index,其中
   CommDB 可达的 owning status 是 `running|blocked`;正常
   cross-boundary / foreign-registry 本身不是 finding。index 不完整必须
   `UNAVAILABLE(transient|structural: owner_index_incomplete)`,不得铸 unknown;
   registered target 首次无 owner 记 `result=session_terminated`,连续两 tick 才标
   `ORPHANED`。
   `shasum` 缺失/失败必须标 `HASH_UNAVAILABLE` 且 STEP 2 为
   `UNAVAILABLE(structural: hash_unavailable)`,禁止留下空 hash 或自动报 clear。

   对每行执行这些唯一判据/动作:
   - 全 scrollback grep `You've hit your session limit` / `You've hit your usage limit`
     / `Claude usage limit reached`(排除 `not your usage limit`)。live 区命中为
     `LIMIT_LIVE`;reset 已过且 `owner=owned` 时 run:
     `flywheel-comm send --project "$PROJECT_NAME" --from "$LEAD_ID" --to "$EXEC_ID" "patrol: usage/session limit reset has passed; resume now"`。
     reset 无法解析写 `UNAVAILABLE(structural: limit_reset_unparseable)`;跨界只上报。
   - 同 target 最后状态行逐字 hash 未变就继承脚本维护的 0600 machine-owned
     `patrol-continuity/<lead>/<project>.tsv` 中的 `last_change_epoch`;同一 sidecar
     也保存 registered target 连续无 owner 的 observation count。Lead 不编辑该
     sidecar,报告重排或修改 result 也不得重置停滞/orphan 连续性。连续
     ≥3600 秒标 `STALLED_60M`。名下 run:
     `flywheel-comm send --project "$PROJECT_NAME" --from "$LEAD_ID" --to "$EXEC_ID" "patrol: pane state has been unchanged for 60 minutes; report status and continue"`;
     跨界只上报。
   - live 区命中 `Press Enter to confirm` / `Press Enter to continue` / 已知 resume
     menu 时标 `INTERACTIVE_MENU`;只有名下且手册明确允许 Enter 才 run:
     `TMUX= tmux send-keys -t "$PANE_ID" Enter`,随后完整 capture 复核。未知 menu
     写 `UNAVAILABLE(structural: menu_unrecognized)`,禁止盲按。
   clear 行由脚本封口 `action=none result=clear`;任何 finding/capture failure 初始
   `action=REQUIRED result=UNSET`,Lead 只能原位修改 `action=` / `result=` 值并留证,
   不得删除、改名或重排 `PANE_EVIDENCE` 的机器字段。
   **“大概没问题”不是证据。**
3. **交接账**(`TURN belt` = CommDB `three_stage_turn`;engine node table =
   StateStore `workflow_run_node`) — run:
   `awk '/^## STEP 3$/{show=1; next} /^## STEP 4$/{show=0} show' "$REPORT_PATH"`。
   快照已按当前 project + active workflow + live session 只读联查;active issue
   无 TURN、holder 不在同 issue live execution、`no_turn_streak >= 3`、或 active
   node 无 live session都是 finding;历史 terminal 行不得重报。
4. **投递账 + verdict/receipt 一致性** — run:
   `awk '/^## STEP 4$/{show=1; next} /^## STEP 5$/{show=0} show' "$REPORT_PATH"`。
   live Runner 明确定义为 StateStore status
   `running|ship_parked|awaiting_review|design_done|approved_to_ship`;只看这些 Runner
   的超窗 `mailbox`、active `turn_wake_outbox` 未 ack、近 24h
   且 `state='pending'` 的 `dead_letter_alerts`、以及 active PR binding head 与
   有效 git-head verdict claim。`accepted` dead letter 禁止重报。输出只含
   allowlist 元数据;禁止消息正文、envelope、summary、token、evidence 原文。
5. **外部真相(整仓维度)** — run:
   `awk '/^## STEP 5$/{show=1; next} /^## STEP 6$/{show=0} show' "$REPORT_PATH"`。
   周期快照用 `GH_REPO=<projectRepo> gh api 'repos/{owner}/{repo}/pulls?state=open&per_page=50'`
   与 REST actions runs 投影整仓时刻;周期巡检面不得用 GraphQL。单个 PR 人工下钻可 run:
   `gh pr view <n> --repo <projectRepo> --json state,mergeable,headRefOid,statusCheckRollup`。
   Discord 最多检查 tick 名册最近活动的 2 个 identifier。先 run:
   `PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE:-${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/projects.json}"; CHAT_CHANNEL_ID="$(jq -er --arg project "$PROJECT_NAME" --arg lead "$LEAD_ID" 'first(.[] | select(.projectName == $project) | .leads[] | select(.agentId == $lead) | .chatChannel)' "$PROJECTS_FILE")"`。
   每个 identifier run(Bridge 只解地址,secret header 只走 stdin):
   `IDENTIFIER='<FLY-XX>'; THREAD_JSON="$(printf 'header = "Authorization: Bearer %s"\n' "${TEAMLEAD_API_TOKEN:?TEAMLEAD_API_TOKEN required}" | curl --config - -fsS "${BRIDGE_URL:?BRIDGE_URL required}/api/chat-threads?issueId=$IDENTIFIER&channelId=$CHAT_CHANNEL_ID")"; THREAD_ID="$(printf '%s' "$THREAD_JSON" | jq -r '.threadId // empty')"; test -n "$THREAD_ID"`;
   最后 run: Discord MCP `fetch_messages(chat_id=$THREAD_ID, limit=20)`。消息与
   archive 状态以 Discord 为真,`chat_threads` 不是状态 oracle。
6. **处置 + 完成报告** — 打开 `"$REPORT_PATH"`,逐行定稿并写证据。名下
   finding 按上面的唯一命令或对应 emergency procedure 有界修复。同一 tick 的
   跨界 finding 聚合成一条,先 run:
   `PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE:-${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/projects.json}"; TADASHI_BOT_ID="$(jq -er 'first(.[] | select(.projectName == "flywheel") | .leads[] | select(.agentId == "flywheel-eng-lead") | .botUserId)' "$PROJECTS_FILE")"; ROUNDTABLE_FILE="${FLYWHEEL_ROUNDTABLE_CONFIG_FILE:-$HOME/.flywheel/roundtable.json}"; ROUNDTABLE_CHANNEL_ID="${FLYWHEEL_ROUNDTABLE_CHANNEL_ID:-}"; test -n "$ROUNDTABLE_CHANNEL_ID" || ROUNDTABLE_CHANNEL_ID="$(jq -er '.channelId | select(type == "string" and length > 0)' "$ROUNDTABLE_FILE")"; test -n "$ROUNDTABLE_CHANNEL_ID"`,
   再用 Discord MCP
   `reply(chat_id=$ROUNDTABLE_CHANNEL_ID, message="<@$TADASHI_BOT_ID> [patrol cross-boundary] <findings>; report: $REPORT_PATH")`。
   地址解不出就写 `UNAVAILABLE(structural: roundtable_channel_unresolved)`,禁止猜数字。
   UNAVAILABLE 建单前 run(精确标题搜重;secret header 只走 stdin):
   `TITLE='[patrol-unavailable] step <n>: <稳定原因>'; DEDUP_JSON="$(printf 'header = "Authorization: Bearer %s"\n' "${TEAMLEAD_API_TOKEN:?TEAMLEAD_API_TOKEN required}" | curl --config - -fsS "$BRIDGE_URL/api/linear/issues?project=Flywheel&labels=Flywheel&state=triage,backlog,unstarted,started&limit=250&slim=true")"; DEDUP_RC=$?; TRUNCATED="$(printf '%s' "$DEDUP_JSON" | jq -r '.truncated // false')"; PARSE_RC=$?`。
   若 `DEDUP_RC != 0`、`PARSE_RC != 0`、`TRUNCATED` 不是 `true|false` 或为 `true`,报告记
   `UNAVAILABLE(transient: dedupe_unverified)`并**禁止建单**。否则 run:
   `EXISTING="$(printf '%s' "$DEDUP_JSON" | jq -r --arg title "$TITLE" '.issues[] | select(.title == $title) | .identifier' | head -1)"`;
   非空则把 identifier 写进报告且禁止重复建单。只有空且满足 structural 首现或
   transient 连续 2 tick 时 run:
   `PAYLOAD="$(jq -n --arg title "$TITLE" --arg description "patrol report: $REPORT_PATH" '{title:$title, description:$description, team:"FLY", project:"Flywheel", labels:["Flywheel"]}')"; printf 'header = "Authorization: Bearer %s"\n' "${TEAMLEAD_API_TOKEN:?TEAMLEAD_API_TOKEN required}" | curl --config - -fsS -X POST -H 'Content-Type: application/json' "$BRIDGE_URL/api/linear/create-issue" -d "$PAYLOAD"`。
   最后 run(完成门):
   `FINAL_STEP_COUNT="$(grep -Ec '^STEP [1-6]: (OK|FINDING|UNAVAILABLE\((transient|structural): [A-Za-z0-9._-]+\))$' "$REPORT_PATH")"; PANE_COUNT="$(sed -n 's/^pane_count=//p' "$REPORT_PATH" | tail -1)"; EVIDENCE_COUNT="$(grep -c '^PANE_EVIDENCE ' "$REPORT_PATH")"; WELL_FORMED_EVIDENCE="$(awk '/^PANE_EVIDENCE / && / pane=[^ ]+/ && / target=[^ ]+/ && / capture_sha256=[^ ]+/ && / state_sha256=[^ ]+/ && / last_change_epoch=[0-9]+/ && / findings=[^ ]+/ && / action=[^ ]+/ && / result=[^ ]+/{n++} END{print n+0}' "$REPORT_PATH")"; case "$PANE_COUNT" in ''|*[!0-9]*) false;; esac && test "$FINAL_STEP_COUNT" -eq 6 && test "$PANE_COUNT" -eq "$EVIDENCE_COUNT" && test "$PANE_COUNT" -eq "$WELL_FORMED_EVIDENCE" && ! grep -Eq 'LEAD-JUDGMENT-REQUIRED|-CANDIDATE$|action=REQUIRED|result=UNSET' "$REPORT_PATH"`。
   失败就没有完成;无法理解本段也必须记 UNAVAILABLE,禁止静默跳过。

`runner_terminal_list` remains a useful internal starting point, but it is one
system view only;不采信 Bridge 单方转述. It must be crossed with `TMUX= tmux`, never used alone. The tick
is the scheduled trigger; the existing inbox-batch and task-boundary cadence
remains an event-driven supplement. The Lead must not create another timer.

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
(no error). `respond` is for **gate answers only** (`approve_to_ship`,
`clarify_question`, …).

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
  `event_seq`, `project`, and `token`. This is distinct from
  `flywheel_inbox_ack(message_id)`, which only acknowledges inbox transport.
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

Do not ACK individual rows in a batch. Until the batch ACK lands it occupies one
of three in-flight slots; an expired lease re-delivers the same rows under the
same durable batch id. ACK is therefore part of handling the delivery, not
optional cleanup.
