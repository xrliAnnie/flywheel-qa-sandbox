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

**巡检的 goal 是把 orchestrator 持续推进到每个 issue 的 Ship card，而不是做记录仪。**
Founder 2026-08-26 19:42:58 直令：

> 「既然这样的话,巡检还有一个 goal 需要写进去,就是每一个 Lead 都需要知道,他们的 goal 是要把 orchestrator 一直推到每个 issue 最后到达 Ship card 那个地方。唯一需要停下来的情况,就是如果有真正的问题必须要我来回答才可以,那 OK,可以停下来等我回答。但除此以外,必须非常激进地去推进这些项目,比如有问题了就去修、runner 卡住了就去推,必须非常激进地往前推进,而不是记录一下发生了什么情况然后就去休息了。我希望在 2080 中,也能够通过巡检让 Lead 明确知道必须做到这一点」

Founder 2026-08-26 19:43:17 直令：

> 「我希望的是,我把事情派给你之后,我就可以去休息了。在这个过程中,你有问题就来问我;没有问题你就往前推,一直推到我有时间来看的时候,这个东西已经推进到我可以 review 的状态。而不是我中途发现好像有一堆问题,而你又坐在那什么都不干。」

Founder 2026-08-26 19:13 在 FLY-2029 的两步直令：

> 「过去几周我们一直都是从头重跑,浪费了太多时间。我需要你把巡检加进去,巡检其实需要做两件事情:
>
> 1. 发现问题并补账:自己去 identify 发现了什么问题,把漏的账补上,让 Bridge 继续操作
> 2. 记录问题:光查漏补缺也不是办法,还是希望 Bridge 能够正确执行。每次遇到问题都要记录下来(可以在 Linear 的某个 Epic 下面),这样我们隔段时间可以 review 一下 Bridge 当前的问题到底在哪里、有哪些重复出现的问题可以解决
>    让所有的巡检都带上这两个步骤」

