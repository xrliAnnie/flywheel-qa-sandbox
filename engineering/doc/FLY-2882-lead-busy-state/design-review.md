# FLY-2882 Lead 忙闲只读接口 — 设计评审记录
Issue: FLY-2882
日期: 2026-09-25
基于: plan.md

Reviewer: Codex (companion, xhigh), thread 01a0da38-eb97-76d0-8f94-95ac2b5d90ae,3 轮。

---

## Design Review — plan.md (Round 1)

Date: 2026-09-25  
Author: Codex  
Status: CHANGES REQUESTED

## Summary

方向正确，但当前计划还不能保证最关键的两个安全合同：读不到/看不懂时绝不报 idle，以及只有可证明时才报 issue。源码核对确认计划引用的主要组件都存在：`locateConfiguredLeadWindow`、`probeV2LeadPane`、`defaultLeadPaneCapture`、`IDLE_READY_MARKERS`、`wireDemuxedProcess`、`TurnDemux`、`CodexLeadInboxSocket`/capabilities、`probeCodexLeadInboxCapabilities`、`resolveCodexLeadStateDir`、`boundedTurnsList`、`SqliteJournalStore.listMemberIds`、`masterOnlyAuthMiddleware`、`lead-persona-routes` 与 `ship-judgment-history`。但它们的实际接口形状暴露出下面 7 个阻塞缺口。

本轮只读了仓库文档、源码、调用方和测试；没有运行测试、启动 Bridge、读取或改动 `~/.flywheel` 生产状态。工作树原有的未跟踪 Mermaid/SVG 文件未触碰。

## What's Good (Keep)

- 保留 research.md 的实测结论：忙态以当前 spinner + turn-wide duration 为正证据，`Worked/Cooked for … · done …` 必须是显式完成态，不能继续复用旧的 glyph-only 正则。
- 复用现有私有 tmux socket、pane 身份探测和只读 capture 通道；不向 pane 输入、不落盘 scrollback、不增加 spawn/kill，爆炸半径合理。
- Codex 选择 sidecar 内存状态 + 现有 HMAC socket，而不是再建一套持久化状态或解析 TUI；capability negotiation 也能兼容旧 sidecar。
- `unknown` 与 `undetermined` 分开，归因失败不污染 busy/idle，且 founder-terminal turn 明确不猜 issue。
- Bridge 路由使用 master-only auth、loopback listener；CLI 复用 strict `parseArgs`、loopback URL 校验、redirect refusal 和超时模式，符合现有惯例。
- 测试计划已经覆盖完成行误判、subagent 行、菜单/compact、老 sidecar、断连和多 issue 等主要表面场景。

## Issues & Recommendations

1. **Issue：Claude 解析器仍有两条“未知/忙 → idle”的路径。** 计划先在边框上方 40 行寻找任意完成行，找不到再以 `IDLE_READY_MARKERS` 判 idle（plan.md:100-107）。但现有常量的 `bypass permissions` 和 `ctx N%` 明确是持久状态栏锚点，并非 idle 专属（`pane-blocked-classifier.ts:47-60`）。因此：(a) 新版/异常 spinner 不匹配且没有历史完成行时，持久状态栏会把正在忙误报 idle；(b) 新版/异常 spinner 下方仍留有上一轮完成行时，扫描会命中旧完成行并报 idle；(c) compact/cancel 当前行与旧完成行共存时，步骤 3/5 的优先级不清，也可落到 idle。这与 §11 “格式变化退化成 unknown”相矛盾。**Why it matters：** 这是 founder 明确要求的 fail-closed 主合同，错报 idle 比 unknown 严重。**Suggested fix：** 把解析规则写成有明确优先级的当前-frame 状态机：先定位唯一且 leadId 匹配的输入框，再识别离边框最近的“状态候选行”；当前候选为 compact/cancel/未知 spinner-like 行时必须 unknown，旧完成行不得越过它授权 idle。不要用持久状态栏 marker 单独授权 idle；只使用经真实 busy/idle 双向夹具证明为 idle-exclusive 的空输入框证据，否则 never-used 形态也应 unknown。新增 `旧 done + 新未知 spinner`、`仅持久状态栏 + 未识别 spinner`、`旧 done + compact`、lead handle 不匹配的阴性测试。**Classification：blocking。**

