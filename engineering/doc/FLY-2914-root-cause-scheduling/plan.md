# FLY-2914 病根排修闭环 — 实施计划
Issue: FLY-2914 (https://linear.app/geoforge3d/issue/FLY-2914/巡检闭环-6-巡检每轮自动列出病根类别出现-3-次且没有修复单在跑-lead-必须呈报-founder-排修让巡检发现的问题变成自动机制)
日期: 2026-09-25
基于: research.md

Status: review-pending
Task category: code
Baseline: 923d7a551

## 一句话
每轮把反复出现、还没人执行修复的病根列出来；Lead 逐条交代呈报或排期，已呈报等待 founder 的类别不重复催。

## Founder 视角
快照 STEP 6 增加“病根待排修”段，按次数降序列完整清单、标题、计数差异、当前处置。每项必须有本轮 thread 呈报消息、仍有效的等待回执或具体排期理由。没处置不能完成巡检。这个机制帮助决定先修什么，不自动建单、派单或修改 Linear。

2026-09-25 只读盘点：210 张直接子单，60 张达阈且非 Done/Canceled；3 张有 active run，剩 57 张。FLY-2373 现有 active run，故排除；标题 ×34 / 描述 31 的差异仍展示。该盘点不是实现验收。

## 1. 范围与不变量
1. 只读 Linear，不增加 occurrence、不写 comment、不改状态；新增排修判断不调用既有病根记账的写路径。
2. 使用既有快照报告、FINDING、judgment 和 receipt，不增加消息通道、timer、自动调度、通用排期平台或新等待表。
3. 复用 founder_ask 的真实投递/回复生命周期，只增加一个 nullable `patrol_schedule_key` 身份列及针对未结算行的唯一索引。
4. 六个 numeric STEP + DWELL 和三个 Bridge gate 计数不变。新检查归 STEP 6，第 3 gate 执行结构检查及服务端回执核验；不改三位 `pj:` receipt 编码。
5. 消息回执只是“呈报发生”的证据；founder 回话只是等待结束，绝不作为 dispatch/ship 批准。
6. 所有候选保留，不用 top-N、分页显示或摘要条数裁掉门的输入。

## 2. 只读候选收集
### 2.1 一个 collector、两个入口
新增 `packages/teamlead/src/patrol-root-causes.ts`，包含固定查询、计数解析、候选筛选和结果 schema。使用现有 @linear/sdk / zod / crypto；不新增依赖。

- 固定 root 为 FLY-2072，先 exact lookup 验证 Flywheel project/team/parent UUID；项目非 flywheel 的巡检写 `not_applicable`。在 flywheel 内按现有 DepartmentRegistry 确认负责 Lead，非负责 Lead 展示 owner 与 not_applicable，不跨部门擅自呈报。owner 不可解时 unavailable。
- 固定 GraphQL query + variables：直接 children，first=100、after、includeArchived=true；取 UUID、identifier、title、完整 description、state.name/type、parent、project、url、updatedAt；不递归孙单。
- 沿 hasNextPage 到 false，重复/空 cursor、GraphQL errors、重复 UUID、parent/scope 不符、超时/超页均 unavailable。上限 30 页 / 3000 行 / 本轮总 deadline 30 秒；达到上限且仍有下一页不得返回 complete。异常原因写稳定 token，不泄露 token/body。
- title 只认尾部 `· ×N`（允许相邻空白），description 只认独立行 `occurrences: N`；N 为非负安全整数。两处有效取 max，记录 titleCount/descriptionCount 与 mismatch；一个有效用该值并报告 missing/invalid source；都无有效计数写 diagnostic，不默认为 0。有非法或重复冲突元数据仍保留可证明的下界与问题，不能静默跳过潜在达阈类别。
- 普通 Epic 管理子单两处计数与 class_key 均无、标题也无病根标记时作为 non-category 排除并统计；有类别标记但计数均不可读则 source incomplete，完成门不能将清单视为空。
- 只排除 state.type completed / canceled，遵守本单字面条件；Duplicate 当前不作为新增排除条件。不得用显示状态 In Progress 推断 run。
- 同一次只读 StateStore 观测，参数化 `project_name=? AND issue_id=? AND status='active'`。当前 issue_id 是 identifier；使用读取到的 canonical identifier 调 getActiveWorkflowRun，不将 UUID 生塞入字段，不以 session/PID/node 猜运行状态。held 不等于 active。
- 本任务按类别子单自身 run 判定；没有明确规范的“描述里提了另一张修复单”不作为排除依据，不做 title 相似匹配。以后需要显式关联修复单属于 follow-up。
- class_key 唯一合法 64hex 为类别身份；缺失/非法时保留 item，identity 使用 child UUID 并报 diagnostic。多个 child 共享 key 不求和、不合并，分别列出并报 duplicate_class_key，避免重复账隐身。
- `scheduleKey=sha256(JSON.stringify([projectName,parentUuid,childUuid,classKey-or-null]))`；不含 title、次数、tick、lead activation。改标题/次数不重开等待；重建 child 或 classKey 改变为新身份，并提示旧绑定不可复用。
- 排序 occurrences DESC，再 identifier ASC。计数差异诊断包括 active/terminal 排除项；FLY-2373 不能因被排除而丢掉 34/31 差异。

### 2.2 接入与事实来源
`bridge/lead-capability-read.ts` 已有 linearClient、StateStore；在 `lead-patrol-registration.ts` 确认不是 requestId replay 之后才收集。可信父进程生成 `rootCauseFacts`，通过 `lead-patrol-snapshot.ts` 的私有 scratch JSON 喂给 shell；不接受模型 envelope 提供这份事实，credential 不传 child。新增 helper 必须进入 PATROL_HELPER_SOURCES pin；编译包/安装脚本路径一并核对。

传统 `flywheel-patrol-snapshot` 使用同 collector 的编译 CLI 入口，凭据复用当前 Linear 读取配置（不打印），active runs 读取已有 managed DB snapshot；无法取得任何一源则明确 unavailable，不回退为 empty。CLI 为 `scripts/flywheel-patrol-root-causes.mjs` 固定 realpath 到 dist，不接受任意 module 或 executable。Bridge 可直接使用 collector，不绕 shell 自发 HTTP。

snapshot 仍只收集事实，不发送消息、不写 founder_ask。每份报告保存 `ROOT_CAUSE_REVIEW`（status/observedAt/parent/count/sourceDigest）、全部 `ROOT_CAUSE_CANDIDATE <JSON>` 与 diagnostics。JSON 一行编码换行，展示字符串另作 Markdown 转义；title 不能伪造 STEP/FINDING。注册的快照摘要绑定完整段，judgment 合并不得删除/改写其原始候选；传统完成检查重新采集 STEP 6 事实，校验完整候选集与 sourceDigest；不相同返回 root_cause_snapshot_stale，要求只刷新本段并重新处置，不重跑其它 STEP，不能只相信模型删过的报告。sourceDigest 仅覆盖规范化候选事实（不含观测时间、volatile 等待投影）；Bridge 用注册原段作基线，无需重新读取 Linear。

## 3. 沿现有 founder_ask 记录等待
### 3.1 最小增量
`StateStore.ts`：FounderAskRecord 增可选 nullable patrol_schedule_key；迁移 PRAGMA 检查后 ALTER ADD，旧行 NULL。索引 `(project_name,patrol_schedule_key) WHERE patrol_schedule_key IS NOT NULL AND settled_at IS NULL` 唯一。保留既有 ask_id、issue_id（沿实际 resolvedIssueId）、thread、lead、message_id、settled_*；不另建表。`founder_ask` 已在 retention protectedCurrentOrReference，新增列不改变旧 retention 分类。

`insertFounderAsk` 只在有 schedule key 的路径进行事务 find-or-insert，以唯一索引抵御并发；返回已有 open ask 时不得再发送。非排修 ask 行为不变。collector 用同 project + key 精确查 open ask，不用 getLatestFounderAskForIssue（其无 project 限制），也不扫描截断的 listOpenFounderAsks。

### 3.2 两种真实发送入口均覆盖
- 传统 Lead：已有 `bridge/tools.ts /chat-threads/send` 的 founderAsk 增可选 `patrolSchedule`，内容为注册候选 identity（issue UUID/classKey/sourceDigest），服务端 fresh 验证 scope/owner/root membership 并计算 key，不能信模型给的 key。仍用原 thread 和 Lead 发送权限。
- Codex：`catalog.ts discord.thread.reply` 增同 optional patrolSchedule；`handlers/discord.ts` 的既有 sender enqueue/deliver/reconcile 中绑定同一 founder_ask。复用既有 requestId 投递去重和 durable outbox；实际持有 StateStore 的 trusted adapter 注入绑定/回填回调，不让模型读写库。
- 新的排修消息限制为单条 ≤1800 字，包含完整 issue identifier、次数、排修请求及 schedule key marker；通过现有 split helper 前限制，避免第一块成功但请求正文在失败的第二块。其他非排修长消息逻辑不变。
- 先 durable reserve ask，再发，再以真实返回的 messageId backfill。message_id NULL 是 sending/unknown，不能当“已呈报”，也不能因下一 tick 重发。已确认发送失败才 settle send_failed；timeout / 连接断开不能直接 settle 为失败，先用现有 outbox receipt 或 exact message marker 回读恢复；无法证实时保留 unknown，给明确重查动作。
- 传统路径这条特定发送增加稳定 requestId（从 askId 派生）和 marker 回读重试保护；不全面重写旧 send route。确认没发才可按同 requestId 重试。并发同 key 的另一次请求返回 existing askId/投递状态。
- messageId 存在且 settled_at NULL 才是 waiting_founder。同项目/类别的未结算 ask 跨 tick/activation/重启沿用。次数增加不重置它。
- founder_ask 既有 authenticated founder ingress / scan 结算逻辑继续使用：本类别所在 canonical issue thread 中真实 founder 回复即结束等待；这表示需要 Lead 重新判断，不表示同意修复。任何 bot、别的线程或更早消息不能结算。读取失败保留等待、不触发重复发送。
- settled founder_reply / question_answered 后，下轮不自动再次呈报：Lead 依据回复记 scheduled 理由，或明确提出新的排修问题并开新 ask。lead_withdrawn/send_failed 不能证明已呈报；需要新处置。

## 4. 完成门：一项清单对应一项处置
继续用 schema=2 `FINDING category=incident step=6 bridge_problem=no result=escalated-with-plan`，`evidence=rootcause:<scheduleKey>`、owner=founder 或 agent:<lead>、next=route:rootcause-schedule / inspect:rootcause-schedule，epic/epic_marker=n/a。这里“incident”是本轮未排修处置，不把已登记病根再次声明为 mechanism_defect；不走 Linear 写账。

FINDING 增可选 `disposition_ref` **仅对 evidence=rootcause:<key> 的 incident 允许**；一般 incident 继续拒绝机制 disposition 字段。同一报告追加 `ROOT_CAUSE_DISPOSITION <JSON>`（是既有 receipt 格式的同报告记录，不是新报告/消息通道）。同步修改 catalog、patrol-judgment、patrol-report 与 runbook AWK allowed keys，不能只改一个入口。

字段：ref、findingId、scheduleKey、mode、askId、threadId、messageId、reason、owner、nextReviewAt、sourceDigest。严格 exact keys，互斥分支：
- `reported`：本轮 report observedAt 之后创建、投递成功的精确 founder ask；服务端核对 key/project/issue/thread/messageId、sender 和真实发送凭据。消息必须含本候选的排修请求。
- `waiting_founder`：前轮投递成功且仍未 settled 的同 key ask；引用原消息，不再发送。即使本轮未发也满足“已有处置”。
- `scheduled`：明确已有排期/延后理由，owner 与未来 nextReviewAt 必填，reason 至少 10 字，拒绝 TODO/TBD；askId/thread/message 可为 null，有依据时引用。仅证明 Lead 记录了可追责的排期，不伪造 founder 同意。nextReviewAt 过期必须本轮重新说明；不通过纯“稍后”或只有任意 URL。

服务端回执校验与纯结构校验分离但必须同时通过：
1. validatePatrolReport 校验候选完整性、每个 scheduleKey 恰一个 finding + disposition、无多余/重复 ref、STEP 6 为 FINDING、有异常不允许 OK、模式结构有效。
2. 共用 trusted verifier 读取 founder_ask/current source 与原 snapshot registry（Bridge 路径），验证 reported/waiting 的精确证据以及 scheduled 时效。Bridge 在 gate 3 内调用；传统 `patrol-continuity validate-report` 增受限 --project/--lead/--db（只读）及 collector 配置，调用同 verifier；runbook 更新参数。无真实数据源不能只跑纯 validator 后宣布完成。
3. 对有 ROOT_CAUSE_REVIEW 的新报告，missing/unknown 数据、缺候选、缺处置、错误 key、假消息、过期等待、sourceDigest 不符均 complete=false。新生成的 flywheel 负责 Lead 报告强制有该段；删整段也必须失败，不只“出现该段才检查”。其它项目/非负责 Lead 必须有显式 not_applicable 及 scope 依据。
4. 如果报告之后 run 已开始，允许 fresh collector 的具体 active run 证据将该项标记为排期已执行；记录在 scheduled reason 并引用 runId，不靠模型删掉旧候选。其余原候选仍需处置。Bridge 注册报告之后新出现的候选归下一次快照；传统入口 fresh 发现变化则本段 stale，刷新再验。不声称跨 Linear 与 SQLite 存在事务快照。
5. 保留其它 STEP 6 FINDING，更新排修处置不得删除原有异常。

## 5. 实施次序（逐步失败用例 → 最小实现）
### A. 收集器与真实样本
新增 collector 测试，覆盖下列矩阵；然后实现固定查询和筛选。将 live-census 的去敏样本缩减为 fixture，不把全量真实描述塞测试。接入 shell、Bridge registration；补固定 helper pin/安装与编译路径用例。

### B. founder_ask 最小绑定
增加 nullable 列、唯一索引与共享 reserve/backfill 查询。扩展两种现有发送入口和 sender reconcile，先测并发、timeout、crash gap 再实现。验证原 founder_ask 回复结算、非排修发送和 UI attention 不回归。

### C. 完成门与 runbook
补候选/处置 schema 与 incident 的窄 disposition_ref 例外。先写“有清单却无处置 → gate 3 fail”单测，再同步纯 validator、Bridge、传统 CLI、AWK 与操作说明。服务端 verifier 不允许用自述 JSON 代替库回执。

### D. 仅相关测试与只读验收
在 packages/teamlead 运行精确文件 vitest（禁止全仓）：
`pnpm exec vitest run src/__tests__/patrol-root-causes.test.ts src/__tests__/patrol-report.test.ts src/__tests__/founder-ask-store.test.ts src/lead-capabilities/__tests__/patrol-completion-gates.test.ts src/lead-capabilities/__tests__/patrol-judgment.test.ts src/bridge/__tests__/lead-patrol-registration.test.ts src/bridge/__tests__/lead-patrol-snapshot.test.ts src/bridge/__tests__/founder-ask-scan.test.ts src/__tests__/fly369-patrol-rule.test.ts`
新增发送绑定测试放既有 Discord handler/tools 对应 test 文件，运行这两个精确文件；实施者先 `rg --files` 确认测试现名，禁止用不存在文件造成“零用例绿”。shell 运行 `bash scripts/__tests__/lead-patrol-snapshot.test.sh` 和 `bash scripts/__tests__/patrol-continuity-launcher.test.sh`。必要时 typecheck 仅受改包；不跑整仓测试。

## 6. 必须通过的测试矩阵
| 类别 | 证据 / 预期 |
|---|---|
| 基本阈值 | 2 不入选、3 入选、降序稳定；title=2/body=3 取3且 mismatch |
| 实际计数 | title34/body31取34；单一有效源可用但告警；重复/负数/overflow/两个都坏不静默归0 |
| 完整性 | 210+项多页、archived 子单、cursor cycle、缺末页、429/超时；不完整不得报告空健康 |
| run | exact project+identifier active 排除，即使无 session；held/terminal run 不排除；别项目同 id 不影响 |
| 身份 | 改 title/次数 key不变；missing class仍列项；重复class两单不合并；重建UUID旧receipt不可用 |
| 必须负例 | 有一项候选且零处置 gate不过；两项只处置一项不过；删整段/删候选/改digest/重复ref不过 |
| 回执 | 任意链接、自述messageId、别thread/issue/key、send_failed、unknown/queued都不算已呈报 |
| 等待 | 已发送未回跨3 tick/重启不重复；founder真实同thread回复结束等待；bot/旧消息不结束 |
| 并发与故障 | 双 Lead/tick 只 reserve一条；发后 crash、超时有真实投递可回读恢复，不盲重发；partial-send禁止 |
| 排期 | 有owner+具体理由+未来复查可过；空理由/过期理由不过；founder回话不产生派单权限 |
| 两载体 | shell 与 Bridge 相同候选/门结果；receipt replay不读取新Linear；source unavailable不得降级为OK |
| 安全与范围 | 恶意标题换行/HTML不可注入报告；API spy 断言仅query无Linear mutation；无自动派单调用 |

## 7. QA 与交付证据
实现后以当前 FLY-2072 数据运行一次真正的 `flywheel-patrol-snapshot --project flywheel --lead flywheel-eng-lead`，保存报告、观测时间、完整性/页数、排序清单及排除依据；不把本设计盘点冒充该验收。
FLY-2373 若仍有 run，须记录其 active runId 排除；另用同一采集链 fixture 移除 run 后证明列入且34/31取34。若 live 无 run 必须在清单。不得为测试变更生产 run 或 Linear。
保存两个载体的门失败/成功用例和等待去重次数证据。真实 founder 呈报不由设计/QA擅自发出；发送行为用现有测试 adapter，不声称实发 founder。

## 8. 迁移、回退和失败边界
新列默认 NULL，不凭旧标题/旧 arbitrary ask 自动迁移已呈报状态；首次启用未绑定项需真实呈报或排期理由。原 founder_ask 保留用于审计，retention 不自动清理等待项。旧代码可以忽略 nullable 列，回退要成套回退 collector、validator、rule/manifest 与 capability schema；只回退 rule 会造成假完成。回退期间明确功能未启用，不把缺新段的旧报告当新验收。
没有新长期缓存、重复词表或抽象调度框架。部署由独立 updater 按窗口执行，merge 不等于已部署。设计节点不实现、不请求 ship、不派后继；经有效 APPROVED 后提交并发布 founder HTML，报告 Lead，再 exact phase_design_complete + park。