因此每个 finding 都必须完成 **步骤 A — 发现即补账推进** 与 **步骤 B —
记录进病根 Epic**。A/B 是实现上述 goal 的手段：唯一可以停在原地的形状是确有
真实性、权限或业务答案必须由 founder 回答；除此以外必须修、推、验证接力并记账，
不得写成「已知，等着」后休息。本规则不扩大巡检检测面或频率，也不改变 founder-only
merge/stop、authority、approval、claim 等硬边界。

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
   finding 按上面的唯一命令或对应 emergency procedure 有界修复。然后对每个
   distinct finding 强制执行下面 A/B；不允许跳过后只写观察结果。

   **步骤 A — 发现即补账推进**：

   1. 从报告拿到 exact shape 与 Bridge 的结构化诊断（稳定错误码、run/request/execution id、
      当前 state/revision），把可复跑的只读 query 与相关 `workflow_run_event seq/kind`
      结果写进报告；只引用负责该诊断的 source symbol/path 作为 owner 入口，不摘录或
      枚举实现条件。错误文案只作索引；证据不足以判定 guard 类别时写 `UNAVAILABLE` +
      owner + 下一动作，不得猜是哪笔账。
   2. 逐守卫分类。防篡改/真实性 guard（`digest`、authority、`head fingerprint`、
      founder consent、`approval`、`claim`、授权或头指纹）必须停手，不改账，带
      classification、evidence、owner 和下一动作上报 founder，result 写
      `escalated-with-plan`。防漏账 guard 只限引擎已产生真实事实、但漏写或漏联
      ledger/route/delivery/event 且“补上即真”的账；按本节附录 exact recipe 当场补，
      不能逐次再请示。此处执行权来自 founder 三次直令：2026-08-19
      FLY-1894/FLY-1877「这个东西你为什么要等我 你自己做决定就可以」；
      2026-08-23 FLY-2072「拨 这个你可以自己决定 不需要问我」；以及上方
      2026-08-26 19:13 两步直令。R5 authority registry 的正式 entry 另单修订；
      本文件不借此扩大 universal contract。
   3. 四条硬边界永远成立：真实性 guard 停手；永不写 authority/gate/approval/claim；
      永不终结 Runner、替换真实身份或丢失 work/context；每次修复都保留 before/after
      evidence 并执行步骤 B。任一 recipe precondition 不满足时不得硬拨，必须明确
      owner + 下一动作 + evidence，写 `escalated-with-plan`。
   4. 补账后至少等一个 Bridge reconcile tick，并记录 baseline 之后由引擎追加的
      `workflow_run_event seq/kind`；接力 event 必须同时满足 `seq > BASELINE_SEQ` 与
      `event_uid NOT LIKE 'patrol:%'`，因为 patrol 自写 event 只证明 transaction commit。
      SQL `changes()==1` 或目标 pane 内容变化本身都不是接力证据。只有 finding 已消失
      可写 `fixed`；Bridge 已进入下一可执行状态可写 `advanced`。没有新 engine event
      时只能按附录做有界 pane 诊断并留下 owner/下一动作，不能写 `fixed|advanced`。
   5. 禁止 `known-waiting`、`known_waiting`、`known`、`waiting`、
      「已知，等着」等归档值；“已知”不是处置，修掉或带可执行 plan 升级才是。

   **步骤 B — 记录进病根 Epic**：Founder 2026-08-27 03:19 选择 A：**一类病根 =
   FLY-2072 Epic 下挂一张子 issue**。每个 `bridge_problem=yes` 的 finding，无论 A
   是补账还是停手升级，都必须命中或新建这张类别子 issue；禁止再把新记录直接写成
   FLY-2072 根 issue 的 comment。**2080 之前的记录存于 FLY-2072 评论区(历史),新记录一律走子 issue**；不迁移二十余条旧 comment，历史需要时只读
   `/api/linear/comments?issueId=FLY-2072&limit=100`，不得用
   `/api/linear/comment` 往 FLY-2072 根 issue 追加新账。

   **判同类（先判、再写）**：从步骤 A 的 exact evidence 归一化三元组
   `ERROR_CODE | GUARD_KEY | STRUCTURAL_SHAPE`。`ERROR_CODE` 是源码实际抛出的稳定
   错误码；`GUARD_KEY` 是同一源码文件 + symbol + 精确 `WHERE`/`if` 守卫（不用易漂的
   line number）；`STRUCTURAL_SHAPE` 是同一缺账表/字段/状态转移，把 run/request/
   execution/pane id、时间戳、attempt 数等实例值删掉。三项**全部相同**才是同类；
   任一项不同就是另一类，证据不足则停写并报 UNAVAILABLE，禁止按标题相似度猜。
   run：

   ```sh
   ROOT_KEY_INPUT="$ERROR_CODE|$GUARD_KEY|$STRUCTURAL_SHAPE"
   ROOT_KEY="$(printf '%s' "$ROOT_KEY_INPUT" | shasum -a 256 | awk '{print $1}')"
   case "$ROOT_KEY" in ''|*[!0-9a-f]*) exit 64;; esac
   test "${#ROOT_KEY}" -eq 64
   ```

   用 `mcp__linear-api__list_issues({team:"FLY",parentId:"FLY-2072",includeArchived:true,limit:250})`
   只查 FLY-2072 的子 issue；必须沿 cursor 分页到 `hasNextPage=false`，任一页不可读或
   cursor 断裂都视为查重不完整、报 UNAVAILABLE，禁止把前 250 条当全集。`list_issues`
   的 description 会截断，分页结果只用于取得完整 candidate identifier 集；必须对每个
   candidate 调 `mcp__linear-api__get_issue({id:"<candidate child identifier>"})`，任一张
   不可读就报 UNAVAILABLE。只在逐张 fresh read 返回的完整 description 中精确找
   `class_key:<ROOT_KEY>`。匹配 0 张走首次；恰好 1 张走重复；>1 张说明类别账已分叉，
   不再写任何一张，报 `UNAVAILABLE(structural: root_class_duplicate)`。标题只帮助人读，
   `class_key` 才是去重权威。

   **首次出现（0 张）**：生成稳定短名，调用：

   ```text
   mcp__linear-api__save_issue({
     title: "[病根] <稳定短名> · ×1",
     team: "FLY",
     parentId: "FLY-2072",
     labels: ["Flywheel"],
     description: "class_key:<ROOT_KEY>\n形状: <错误码/卡点/结构形状>\n根因: <漏的表字段或断裂剧本>\n处置: <补了什么 + baseline 后非 patrol engine event seq:kind；无 event 则 owner/下一动作>\n首见时间: <UTC ISO-8601>\n\noccurrences: 1\npatrol-finding:<report>:<step>:<ordinal>:<64hex>"
   })
   ```

   description 的固定四字段就是 `形状/根因/处置/首见时间`，不得拿实例 id 充当类别；
   `occurrences` 与 `class_key` 是机器元数据。创建后立即用
   `mcp__linear-api__get_issue({id:"<child identifier>"})` 复核：
   team=`Flywheel`、parent=`FLY-2072`、label 含 `Flywheel`、title=`[病根] ... · ×1`、
   description 四字段齐全且含 marker。任一不符都不得报记账成功，也不得退化成顶层 issue。
   Linear MCP 的 issue `id` 是 `FLY-<number>` identifier，不是完成门要的 UUID；复核后必须
   用 Bridge 的 exact-identifier 读口取真实 child UUID（secret header 只走 stdin）：

   ```sh
   CHILD_IDENTIFIER='<child identifier>'
   CHILD_LOOKUP_JSON="$(printf 'header = "Authorization: Bearer %s"\n' "${TEAMLEAD_API_TOKEN:?TEAMLEAD_API_TOKEN required}" | curl --config - -fsS --get --data-urlencode "query=$CHILD_IDENTIFIER" "${BRIDGE_URL:?BRIDGE_URL required}/api/linear/issue")"
   CHILD_UUID="$(printf '%s' "$CHILD_LOOKUP_JSON" | jq -er --arg identifier "$CHILD_IDENTIFIER" 'select(.matchType == "identifier" and .issue.identifier == $identifier) | .issue.id')"
   printf '%s\n' "$CHILD_UUID" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   ```

   curl、JSON、identifier 精确匹配或 UUID 格式任一失败都不得拿 `FLY-<number>` 冒充
   receipt UUID，必须走下方 `linear_epic_unavailable`。

   **同类再次出现（恰好 1 张）**：绝不新建。先 fresh read 类别子 issue，读取
   `occurrences: N`，并用 `mcp__linear-api__list_comments` 分页到尽头，按本次
   `patrol-finding:` marker 精确搜重；marker 已存在就复用原 comment UUID、只校准
   count，不再 POST。marker 不存在才调用：

   ```text
   mcp__linear-api__save_comment({
     issueId: "<child identifier>",
     body: "本次实例: <UTC + stable run/request/execution id>\n形状: <本次错误码/卡点>\n处置: <本次补账或升级动作>\n引擎接力证据: <baseline 后非 patrol engine event seq:kind；无 event 则 owner/下一动作>\npatrol-finding:<report>:<step>:<ordinal>:<64hex>"
   })
   mcp__linear-api__save_issue({
     id: "<child identifier>",
     title: "[病根] <同一稳定短名> · ×<N+1>",
     description: "<原 description，仅把 occurrences: N 改成 occurrences: N+1>"
   })
   ```

   写后再次 fresh read；只有 comment UUID/body marker 可读、`occurrences=N+1` 且标题
   `×N+1` 一致才算成功。并发导致 N 已变化时重读后只重试 count 更新，绝不重复 comment。
   `是否重复` 由同一 child 下的实例 comments + `occurrences` 直接表达，不再靠根 issue
   评论区人工写“见过”。Founder 定期 review 时打开 FLY-2072 看子 issue 列表：标题就是
   类别，`×N` 就是热度；反复出现的类别直接成为正经修引擎的排期依据。

   `EPIC_MARKER` 是 `patrol-finding:` 稳定行末尾的 64-hex。首次的 receipt UUID 是上面
   Bridge exact lookup 返回的 `CHILD_UUID`，重复的 receipt UUID 是本次 comment UUID；沿用完成门既有字段，写
   `epic=FLY-2072#<receipt UUID>` 与 `epic_marker=<EPIC_MARKER>`。只有 marker 在新建
   description 或本次 comment 中可回读、且上述 parent/count 检查通过才能封口。Linear
   MCP 不可用、Bridge exact lookup 失败、查重不完整或任何写后验证失败，必须写
   `UNAVAILABLE_CAUSE step=6 class=transient token=linear_epic_unavailable`，并按既有
   UNAVAILABLE 建单流程逐 cause 搜重；不得假装记账成功。多 cause 每个各写一行
   `UNAVAILABLE_CAUSE`，STEP 6 唯一状态行用 `multiple_unavailable` 聚合（任一
   structural 则 structural，否则 transient）。

   每个 distinct finding 最后追加一行，字段和值不得含空格：
   `FINDING step=<1-6> bridge_problem=<yes|no> result=<fixed|advanced|escalated-with-plan> evidence=<stable-token> owner=<agent:agent-id|founder|n/a> next=<inspect:token|repair:token|authorize:token|route:token|file:token|retry:token|n/a> epic=<FLY-2072#comment-uuid|n/a|unavailable> epic_marker=<64hex|n/a>`。
   `fixed|advanced` 必须 `owner=n/a next=n/a`；`escalated-with-plan` 必须有
   `owner=founder|agent:<registered-id>` 与有限动词下一步。`bridge_problem=no` 必须
   `epic=n/a epic_marker=n/a`。

   同一 tick 的跨界 finding 聚合成一条,先 run:
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
   再 run 以下 finding validator；非零同样没有完成：