2. **Issue：计划要求的 Claude unknown 原因无法由现有 locator/probe API 如实产生。** `locateConfiguredLeadWindow()` 会调用 `locateLeadWindow()`，而后者已经执行 `probeV2LeadPane(..., "capture")`；plist/manifest 缺失、tmux 不可达、pane 身份或 PID 不匹配最终都折叠为同一个 `null`（`fleet-lead-locator.ts:21-52`，`LeadWindowLocator.ts:112-142`）。`probeV2LeadPane()` 本身也只返回 boolean，并吞掉异常；`"send"` 的 false 既可能是前台非 Claude，也可能是整个身份已不可证（`LeadWindowLocator.ts:48-109`）。所以 plan.md:110-113 不能可靠地区分 `lead_window_not_found`、`pane_identity_indeterminate` 和 `lead_process_not_running`。**Why it matters：** `unknown` 必须携带真实原因；错误原因会误导是否重启/等待。**Suggested fix：** 明确新增一个无探测的地址解析步骤，或把 locator/probe 改为 tagged result（missing carrier/manifest、tmux error、identity mismatch、foreground non-Claude）。顺序应是先证明 capture identity，再检查 send-strength；send 失败后重新做 capture-strength，只有 identity 仍成立时才可报 `lead_process_not_running`。把涉及的现有文件和分支测试加入改动清单。**Classification：blocking。**

3. **Issue：Codex 冷启动 seed 与实时事件之间没有线性化规则，可能复活一个已经完成的 turn。** `wireDemuxedProcess` 确实是事件入口，`proc.on("exit")` 和 `DaemonConnectionSupervisor` 的 `onConnectionLost` 也确实存在；但计划只写 `seed(latestTurn)` 后置 `seeded=true`（plan.md:119-132），没有定义 seed RPC 与 `turn/started`/`turn/completed` 并发时谁胜出。例如 turns/list 在 turn 活跃时取到 `inProgress`，随后 completion 先删掉 Map，迟到的 seed 再把它放回，就会永久报 busy。当前共享候选 `boundedTurnsList()` 还只返回“唯一 terminal row” boolean，并不返回 id/startedAt（`codex-lead-thread-rotation.ts:290-329`）；“实现时以实际 hook 为准”也没有固定生命周期所有权。**Why it matters：** 这是可重复的 stale-busy/错误 startedAt 状态，且只会在重启/重连的高风险窗口出现。**Suggested fix：** 在设计里钉死每个 supervisor generation 一个 tracker，先同步挂事件和 exit fence，再发 seed RPC；用 generation + event revision/epoch 校验 seed，seed 开始后若观察到任何 turn 事件则丢弃该响应并重试/保持 unseeded，绝不能覆盖实时状态。`proc` exit 必须同步 `markDisconnected()`；旧 generation 的迟到事件必须被 fence。抽出一个严格解析、带 10s bound 的 `readLatestTurn()`，让原 `boundedTurnsList()` 继续保持原来的 terminal-only 行为。补 seed-response/completion 交叉、seed 期间新 start、disconnect/rebuild、旧 generation 迟到事件、rotation 与两次 seed 失败测试。**Classification：blocking。**

