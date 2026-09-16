# FLY-2619 Raya 汇报合同 — 实施计划
Issue: FLY-2619 (https://linear.app/geoforge3d/issue/FLY-2619/raya汇报合同-文字模式不再每轮强制发言恢复-1846-63没内容可跳过-她可见面去统计头缺交名单roundid英文报错取消-6h)
日期: 2026-09-15
基于: research.md

状态：R3 有效 reviewVerdict=APPROVED（request e6df50c6-e482-4ba0-94b0-6ce36f3e2bba）。此文为实施合同，尚未实现或上线。

## 1. 交付与范围

E-1 / E-2 / E-4；以本任务 QA 的「有实质内容仍发一条」为负向约束。后台 summary_due、review、merge=已读、问题与 memory provenance 继续逐轮。所有自动轮报（包括纯数量、缺交、普通无变化、偏好确认、报错转贴）都不构成必须发言的理由。有内容指新的、可解释的业务事实/判断/对她有实际价值的变化；模型可选择沉默，不能仅因读了一个 PR 就拼一条消息。人工询问的正常回复保持原流程。

不做 E-3 thread 开关/命名/归档、E-5 要你答、语音合同修改、节奏重设、全局通知引擎、生产变更。Lead 在 question `c8fc90fd-c662-4a39-9f89-5ca338dcf6f1` 的正式答复已确认此范围：不得全面禁言；clock-caused reports 取消即覆盖六小时汇总；旧队列和 missing-report replay 必须覆盖。

## 2. 数据与唯一身份

保留 `summary-absorption:<UTC ISO>`、每轮 `lead_events` seq、frozen `summary_slot_settled`、原 report_line、每 PR merge/问询与 memory provenance。新建 StateStore 的小型 summary presentation 表和成员表（实现命名可保持下列名称）：

- `summary_presentation_groups`: `id`, canonical project/lead, contractVersion=2, createdAt, state=`collecting|ready|silent|sending|sent|ambiguous`, decisionReason, frozenText/hash, outboundKey, messageId/lastError。
- `summary_presentation_members`: `(project,lead,roundId)` UNIQUE，groupId，sourceSeq，businessState=`pending|complete|failed`，内部 outcome/证据引用。group 外键与成员校验同一事务。
- `summary_presentation_rounds`: `(project,lead,roundId)` UNIQUE，sourceSeq、slotStartMs、disposition=`eligible|claimed|historical_presented|historical_silent|needs_reconciliation`、sourceDigest/evidenceRef。它是唯一准入索引，不从 ACK 或“没有 member”推导待处理。
- `summary_presentation_migration`: canonical project/lead、contractVersion、migrationBoundarySeq、sourceDigests、cursor、state=`building|complete`。首次 begin 必须等待 complete。
- 组 ID = 首次 claim 时生成并持久化的 UUID，不是时间桶，也不是可变成员列表 hash；发送键固定 `summary-presentation:<groupId>`，不得按 roundId 或重试次数变键。
- 数据库迁移只新增表/索引；SQL 全参数化。旧轮次与历史 report.txt/JSONL 不改写。新增状态是呈现索引，不能取代 canonical merge / memory 事实。

组成员一经冻结不可加减；新到的轮次属于下一次处理。显示名与内部身份分离。后台仍能从任何 roundId 找到自己的业务结果及 group；静默必须有 reason 和逐轮完成记录，但不得造 `report sent`。

## 3. 一次处理与恢复

### 3.1 机制结算与模型消费分开

rider 一次 pass 先计算所有可结算候选，按 slotStartMs 升序在一个本地事务内追加原逐轮事件和 `disposition=eligible` 的准入行，提交全部后才 enqueue。已有 frozen event 去重语义不变；不能在两轮之间先 enqueue 第一轮，让 begin 抢到半个 pass。崩溃后从原 journal 重投运输；事务提交前 begin 看不到半份 eligible 集合。新旧 renderer 仍分别投原 event，原逐条 ACK 不合并。

begin 先要求 §5.4 迁移 complete，再读取当前 active 组：collecting 继续补业务，ready/sending 查冻结出站。**active-group 唯一约束只覆盖 collecting/ready/sending；ambiguous 不占 active 名额**，它是独立待对账项，不由 begin 返回，不阻止下一组领取新的 eligible 轮次。并发 begin 通过 StateStore 事务和上述每 canonical identity 的 active-group 唯一约束返回同一组。没有 active group 才在事务中取该身份准入行的最大 sourceSeq 作为 `groupClaimSeq`，claim 所有满足下列条件的行：

```sql
SELECT roundId, sourceSeq, slotStartMs
FROM summary_presentation_rounds
WHERE project = ? AND lead = ?
  AND disposition = 'eligible' AND sourceSeq <= ?
ORDER BY slotStartMs ASC, sourceSeq ASC;
```

查询还必须 JOIN 原 lead_events 校验 `event_type='summary_absorption_round'`、lead_id 和 payload 中 project_name 与已解析 canonical identity 相符；SQL 参数化，非法 JSON 进入内部隔离诊断，不准入。`eligible` 只能由 rider 的提交事务或 §5.4 的已核对恢复准入产生；不能由任意模型自报 roundId 创建。claim 在同一事务将这些行改为 claimed、插入 members、冻结 groupClaimSeq。由此同组包含同 pass 两轮及已经存在的积压，跨 mailbox batch 也不拆组。

**32 仅为业务读取页大小，不是组成员数上限。** 冻结 groupClaimSeq 确定这次处理的集合；它是“当时已经入账”的边界，不是轮次时间上界。所有 sourceSeq<=groupClaimSeq 的 eligible 行一次认领，不使用 LIMIT 32 截断组；读取按 `(slotStartMs,sourceSeq)` 游标分页。禁止 CHECK(count<=32)、禁止按页 finalize。组冻结后新入账轮次属于下一次处理。组内按真实 slot 时间从旧到新处理，不能将 sourceSeq 误当轮次时间。

### 3.2 业务完成与呈现完成

Raya 逐轮执行旧 review/merge/问询/memory 流程，记录每轮结果。`record` 校验 round 属于组及 evidence 引用格式；业务有失败也记明失败，不把未完成误记空轮。全部成员有完成/失败结果后 `finalize(groupId, decision)` 才可执行；缺成员返回 `{result:"incomplete", groupState:"collecting"}`，不改变持久状态、零 Discord 调用。

decision 为 silent 或 substantive。silent 写终态 silent、理由及逐轮映射，无发送。substantive 提交一份短中文正文和来源引用；服务端校验后冻结正文 hash、目标和出站键，ready→sending→sent，成功必须带真实 messageId。不能用 reviewed/merged 个数机械推 substantive。实质判断由 Raya 完成；机制保证同组只有一个决定和一份正文。

finalize 重放：silent/sent 返回原状态；同组不同正文或决定冲突拒绝；sending 使用原出站；ambiguous 保留未知，发脱敏机制告警并查原真实回执，不按「补记」重发，同时释放 active 名额。原 members 保持 claimed、原 outbox key/in_flight marker 保留，不能重新加入下一组。受管对账若取得与原 key/nonce/目标绑定的真实 messageId，可用带 operator/reason/evidenceRef/时间的幂等 reconcile 操作将该组从 ambiguous 置 sent；没有确证则保持待核对，仍允许后续组工作。本单不提供“证明没发就换键重发”的新通路，也不把经过一段时间等同于没发。发送成功而业务 ledger 追加失败，只恢复关联记录；已经发送不重新发送。领取成功后崩溃、成员只完成一半、正文冻结后崩溃、发送后回执写入前断开，各有恢复测试。

### 3.3 卡住的组不能无声地挡住未来

沿已有 GatePoller 检查 collecting 组的 lastProgressAt；超过创建时冻结的两个 cadence 周期无业务进展，只发一次脱敏机制告警（§4），不自动 silent，不伪造完成。record 失败响应带可记录的内部 failureRef；合法成员可用业务 failed + 该 failureRef 完成记录，不要求再次提交那份永远不通过的证据格式。需要人工恢复时，现有受管支持操作可补记逐成员失败/结果、原因、操作者、时间与原组 ID；全部成员有明确处置后再由正常 finalize 作决定。修复原组后后续 eligible 轮次正常 begin。支持操作不得重置 sent/sending/ambiguous 的发送键、outbox 状态或删除成员；仅允许上述凭真实回执的 ambiguous→sent 对账，禁止解除 in_flight 后重发。超时本身不授权发送或丢弃工作。同一 tick 对长期 sending/ambiguous 和 migration building 记录无进展信号，告警按组/迁移身份去重，不以告警自动制造完成。sending 只按真实发送器返回的 ambiguous/可核对超时结果进入待对账，不靠模型猜测变更。该恢复 seam 与告警测试属于 B/M 块，不新造定时器或提醒服务。

## 4. 发送与呈现边界

新增有明确 schema 的 `summary_presentation` 工具（begin/record/finalize/status），放在标准 lead-actions 中，Bridge 端新 summary presentation route/controller 校验现有认证 + canonical project/lead + registry 收件身份。这里的身份校验是请求与 registry 的完整性校验，**不是调用方的 per-Lead 鉴权**：继承现有共享 bearer token，持有该 token 的其他进程仍可声明 Raya 身份；本单不声称修复 FLY-246 的平台鉴权边界。模型只能引用 groupId、提交自己的内容判断，不能选 raw channel 或自定发送键。controller 使用现有 `CodexLeadOutboundHandler` / durable dedup 路径发送；不重新实现 Discord POST。实现复用应抽共享调用 seam，不经 loopback 假装外部权限。

该功能只管理 canonical Raya 的 summary 业务。事件投影明确「不要以 discord_send 或 assistant final 另发轮报；用 summary_presentation 完成」。不增加含糊的“presentation 标记”字段：新工具的专用 controller 才能从组记录构造 `summary-presentation:<groupId>` 内部发送键；通用模型 `discord_send` 入口针对 canonical Raya 拒绝 `summary-absorption:<ISO>:report` 旧键及保留的 `summary-presentation:` 键（含统一 lead-action 前缀后的等价形式），controller 经内部 seam 调用原发送器。这条旧键拒绝仅是纵深防御：只读取证 `raya-lead-workspace/state/summary-merge-receipts.jsonl` 三个 report_attempt（2026-09-16 00:11/00:14/00:34Z）确实记录了该 eventId 形状，但 attempt 不能证明最终 discord_send 采用了它，更不证明全部旧轮报都有此键。未带 eventId 时平台会分配 UUID；不能声称这条拒绝规则覆盖这些发送。真正的业务迁移控制在新版 persona/旧队列投影/恢复合同及专用工具，需真实消费链 QA 证明；其他 eventId 的自由文本只受既有约束；普通人工回复、Lead 问询与 voice 不受影响。**这不声称能从任意自由文本机械识别所有伪装轮报**：无标记模型误调用是集成 QA 要检出的违反合同；本单不建立全能力防恶意模型沙箱。若真机仍从泛用 send/final 产生第二条，验收失败，必须补齐实际调用入口，不能只交 prompt 单测。

最终 formatter 只接受正文与可展示的事实链接，不接受整个 SummaryRoundResult / Error 对象。roundId、groupId、统计头、缺交名单、队列计数、原始报错只写后台。已有状态映射转为简短中文影响说明，仅当有实际业务意义才候选展示；未知错误统一记录内部诊断，不能 fallback 为 `${error}` 给她看。防回归校验拒绝已知 roundId、N/M 份已交、stack/错误原文（用提交的诊断指纹比对）；禁止把黑名单正则当作完整语义保证。未知英文术语不是一律删除；具体 raw error 必须与内部诊断分离。长正文应在发前压缩到单条平台限额以内，不能靠自动分片满足「一次」；超限退回内部修订，不能静默截掉关键事实。

**fleet alert 也是 founder 可见面，不是后台。** `summary-absorption-rider.ts:349–362` 的 alertFailure → `LeadAlertNotifier` → `UnifiedAlertConfig`/统一 Discord 告警频道必须纳入本单。原 `report_line`、producer 缺交名单、slot/roundId、原始异常先落内部日志/DB 的诊断记录；面向 Discord 的 title/body 只用固定中文故障类别、简短业务影响及可供工程查证的非轮次诊断引用，不再拼接原字段。例：“进展收集出现送达问题，工程侧正在处理。”若需要引用，用独立 opaque diagnosticRef，不能把 roundId 改名后继续显示。修复既有持久 alert 的 replay 投影；已发布历史消息不追溯删改，但未送出的旧告警必须经过同一 formatter。通用告警器会显示的 eventId/footer 也须检查，内部去重身份保留，不能自动显示内部键。故障仍送到原机制告警渠道，不全面关告警。只处理本 summary 业务的告警，其他系统事件不重设计。

HTML/报告模板所有外来值必须 HTML escape；DOM 用 textContent/value。Discord 保留现有 allowed_mentions 限制。

## 5. 旧合同迁移及消费者覆盖

1. rider 新事件明确 contractVersion=2、后台用途，无强制发言/逐字复制；冻结统计保留。
2. 三个事件 renderer 共用一个纯 summary 投影 helper：旧版本与无版本事件按新版呈现规则渲染，不直接转发旧 notification_context 中的发言命令。内部诊断完整作为后台数据；不覆盖原 journal 字节或身份。不只改新事件而放任已排队旧指令。
3. 对 Raya 实际加载 persona/rules 做来源清单（路径、源码仓/commit、部署/加载 hash）。旧 `IDENTITY.md` 的 visible reporting 与 missing-report recovery 替换为新组状态协议，源代码改动必须在独立 Raya 源码 checkout/feature branch 做配套提交；绝不编辑 `~/.flywheel/raya/`。若当前已迁入 FLY-2447 受管业务模块，修改其真实源文件并记录映射，不凭旧绝对路径改 dist。配套源提交与 Flywheel 提交构成同一激活清单；不能省略后宣称已生效。
4. **历史回填是强制实施块 M，先于首次 begin**。StateStore schema 安装不等于业务迁移完成。受管迁移程序在独立 updater 激活事务边界记录 canonical identity 与 `migrationBoundarySeq`（当时该身份 summary journal 最大 seq），写 migration=building；新 begin 返回 migration_required、零认领/发送。之后由受管 migration adapter 读取当时实际业务 workspace 的旧 JSONL/出站回执和 journal，记录输入路径及 digest，按 sourceSeq 游标分批写准入索引。不得把全体“无 member”当 eligible，更不能把 delivered_at/acked_at 当业务完成。
   - 对每一个 seq<=migrationBoundarySeq 的历史 round 必须有 disposition：真实 messageId 与绑定的 durable sent 回执相符 → historical_presented；明确旧业务完成且明确选择静默 → historical_silent；只有 attempt、缺失/损坏 ledger、来源不对应或业务状态不明 → needs_reconciliation。这些行都是迁移分类的完成结果，均不进普通 begin；未知不是业务完成或送达成功。
   - 只有从旧业务材料能明确证明“尚未处理且无发送尝试”的历史积压才写 eligible，保留校验后的 evidenceRef；所有此类积压跟新 eligible 一起组成一个恢复组，而非每历史轮一条。无法证明的保持 needs_reconciliation。后续核对可以将其单独显式释放为 eligible（留 operator/reason/证据），不能改成 sent 冒充回执。
   - sourceSeq<=migrationBoundarySeq 每条都已分类、无缺洞、digest 未变后，单一事务置 migration=complete；若输入变化则重新核对未确认分类，不能跳 cursor。迁移失败可从 cursor 重启，UPSERT 相同身份/相同 digest 幂等，不覆盖已有 finalized 组。seq>migrationBoundarySeq 的新事件由 rider 新事务写 eligible，等待 migration complete 后才被 begin 领取。
   - needs_reconciliation 独立列为待核对工作并发一条脱敏机制告警；不加入 collecting，不阻塞新实质消息。已存在旧 report.txt 和旧 JSONL 均保留原样。启动恢复从准入索引和 group 结果读取，禁止再以“无 report 行”为补发授权。首次 begin + 百条历史/不明回执/三条新轮次的混合 fixture 是 M 块必测，不能降成可选人工步骤。
5. 新工具消费者必须同步：`lead-actions/{lead-actions-main,mcp-config}.ts` 的工具注册、LEAD_ACTIONS_TOOLS exact allowlist、assertFullAccessLeadActionsConfigGate、`bin/render-lead-actions-config.ts` 与 `scripts/codex-lead-tui-home.sh` 配置再生成路径；无业务权限的 Lead 调用新工具由 controller 拒绝，但不破坏已有 enabled_tools 契约。
6. `summary-inflow.md` 改缺交可见性措辞；原 ACK、migration-proof、runtime render 测试同步更新。保留正常人工回复和全部非 Raya Lead 行为；不改通用鉴权/alias 语义。

## 6. 实施顺序与测试证据

每一块均先红测试，再最小实现，再重构；本设计阶段不写实现代码。

| 块 | 改动 | 必测 |
|---|---|---|
| A | rider + 统一投影 + 旧合同测试更新 | 连续三空轮均有 frozen/round，无自动发言义务；旧 payload 重放无旧强制指令；due/absent/unknown 不变 |
| M（A/B 表结构后，任何 begin 启用前） | 强制历史迁移、准入索引与迁移完成栅栏 | 百条历史有/无真实回执 + 已知未处理 + 新轮次混合；无回填拒绝 begin；回填中断/重复/源变化；未知历史不阻塞新单轮消息；ACK 不当完成 |
| B | StateStore 表、controller、组事务、卡住组恢复 | 两轮原 seq 倒序仍按 slot 升序；pass 半提交不准入；跨 batch/重启同组；并发 begin；65 条按 32 页大小只一组；incomplete 不变 sending；超龄脱敏告警一次、补 failed 后继续；一次真实 sender throw→ambiguous 后新组 substantive 仍发一条，旧组不重发；迟到真实回执仅结清旧组；重复 finalize、冲突正文、错声明身份拒绝 |
| C | tool + founder/summary fleet-alert formatter + durable sender seam | silent=0；substantive=1；两轮正文只一条；roundId、N/M、缺交、英文错误在测试 chat + alert 双频道均不泄漏；旧 alert 重放也过 formatter；保留故障可定位；超长不分片；发送未知不盲重发 |
| D | 受管 persona 源码与恢复合同 | 空轮不补报、成功回执丢失不重复、旧 queued prompt 不回退；summary 问 Lead、merge 守卫与 voice/reactive 回归 |
| E | 隔离真实链路与 CI | 下述矩阵和精确 head CI 全绿 |

建议单测集合：`pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/summary-absorption-rider.test.ts src/__tests__/summary-due-render.test.ts`，加新 presentation store/controller/formatter/integration 测试、protocol-ingress ACK 和现有 Codex outbound suites、`lead-actions/__tests__/{mcp-config,runner-mcp-config}.test.ts` 的 exact allowlist/config gate 测试；`pnpm --filter flywheel-teamlead typecheck`。实际受管源配套仓也须对应 head 测试。PR CI 必须与最终 Flywheel head 相同，不能拿旧绿结果。

真机 QA 使用 529 隔离副本、测试 bot/频道、独立 workspace/state/DB；启动前核对身份、chat 与统一 alert 测试频道都非生产频道，目标频道非真实 #raya、禁止生产路径，测试后 teardown。跑真实标准 Raya Lead + 真实 Bridge 出站，不用手工调用纯函数代替消费链：

- 连续三轮无实质内容：给出三 roundId 对应后台业务完整记录与三个 silent/组关联，观察窗口内 founder 测试频道新增 0。
- 两轮积压（有实质内容）：在消费前准备两轮，跨 transport batch 也测；后台 2，group 1，真实 Discord messageId 1，全文无污染。
- 两轮全空：后台 2、消息 0（不为 E-4 人为造一条空消息）。
- 单轮实质内容：真实消息 1，证明不是全面禁言；人工对话仍正常。
- 六小时定时：注入可控时钟或测试 cadence 驱动相同真实调度调用链，记录 due/settlement 发生，自动主频道汇总 0。若只缩短 cadence，要另有默认 6h 配置接线断言，不声称真实等待了 6 小时。
- 注入 undelivered + 缺交、内部 ID、英文 merge/push error，并重放旧未发告警：同时读取测试 chat 与统一 alert 频道的完整消息（含标题、embed/footer），两侧均无污染；原始细节可由内部诊断引用定位；正常机制告警仍到达。
- 预置百条历史（已发、静默、未知、未处理）后执行 M；未知不卷入 collecting，三条新空轮仍完成，一条新实质仍送出；中断迁移重启结果相同。
- 重启/两次 finalize/发送回执缺失：不连发；unknown 明示内部状态。让真实发送 seam 抛错使旧组 ambiguous，随后注入新实质轮：新组能发送一次，旧 members 不重入、旧 key 不重发；晚到真实回执只结清旧组。同时断言 active 唯一索引的谓词不含 ambiguous。

证据绑定 Flywheel/Raya 源码 heads、实际加载合同 hash、隔离身份、每轮及组状态、消息 ID/原文、时间窗和 teardown。当前没有这些验收结果，不能声称可用。

## 7. 发布、回滚与后续

合入≠生效。合入前及部署/重启前，旧合同仍生效；独立 updater 班车或 founder 授权的紧急票完成受管部署与重启，核对两仓版本/加载合同后才可报告新规则激活。本节点不申请 ship、不部署、不重启。

迁移增加的后台表保留；回滚二进制不删账本/组/出站回执、不更换已发送键。降回旧合同会重新带来轮报噪声，必须在回滚说明中诚实注明，不能一边退回旧版一边称已经静默。混合版本不算激活成功。

后续单：E-3 thread 生命周期、E-5 要你答、上游更完整的文字/耳机分层另行收敛。本单不得预置 thread 新建/自动归档作为隐藏依赖。

非阻塞 Follow-up（R3 LOW `ready-state-no-liveness-signal`）：由 Lead 选择实施时补齐 ready 无进展告警及“尚无出站尝试时按已冻结正文/键继续”的明确说明。现有正文冻结后崩溃恢复测试仍必做；该建议不改变本轮有效 APPROVED。