# FLY-2080-FINDING-GATE-BEGIN
awk '
function value(name,    i,prefix) {
  prefix=name "="
  for (i=1; i<=NF; i++) if (index($i,prefix)==1) return substr($i,length(prefix)+1)
  return ""
}
function uuid(v,    body,n,a) {
  if (index(v,"FLY-2072#") != 1) return 0
  body=substr(v,10); n=split(body,a,"-")
  return n==5 && length(a[1])==8 && length(a[2])==4 && length(a[3])==4 && length(a[4])==4 && length(a[5])==12 && body !~ /[^0-9a-f-]/
}
function hex64(v) { return length(v)==64 && v !~ /[^0-9a-f]/ }
/^STEP [1-6]: FINDING$/ { step=substr($2,1,1); required[step]=1; next }
/^UNAVAILABLE_CAUSE / {
  step=value("step"); class=value("class"); token=value("token")
  if (step=="6" && class=="transient" && token=="linear_epic_unavailable") linear_unavailable=1
  next
}
/^FINDING / {
  step=value("step"); bridge=value("bridge_problem"); result=value("result")
  evidence=value("evidence"); owner=value("owner"); next_action=value("next")
  epic=value("epic"); marker=value("epic_marker")
  if (step !~ /^[1-6]$/ || !required[step]) bad=1; else detail[step]++
  if (bridge!="yes" && bridge!="no") bad=1
  if (result!="fixed" && result!="advanced" && result!="escalated-with-plan") bad=1
  if (evidence !~ /^[A-Za-z0-9][A-Za-z0-9._:-]*$/) bad=1
  if (result=="fixed" || result=="advanced") {
    if (owner!="n/a" || next_action!="n/a") bad=1
  } else {
    if (owner!="founder" && owner !~ /^agent:[A-Za-z0-9][A-Za-z0-9._-]*$/) bad=1
    if (next_action !~ /^(inspect|repair|authorize|route|file|retry):[A-Za-z0-9][A-Za-z0-9._:-]*$/) bad=1
  }
  if (bridge=="yes") {
    if (epic=="unavailable") { if (marker!="n/a") bad=1; needs_linear_unavailable=1 }
    else if (!uuid(epic) || !hex64(marker)) bad=1
  } else if (epic!="n/a" || marker!="n/a") bad=1
}
END {
  for (step in required) if (!detail[step]) bad=1
  if (needs_linear_unavailable && !linear_unavailable) bad=1
  exit bad
}
' "$REPORT_PATH"
# FLY-2080-FINDING-GATE-END

   失败就没有完成;无法理解本段也必须记 UNAVAILABLE,禁止静默跳过。

### FLY-2080 附录 A — receipt 死结完整配方

只在步骤 A 已证明“目标 execution 已真实收到并完成 rework，但 receipt 剧本漏记”时
执行。核心不是单拨一行：`workflow_rework_delivery held→wake_delivered` 与
`workflow_run held→active` 必须同一 transaction；否则下一轮会撞 chain CAS。route、
target `workflow_run_node`、可选 `workflow_rework_verification_path` 与
`rework_delivery_wake_delivered` event 也必须一起闭合。

先从只读错误现场取得精确 id，验证 id 字符集，保存 0600 backup 和 engine event
baseline。`TARGET_PANE` 继续用于事务前真实性证明或 event 为空后的有界诊断，不为
pane 输出建立 baseline 指纹：