4. **Issue：计划中的 Codex journal 归因链在当前 API 上不可实现且漏掉真实消息来源。** 计划要“按 `turn_id` 找 journal entry，再 `listMemberIds(entry.id)`”（plan.md:135-139），但 `JournalStore`/`LeadJournal`/`SqliteJournalStore` 目前只有 `getById`、`getByIdempotencyKey`、`listMemberIds`，没有按 turnId 查询；改动清单也没有这些文件（`LeadJournal.ts:135-170`，`SqliteJournalStore.ts:255-278`）。而且 `turn/started` 的 held event 会在 `claimTurn()` 内回放，早于 router 的 `journal.toDispatched(id, turnId)`（`codex-lead-tui-runtime.ts:454-474`，`LeadInputRouter.ts:319-325`），所以即使加查询也存在短暂未绑定窗口。另一个真实路径是 sidecar 直接 Discord ingress：它调用 `router.submit({source:"discord"})`，不会写 `journal_member`（`CodexDiscordGateway.ts:253-282`，`CodexDiscordMailboxStrategy.ts:41-92`）。**Why it matters：** 当前计划会在正常 busy turn 上拿不到 deliveryIds，而合同里没有对应的确定性 `undetermined` 结果；仓促补一个任意 SQL `LIMIT 1` 还可能绑定错 entry。**Suggested fix：** 在 `JournalStore`、内存实现和 SQLite 实现中新增只读、歧义感知的 turn lookup（0/1/>1 三态；必要时加索引但不要对重复旧数据任取一行），并加入改动清单/测试。对 started→journal bind 窗口返回明确 `undetermined`，不可缓存成空闲或错误 issue。对 `source:"discord"`、bootstrap/system turn 和没有 membership 的 entry 明确定义无正文的 conservative 分支（最简单是新的 `no_delivery_binding` 原因）。**Classification：blocking。**

5. **Issue：issue attribution 目前能给出错误 issue，且 Discord 映射所依赖的事实与当前源码不符。** (a) Claude 的 `[start-10s,start+3s]` 只是时间相关，不是因果证明；founder 在终端开轮时恰好收到一条某 issue 的消息，就会唯一映射到一个错误 issue。(b) 当前 Discord mailbox producer 写的是 `from_agent="founder"` 或 `discord:<authorId>`，`source_ref` 是 delivery id，不是 channel/thread id（`discord-chat-ingest.ts:163-203`）；按计划把 `from_agent` 查 `chat_threads.thread_id` 是把用户 id 当 thread id。(c) Claude 查询和 sidecar 返回都静默截到 20 条，但 mailbox batch 配置允许 1..50 条（`mailbox-queue-config.ts:72-79`）；被截掉的第 21 条可能来自另一张 issue，前 20 条却会错误地给出唯一 issue。**Why it matters：** 用户明确要求 wrong issue 比 undetermined 更坏；这些不是纯理论上的 parser 格式问题，而是合同上的反例。**Suggested fix：** 最小安全方案是 Claude 一律 `undetermined`（新增 `causality_unproven`），直到有结构化 turn-start receipt 绑定 delivery id；不要把时间窗升级成 `{kind:"issue"}`。Discord chat 在不读 body 的约束下也应一律 unmapped/undetermined，除非另一个有独立范围的变更先把 origin thread id 写入专用 metadata。所有候选集合都必须完整，或使用 `limit+1`/显式 `truncated`，一旦溢出返回 `candidate_overflow`；Codex 的 50-member batch 不能截成 20 后继续判唯一。保留 question execution→session 和 lead_event seq→session_key 两条可证明链，并对每条结果做 issue-id 校验。**Classification：blocking。**

6. **Issue：privacy 约束还没有落实到实际 getter；复用现有 StateStore getter会读出 payload。** 计划说只读 `lead_events.seq, session_key`，但又允许使用“现有 getter”（plan.md:151-154）。当前 `getLeadEventBySeq()` 执行 `SELECT *`，`mapLeadEventRow()` 会把 `payload` materialize 成字符串（`StateStore.ts:26003-26007`，`StateStore.ts:89001-89011`）；`StateStore.ts` 也不在改动清单。这已经越过“never read message bodies”，即使最终响应不返回 payload。**Why it matters：** 隐私要求禁止读取正文，不只是禁止在 HTTP 中展示；误用现有方便 API 很容易在实现时发生。**Suggested fix：** 明确新增并命名 metadata-only getter，只 `SELECT seq, session_key`；Discord thread 复用现有 `getChatThreadByThreadId()` 即可，它已经只读两张 thread 表的元数据。CommDB reader同样必须用 read-only/fileMustExist 句柄和显式列清单，任何错误日志/response 都不得拼接 row、pane、SQL 参数或原始 sidecar response。把 `StateStore.ts` 加入改动清单，并用 sentinel body 测试和 SQL/query seam 证明 `content`、`delivery_content`、`payload` 从未被选择/记录。**Classification：blocking。**

