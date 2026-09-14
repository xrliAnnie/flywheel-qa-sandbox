# FLY-2399 自动审批判断与学习 — 实施记录
Issue: FLY-2399 (https://linear.app/geoforge3d/issue/FLY-2399)
日期: 2026-09-10
基于: plan.md

## 投递可见时间的批准补充

Lead 于 2026-09-11 UTC 在问题 `4388ee31-b720-43d3-bc33-cced30d51bec` 的答复中裁定：采用既有 `workflow_run_event` 的新非权威种类 `ship_judgment_visible` 保存只追加投递回执，不增加第九张表，不增加可变历史列，不修改批准写路径或已钉住的 plan.md。

原因：单个 delivery 行的 posted_id/visible_at 会被后续 PATCH 覆盖，无法重建较早 founder 决定之前真正可见的意见。回执在投递确认 CAS 的同一事务内，通过 StateStore 既有事件追加器写入；event_uid 由 run_id、opinion_id、message_id 确定性生成，重复确认不产生新事件。payload 保存原 receipt_time 和 observed_at。增长受每卡意见及 PATCH 频率上限约束，沿用既有事件归档与保留机制。

该种类只供审计和历史对照，不能被引擎消费为转移或批准。新增调度器负向测试向真实运行追加该事件（包括诱导性的 approved 字段），确认节点和启动请求不变。后续 §7.2 对照查询选择决定时点之前的可见回执；同毫秒记录仍按原计划归为时序不足，不计前瞻成绩。对照查询尚待实现，不能把本回执存储测试当作整个学习闭环完成。

当前投递持久层已包含领取代次、回执 CAS、退避、POST/PATCH 时间槽以及两次同边界空扫描恢复。sender 已接入 Bridge 扫描后投递和停止信号；模式切换历史标记、决定配对和澄清仍未交付。

发送准入使用 delivery 的两个 nullable 派生当前状态列 validated_presentation_digest / validated_at；旧库迁移可重放。它们只表示最近一次相同展示摘要重验证是否仍在 60 秒内，不保存或重建历史，不能供前瞻成绩使用。发现不同候选时即清空，即使候选正在限频等待。原 opinion 检查时间不变；只有实际可见回执进入上述只追加事件。

消息渲染从已保存意见读取三点、引用、机械检查范围和原时刻，明确 dry_run 与仍由 founder 批准。引用逐字符转义并按转义后的 UTF-16 长度限额，覆盖提及、Markdown 与 Unicode 膨胀的边界；不把旧三闸统计当新语义得分。旧统计取自原 delivery 指向的快照，以单行有界查询读取。

Discord 适配一次只发一条消息，无内部重试，持久 sender 预留请求槽并设置 10 秒总超时。POST/PATCH 响应必须匹配名册 bot、线程、消息及完整内容；PATCH 要求 edited_timestamp，不能回用创建时间。偏移时间统一为 UTC 后保存；429 使用 retry_after。恢复扫描以本卡最早意见为下界，最多 4 页、每页 100 条及 512KiB，并校验名册 bot、完整 marker、意见 ID、分页顺序和唯一匹配；未穷尽不推断不存在。Bridge 集成测试使用模拟 HTTP 走通不可判定意见到可见事件，不代表真实 Discord 或 QA 验收。

旧 gate 的 dry_run 入口现为 capture-only：沿用同一 snapshot 捕获、比较及旧统计，不创建普通旧 delivery intent。auto 显式恢复 intent；同一快照也能重建，冻结字段清空与代次撤销在 intent 事务内完成。新消息的旧统计附栏读取最新旧 snapshot，不依赖已经冻结的旧消息指针。

旧 sender 在 dry_run 每批最多处理 20 个冻结请求，仅编辑自己保存的 followup_message_id。未确认 POST 先按原扫描协议恢复；新增 expectedGeneration 校验防止旧扫描回执穿过恢复 auto 的事务。没有实际消息且没有在途 POST 的 intent 直接记冻结完成，不发送空历史消息。成功历史 PATCH 后保存 frozen_at；后续 tick 无重复 PATCH。冻结中的不确定 POST 不因旧重试上限被误标 gone，正常 auto 的原重试上限不变。Bridge 启动撤销已有冻结完成记录的代次并保留冻结请求，off 不写消息，恢复 dry_run 后重做自己的历史标记。

新 delivery 增加 delivery_mode / mode_label 两个当前状态列，仍为八张表；这些字段不是历史回执来源。模式变更撤销租约代次、清空当前重验证，保留已发 message_id 和未知 POST 状态。独立三秒模式循环每次至多两个网络尝试，并由 Bridge stop 取消及等待；off/auto 只恢复未知 POST 或 PATCH 自己的历史标记，不 POST 新意见。历史 PATCH 共用每卡六次/小时预留，租约/退避期间不占用扫描批次；持卡 bot 无法解析时持久记错并退避。回到 dry_run 后重新采集验证，再更新同一消息。模拟 HTTP 覆盖上述往返和可见事件；完整双 sender 实机往返、学习闭环及最终 QA 仍未完成。

`outcomes.ts` 是本次唯一新增的 B2 只读消费者，边界测试允许的精确路径总数为六，原禁止组件断言保留。每批至多读 50 条尚未投影的 Flywheel verdict，核对 B2 标记和源捕获身份；gate_response 核 actor/captured founder/source ID，founder_message 另核原卡、问题、HEAD 和消息/验证时间。自动与代理单独归因，未知身份不进入人工成绩。只追加 outcome，不写原 verdict、holder 或批准状态；源 ID 幂等。

目标摘要从决定之前最新意见引用的冻结 input 重建，核原卡、B2 主仓目标、完整仓库集合、声明 revision 及决定前的重新绑定。新增仓库/HEAD 漂移或缺材料保留 unresolved 摘要，不冒称同一目标。该 observer 尚未接入 Bridge：取消来源、可见意见时序、历史刷新状态、澄清与统计仍需完成。当前单元测试使用真实表和合成 B2 事实证明归因、目标漂移、只追加与不改批准，不替代真实 source writer 到学习闭环的端到端证明。

学习配对现从新 outcome 与只追加可见回执读取：同卡、run、完整 targets_digest，取决定之前最近可见的意见，核意见/评估创建时间均严格早于决定。保留 created_at、visible_at、decided_at 和 read_gap_ms；同毫秒、late、未知作者、目标漂移、待刷新、历史不明及同卡后续改判分别排除。4×3 动作关系表只表示动作一致或分歧，不表示质量正确，也不证明 founder 看过消息。

delivery 的 nullable presentation_state_changed_at 是当前状态时钟：意见候选改变/清空、可见确认和模式变化时更新；无展示变化的常规重验不更新。observer 若确认状态在决定前已稳定，可保存 clear/pending/inactive；决定后的变化或旧库缺时钟保留 unknown，不用当前清洁状态回填历史。该字段不是历史回执替代品，旧库迁移默认 NULL；真实可见时刻仍仅来自批准使用的追加事件。取消观察、澄清、统计、运行循环接入与端到端证明尚待完成。

澄清持久层新增 `clarifications.ts`：只从学习配对读取有效分歧，在 dry_run 下按 `sha256([question, opinion_id, outcome_id])` 创建唯一根与原冻结线程/卡的发送 intent；同事务失败全部回滚。尚无网络发送，不声称已向 founder 提问。

答复入口只接线程/消息 ref，通过注入的服务端 fetch 重新读取原文；10 秒总截止与外部取消均不落迟到结果。核 canonical founder 在 fetch 前后不变、原作者、线程、消息 ID、显式 reply 指向已持久绑定的澄清消息、消息与编辑时间。回复原 ship 卡或第三条消息均不消费。答复和 ack intent 原子追加，原文及重新核验的编辑版本分别保留，稳定源与版本幂等；仅记录解释，不改变 holder。该 fetch 尚未接入生产适配器，ack 尚未实际发送；完整原卡 approve/rework 路由及 B2 端到端负向验收仍待做。

取消来源只读调查发现 `closeout_report` 的 canceled 状态没有原消息身份，技术 terminated/supersession 不等于 founder 取消。已通过非阻塞问题 `773e675b-01cc-42db-b576-cdd222def014` 向 Lead 请求现有可信 writer/source 的精确位置；没有证据时不猜人工归因，继续独立工作。

本批 TDD：先确认缺澄清模块失败，再确认缺 observe 行为失败，最小实现后 3 个聚焦文件 43 用例通过；TeamLead `tsc --noEmit` 通过。覆盖 root/ack 事务回滚、模式、排除配对、错误引用/身份/时间、网络失败、取消及编辑幂等。测试用真实内存表和模拟 fetch，不是 Discord 实机证据。尚未运行全仓门禁、最终 review 或创建 PR；T1–T6 整组完成仍未声明。

## 取消来源的 Lead 裁定与运行接入

问题 `773e675b-01cc-42db-b576-cdd222def014` 已答复：founder 取消正门是 Linear Canceled，不存在要求核验的原始聊天消息。允许只读组合 `linear_state_observations` 的 canceled / terminal_authorized 观测、`bridge.lifecycle-closeout` 写出的 `closeout_report` canceled 事件、同 issue 的原 run 映射，三者缺一保留 unknown；不得改任何 writer。此为实施补充，已钉住的 plan.md 未改。

`outcomes.ts` 每批最多投影 50 个现有 closeout/card 来源，保存事件 ID、原 Linear 观测和归因版本。按既有 run alias 映射核 rootKey 与 issue，Linear 更新时间、观测时间须不晚于 closeout，run/card 必须在取消前存在；未授权、已重开、缺观测、错误 root 或多个历史 run 无法唯一映射时仅 unknown。没有明确 canceled closeout 的技术终态不生成取消 outcome。未知归因使用 closeout 时刻；有效归因使用 Linear 更新时间，并独立核冻结目标及可见配对。无 B2 FK，不写原 holder、verdict、Linear 观测或 closeout。

Bridge 已有三秒周期现在通过 StateStore 的窄 getter 调用 B2 和取消只读 observer，沿用单次在途及 stop 生命周期；每种来源最多 50 条。off/auto 继续补记历史实际决定，不创建新判断或澄清问题。只读对照消费者边界仍为原五项加 outcomes.ts，共六项。

本批验证：取消基础与运行接入均先确认行为缺失的失败；多 run 夹具先修正真实 active-run 唯一约束，再确认旧实现错误给 founder_verified 的红测，补歧义保护后转绿。4 个聚焦文件 54 用例、TeamLead `tsc --noEmit` 和 diff whitespace 检查通过。fixture 使用真实表与合成现有 writer 事件，不能代替生产观测或实机 QA。澄清/ack 发送、配对调度、原卡路由端到端、历史页与全仓门禁仍未完成。

学习调度已接入同一运行周期：B2 与取消 observer 分别捕获错误，任一失败不会跳过另一来源或模式历史处理。澄清 sweep 另有独立错误标记；仅 dry_run 读取只追加 outcome 的本地行序，每批最多 50 条，调用既有严格配对及根问题幂等逻辑。根/intent 与游标在同一事务提交，失败不跳过该批；off/auto 不消费游标。只追加、禁止删除的 outcome 本地行序仅作进度，不作外部来源 ID 或成绩证据。

既有第八表 project_state 增加 `learning_cursor` 非负整数派生进度，默认 0；不新增表。迁移重放和真实关闭/重开保留游标，批次测试覆盖 51 条未知结果继续推进、VACUUM 后续扫、新记录在 off 等待再恢复；未知结果不创建根。运行测试证明已配对分歧从实际 modeTick 产生澄清 intent，原 root/intent 故障可回滚整批。4 个聚焦文件 32 用例、TeamLead 类型检查及 diff 检查通过。澄清/ack 网络发送、认证消息分流、历史统计、取消重复 closeout episode 去重审计及最终全仓门禁仍待完成；这里没有真实发问或 founder 回答证据。

澄清/ack 投递持久层 `learning-delivery.ts` 使用既有 delivery 表的 purpose/subject 复合键，问题与收据均为独立不可变消息，不 PATCH 判断或旧 auto 消息。每次领取递增 generation、30 秒租约；确认仅接受当前租约和目标 ID，响应丢失保留 uncertain，过期原回执不覆盖后来领取。每个 intent 的 POST 请求槽在领取事务内预留，含失败最多两次/小时；失败按 1/2/4/8/16 分钟后每小时退避，接受更晚 retry-after。

未知 POST 只能先扫描。两次同 frontier 空结果至少间隔 30 秒后恢复 pending；frontier 变化重新计时，off 可恢复未知发送但不新发澄清，重回 dry_run 后仍受已预留请求槽约束。学习答复测试现在通过这条正式确认路径绑定澄清消息，去掉直接 UPDATE 的模拟回执。TDD 先确认缺模块与 emptyScan 的失败，后 2 个聚焦文件 24 用例及 TeamLead 类型检查通过。当前仅持久状态机完成；尚需有界工作查询、渲染、认证网络发送/扫描、403/归档不可用处置与路由接入，未发送真实 Discord 消息。

澄清发送取件每次最多 20 条，过滤未到期租约、退避、终态与 mode；off 只保留 ack 和未知 POST 恢复。POST 限频后持久写入最早请求槽释放时间，避免每轮重新取到同一条。测试暴露到期重试排在所有新任务之后的饥饿问题，已改为到期重试优先。不可用确认同样要求当前租约，保存 unavailable 与具体错误，之后旧回执不得将其改成已发；这只是持久层，网络 403/归档识别仍待接入。

`learning-render.ts` 生成独立澄清与 ack 正文及明确 replyTo：澄清链接原机器意见、原决定（无单独决定消息则原审批卡），cannot/approved 问条件变化还是判断遗漏，取消问方向/优先级变化。ack 原文为「已记录，未改变批准」，批准/打回指回原卡。只渲染固定文字和校验后的 snowflake/hash，不重发自由回复原文，不添加批准按钮。3 个聚焦文件 28 用例和 TeamLead 类型检查通过，类型检查原进程等待后正常完成，未重启。尚未从账本组装 renderer 参数或接入网络 sender/scanner，不能声称已可发送或已完成 founder 路由验收。

投递正文现可从账本组装：在同一只读事务中按 clarification/ack 的 root/reply、冻结 input 和绑定 delivery 取原问题/线程/卡；澄清读取决定前该意见的可见事件作为机器链接，不从当前 holder 重建。原决定有同线程已捕获消息 ID 时使用它，否则原审批卡；ack 只用已核验 reply_source_id 的原线程/消息，并保留 verified_at 作为扫描下界。缺字段、错线程或不合法引用返回不可用视图。换卡测试证明历史链接不漂移，ack 不带原答复全文。

认证扫描器抽出共享实现，新增 typed clarification/ack 入口，沿用 bot 身份、线程、分页边界、字节预算、唯一匹配与可见时间核验；学习消息 subject 仅接受 64 位小写 hex，意见入口保持既有格式。测试确认三种标记不互认。先确认缺 view/新扫描入口的红测，再聚焦验证；本批 4 个相关文件共 32 个独立用例通过（分批运行），最终 TeamLead 类型检查及 diff 检查通过。实际网络 sender、归档/403 识别、Bridge 发送和解释路由尚未完成，未发送真实消息。

`learning-transport.ts` 新增发送适配：先认证 GET 原 thread，核 guild/thread/type 和 archived/locked，再复用现有单次 POST 的自动化标记、禁提及、reply reference 与真实响应校验。已知归档/锁定、身份不符、403/404 返回具体 unavailable；不发 unarchive 或 channel mutation。预检与 POST 不是 Discord 原子操作，因此这里只证明发送前检查已知归档状态，不声称外部并发归档不可能发生。

预检网络失败明确 failed（还没发消息）；POST 失去响应保留 uncertain。两阶段 429 都保留有限有效 retry-after，无内部重试。caller 必须提供有界取消信号；下一步 sender 将统一包裹整轮 10 秒截止、持久结果与 shutdown。先确认缺适配器红测，后新适配 9 例与原传输 3 例共 12 例、TeamLead 类型检查及 diff 检查通过。全部是模拟 HTTP；尚未接 Bridge 发送循环、真实 founder 回复路由或实机 QA。

`learning-sender.ts` 将一次网络发送/恢复与正式 LearningDelivery 串联：领取后读取冻结正文，整轮 POST（含预检）或 scan 共用 10 秒 deadline 与外部 stop AbortSignal；Promise.race 保证不合作的网络挂起不拖住停止，迟到结果不再触碰持久回执。unknown/失败/空扫描/unavailable 分别进入既有状态机；scan 必须命中该 claim 的准确 subjectId 才确认，不能因 marker 类似绑定别的问题。正文缺失保留 unavailable。

sender 测试使用真实内存 delivery 状态机，只隔离已单独验证的正文读取和网络回调；覆盖响应丢失后只扫描恢复、错误 subject 拒绝、停止后迟到响应、假时钟 10 秒截止、归档不可用。3 个聚焦文件 15 个独立用例通过，类型检查先暴露 Promise 回执联合推断错误，补显式联合后最终 sender 4 例及 TeamLead 类型检查通过；diff 检查通过。Bridge 尚未调用该 sender；下一步添加有界批次与配置/owner 路由，再接真实解释 observer。没有实机消息或原卡 B2 路由验收。

Bridge 发送循环已接入：StateStore 暴露 LearningDelivery 窄 getter，plugin 注入现有 discordGuildId，factory 通过原 question/run 的持卡 Lead 名册解析 bot。每轮读取最多 20 个工作项、实际 sender 尝试最多两个，使用冻结 claim 的线程；缺 owner/guild 持久退避一小时，不反复占队列首部。POST 预检后再次核验原 bot/token 和模式（ack 可补发，澄清必须仍 dry_run），防止预检期间切换后的新 POST。

learningSweep 沿用 runtime 的单在途与 stop 信号，独立报错后继续模式历史处理。回归测试暴露未配置学习 callback 时额外 await 改变旧模式循环同步时序，已保留旧时序；模式与学习两种在途 sweep 均验证 stop 等待且不重叠。真实 factory + delivery 状态机 + 模拟 HTTP 证明两条/轮、下一轮续发、原 bot token、缺 bot 零请求并持久退避；正文组装在此测试单独隔离，已有真实账本测试。最终 4 个聚焦文件 20 用例、TeamLead 类型检查与 diff 检查通过。尚未注入认证解释 observer 或验证原卡 approve/rework 到 B2 的反向链；无真实 Discord/QA 证据，T5/T6 与完整门禁仍未完成。

认证解释分流已接入 GatePoller → founder-reply-deliverer → plugin factory。在审批/宽泛分类之前，仅标准显式 reply 调用 reference-only observer；handled 表示已持久接收才推进 cursor 并停止分类，retry 保持 cursor，通过既有失败重试处理。原 chat ingest 审计仍保留，不等于审批或需求创建。

新 `bridge/ship-judgment-routes.ts` 先只读查询准确 thread/clarification message 的唯一已投递 root，普通/原卡引用立即 ignored 且不取网络；然后核 Flywheel 原 run、原持卡 Lead 标签匹配及 canonical founder 配置，用该 Lead bot 认证 GET 原消息，64KiB/10 秒边界，交既有原作者/时间/引用核验与只追加答复事务。503 返回 retry，重放已记录答复返回 handled；ack 仍由独立发送循环处理。未新增 B2 读取者或修改批准 writer。

TDD 分别确认缺分流 hook 与缺 factory 红测后实现。消息分流最终 46 例（包含 learning handled/retry、原卡 approve/reject 在 observer ignored 后继续审批回调）、学习 ledger/factory 23 例、authorship 边界 1 例通过；GatePoller wiring 9 例另批通过，使用已有部分 mock 的预期日志，不是失败。最终 TeamLead 类型检查/diff 检查通过。当前原卡测试使用审批 callback 替身，不能替代计划要求的真实 writer → B2 反向证明；归档历史线程是否进入扫描、手工 ref/编辑重扫、取消重复 episode、统计历史页与最终门禁仍需核实/完成。无实机 QA 或真实消息证据。

历史答复扫描审计发现：GatePoller 原来只从 listNonTerminalSessions 与待答问题建线程，因此 issue 结束后的澄清线程可能退出扫描。已新增已投递 root 的原线程来源：只读取匹配冻结 input 的 clarification delivery，按 snowflake 顺序去重，每页最多 25，越过末尾回绕；未发送/不可用记录不入选。原 run 终止仍可通过原 holder/Lead 标签解析线程。

plugin 将该有界来源注入同一 GatePoller，历史线程与当前线程合并去重、使用既有 scanBudget 和 founderReplyScanCursor，不创建 gate，不改变线程状态。来源读取失败与常规扫描隔离；候选全无法映射且没有其它任务时仍推进候选 cursor，避免一页坏映射永远卡住后续线程。既有消息 cursor 保留，不因历史接入重放旧外部动作。

TDD 先确认缺线程来源以及无活跃 session 时零扫描的失败，后用真实临时 CommDB/StateStore + 模拟 Discord 证明历史线程读取；ledger 测试另证明只在实际投递后入选、回绕及终止 run 后继续映射/答复。3 个聚焦文件 33 例、TeamLead 类型检查与 diff 检查通过（GatePoller 的部分 mock 预期日志仍有输出）。真实 writer→B2 反向证明尚未完成，原卡 callback 测试不能替代；旧消息编辑/manual ref 重取入口、取消 episode 去重、历史统计页面与全仓门禁仍待完成。没有真实 Discord 或 QA 验收证据。

## 原审批卡真实写入链路回归（2026-09-11）

新增 `approval-writer.integration.test.ts`：临时 CommDB 与内存 StateStore，固定 land manifest、当前 review 节点、holder、精确 HEAD 和 PR 绑定；从既有 Discord ingress 进入实际澄清 observer、实际审批 factory/handler、可信 founder writer，再由实际 source projector 生成 B2。只模拟 Discord GET，审批文本识别、写入器和投影器均未替换。分别用协议词「通过」「打回」，断言单条 approved/rework、founder_authored=1、原问题与 HEAD、captured founder 身份、source 时间以及重复 drain 不新增记录。生产代码和授权契约无修改。

构建集成夹具时先暴露了缺失 cursor、session HEAD 以及 gate 节点应为 review 的前置条件；补全夹具后通过。另确认自由文本「打回：补测试」不等同于固定「打回」协议词，本单未扩大词表。

验证：新集成 2 例、既有 founder ingress 46 例、B2 作者边界 1 例，共 3 文件 49 例通过；TeamLead `tsc --noEmit` 通过。这证明普通原审批卡在新 observer 接入后仍能真实写入 B2；尚未在同一集成夹具中加入已投递的未答澄清根，也未证明含批准词的澄清回复在完整链路上零 B2 写入。后两项仍是下一步，不能据此宣称整个隔离验收完成。无 live Discord、全仓门禁、review 或 PR 证据。

## 真实决定后的澄清反向词隔离（2026-09-11）

原审批卡集成现扩展为完整时序：预先冻结并确认可见的机器意见，真实 ingress → trusted writer → B2 产生相反 founder 决定，真实 outcomes reader 和 clarification sweep 从该 B2 生成问题，确认问题投递后，再经真实 ingress 和 authenticated reference fetch 接收解释。批准后的解释为固定词「打回」，打回后的解释为固定词「通过」。两者均只新增 explained 记录与待发 ack；原 CommDB response、source event 列表、B2、gate holder 和 workflow run 逐项保持原值；审批 handler 调用次数保持一次。断言实际原消息 GET URL、Bot header、signal 与 redirect 策略。

这修正了上一段下一步的时序表述：澄清根只能在真实决定后形成，不能为了测试“未答澄清 + 首次决定”而手工制造不存在的前置状态。本回归不手工插入 B2 或 outcome。机器评估和投递回执仍是本地受控夹具，HTTP 为 mock，不能当 live 交付证明。

验证：学习测试 23 例、完整集成 2 例、B2 作者边界 1 例，共 3 文件 26 例通过，TeamLead tsc 通过。生产行为代码未修改。下一步为取消 episode 去重，之后 manual reference/edit、统计/历史/T5-T6 和全仓门禁。

## 重复取消收尾的学习去重（2026-09-11）

RED：同一已验证 Linear Canceled 更新时间对应两条 closeout，第二条到达后第一条原本 unresolved_binding 被改判 timing_ambiguous。最小修复在学习读取端识别同 run/question/card、同 capture issue_uuid、同决定时间的已验证 closeout，只让首个本地追加回执参与判断，其余返回 duplicate_cancellation。首回执比较其它决定时排除本 episode 的重投回执，避免同毫秒污染。无 source/授权/既有 outcome 写入或 schema 修改；原始收尾审计条数仍保留，统计必须使用 pairing 排除 duplicate_cancellation，不能直接拿 raw receipt count 当决定分母。

capture 必须带原 linear-canceled-closeout-run-v1 归因及取消状态/授权/更新时间；不合格或其它来源不会套去重。不同 Linear 更新时间仍作为后续决定单独排除；这只按捕获证据识别同一次取消，不推测缺失的状态历史。测试覆盖重复扫描、VACUUM 后重新读取、只读审计行不变、后续更新时间不被折叠。3 文件55例及 tsc 通过。

同thread旧澄清 pending＋新的当前原审批卡两种反向入口仍需补齐，前节已证实的“先决定再生成澄清”不替代该要求。

## 同 thread pending 澄清的原卡反向验收（2026-09-11）

完整集成进一步覆盖 §7.3/U7：真实旧 B2 形成并投递未答澄清后，在同一 issue/thread 夹具中物化下一轮当前 gate、精确 HEAD/PR 绑定和 CommDB question。此物化是本地受控测试前置状态，不调用生产 dispatch，也不声称测到了 orchestrator 续轮。分别明确回复新当前原审批卡「通过」「打回」，实际 factory/handler/trusted writer 写源事件，实际独立 projector drain 写真实 B2；历史澄清仍未解释且未发起原消息 fetch。回复第三条普通消息的固定判词，既不答新卡、不生成新 B2，也不结澄清。

随后引用历史澄清的相反判词由 authenticated fetch 记录为 explained/ack intent；旧、新两轮的 response、B2、holder、run 和完整 source 列表不变。此补充完成前文尚待的“同 thread pending + 原卡真实 writer”正反场景，不将同 thread 误解为同一个已经回答的 question 再首次决定。

验证：完整集成2例、学习23例、原 ingress46例、B2作者边界1例，4文件72例通过；TeamLead tsc 通过。仍无 live Discord/独立 QA 或全仓门禁证据。下一步 Lead 原消息 ref 服务端复核入口（含旧编辑消息），然后统计/历史/T5-T6、完整门禁及审查。

## Lead 原消息引用复核入口（2026-09-11）

新增 `POST /api/ship-judgment/reference`，实际 Bridge 注册要求 API token；正文严格限定 threadId/messageId/replyToMessageId 和 Lead 身份凭据，拒绝自由文本/作者字段及非 Flywheel 项目。复用 `authorizeLeadWrite`、forwarded identity/lease/carrier 校验与现有原 holder/Lead label 映射。原消息 HTTP 前及取回后都重核当前 Lead 授权，授权失效不能追加解释。复用实际 clarification observer 的 canonical founder/thread/explicit reply/编辑时间核验；只提交引用，不信调用者提供的原文。

新增命令：`node "$FLYWHEEL_COMM_CLI" ship-judgment-ref --message-ref <threadId>/<messageId> --clarification-id <澄清消息ID> [--bridge-url <loopback URL>]`。从既有 Lead 环境取身份并校验，要求 Flywheel 项目及 TEAMLEAD_API_TOKEN，只向 literal loopback Bridge POST，redirect=error，20秒超时。正常返回 `recorded_or_existing`，其余失败非零；无本地写入替代、不自动重试、不回显凭据/网络异常正文。它是明确的解释写入口，不并入 T5 的只读 report/show 命令。

旧消息编辑可手工重新提交：真实持久夹具验证新增一版 explained 与 ack intent；同版本重复提交不增行；fetch 中授权失效返回403且不新增。实际 Bridge HTTP 测试先 RED 404、注册后验证无token401和非法正文400；CLI验证只传引用/认证、非法及重复参数/远程目标/未授权零POST、503/失联/异常成功正文不伪报成功。

验证：TeamLead4文件28例、Comm命令5例，合计33例通过；两包 tsc、Comm build 与编译后 help 命令注册通过，diff check通过。这里的 Lead 授权阳性使用注入 seam，真实授权库沿用现有实现；HTTP为本地测试和mock Discord，并非 live founder 对话。全仓门禁、review、CI、QA与PR仍未完成。后续重点为统计口径和独立历史发布/T5页面容量，以及剩余T1-T3预算审计。

## 固定截止时点的统计读取基础（2026-09-11）

先补配对的 `asOf`：主 outcome、先前决定/重复取消候选都限制 observed_at 截止；意见、input、evaluation 和可见回执分别限制其创建/观测截止，避免后来入库的回溯决定或回执污染旧报表。默认无显式截止的调用保持既有行为。RED 已复现未入库时仍看见 outcome；回归进一步覆盖晚回执及 late-backdated 决定，当前查询与固定旧时点查询能给出不同而有证据的结果。lead_manual 与 retro 都不进入机器配对或充当先前 founder 决定。

新增 StateStore.getShipJudgmentStatistics()：单只读事务，严格 canonical UTC `from < to <= asOf`，决定窗口 `[from,to)`，原始 outcome 观测截止为 asOf。输出完整4×3表、可建议在人工批准中的占比、可建议后打回率（批准+打回分母，不含取消）、可建议后取消率、总体取消比例；每项都有分子/分母，分母0返回null。按 policy/model 独立分组，支持精确版本筛选；排除项单独列，含版本不符、duplicate_cancellation、retro/manual/未知作者/时序/绑定/待刷新等，不改原始记录。

卡片清单以 gate question 为单位（包括尚未贴出的卡），选在窗口内创建/产生意见/决定的项目条目，按 asOf 读取意见与决定状态；不按版本过滤清单，避免没input的卡消失。无意见、undetermined、无已验证人工决定、未确认可见分别计数。原始 outcome 回执条数与唯一 gate question 数不可相加；自动观测、手工记录与历史补录分开。每次最多10000 outcome和10000 gate问题，超限明确报错要求缩小区间，绝不截断冒称全量。报告脚注不把投递在先当已读、不把动作一致当质量或因果正确率。

已知未完成项：现有 mutable delivery.last_error 不能重建历史asOf失败状态，故 deliveryFailureCount 明确null，只能报告未确认可见，不能称其失败或零失败；需补可信失败历史后满足最终统计验收。此基础尚未连接只读CLI/HTML/history，Lead手工/retro导入仍待交付。未因此完成任何整个T组。

验证：5文件61例（统计3、学习25、outcome30、真实writer集成2、B2作者边界1）通过；增加StateStore入口后统计3例复核，TeamLead tsc/diff通过。统计数学测试覆盖完整零值格、零分母、取消与打回分母分离；真实持久配对夹具覆盖版本分组/筛选，另测UTC与半开边界、未来观测排除、10001条明确拒绝。没有live/全仓CI/review/PR证明。

## 2026-09-11 — Immutable opinion delivery failure evidence

Added non-authoritative workflow_run_event kind ship_judgment_delivery_error inside the existing delivery lease CAS transaction. Failed audit insertion rolls back the state change; repeated stale claims append nothing. Records distinguish confirmed failures from uncertain responses. This is an implementation of historical delivery statistics, not an extension of approval authority or a new table.

Statistics now counts distinct cards with confirmed normal opinion POST/PATCH failures in [from,to), including subsequently recovered attempts. Unknown responses remain separate. History-mode edits, scans, clarification messages and acknowledgements are outside this count. A durable INSERT OR IGNORE migration timestamp records the audit installation boundary; earlier intervals expose observed counts but return null for the complete failure count. Reopening retains that timestamp. Mutable last_error is never the historical source.

TDD: new historical-count test failed with null instead of zero before statistics implementation. Final focused delivery/statistics/schema run: 3 files, 13 tests passed. Dispatcher audit guard: 2 passed, 105 skipped; neither visibility nor delivery-error events dispatch work or change nodes. TeamLead tsc --noEmit passed. These are local fixture tests, not Discord/host or full-repository proof. Read-only CLI, history publication, Epic integration and remaining T5/T6 requirements remain outstanding.

## 2026-09-11 — Read-only statistics API and comm report

Added GET /api/ship-judgment/report behind existing master API-token authentication. The router accepts Flywheel only, shares the statistics range validator, rejects duplicate/unknown query fields and invalid UTC ranges, freezes an explicit asOf (or request time), and returns schema_version/policy/source plus the report. Tokenless deployments fail closed with 503; existing scoped tokens remain rejected. Database failures return statistics_read_failed, never an empty successful report. The read route is independent of dry_run/off runtime activation.

Added flywheel-comm ship-judgment report --project flywheel --from UTC --to UTC, optional --as-of, --policy-version and --model-snapshot-digest. It performs one loopback authenticated GET with a deadline and no redirect, local database access, write fallback or retry. Output retains server evidence timestamps and denominators. show remains to implement.

Validation: real local HTTP test initially failed 404; final Bridge/read/statistics/reference run passed 8 tests, including actual CLI-to-Bridge-to-store response equality, total_changes unchanged, malformed queries, tokenless/scoped denial, and missing-table explicit 503. Comm client tests passed 5. Comm typecheck/build and built --help registration passed. A file-name collision with the existing reply observer was caught by typecheck, corrected by restoring it and using ship-judgment-read-routes.ts; existing reference tests subsequently passed. No live Bridge or Discord proof claimed.

## 2026-09-11 — Read-only audit show by question or ID

Added ShipJudgmentReader and authenticated GET /api/ship-judgment/show, wired to comm ship-judgment show --project flywheel --question ID or --id ID. Exactly one selector is required. Question lookup lists immutable input/evaluation/opinion/outcome/clarification IDs with source labels; ID lookup returns the original record with its card/run context, including reference IDs and stored JSON evidence. No active-run or thirty-day restriction is applied. All external values are SQL parameters; project membership is checked against the authoritative run.

Bounded reads fail explicitly above 1000 card records (individual IDs remain available) or 1 MiB for an individual record; no silent truncation. Manual/retro origins remain distinct, and ambiguity across record types fails closed. Neither the reader nor CLI writes or migrates databases. Missing IDs return 404, invalid selectors 400, read failures 503; master token authentication is unchanged.

Validation: getter test initially failed missing reader, HTTP show test failed 404 and both CLI selectors failed before implementation. Final local runs passed TeamLead show/HTTP 5 tests and Comm report/show 7 tests. Tests include old 2020 records in terminated runs, cross-project denial, SQL-injection-shaped IDs, immutable manual/retro provenance, record count and size bounds, actual CLI-to-Bridge show, unchanged total_changes, and report regression. TeamLead typecheck and Comm build/typecheck plus built help passed. Test fixture updates were rejected by existing immutable-ledger triggers and corrected to insert records; no trigger was relaxed. Live host/Discord and full-repository verification remain outstanding.

## 2026-09-11 — Frozen history query and static page renderer

Added independent project-wide 30-day history reads from holders/opinions/outcomes and existing narrow-auto audit. Reads use one transaction and a fixed asOf, exclude later-observed outcomes, retain terminated cards, and select latest evidence without active-Epic membership. Machine opinion origin and decision origin are separate; retro decisions are labeled separately from the machine opinion. Clarification display derives pending divergence from cutoff-aware pairing and explained replies from verified_at. Content digest includes ordered records, audit IDs/state and template version, excluding query asOf itself. The query fails explicitly above 10000 cards; it does not silently return a partial history.

Added static twenty-row pagination renderer using existing injectHeadMeta/CSP. Complete escaped code points are bounded per field; every rendered row is checked at 2 KiB and every hardened page at 64 KiB. Pages show frozen timestamp/count/page count, source and uncertainty labels, short evidence and stable audit ID, validated Discord card links and a same-origin HTTPS next link. No runtime fetch or script is emitted. Publication verification remains the caller responsibility; no unverified URL has been published.

TDD: missing history reader/module failures preceded implementation. Final local history query/render run passed 5 tests; TeamLead tsc --noEmit passed. Tests cover late observation/asOf, unchanged digest on time-only refresh, 30-day expiration, terminated cards, read-only total_changes, injection-shaped text, same-origin navigation, empty pages and maximum row identifier/enum/multibyte sizes. Text-only onerror strings are escaped content, not DOM event attributes. No browser/host visual proof claimed.

Outstanding before T5 acceptance: durable backward publication/verification and restart reuse, independent one-minute timer/30-minute rounds/TTL renewal, dirty sources, remaining history edge cases and legacy-auto show lookup, Epic six consumers and capacity gates, retro importer. Main Epic does not consume this renderer yet.

## 2026-09-11 — Durable history publication state

Added ShipJudgmentHistoryState using the existing project-state table. It reserves a two-minute lease and thirty-minute next-attempt deadline before a round; failed or crashed attempts do not reset that deadline. Frozen rows/asOf/digest, staged HTML/token/URL and verification receipts persist in building_manifest. Recovery reuses the same manifest while retaining later changes as dirty. Page staging proceeds backward only after successor verification, prohibits token reuse across pages, and rejects expired/stale lease mutations. Publication replaces the old manifest/URL/asOf only when every page has a verified receipt. Failure retains the previous public entry and reports an error.

Content-identical snapshots reuse the prior entry while its pages remain within the twelve-day renewal boundary. An unrelated prior query failure does not trigger renewal. A known published_url_invalid code or approaching expiry allows renewal; the existing fourteen-day expiry remains recorded. Dirty changes arriving during work are preserved. These are durable state decisions only: no network validation is claimed by direct verifyPage fixture calls.

TDD: missing state getter, lost dirty flag during resume, inappropriate renewal after a query failure, and duplicate-page-token tests failed before their fixes. Final history state/query/render suite: 3 files, 9 tests passed; TeamLead tsc --noEmit passed. A real temporary SQLite file was closed/reopened to prove staged token and next-due retention. Tests also cover backward order, incomplete publication rejection, lease expiry, old entry on failure, unchanged result, and twelve-day renewal selection.

Still outstanding: actual ReportRegistry staging/recovery and Blob adapter, HTTP 200 verification, cancellation/timeouts around network, independent timer and Epic refresh callback, dirty source wiring and full U9 acceptance. No hosted report, production write, browser proof or whole T completion in this batch.

## 2026-09-11 — Ordinary report resume and history publisher adapter

Added ReportRegistry.resumePublish: reconstruct an ordinary report from its durable entry and hardened bytes, preserving token/creation time and refusing expired metadata or conflicts with an existing token. Reconstruction reads the latest registry, so unrelated reports committed during upload are retained. The history adapter stages/commits inside short shared critical sections; neither Blob upload nor public URL verification holds that lock.

Added optional ReportBlobStore.resumeReport and the Vercel implementation. Recovery reads the existing private object first; identical bytes are reused without overwrite or TTL renewal, missing objects use ordinary allowOverwrite:false upload, conflicting bytes fail. AbortSignal reaches Blob GET/PUT, existing-byte reads are bounded by expected size. Existing ordinary/Epic upload APIs remain unchanged.

HistoryReportPublisher now stages ordinary hardened pages, reuses persisted token/creation time for upload and registry commit, and verifies HTTP 200 plus exact body bytes at the configured gateway origin with redirects rejected and a 10-second deadline. It has no public database read route. Public report trailing-slash URLs are accepted by the durable page-state guard. An unresponsive upload fails at the deadline; a late completion cannot commit the registry.

TDD: missing resume APIs/publisher and real gateway URL incompatibility were reproduced before fixes. Validation: existing/new registry tests68 + Blob tests9 + publisher/state tests6 =83 passed. TeamLead tsc --noEmit passed after using the repository-supported no-cache request header. The publisher uses real temporary registry files and fake Blob/HTTP transports; its test holds upload pending while an unrelated report commits through the same critical section, and fake time proves late upload cannot commit. No real hosted report or production mutation has been performed.

Next: whole-round backward orchestration, persistent page receipts and independent timer/shutdown wiring, dirty source events/Epic refresh notification, whole-round120s and complete U9 verification. Network fixtures do not substitute for later hosted/browser QA.

## 2026-09-11 — Whole-round history runtime and Bridge lifecycle

Connected query, durable state, renderer and report publisher in ShipJudgmentHistoryRuntime. It freezes a snapshot, walks pages from last to first, saves each staged token/HTML before upload, records verification before referencing a successor URL, and publishes the manifest only when complete. Failed rounds retain staged pages and the old entry; restarting the runtime reuses verified pages and staged tokens. Identical content returns before any stage/upload/verification.

The runtime owns an independent one-minute timer, a whole-round 120-second cancellation race, and clean shutdown. Durable state continues to impose the thirty-minute attempt interval. Aborted or late dependency results cannot write a new page receipt. Unexpected claim/failure-store errors return an explicit failed result and a fixed error code instead of rejecting an unattended timer promise.

Added a Bridge factory scoped to configured Flywheel ordinary Blob hosting. It is independent of the opinion mode flag; non-Flywheel, missing resume-capable Blob storage, or a QA report host override creates no history runtime. The plugin starts/stops it alongside other owned services and schedules the existing Epic refresher through the new ship_judgment_history reason after publication/failure status changes. It does not put history work in the Epic materialization await chain.

TDD: missing runtime/factory and uncaught store-failure tests failed before implementation/fix. Final focused history runtime/factory and Epic model/refresher run: 4 files, 65 tests passed; TeamLead tsc --noEmit passed. Tests cover backward publish order, partial verification failure/reuse, time-only zero-network rounds, minute checks/thirty-minute interval, 120s timeout, cancellation with an unresponsive publisher, stopped timer, fixed error reporting, and factory scope. Fake publishers and time do not prove real host delivery. Plugin lifecycle wiring is code/typecheck evidence, not a live restart.

Still outstanding: all dirty-source wiring, history edge-case/auto-audit lookup refinements, Epic summary/history consumers and capacity acceptance, retro import, complete U9 including real publish integration and TTL flow, remaining collector budget audits/full gates/review/PR.

## 2026-09-11 — Atomic history invalidation and late explanations

Moved opinion history_dirty invalidation into the same insert-trigger mechanism used for outcomes and clarifications. The three immutable-ledger triggers mark only Flywheel project history, in the caller transaction; rollback rolls back the mark. They do not alter leases, next_due_at, approval records or workflow dispatch. Removed the duplicate opinion-specific statement. This also covers later imports without requiring each writer to remember a separate dirty update.

History membership now includes cutoff-eligible verified explanations. An old terminated card can re-enter the rolling thirty-day window when its explanation arrives, while a query with an earlier asOf still excludes that reply. The latest historical explanation remains visible after a later decision on the same card and is labeled “历史决定已解释”. Unanswered original divergent roots remain pending even when the latest decision is an override; the original outcome must still pass the real cutoff-aware pairing policy. Pending-root scans are bounded and fail explicitly on overflow.

TDD: absent dirty mark on outcome insert, missing thirty-two-day-late explanation, and hidden pending original clarification after a later approval were reproduced before fixes. Final learning/history/dirty run passed27 tests; migration/real approval-writer integration/render regression passed10. TeamLead tsc --noEmit passed. The dirty test proves same-transaction rollback, cross-project exclusion and unchanged next-due/generation. Original approval/rework integration remains actual local writer/B2 code with fixture transport, not production approval proof.

Remaining: legacy-auto audit show/history identifiers, Epic six read/render consumers and hard capacity tests, retro import, complete history publishing/TTL U9 acceptance, other collector budget audits and full-repository gates/review/PR. No whole T group or hosted visual acceptance claimed.

## 2026-09-11 — Legacy narrow-auto audit lookup

The read-only show reader now includes existing auto_narrow_decision_audit records, with explicit auto_narrow_gate source and project checks. Question lookup lists these IDs; exact lookup returns their original control/declaration/strength-two references. Audit ID input accepts the legacy table's 240-character boundary while question IDs remain limited to200. History rows without a semantic opinion use the actual automatic-decision or outcome audit ID instead of a null placeholder. No new automatic approval event is introduced.

TDD: the existing real narrow-auto source-projection test reproduced missing show output before the change. Final existing auto-narrow approval tests30 + show2 + Comm CLI7 passed; both package typechecks passed. The augmented test checks exact and question lookups, history source/authorship labels, and unchanged total_changes after reads. Existing two-database auto path remains fixture-based, not a live auto approval.

Epic consumer inspection: readEpicItemFacts is the shared data boundary; generate maps source facts into Cells; model validates optional fields; renderers use AuditDictionary/AuditSidecar. The next implementation must extend these existing paths, preserve count/phase derivations and existing Lead notes, keep child additions within256B, and put full audit detail in sidecar rather than inline history. This inspection is not implementation or capacity proof.

## 2026-09-11 — Epic judgment facts and Cell boundary

Shared readEpicItemFacts now projects a Flywheel-only optional judgment fact from the latest issue-bound holder and opinion. It carries the original opinion clock, policy/model identity and evaluation/mechanical evidence. Delivery receipts determine pending/published/history display; these labels convey no approval authority. Reads use a transaction and parameterized issue keys; failures remain independent statestore_error facts. Other projects receive no new fact.

The existing Epic generator and strict model now carry the optional Cell, preserve source_updated_at and reject invalid display enums or incorrect provenance. No holder produces no optional Cell; a failed read produces an explicit missing Cell. Existing count and stage derivations remain untouched. TDD reproduced absent shared facts and absent generated Cells; after correction, facts1 + StateStore14 + model48 + generator17 passed (the generator was rerun after correcting Date-to-UTC conversion). TeamLead tsc --noEmit passed. These are local fixture tests, not rendered/hosted acceptance.

Remaining next: HTML/Markdown compact summary and complete sidecar audit, history preview/materialization, exact child/preview/main-page capacity tests, then retro/U9/collector audits and full gates/review/PR. No whole T group is complete.

## 2026-09-11 — Compact Epic judgment rendering

HTML and Markdown now show fixed machine-opinion display/overall labels. Hosted HTML adds one compact line with a numeric audit reference linking to the existing content-addressed audit attachment; the complete Cell, including source clocks and evaluator/mechanical evidence, is stored losslessly in that sidecar. Standalone HTML exposes escaped evidence in a native details element and existing provenance dictionary; Markdown retains the original full Cell. No new script, public database route or permission control is introduced.

TDD reproduced the absent summary first. The new fixture verifies a hostile large evidence payload stays out of hosted HTML, round-trips through the decoded sidecar, remains escaped in standalone HTML, and retains the source timestamp/reason in Markdown. Its single-child HTML increment is at most256 bytes. New render1 + existing render27 + audit dictionary2 passed; TeamLead tsc passed. This is not the complete8-root/60-child capacity test or authenticated hosted/browser proof.

Next: history preview/materialization and exact saturated capacity tests, with optional-row shrinking and history-entry fallback as pinned, then retro/U9/collector audits and full repository gates/review/PR.

## 2026-09-11 — Local history preview materialization

Epic now receives an optional history Cell through its existing Bridge materialize/generate/model chain, only for Flywheel. The synchronous reader shares one local SQLite transaction for existing thirty-day history and publication state, projects at most20 rows plus total, and carries the last published URL/asOf/error/dirty state. No publishing or verification network call occurs on this path. A failed history query retains the previously published entry and marks readError; unavailable publication state produces a static unavailable marker rather than aborting Epic generation. HTTPS-only URL and row-limit validation apply at the model boundary.

TDD reproduced missing reader, missing generated Cell, missing Flywheel materializer invocation, and uncaught missing-state-table failure before fixes. Final local tests: history reader1, materializer2, generator18, model48 (69 total) passed, plus TeamLead tsc. Tests prove reads do not change SQLite total_changes, old entry survives a history-table failure, source failure is explicit, non-Flywheel materialization does not invoke the reader, and unsafe URLs are rejected. This does not yet prove rendered preview layout, all20 saturated rows, full8-root/60-child capacity, or host behavior.

Next: render the history preview and fallback entry in HTML/Markdown, verify16KiB preview and512KiB main capacity with required fixture cardinality, then remaining retro/U9/collector audits and full gates/review/PR.

## 2026-09-11 — History preview rendering and bounded entry

The existing HTML/Markdown renderers now show a static latest20 history section with total, source/decision attribution, clarification state, original-card links and the last published thirty-day entry. HTML stores the complete preview Cell in the immutable audit sidecar; rendered issue/summary text is codepoint-truncated after escaping. Publication errors retain the available old link, while missing/unusable links do not claim a prior publication. Read errors suppress rows and explicitly mark the failed preview. Markdown uses the same safe static HTML section.

TDD first reproduced absent preview, then an escaped-URL expansion exceeding the zero-row fallback budget. Final render tests3 + existing27 passed and TeamLead tsc passed. A20-row fixture with long hostile/Unicode fields proves preview<=16KiB, source/authorship/error labels, original links, full sidecar roundtrip and Markdown presence. Explicit zero-row rendering proves<=1KiB; URL admission counts escaped bytes. These tests do not yet prove the global512KiB budget or automatic row shrinking in the publication pipeline.

Next: connect optional preview/summary shrinking into existing attention/publication budgeting, verify8roots60children and saturated attention with all required metadata, then remaining retro/U9/collector audits and full repository gates/review/PR.

## 2026-09-11 — Optional rows in the publisher budget

Hosted rendering now accepts presentation-only row limits. Omitted machine summaries still add their complete Cells to the sidecar and show a truncation notice; task rows, root counts and source documents remain unchanged. The publisher uses a bounded search to shrink history preview rows first, then machine-summary rows, measuring actual injectHeadMeta output plus the existing previous-audit attribute allowance. Both original pre/post-hardening512KiB checks remain. If the zero-row rendering still cannot fit, it is returned to those checks for the existing explicit structural failure; no tasks are silently dropped.

TDD reproduced ignored summary limits and the absent budget module. Final optional-budget1 + judgment-render3 + existing publisher10 tests passed; TeamLead tsc passed. The budget test uses the original8-root/60-child fixture, adds opinions to every child, forces a smaller byte limit, proves retained task/root counts and unchanged input object, and decodes retained audit evidence. Its impossible-limit branch preserves tasks and stays oversized. This is not the pinned combined attention-cap acceptance.

Dependency discrepancy: current branch has no applyAttentionBudget implementation or Epic attention field; founder-budget fixture still says C5 adds merged attention. Nonblocking Lead question cf21f54b-cbb0-4120-9a82-549270f56464 asks for authorized dependency integration/disposition. First check returned not yet. Do not substitute a new attention mechanism or claim that gate passed. Next continue full notes/history fixture and remaining independent audits while awaiting the reply; full gates/review/PR remain.

## 2026-09-11 — Full local notes/history capacity and publisher preservation

The original8-root/60-child fixture now has a separate FLY-2399 variant with one280-codepoint engineering note on every root and child, sixty machine judgments, and twenty saturated history rows. Raw HTML461121B <=491520; actual CSP hardening plus previous-audit binding allowance461435B <=524288. This result excludes the currently absent attention dependency.

Additional tests verify history rows are removed before current opinions, the selected row count fits while count+1 exceeds the same measured budget, and complete history survives in the sidecar. A publisher integration uses real temporary ReportRegistry and local StateStore with mocked Blob: oversized input shrinks and publishes while preserving8roots/60children; essential content too large returns structural failure without a second upload or change to the prior publication/page. Capacity2 + optional-budget2 + publisher11 passed; TeamLead tsc passed. No hosted proof claimed.

Lead answered question cf21f54b-cbb0-4120-9a82-549270f56464: real attention-budget.ts/materialize.ts are on origin/main via FLY-2484. Authorized mechanical merge origin/main into this branch, no rebase/design change; preserve main attention semantics and this branch additions, retain §8 thresholds. No review currently running. Next integrate that dependency after required authorization check and run actual combined attention capacity proof.

## 2026-09-11 — Bind authenticated refetch to the preauthorized clarification root

The reference observer previously selected Lead authority using the submitted reply target, then could record against a different target returned by Discord. Bridge now forwards the expected replyToMessageId into the clarification observer; after canonical fetch it rejects a different message_reference.message_id before any transaction. Existing direct observers may omit the optional expected target; Bridge/manual-reference paths always supply it.

TDD reproduced a mismatched expected target being recorded. After the guard, learning25 + actual local approval-writer integration2 + reference-route2 passed; TeamLead tsc passed. The negative fixture proves no explanation row is inserted. This is fixture transport, not authenticated live Discord proof.

Lead answered d13f5cc0-d78e-4002-a0c5-505e52b66778: verify-approval governs ship PR merges into main, not branch synchronization; the old ANY merge wording is being corrected by FLY-2509/#1157. Proceed with authorized git merge origin/main into this worktree branch, preserving main attention semantics and this feature.

## 2026-09-11 — Actual attention capacity and hosted materialization

After main integration, the combined fixture uses real buildAttention/rebuildAttention and applyAttentionBudget with200 saturated source candidates. It retains8roots, one280-codepoint note on every issue, machine judgments and20 maximum preview rows. The zero-attention candidate includes the real truncation warning. Measured child cap69 has hardened+binding521503B; cap70 is asserted over524288B. At cap69, actual applyAttentionBudget preserves all tasks/history and retains0 attention rows with source_truncated. This is an explicit capacity limitation, not a claim all200 remain visible. The post-merge v1 full-notes/history baseline is raw462357/hardened462671B; prior smaller numbers preceded main CSS integration.

Fixture audit corrected missing lead-note source_updated_at and wrong epic_scope provenance exposed by the real model validator. The fixture now validates before use. Search starts at60 and measures through the first exceeding child count so constructing arbitrary oversized JSON does not bypass the document gate.

TDD also reproduced materialize rejecting the valid60-child hosted page because it measured standalone inline-audit HTML. Materialization now supplies actual hardened hosted rendering plus previous-audit allowance to unchanged applyAttentionBudget. Optional row reduction and both publisher512KiB gates remain in effect; the existing materialization assertion now checks the actual hosted representation. Standalone inline-audit export is not the hosted publication artifact. Final capacity3 + optional-budget2 + materialize6 + publisher11 =22 tests passed; TeamLead tsc passed. No real browser/host proof claimed.

Next: remaining retro import/U9/collector and scope audits, then required full repository gates, code review, PR and exact-head delivery. No whole T group marked complete solely from these focused tests.

## 2026-09-11 — Read-only retro quarantine import

Added scripts/import-ship-judgment-retro.mjs, a bounded local JSONL converter with no DB/network or authority writes. Explicit retro=true rows receive legacy_retro IDs from SHA256([source kind,file digest,physical line]); every record remains quarantined, prospective=false, authorship=unknown. Original parsed fields and the exact decoded raw line including CRLF/LF are preserved. Non-retro entries are skipped. Missing complete head/question/prediction time and unverified binding/author evidence remain explicit; even apparently complete user-supplied references cannot become verified. CLI output uses exclusive creation and cannot overwrite source/existing output; malformed files produce no partial artifact.

The current7008-byte manual ledger has11 rows. The generated retro-import.json contains6 quarantined historical records and5 skipped later entries. Source digest b41d99542c5a0220a5acf9b35698fb110bbb32a740f14af68c56ae602dc7c69d matches the source after conversion; the source was not changed. This is a real source-file conversion, not a prospective quality result or trusted founder decision import.

Three Node tests pass: six-row byte/identity preservation and replay; malformed/UTF8/size/authorship rejection; CLI exclusive outputs and no partial results. The test is registered in the existing CI Node-script step. Remaining: U9 integrated publishing/restart renewal, collector/requirement audit, full repository gates, independent QA/model evidence, review/PR and exact-head delivery.

## 2026-09-11 — U9 integrated history publication recovery

Added one composed test using actual HistoryRuntime, HistoryReportPublisher, VercelBlobReportStore, temporary ReportRegistry and a file-backed StateStore reopened after failure. Only the external Blob client and public HTTP responses are simulated. Twenty-one distinct gate/run fixtures produce two pages; page2 uploads/verifies before page1. While page1 verification is held, the Epic local preview still returns20 rows/total21. A failed page1 verification leaves the public history entry unset.

After runtime shutdown and database/registry reopening, the durable30-minute reservation prevents work. At the next eligible round, page1 reuses its existing object (zero additional PUT), page2 is not reverified, and the original frozen asOf and links survive. A later unchanged round performs zero network operations and retains the URL. Advancing the controlled clock to12days publishes two fresh objects and changes the history entry; old objects/registry records remain intact.

Integrated1 + runtime5 + publisher2 + history-state4 =12 tests passed; TeamLead tsc passed. These are executable local restart/transport proofs, not live Vercel/Discord/browser acceptance. Remaining: final collector/requirement audit, full repository gates, required independent QA/model evidence, code review, PR and exact-head delivery.

## 2026-09-11 — Repository gate first pass and lint normalization

Required pnpm -r build passed. Initial pnpm lint reported71 errors. Scoped safe Biome import/format fixes were applied only to65 files changed by this branch; the remaining history HTML helper name was made unambiguous and a comma-expression sidecar registration extracted without changing output. Final pnpm lint passes with15 pre-existing warnings. Seven history-page/judgment-render regression tests pass after cleanup. Gate logs: /tmp/fly2399-build.log, /tmp/fly2399-lint-final.log, /tmp/fly2399-lint-regression.log.

Required pnpm test:packages:run is still running in exec session74786, redirected to /tmp/fly2399-packages.log. Preserve/poll that process, do not restart on observation timeout. No full-package success or failure is claimed yet. The initial tested tree precedes formatting-only cleanup; final exact-head validation remains required.

Collector audit found a remaining pinned §4 requirement: production-collect currently calls checkGitMerge per card, without the shared repo/main/head/target-base cache. Existing project refresh cache holds GitHub files only. Next implement60-second, persistently bounded merge-probe reuse in the existing mechanical_cache_json envelope, with no ninth table or authorization change, then finish the remaining audit/gates/review/PR.

## 2026-09-11 — Shared merge-probe cache and first aggregate result

ProjectRefreshStore now persists merge probes inside the existing mechanical_cache_json envelope, keyed by repo identity/main SHA/head SHA/target-base SHA. Reads require both the shared snapshot and probe to be within60seconds; saving does not change snapshot time/digest. Up to200 entries share the existing4MiB cache ceiling. Expired entries are removed on save; unavailable/stale/full cache yields undetermined in production collection instead of an unpersisted pass. Bridge explicitly supplies this cache; private Git objects remain collected/disposed for frozen source evidence. No table or approval path added.

TDD reproduced missing store methods and duplicate production merge calls. Project-refresh6 + production-collect1 + actual Git conflicts3 =10 tests pass; TeamLead tsc and repository lint pass (15 existing warnings). Tests cover tuple separation, cross-instance persistence, backward clocks/expiry, no freshness extension,200-entry admission and repeated production probe reuse.

The first required pnpm test:packages:run exited1 in session74786. Claude-runner reported1 failed/1256passed/2skipped plus one unhandled onTaskUpdate timeout. The deterministic failure was kill-path inventory missing this branch's three new entries (one QA signal0 test and two bounded evaluator-child signals). Inventory was updated only for those three scanner-derived entries, preserving all previous entries/classifications; its5 focused tests now pass. This does not make the failed aggregate run green. Log remains /tmp/fly2399-packages.log. A repaired-head rerun and subsequent package coverage are still required; no contention rerun consumed yet.

Next finish requirement/QA-fixture audit and remaining input cancellation/bounds checks, then final build/full-package verification, review, PR and exact-head handoff.

### Credential cancellation audit — 2026-09-11

Credential resolution now receives the same abort signal as Git preparation and shared GitHub refresh. The host gh auth token subprocess receives that signal in addition to its existing 20-second timeout; already-aborted requests do not resolve credentials or send HTTP. The two new regression tests first failed on absent signal propagation, then passed after the bounded change. Four focused files passed 12 tests; TeamLead tsc passed. This is local transport verification, not authenticated GitHub or semantic-model QA.

Independent QA still owns the frozen semantic expectations, real model results, three mutation kills and real Discord/browser chain in plan section 9. Those are not established by the current mocked evaluator/transport tests. Implementation must provide an isolated replay driver and handoff before its completion; no QA successor has been dispatched.

### Isolated QA replay entry — 2026-09-11

Added scripts/replay-ship-judgment.mjs plus three root Node tests, explicitly wired in CI after build. It accepts one bounded strict frozen packet, invokes the production isolated evaluator, captures raw successful stdout plus validated mapping, and writes a new private local report. Expectations are not an accepted input field; all reports remain acceptance=not_assessed and injected test transport is labeled. Existing output is rejected before a model call, process cancellation propagates, and real missing-binary failure stays a failure. Tests first failed for the absent entry, then all three passed. qa-handoff.md specifies independent expectations, 12-case matrix, source mutations and live-slot evidence still required. No real model/Discord/browser QA was performed.

### B2 timestamp consistency — 2026-09-11

The new outcome observer now requires founder-message verification time to be at or before the original B2 recorded_at, in addition to card <= message <= verification. A future verification timestamp previously classified as founder_verified; the new negative case failed with and without target drift, then passed after the one-condition guard. Inconsistent evidence remains unknown using the original B2 decision timestamp; no authority row is rewritten. Existing outcome and learning tests passed together. The repaired aggregate suite was already running (before TeamLead package start) during this change; it is not an exact-head CI receipt.

### Repository gate receipts before first code review — 2026-09-11

Final lint and recursive build after beaed3e6a passed (lint retains 15 existing warnings). CI enumeration passed: 305 shell suites classified and 49 Node suites enumerated, including the new replay entry. No new scripts/__tests__/*.test.sh was added by this branch.

Full package R1 failed the three missing kill inventory records plus Vitest onTaskUpdate; R2 after inventory repair still exited1 solely with one unhandled onTaskUpdate timeout in claude-runner, despite 50 files/1257 tests passing and2 skipped. Flywheel-comm passed159files/2278tests with2 skipped in R2. Recursion stopped before TeamLead; neither run is a green aggregate. Logs: /tmp/fly2399-packages.log and /tmp/fly2399-packages-r2.log. One allowed pure contention rerun R3 is running at /tmp/fly2399-packages-r3.log; no additional same-cause rerun is planned. Exact-head CI remains a separate pending gate.

## 2026-09-11 — Resume, R1 review and census contract repair

R1 request `28affe11-9424-468c-8d2f-64b9ae9c31a8` returned effective/reviewer APPROVED on frozen `beaed3e6a5c49dc49291b4c805296fe957a712da`. All 17 MEDIUM/LOW findings are archived verbatim in code-review-r1.md, without advisory fixes. The three preserved docs/progress commits were restored by fast-forward from backup/FLY-2399-pre-review-ledger-e74629cdf.

R3 full-package aggregate terminated EXIT1: TeamLead 1028 passed/4 failed files, 13354 passed/4 failed/7 skipped tests, plus one onTaskUpdate error. The four failures were census inventory, founder-budget/materialize 5000ms timeouts, and chat-thread-routes response wording. Lead instruction `aba5c2c7-4e2e-4a79-9fda-4ed5c6ba80eb` classifies the missing subscription-process.ts raw_spawn=1 inventory entry as a real CI contract omission; the other failures are retained as host-contention evidence with exact-head CI authoritative. No full-package rerun or unrelated fix is performed.

The census focused test failed before repair and passed after adding exactly one sorted manifest entry, describing the existing evaluator deadline/output/abort lifecycle. No runtime behavior changed. Full Quick Gate is running from all 28 run commands extracted in order from .github/workflows/ci.yml (including install/build/typecheck/lint and every named contract); result pending, log /tmp/fly2399-quick-gate.log.

Quick Gate first run EXIT1 at its final retention-consumer command: five new exact read consumers were unclassified. Added only those five `(file, relation, baseTable, read)` records with conservative `protect` disposition because visible-receipt reconstruction, cancellation attribution and original-thread links consume retained evidence. This is audit classification, not a deletion-policy or query change; target tables/scanner and existing entries are unchanged. Production scanner now passes and all five gate tests pass, including missing-consumer and anti-join guards. Full Quick Gate is rerunning after this bounded configuration change at /tmp/fly2399-quick-gate-r2.log.

Full Quick Gate second run completed EXIT0 after both inventory repairs: all 28 workflow run commands passed, including frozen-lockfile install, recursive build, recursive typecheck, lint, root Node suites, workflow-seed verification, residue and retention gates. Log: /tmp/fly2399-quick-gate-r2.log. This supersedes only the failed Quick Gate attempt, not the failed full-package R3 aggregate or independent QA. Runtime source remains byte-identical to reviewed beaed3e6a; successors modify documentation and two inventory configurations only.

## 2026-09-11 — Lead upgrades off kill switch to blocking

Lead instructions d07bb2d1-e071-4877-aba2-b2b7d2ebb102 / ac4cfa60-295f-40ac-9467-aa226c845c54 supersede the earlier off-mode acknowledgement/history behavior. The reply observer now exits before source access in off, rechecks after asynchronous fetch, and exposes no reply targets/threads in off. Learning queue/claim pause both ack and clarification, including uncertain scans; the transport pre-POST guard also rejects off. Runtime modeTick performs no outcome observation, learning writes or delivery while off. Existing durable pending work is preserved for re-enable; dry_run and the old approval path remain separate.

New checks reproduced four failures before repair. The 33 learning/runtime/delivery checks then passed, including no source fetch, no total_changes, no model or delivery calls, and off during fetch. Broader regression passed 49 files; seven old cancellation fixtures still expected observation while off and were revised to assert zero before re-enable followed by the original positive/negative cancellation assertions. The full 32-case outcome file passed afterward. No cancellation-source or approval logic changed.

Table census was already current: origin/main bece7de15102c45b376eb2df4cc85eeb55b85e62 has 144 protected-current and 205 total (both golden assertions); this branch has 152/213/213 including exactly eight ship_judgment tables. Added provenance comments beside all three existing values; the full retention test file passed in the broader run. No duplicate eight-table increment. PR disclosure: these fixed census goldens may conflict with #1156/#1160 landing order; the later landing branch must rework against current main.

R2 request 69d44b4e was already running on 66e5d4c87 when the upgrade arrived. Lead bcdee65a-b59e-4505-be35-e5cef860f6fc directs one corrective push, head_moved automatic rerun if still running, otherwise one bounded final-head R3; never parallel reviews. The remaining 16 advisory implementation suggestions are not fixed (the retention advisory is documented, not a retention-policy change).

## 2026-09-11 — R2 CI test-only repair

R2 automatic head-move successor e77881e0 returned CHANGES_REQUESTED on 87aab52be, with only HIGH bridge-runtime-off-mode-test-red. Full findings are archived in code-review-r2.md; seven advisories are not repaired. CI34596676522 showed the same two Bridge test failures (TeamLead3) and one materialize hosted-budget 5000ms timeout (TeamLead1); other earlier auto-narrow failures in the log were expected mutation kills, not the final shard failure.

Lead c7f4133b-68de-4baf-8296-7d9617bcf14a and e096b06b-871b-4b68-9aa8-72e71e33f27c authorize only test changes. The Bridge tests first reproduced two failures, then assert off produces zero network calls, zero total_changes, and three untouched pending ack rows. They re-enable dry_run and retain the original two-per-round, eventual third receipt and missing-bot defer assertions. The one materialize test receives 15000ms timeout; every content/budget assertion is unchanged. Both files pass all ten tests. Production source is byte-identical to 87aab52be. No local full-package rerun; prior complete QuickGate green and aggregate red remain distinct receipts.

Lead 80d70f40-b7a0-4eca-8610-67032d2421ff additionally upgrades R2 off-leaves-opinion-marked-current to required work. Off now calls the existing setMode locally before returning, closing existing opinion accounting without invoking any modeSweep transport. The real-ledger regression first failed because readEpicJudgment remained published, then passed with history, unchanged original message ID, repeat-off idempotence, and no observer/collector/model/learning/mode transport calls. This narrow accounting write is the explicit exception to the prior off zero-write statement; no new learning records or messages are created. Six affected files pass 76 tests including the Bridge and budget repairs. R3 is the final authorized review round; any non-APPROVED result goes to Lead without R4.