```sh
STATE_DB="${FLYWHEEL_STATE_DB_PATH:-${TEAMLEAD_DB_PATH:-$HOME/.flywheel/teamlead.db}}"
REQUEST_ID='<exact request_id from the read-only probe>'
TARGET_PANE='<exact canonical pane id>'
case "$REQUEST_ID:$TARGET_PANE" in *[!A-Za-z0-9._:%-]*) exit 64;; esac
REPAIR_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/patrol-repairs"
umask 077; mkdir -p "$REPAIR_DIR"
BACKUP_PATH="$REPAIR_DIR/FLY-2080-receipt-${REQUEST_ID}-$(date -u +%Y%m%dT%H%M%SZ).db"
sqlite3 -bail "$STATE_DB" <<SQL
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
.backup '$BACKUP_PATH'
SQL
chmod 600 "$BACKUP_PATH"
BASELINE_SEQ="$(sqlite3 -bail "$STATE_DB" "PRAGMA busy_timeout=5000; SELECT COALESCE(MAX(e.seq),0) FROM workflow_run_event e JOIN workflow_rework_request q ON q.run_id=e.run_id WHERE q.request_id='$REQUEST_ID';")"
```

先 run 此 read-only probe，并把输出逐字段写入报告。它必须恰好一行，且：delivery
`state='held' AND last_error='delivery_awaiting_receipt'`；run
`engine_owned=1 AND status='held'`；route 是 latest；target node 恰为 `admitted` 且
execution 等于 route actor；path 不存在或恰为 `pending`；同 run 没有
`workflow_carrier_delivery state='held' AND last_error LIKE 'run_inactive:%'`：

```sh
sqlite3 -bail -header -column "$STATE_DB" <<SQL
PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
SELECT d.request_id,q.run_id,d.generation,d.route_revision,d.state AS delivery_state,
       d.last_error,r.status AS run_status,r.engine_owned,
       rr.target_node_id,rr.target_attempt,rr.preferred_actor_execution_id,
       n.state AS node_state,n.execution_id,p.state AS path_state,
       (SELECT MAX(x.revision) FROM workflow_rework_route_revision x
         WHERE x.request_id=d.request_id) AS latest_revision,
       (SELECT COUNT(*) FROM workflow_carrier_delivery c WHERE c.run_id=q.run_id
         AND c.state='held' AND c.last_error LIKE 'run_inactive:%') AS held_carriers
  FROM workflow_rework_delivery d
  JOIN workflow_rework_request q ON q.request_id=d.request_id
  JOIN workflow_run r ON r.run_id=q.run_id
  JOIN workflow_rework_route_revision rr
    ON rr.request_id=d.request_id AND rr.revision=d.route_revision
  JOIN workflow_run_node n ON n.run_id=q.run_id
    AND n.node_id=rr.target_node_id AND n.attempt=rr.target_attempt
  LEFT JOIN workflow_rework_verification_path p ON p.request_id=d.request_id
 WHERE d.request_id='$REQUEST_ID'
   AND d.state='held' AND d.last_error='delivery_awaiting_receipt'
   AND r.engine_owned=1 AND r.status='held'
   AND d.route_revision=(SELECT MAX(x.revision) FROM workflow_rework_route_revision x
                          WHERE x.request_id=d.request_id)
   AND n.state='admitted' AND n.execution_id=rr.preferred_actor_execution_id
   AND (p.request_id IS NULL OR (p.route_revision=d.route_revision AND p.state='pending'))
   AND NOT EXISTS (SELECT 1 FROM workflow_carrier_delivery c WHERE c.run_id=q.run_id
                    AND c.state='held' AND c.last_error LIKE 'run_inactive:%');
SQL
```

pane/commit/TURN 必须另行证明 `preferred_actor_execution_id` 已完成这次 rework；不成立
就是伪造 receipt，按防篡改类停手。若 pane 参与这项事务前真实性证明，只 run
`TMUX= tmux capture-pane -p -S -40 -t "$TARGET_PANE" | tail -40`；不落原文、不做
哈希、不与事务前后的输出做前后比较，只在报告写非敏感 `pane_marker=<state>` 与
`observed_at=<UTC>`。probe 恰好一行后才可 run 下列
`BEGIN IMMEDIATE`。每个 `patrol_assert_*` 都用 `CHECK(v=1)` 把竞态变成 rollback；新
route revision 还会重新武装以 revision 为键的 stall watchdog：