7. **Issue：外部合同和验证门槛没有把计划声称的不变量编码进去。** `LeadActivityV1` 把 `unknown`、`turn`、`trigger` 都写成 optional（plan.md:42-61），因此类型允许 `state:"unknown"` 无原因，也允许 `state:"busy"` 无 timing/trigger；sidecar snapshot 也没有严格 response schema、数量/字符串长度、timestamp 合法性与 future-skew 校验。测试执行段还明确写“核对 Tests 条数，不看退出码”，并只给了 `--filter flywheel-teamlead`，不会执行新增的 `flywheel-comm` CLI 测试，也没有两个 package 的 typecheck（plan.md:189-207）。**Why it matters：** malformed/旧 sidecar 回包可能被错误默认成空数组→idle；而忽略进程退出码/Unhandled Errors 会把失败测试报告成通过。**Suggested fix：** 把 DTO 改成 discriminated union：busy 强制 `turn+trigger`，idle 禁止它们，unknown 强制枚举 reason+固定 detail；对 socket response 用 strict runtime schema，任何畸形值返回新的 `sidecar_protocol_invalid`，不得默认 idle。验证必须同时要求 exit code 0、无 unhandled errors、预期 test/file counts；分别运行 teamlead targeted tests、flywheel-comm targeted CLI tests，以及两个 package 的 `typecheck`，仍然不跑全量 suite。**Classification：blocking。**

8. **Issue：`source:"claude_pane_spinner"` 在 idle/unknown 响应中并不真实。** 完成行、空输入框、窗口缺失和身份不确定都不是“spinner”来源。**Why it matters：** 需求要求返回真实 data source；错误标签会让调用方误以为 busy spinner 已被观察到。**Suggested fix：** 将来源改为载体级 `claude_pane`，或按证据细分 `claude_pane_spinner` / `claude_pane_completed` / `claude_pane_ready` / `claude_pane_probe`；Codex 同理可保留 `codex_sidecar_turn_state`。**Classification：advisory。**

## Verdict

CHANGES REQUESTED

在批准前，至少要关闭以上 7 个 blocking 项：Claude 判定必须真正 fail-closed；Codex seed 必须线性化；journal/来源路径必须与现有 API 对齐；所有 issue 归因必须从“相关”收紧到“可证明”；正文列不得被读取；合同与 targeted verification 必须能阻止 invalid idle/invalid success。

---

## Design Review — plan.md (Round 2)

Date: 2026-09-25  
Author: Codex  
Status: CHANGES REQUESTED

## Summary

draft v2 实质性关闭了 R1 的大多数问题：Claude 不再用常驻状态栏授权 idle，locator 原因与现有 API 对齐；Codex 增加了 generation/revision fence；journal 绑定改成 0/1/2 三态且不截断；Claude/Discord 不再猜 issue；SQL 正文列、DTO 不变量、sidecar 严格校验和验证门槛也都写进了计划。修订后的 issue attribution 没有发现新的“给出错误 issue”路径，privacy 设计也没有发现 pane 原文、sidecar 原始回包或 message body 进入响应/日志/持久化的路径。

不过，本轮增量复核仍发现 4 个 blocking 缺口：Claude 的候选行定义还能越过一个新 glyph 的当前状态行并命中旧 done；Codex 成功 seed 的 terminal/empty 语义没有定义；sidecar snapshot 对非 message turn 的 `binding` 形状自相矛盾；socket 的 wire envelope 与 conditional feature contract 未与现有共享 server 形状对齐。因此当前仍不能批准。

本轮只重读了 draft v2、§12、相关 research 事实，以及上述改动触及的现有 parser/socket/runtime 接口；没有重开已通过的架构选择，没有运行测试、启动 Bridge，也没有读取或修改 `~/.flywheel` 生产状态。工作树原有文件未触碰。

## What's Good (Keep)

- 保留 §4 的方向：输入框必须精确匹配 `leadId`，只看边框上方，不以 `IDLE_READY_MARKERS` 或无历史状态行授权 idle；`lead_window_unavailable` 的合并原因也忠实反映了现有 locator 只能返回 `null` 的事实。
- 保留每个 proc generation 一个 tracker、先挂 exit、实时事件递增 revision、seed response 受 revision fence、disconnect 清空并作废实例的设计；它关闭了 R1 的迟到 seed 复活已完成 turn 的核心竞态。
- 保留 `readLatestTurn()` 与现有 terminal-only `boundedTurnsList()` 分离，避免改变 thread rotation 的既有安全语义。
- 保留 `findEntryIdsByTurnId(... LIMIT 2)`、pending/ambiguous/no-members/overflow 四个 fail-closed 分支，以及完整返回最多 64 个 member、不在截断集合上判唯一的规则。
- 保留 Claude v1 恒为 `causality_unproven`、Discord 恒为 unmapped，只让 question execution→session 与 lead_event seq→session_key 两条结构化链产生 issue；这是对“错单比 undetermined 更坏”的正确收缩。
- 保留 metadata-only StateStore getter、CommDB readonly handle + 显式列、SQL/body sentinel 测试；这些措施把“不读正文”落实到了实际数据访问边界。
- 保留判别联合、固定 detail、`sidecar_protocol_invalid`、两包 targeted tests/typecheck，以及“exit code 0 + 无 unhandled errors + 数量符合预期”三重验证门槛。
- `source: "claude_pane" | "codex_sidecar"` 已准确表达载体级数据来源，关闭了 R1 advisory。

## Issues & Recommendations

1. **Issue：Claude 的“最近候选行”仍能越过当前未知状态行，用旧 done 错报 idle。** §4.1 把候选行先限定为已知 glyph 集合 `^[✻✶✳✢✽·*] \S`，然后才对候选内容做 unknown 判定（plan.md:113-117）。因此下面的帧会把第一行当作“最近候选”并返回 idle，第二行虽然更靠近输入框，却因新 glyph `◆` 不在集合中而被完全跳过：`✻ Worked for 1m 17s · done …` / `◆ Thinking… (8s · …)` / `──── @leadId ────`。这直接反驳了“旧完成行不可能越过未知当前行”和 §11“格式变化不会错答”的声明；现有“旧 done + 更近未知格式”测试如果仍使用已知 glyph，也捕捉不到该反例。**Why it matters：** 这是 R1 #1 的原始安全合同，能够把真实 busy/unknown 报成 idle。**Suggested fix：** 把“哪一行占据当前 status slot”与“是否认识它的 glyph/文法”分开。在接受较远的已知 busy/done 行前，所有更近的非空第 0 列行必须被明确证明为可跳过的 interstitial；任何未分类的更近第 0 列行都应返回 `unrecognized_status_line`。至少新增“旧 done + 更近的未知 glyph/prefix”阴性夹具，确保不会扫描穿透它。**Classification：blocking。**

2. **Issue：成功 seed 为 terminal 或 empty thread 时，tracker 如何成为可信 idle 仍未定义。** `applySeed()` 只明确了 `status === "inProgress"` 时写入 `active`，没有明确任何成功 seed 都要 `seeded = true`，也没有定义 terminal turn 或 `thread/turns/list` 返回 `data: []` 时的返回类型/状态转移（plan.md:134,139-140）。现有 `boundedTurnsList()` 恰好要求一条 terminal row；新函数若只“严格解析 `{id,status,startedAt}`”，空数组无法表示，而 terminal/empty 又是冷启动后证明 idle 的主要路径。当前测试清单也只有 in-progress seed 的竞态，没有 terminal/empty 成功 seed。**Why it matters：** 实现者要么让正常空闲 Codex Lead 永久停在 `turn_state_not_seeded`，要么自行猜测何时可把空数组当 idle；两者都没有闭合 R1 #3 的 authoritative seed 合同。**Suggested fix：** 明确定义 `readLatestTurn(): LatestTurn | null`（严格校验整个 response；`null` 只代表成功且 `data: []`），并规定 revision fence 通过后：valid in-progress → 设置唯一 active；valid terminal 或 `null` → `active.clear()`；三种成功结果最后都设置 `seeded = true`。未知 status/畸形 response 仍是 seed 失败，绝不能授权 idle。补 empty、terminal、in-progress 三种成功 seed 及各自与实时事件交叉的测试。**Classification：blocking。**