```sh
sqlite3 -bail "$STATE_DB" <<SQL
PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
BEGIN IMMEDIATE;
CREATE TEMP TABLE patrol_ctx AS
SELECT d.request_id,q.run_id,d.generation,d.route_revision AS old_revision,
       d.route_revision+1 AS new_revision,rr.target_node_id,rr.target_attempt,
       rr.preferred_actor_execution_id,
       (SELECT COUNT(*) FROM workflow_rework_verification_path p
         WHERE p.request_id=d.request_id AND p.route_revision=d.route_revision
           AND p.state='pending') AS path_count
  FROM workflow_rework_delivery d
  JOIN workflow_rework_request q ON q.request_id=d.request_id
  JOIN workflow_run r ON r.run_id=q.run_id
  JOIN workflow_rework_route_revision rr
    ON rr.request_id=d.request_id AND rr.revision=d.route_revision
  JOIN workflow_run_node n ON n.run_id=q.run_id AND n.node_id=rr.target_node_id
    AND n.attempt=rr.target_attempt AND n.execution_id=rr.preferred_actor_execution_id
 WHERE d.request_id='$REQUEST_ID'
   AND d.state='held' AND d.last_error='delivery_awaiting_receipt'
   AND r.engine_owned=1 AND r.status='held' AND n.state='admitted'
   AND d.route_revision=(SELECT MAX(x.revision) FROM workflow_rework_route_revision x
                          WHERE x.request_id=d.request_id)
   AND NOT EXISTS (SELECT 1 FROM workflow_carrier_delivery c WHERE c.run_id=q.run_id
                    AND c.state='held' AND c.last_error LIKE 'run_inactive:%');
CREATE TEMP TABLE patrol_assert_preflight(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_preflight SELECT COUNT(*) FROM patrol_ctx;
CREATE TEMP TABLE patrol_assert_path_shape(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_path_shape SELECT CASE WHEN path_count IN (0,1) THEN 1 ELSE 0 END FROM patrol_ctx;

INSERT INTO workflow_rework_route_revision
 (request_id,revision,target_node_id,target_attempt,preferred_actor_execution_id,
  invalidation_scope_json,verification_policy_json,interpreted_by,
  interpretation_reason,created_at)
SELECT old.request_id,c.new_revision,old.target_node_id,old.target_attempt,
       old.preferred_actor_execution_id,old.invalidation_scope_json,
       old.verification_policy_json,'patrol:FLY-2080',
       'receipt ledger repair after exact guard proof',datetime('now')
  FROM patrol_ctx c JOIN workflow_rework_route_revision old
    ON old.request_id=c.request_id AND old.revision=c.old_revision;
CREATE TEMP TABLE patrol_assert_route(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_route VALUES(changes());

UPDATE workflow_rework_delivery
   SET route_revision=(SELECT new_revision FROM patrol_ctx),
       state='wake_delivered',hold_count=0,owner_id=NULL,lease_expires_at=NULL,
       next_retry_at=NULL,last_error=NULL,updated_at=datetime('now')
 WHERE request_id=(SELECT request_id FROM patrol_ctx)
   AND route_revision=(SELECT old_revision FROM patrol_ctx)
   AND state='held' AND last_error='delivery_awaiting_receipt';
CREATE TEMP TABLE patrol_assert_delivery(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_delivery VALUES(changes());

UPDATE workflow_run_node SET state='running'
 WHERE run_id=(SELECT run_id FROM patrol_ctx)
   AND node_id=(SELECT target_node_id FROM patrol_ctx)
   AND attempt=(SELECT target_attempt FROM patrol_ctx)
   AND execution_id=(SELECT preferred_actor_execution_id FROM patrol_ctx)
   AND state='admitted';
CREATE TEMP TABLE patrol_assert_node(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_node VALUES(changes());

UPDATE workflow_rework_verification_path
   SET route_revision=(SELECT new_revision FROM patrol_ctx),state='active',updated_at=datetime('now')
 WHERE request_id=(SELECT request_id FROM patrol_ctx)
   AND route_revision=(SELECT old_revision FROM patrol_ctx) AND state='pending';
CREATE TEMP TABLE patrol_assert_path(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_path
SELECT CASE WHEN changes()=(SELECT path_count FROM patrol_ctx) THEN 1 ELSE 0 END;

UPDATE workflow_run SET status='active'
 WHERE run_id=(SELECT run_id FROM patrol_ctx) AND engine_owned=1 AND status='held'
   AND EXISTS (SELECT 1 FROM workflow_rework_delivery d JOIN patrol_ctx c
                ON c.request_id=d.request_id
                WHERE d.route_revision=c.new_revision AND d.state='wake_delivered')
   AND EXISTS (SELECT 1 FROM workflow_run_node n JOIN patrol_ctx c ON c.run_id=n.run_id
                WHERE n.node_id=c.target_node_id AND n.attempt=c.target_attempt
                  AND n.execution_id=c.preferred_actor_execution_id AND n.state='running')
   AND NOT EXISTS (SELECT 1 FROM workflow_rework_verification_path p JOIN patrol_ctx c
                    ON c.request_id=p.request_id
                    WHERE p.route_revision<>c.new_revision OR p.state<>'active');
CREATE TEMP TABLE patrol_assert_run(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_run VALUES(changes());

INSERT INTO workflow_run_event(run_id,seq,event_uid,kind,node_id,execution_id,payload,at)
SELECT run_id,(SELECT COALESCE(MAX(e.seq),0)+1 FROM workflow_run_event e WHERE e.run_id=c.run_id),
       'patrol:FLY-2080:receipt:'||request_id||':rev'||new_revision,
       'rework_delivery_wake_delivered',target_node_id,preferred_actor_execution_id,
       json_object('requestId',request_id,'generation',generation,'from','held',
         'fromReason','delivery_awaiting_receipt','to','wake_delivered',
         'routeRevision',new_revision),datetime('now')
  FROM patrol_ctx c
 WHERE NOT EXISTS (SELECT 1 FROM workflow_run_event e
                    WHERE e.event_uid='patrol:FLY-2080:receipt:'||c.request_id||':rev'||c.new_revision);
CREATE TEMP TABLE patrol_assert_event(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_event VALUES(changes());
COMMIT;
SQL
```

事务后必须静态复核 delivery=`wake_delivered`、node=`running`、path absent/`active`、
run=`active`，再等至少一个 reconcile tick 并 run：

```sh
sleep 10
AFTER_EVENTS="$(sqlite3 -bail "$STATE_DB" "SELECT e.seq||':'||e.kind FROM workflow_run_event e JOIN workflow_rework_request q ON q.run_id=e.run_id WHERE q.request_id='$REQUEST_ID' AND e.seq>$BASELINE_SEQ AND e.event_uid NOT LIKE 'patrol:%' ORDER BY e.seq;")"
printf 'engine_handoff events=%s\n' "$AFTER_EVENTS"
test -n "$AFTER_EVENTS"
```