3. **Issue：`turn-state.v1` 对非 message turn 的 `binding` 合同自相矛盾。** §5.1 要求每个 `activeTurns` 元素都完整包含 `{turnId, startedAtMs, origin, binding}`（plan.md:135），§5.4 又要求严格 schema“字段齐全”（plan.md:154）；但 §5.3 只为 `origin="message"` 计算 binding（plan.md:145-148），没有定义 `founder_terminal` 和 seed 得到的 `unknown` 应返回什么。若省略字段，合法的 founder turn 会被 Bridge 判成 `sidecar_protocol_invalid`；若随意填 `pending/no_members`，又会把不适用的 journal 语义混入合同。**Why it matters：** founder-terminal turn 和冷启动 seed turn 是明确要求覆盖的正常 busy 路径，不能因为 DTO 形状不完整退化成 protocol error。**Suggested fix：** 把 sidecar turn 也定义成判别联合：`origin:"message"` 必须携带 binding；`origin:"founder_terminal" | "unknown"` 必须省略 binding，或明确引入且只用于这两类的 `not_applicable` 状态。Bridge 严格 schema 与 §6 分支使用同一联合。新增 founder/unknown snapshot 经 socket 严格校验后仍返回 busy + 对应 undetermined reason 的端到端单测。**Classification：blocking。**

4. **Issue：新增 socket 方法的 wire envelope 与 feature gating 尚未对齐现有共享 `CodexLeadInboxServer`。** 计划写“请求必须恰好 `{method:"readTurnState"}`”并笼统写 `features` 加值（plan.md:141,149-150）。但现有所有 v2 request 都必须包含 `version:2`、`leadId`、`auth`，HMAC canonicalization 也覆盖 `version/method/leadId`（`CodexLeadInboxSocket.ts:64-69,612-636,956-1027`）；字面实现该请求会在认证前被 parser 拒绝。与此同时，TUI 与 headless 都实例化同一个 `CodexLeadInboxServer`（`codex-lead-tui-runtime.ts:1598-1630`；`codex-lead-runtime.ts:2048-2075`），feature 数组也在该共享类内生成。若无 conditional provider，§5.3 的“加 feature”会让 headless 也宣告能力，与 §5.2“headless 不宣告”冲突。**Why it matters：** 前者会让方法根本不可调用；后者会使 Bridge 对 headless 发起一个它无法兑现的请求，而不是稳定返回 `sidecar_lacks_turn_state`。**Suggested fix：** 明确新增 `ReadTurnStateRequest = {version:2, method:"readTurnState", leadId, auth}`，无额外业务字段；把它加入 request union、strict allowed-key parser、unsigned union、canonical HMAC 与 client helper。给 `CodexLeadInboxServerOptions` 增加可选的 `turnState` read provider，只有 provider 存在时才宣告 `turn_state_v1` 并接受该方法；TUI 传 tracker snapshot provider，headless 不传。测试必须同时断言 TUI feature+调用成功、headless 不含 feature，以及多余字段/错误 HMAC 被拒绝。**Classification：blocking。**

## Verdict

CHANGES REQUESTED

R1 的 attribution、privacy、reason/source 与验证门槛问题已基本关闭；批准前只需把以上 4 个边界钉死。最关键的是补上未知 glyph 不得扫描穿透旧 done 的规则，并把 Codex seed、snapshot union、socket envelope/conditional capability 写成实现者无需猜测的明确合同。

---

## Design Review — plan.md (Round 3)

Date: 2026-09-25  
Author: Codex  
Status: APPROVED

## Summary

draft v3 已关闭 Round 2 的 4 个 blocking 项，未发现这些修改引入新的 blocking regression。

Claude parser 现在先确定结构上的状态槽位，再解释状态文法；任何非白名单的更近第 0 列行都会停止扫描，因此未知 glyph、排队行和 prompt echo 都不能再被跳过以命中旧 done。`⏺ ` 的跳过规则有同版本、同机 14 个生产 pane 的只读实测依据，且其依赖已在 §11 明示。Codex seed 对 in-progress、terminal 和 empty thread 都有完整且受 revision fence 保护的状态转移；sidecar turn 与 socket request 都改成了严格判别合同；feature 也由 TUI-only provider 条件宣告，符合现有 TUI/headless 共用 `CodexLeadInboxServer` 的源码形状。

本轮仅复核 R2 的 4 项及其相邻契约。未重审已关闭的 attribution/privacy/route 设计，未运行测试、启动 Bridge，也未读取或修改 `~/.flywheel` 生产状态。

## What's Good (Keep)

- §4.1 的 upward walk 只跳过空行、缩进行和经实测确认的 `⏺ ` transcript/notice 行；第一条其它第 0 列行立即占槽。由此，`◆ …`、`› …`、`❯ …` 都会得到 `unrecognized_status_line`，旧完成行不再能越权授权 idle。
- 新增的阴性夹具准确覆盖 R2 反例，同时覆盖 `⏺ ` notice 可安全跨过、queued message 位于 spinner 上方时仍 busy 的当前生产形态。
- `readLatestTurn(): Promise<LatestTurn | null>` 明确定义了严格 whole-response validation、empty thread、四个允许的 status 以及其它输入抛错；`applySeed()` 对 in-progress、terminal、null 三类成功结果都置 `seeded=true`，畸形结果保持 unseeded。
- revision fence、实时事件优先级、disconnect 作废和 generation 隔离没有因新增 terminal/null 分支而退化。
- `SidecarTurn` 判别联合消除了非 message turn 的 binding 歧义：message 必须带 binding，founder/unknown 必须不带；Bridge 严格 schema 和端到端测试同时覆盖正反两面。
- `ReadTurnStateRequest` 已与现有 v2 wire envelope 对齐，并明确进入 request union、allowed-key parser、unsigned union、canonical HMAC 和 client helper。
- 可选 `turnState` provider 同时控制 feature 宣告和方法可用性：TUI 传入，headless 不传。该设计与两个 runtime 共用同一 `CodexLeadInboxServer` 的现有结构一致，不会让 headless 虚假宣告能力。
- 本轮改动没有扩张 issue attribution，也没有新增读取或返回 pane 原文、message body、journal payload 或原始 sidecar 回包的路径。

## Issues & Recommendations

1. **Issue：`readLatestTurn()` 的严格 parser 测试目前归在纯 tracker 测试描述中，测试归属不够准确。** §8.3 写了“畸形回包保持 unseeded”，但 `LeadTurnStateTracker.applySeed()` 接收的是已经解析完成的 `LatestTurn | null`；whole-response 的 `result.data`、0/1/>1 行、缺字段、未知 status 和 timeout 实际属于 `codex-lead-thread-rotation.ts` 的新函数边界。**Why it matters：** 不影响当前设计正确性，但如果只实现 tracker 单测，计划声称的严格 wire parser 可能没有被直接证明。**Suggested fix：** 在现有 `codex-lead-thread-rotation.test.ts` 增加 `readLatestTurn()` 的 table tests：`data:[]`、四种合法 status、两行、缺失/额外字段、未知 status、非法 `startedAt` 和 timeout；同时保留一条回归断言证明 `boundedTurnsList()` 的 terminal-only 行为未改变。runtime/tracker 测试继续负责“parser throw 后保持 unseeded”和 revision race。**Classification：advisory。**

## Verdict

APPROVED

Round 2 的四个 blocking 均已被明确、可实现且与现有源码形状一致的合同关闭。上述测试归属建议应在实现时纳入，但不阻塞计划批准。