所有 `patrol:%` event 都由 patrol 配方自己写入，只证明 transaction commit，必须从
接力事件中排除；否则 Bridge 已停机时也会假绿。`test -n` 失败时，不把“暂时没有
event”解释为修复失败；仍用上方已校验的 `TARGET_PANE` 做同一条 40 行有界读取，
不落原文、不做哈希、不做前后比较，只记录 `pane_marker`、`observed_at` 与明确
`next=inspect|repair|retry:<token>`。pane_marker 不能单独支持 `fixed|advanced`。
predecessor 分支也只认 baseline 后的新非 patrol engine event。

### FLY-2080 附录 B — replacement 铸造漏账完整配方

输入必须是引擎已经 reserve 的 `NEW_EXECUTION_ID`；本配方绝不创建
`workflow_actor`、execution、authority、approval 或 claim。先执行与附录 A 相同的
DB path、0600 `.backup` 与 event baseline；如需 pane 参与事务前真实性证明或事后
诊断，也复用附录 A 的字符校验、40 行读取与不落原文合同。再设置并校验：

```sh
REQUEST_ID='<exact request_id from the read-only probe>'
NEW_EXECUTION_ID='<engine-reserved replacement execution id>'
case "$REQUEST_ID:$NEW_EXECUTION_ID" in *[!A-Za-z0-9._:%-]*) exit 64;; esac
```

read-only probe 必须恰好一组：request/run 存在且 `engine_owned=1`、run
`status IN ('active','held')`、`base_revision` 是 lowercase 40-hex；latest route 仍
指旧 execution；delivery 指 latest 非终态 revision；`workflow_actor` 与同
run/node/attempt 的 `workflow_run_node` 已指向新 execution，node state 在
`pending|admitted|running`；新 execution 恰好一条且为该 attempt 最大
`launch_ordinal` 的 dispatch `workflow_side_effect_ledger`，state 是
`intent_recorded|launch_committed`、reason empty；没有 route 已指向新 execution。
任一身份事实不存在都按真实性类停手，禁止人工铸造：

```sh
sqlite3 -bail -header -column "$STATE_DB" <<SQL
PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
SELECT q.request_id,q.run_id,q.base_revision,r.engine_owned,r.status AS run_status,
       d.route_revision,d.state AS delivery_state,d.last_error,
       old.target_node_id,old.target_attempt,
       old.preferred_actor_execution_id AS old_execution_id,
       a.execution_id AS new_execution_id,n.state AS new_node_state,
       l.launch_ordinal,l.state AS ledger_state,l.reason
  FROM workflow_rework_request q JOIN workflow_run r ON r.run_id=q.run_id
  JOIN workflow_rework_delivery d ON d.request_id=q.request_id
  JOIN workflow_rework_route_revision old ON old.request_id=q.request_id
    AND old.revision=d.route_revision
  JOIN workflow_actor a ON a.execution_id='$NEW_EXECUTION_ID'
    AND a.project_name=r.project_name AND a.issue_id=r.issue_id
  JOIN workflow_run_node n ON n.run_id=q.run_id AND n.node_id=old.target_node_id
    AND n.attempt=old.target_attempt AND n.execution_id=a.execution_id
  JOIN workflow_side_effect_ledger l ON l.run_id=q.run_id
    AND l.node_id=n.node_id AND l.attempt=n.attempt AND l.kind='dispatch'
    AND l.execution_id=a.execution_id
 WHERE q.request_id='$REQUEST_ID' AND r.engine_owned=1
   AND r.status IN ('active','held')
   AND length(q.base_revision)=40 AND q.base_revision NOT GLOB '*[^0-9a-f]*'
   AND d.route_revision=(SELECT MAX(x.revision) FROM workflow_rework_route_revision x
                          WHERE x.request_id=q.request_id)
   AND d.state NOT IN ('completed','needs_lead')
   AND n.state IN ('pending','admitted','running')
   AND l.launch_ordinal=(SELECT MAX(x.launch_ordinal) FROM workflow_side_effect_ledger x
                         WHERE x.run_id=l.run_id AND x.node_id=l.node_id
                           AND x.attempt=l.attempt AND x.kind='dispatch')
   AND l.state IN ('intent_recorded','launch_committed')
   AND (l.reason IS NULL OR trim(l.reason)='')
   AND NOT EXISTS (SELECT 1 FROM workflow_rework_route_revision x
                    WHERE x.request_id=q.request_id
                      AND x.preferred_actor_execution_id=a.execution_id);
SQL
```

只有恰好一行才 run 主事务。它将 dispatch reason 补为
`rework_replacement:<requestId>`，append 指向新 execution 的 route revision，
delivery→`replacement_pending`，同步可选 path；仅当同一 delivery
`last_error='delivery_replacement_pending'` 导致 run held 才恢复 active。held carrier
存在则 preflight 为零行、整单 rollback：

```sh
sqlite3 -bail "$STATE_DB" <<SQL
PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
BEGIN IMMEDIATE;
CREATE TEMP TABLE patrol_ctx AS
SELECT q.request_id,q.run_id,q.base_revision,d.route_revision AS old_revision,
       d.route_revision+1 AS new_revision,d.state AS old_delivery_state,d.last_error,
       old.target_node_id,old.target_attempt,'$NEW_EXECUTION_ID' AS new_execution_id,
       l.launch_ordinal,l.state AS ledger_state,
       (SELECT COUNT(*) FROM workflow_rework_verification_path p
         WHERE p.request_id=q.request_id AND p.route_revision=d.route_revision
           AND p.state IN ('pending','active')) AS path_count,
       CASE WHEN r.status='held' AND d.last_error='delivery_replacement_pending' THEN 1 ELSE 0 END AS wake_run
  FROM workflow_rework_request q JOIN workflow_run r ON r.run_id=q.run_id
  JOIN workflow_rework_delivery d ON d.request_id=q.request_id
  JOIN workflow_rework_route_revision old ON old.request_id=q.request_id AND old.revision=d.route_revision
  JOIN workflow_actor a ON a.execution_id='$NEW_EXECUTION_ID'
    AND a.project_name=r.project_name AND a.issue_id=r.issue_id
  JOIN workflow_run_node n ON n.run_id=q.run_id AND n.node_id=old.target_node_id
    AND n.attempt=old.target_attempt AND n.execution_id=a.execution_id
  JOIN workflow_side_effect_ledger l ON l.run_id=q.run_id AND l.node_id=n.node_id
    AND l.attempt=n.attempt AND l.kind='dispatch' AND l.execution_id=a.execution_id
 WHERE q.request_id='$REQUEST_ID' AND r.engine_owned=1 AND r.status IN ('active','held')
   AND length(q.base_revision)=40 AND q.base_revision NOT GLOB '*[^0-9a-f]*'
   AND d.route_revision=(SELECT MAX(x.revision) FROM workflow_rework_route_revision x WHERE x.request_id=q.request_id)
   AND d.state NOT IN ('completed','needs_lead') AND n.state IN ('pending','admitted','running')
   AND l.launch_ordinal=(SELECT MAX(x.launch_ordinal) FROM workflow_side_effect_ledger x
                         WHERE x.run_id=l.run_id AND x.node_id=l.node_id AND x.attempt=l.attempt AND x.kind='dispatch')
   AND l.state IN ('intent_recorded','launch_committed') AND (l.reason IS NULL OR trim(l.reason)='')
   AND NOT EXISTS (SELECT 1 FROM workflow_rework_route_revision x WHERE x.request_id=q.request_id AND x.preferred_actor_execution_id=a.execution_id)
   AND NOT EXISTS (SELECT 1 FROM workflow_carrier_delivery c WHERE c.run_id=q.run_id AND c.state='held');
CREATE TEMP TABLE patrol_assert_preflight(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_preflight SELECT COUNT(*) FROM patrol_ctx;
CREATE TEMP TABLE patrol_assert_path_shape(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_path_shape SELECT CASE WHEN path_count IN (0,1) THEN 1 ELSE 0 END FROM patrol_ctx;

UPDATE workflow_side_effect_ledger SET reason='rework_replacement:'||'$REQUEST_ID',updated_at=datetime('now')
 WHERE run_id=(SELECT run_id FROM patrol_ctx) AND node_id=(SELECT target_node_id FROM patrol_ctx)
   AND attempt=(SELECT target_attempt FROM patrol_ctx) AND kind='dispatch'
   AND launch_ordinal=(SELECT launch_ordinal FROM patrol_ctx)
   AND execution_id=(SELECT new_execution_id FROM patrol_ctx)
   AND state=(SELECT ledger_state FROM patrol_ctx) AND (reason IS NULL OR trim(reason)='');
CREATE TEMP TABLE patrol_assert_ledger(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_ledger VALUES(changes());

INSERT INTO workflow_rework_route_revision
 (request_id,revision,target_node_id,target_attempt,preferred_actor_execution_id,
  invalidation_scope_json,verification_policy_json,interpreted_by,interpretation_reason,created_at)
SELECT old.request_id,c.new_revision,old.target_node_id,old.target_attempt,c.new_execution_id,
       old.invalidation_scope_json,old.verification_policy_json,'patrol:FLY-2080',
       'replacement ledger repair after exact guard proof',datetime('now')
  FROM patrol_ctx c JOIN workflow_rework_route_revision old
    ON old.request_id=c.request_id AND old.revision=c.old_revision;
CREATE TEMP TABLE patrol_assert_route(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_route VALUES(changes());

UPDATE workflow_rework_delivery
   SET route_revision=(SELECT new_revision FROM patrol_ctx),state='replacement_pending',
       hold_count=0,owner_id=NULL,lease_expires_at=NULL,next_retry_at=NULL,
       last_error=NULL,updated_at=datetime('now')
 WHERE request_id=(SELECT request_id FROM patrol_ctx)
   AND route_revision=(SELECT old_revision FROM patrol_ctx)
   AND state=(SELECT old_delivery_state FROM patrol_ctx);
CREATE TEMP TABLE patrol_assert_delivery(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_delivery VALUES(changes());

UPDATE workflow_rework_verification_path
   SET route_revision=(SELECT new_revision FROM patrol_ctx),updated_at=datetime('now')
 WHERE request_id=(SELECT request_id FROM patrol_ctx)
   AND route_revision=(SELECT old_revision FROM patrol_ctx) AND state IN ('pending','active');
CREATE TEMP TABLE patrol_assert_path(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_path SELECT CASE WHEN changes()=(SELECT path_count FROM patrol_ctx) THEN 1 ELSE 0 END;

UPDATE workflow_run SET status='active'
 WHERE run_id=(SELECT run_id FROM patrol_ctx) AND engine_owned=1 AND status='held'
   AND (SELECT wake_run FROM patrol_ctx)=1;
CREATE TEMP TABLE patrol_assert_run(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_run SELECT CASE WHEN changes()=(SELECT wake_run FROM patrol_ctx) THEN 1 ELSE 0 END;
COMMIT;
SQL
```

主事务后重读 dispatcher replacement guard：reason prefix、request/run、route
node/attempt/execution、delivery revision/state 与 base SHA 必须同时成立。再用附录 A 的
baseline event gate 验证 Bridge launch/advance；只见 rows changed 不算接力。同步遵守
附录 A 的 event-empty 诊断合同：pane_marker 只能决定下一动作，不能单独过完成门。

#### 仅限 `engine_predecessor_unavailable` 的 predecessor 事件分支

replacement-context dispatch 不走本分支。只有 generic replacement 后确切错误码为
`engine_predecessor_unavailable`，才沿每个
`execution_dead_rolled_back.payload.newExecutionId` 唯一回溯至最初 target execution；
必须同时证明它没有以 `successorExecutionId` 出现在既有 `edge_traversed`，且恰好一个
既有 `node_completed`（`json_extract(payload,'$.outcome')='qa_fail'`）+
`workflow_rework_request` + target node/attempt + snapshot loop edge 组合证明 transition。
候选为 0 或多条均停手。source QA execution 的 `sessions` row 必须仍存在，并用引擎
同一个 read-only `resolveWorkflowHeadAuthority` probe 得到 lowercase 40-hex
`prHeadSha`；缺 session/head invalid 均禁止写 append-only event。

从上述唯一 probe 固定 `RUN_ID SOURCE_NODE_ID SOURCE_EXECUTION_ID SOURCE_ATTEMPT
EDGE_ID TARGET_NODE_ID TARGET_ATTEMPT SUCCESSOR_EXECUTION_ID REQUEST_ID
MAX_ITERATIONS_OR_NULL`。有界 loop 用 snapshot 中的正整数；无上限 loop 必须用 SQL
`NULL`，不能猜一个额度。`loopIteration` 必须按 authoritative counter
`COUNT(kind IN ('loop_iteration','loop_limit_escalated') AND edge_id=EDGE_ID)+1`，不能
从报告猜。完整 payload 字段名固定为 `targetNodeId`、`targetAttempt`、
`sourceAttempt`、`outcome`、`successorExecutionId`、`reworkRequestId`、
`loopIteration`。在一个 `BEGIN IMMEDIATE` 中先 append canonical `edge_traversed`，
再 append companion `loop_iteration`，两条各用 next seq；INSERT 前再次查 absence，
任一 UID/事实已存在即整单 rollback：

```sql
PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
BEGIN IMMEDIATE;
-- Values below come only from the unique read-only proof described above.
CREATE TEMP TABLE patrol_edge_ctx AS
SELECT '<RUN_ID>' run_id,'<SOURCE_NODE_ID>' source_node_id,
       '<SOURCE_EXECUTION_ID>' source_execution_id,<SOURCE_ATTEMPT> source_attempt,
       '<EDGE_ID>' edge_id,'<TARGET_NODE_ID>' target_node_id,<TARGET_ATTEMPT> target_attempt,
       '<SUCCESSOR_EXECUTION_ID>' successor_execution_id,'<REQUEST_ID>' request_id,
       <MAX_ITERATIONS_OR_NULL> max_iterations,
       1+(SELECT COUNT(*) FROM workflow_run_event e WHERE e.run_id='<RUN_ID>'
           AND e.edge_id='<EDGE_ID>' AND e.kind IN ('loop_iteration','loop_limit_escalated')) loop_iteration;
CREATE TEMP TABLE patrol_assert_edge_absent(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_edge_absent
SELECT CASE WHEN COUNT(*)=0 THEN 1 ELSE 0 END FROM workflow_run_event e,patrol_edge_ctx c
 WHERE e.run_id=c.run_id AND e.kind='edge_traversed'
   AND json_extract(e.payload,'$.successorExecutionId')=c.successor_execution_id;
INSERT INTO workflow_run_event(run_id,seq,event_uid,kind,node_id,edge_id,execution_id,payload,at)
SELECT run_id,(SELECT COALESCE(MAX(seq),0)+1 FROM workflow_run_event WHERE run_id=c.run_id),
       'patrol:FLY-2080:edge:'||request_id||':'||successor_execution_id,
       'edge_traversed',source_node_id,edge_id,source_execution_id,
       json_object('edgeId',edge_id,'targetNodeId',target_node_id,'targetAttempt',target_attempt,
         'sourceAttempt',source_attempt,'outcome','qa_fail',
         'successorExecutionId',successor_execution_id,'reworkRequestId',request_id,
         'loopIteration',loop_iteration),datetime('now') FROM patrol_edge_ctx c;
CREATE TEMP TABLE patrol_assert_edge(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_edge VALUES(changes());
INSERT INTO workflow_run_event(run_id,seq,event_uid,kind,node_id,edge_id,execution_id,payload,at)
SELECT run_id,(SELECT COALESCE(MAX(seq),0)+1 FROM workflow_run_event WHERE run_id=c.run_id),
       'patrol:FLY-2080:loop:'||request_id||':'||successor_execution_id,
       'loop_iteration',source_node_id,edge_id,source_execution_id,
       CASE WHEN max_iterations IS NULL
         THEN json_object('iteration',loop_iteration)
         ELSE json_object('iteration',loop_iteration,'maxIterations',max_iterations) END,
       datetime('now')
  FROM patrol_edge_ctx c;
CREATE TEMP TABLE patrol_assert_loop(v INTEGER CHECK(v=1));
INSERT INTO patrol_assert_loop VALUES(changes());
COMMIT;
```

把占位值替换后以 `sqlite3 -bail "$STATE_DB"` 执行。事务后仍必须等 Bridge reconcile，
只有 baseline 后的新非 patrol engine event 能证明 dispatcher 已接力，才可记
`advanced|fixed`；event 为空时只做附录 A 的有界诊断并留下下一动作。

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

Do not ACK individual rows in a batch. Until the batch ACK lands it occupies one
of three in-flight slots; an expired lease re-delivers the same rows under the
same durable batch id. ACK is therefore part of handling the delivery, not
optional cleanup.
