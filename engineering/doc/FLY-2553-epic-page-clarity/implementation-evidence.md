# FLY-2553 固定 Epic 页减噪 — 实施证据
Issue: FLY-2553 (https://linear.app/geoforge3d/issue/FLY-2553)
日期: 2026-09-14
基于: plan.md

## 当前 v5 状态（覆盖下文历史验收，尚未完成）
- 当前授权 instruction `1f730e22-cb8c-46b1-8465-8733f922aa47`；原六段页面/旧 QA PASS 不适用于此次返工。PR #1194 待推新代码、新有效审查及精确头 CI。
- 来源修复 RED `/tmp/fly2553-scope-metadata-red.log`：已在 Epic 范围内但未重复根 label 的 child 缺失身份。复用同一次已证明 team/project/label 范围的 scope metadata；不回退绕过身份 resolver。GREEN `/tmp/fly2553-scope-source-final.log` 23/23，包括跨范围拒绝、错误/冲突和无真实 thread 的负向保护。
- Epic 全量 `/tmp/fly2553-epic-final-local.log` 410通过/1容量超时；focused `/tmp/fly2553-container-capacity-green.log` 54/54恢复；集成 `/tmp/fly2553-integration-recovery.log` 24/24（真实CLI及publisher）。最新 `/tmp/fly2553-scope-recovery.log` 27通过/3失败，其中2容量超时、1新负向fixture期望错误；后者已在23/23中修正。容量超时红回执保留，未调timeout或断言。宿主当时load110.91。最终全仓仍待运行。
- 新布局保留判断时效/隐藏原始时间；附录保留所有出处、无Epic子单、stuck/dependency/freshness事实。遗留mailbox ship与founder标签不独立冒充当前founder_gate。
- 浏览器MCP被approval policy=never拒绝；隔离Chrome exit-6。问题回执 `1140c9ab-cb4d-4dc8-abc0-4743cd175ee4` 明确宿主浏览器/手机展开对照由QA/Lead执行；本节点交publish-only HTML和逐块对照，不声明浏览器通过。

### 当前快照授权（替代旧直接读取生产库安排）
由Lead提供、管理，只读打开并记录SHA256，未创建生产DB副本、未打开生产库：
- StateStore `/Users/xiaorongli/.flywheel/patrol-repairs/FLY-2447__teamlead-global__2026-09-14T23:22:07.130Z__7300d10e-b512-4dd8-9045-0597d2cec143.db`，SHA256 `db090787f5d2da09ffb80899a36802ede0e9b9932310e41d09416b6e589fdc9e`。
- CommDB `/Users/xiaorongli/.flywheel/patrol-repairs/FLY-2329__comm-flywheel__20260914T223653Z.db`，SHA256 `6e658314cf2d386d5310989e0365454ead4e312fe57af205cee556337515ae70`。
- 时间不同，Linear为读取时现值，组合视图非原子快照。初渲染8根78子单，bundle39655B，加固39882B，audit203197B；founder1项身份缺失促成上述修复。最终数值/身份及托管证据待重渲染填入。

### 当前快照实测（2026-09-14T23:57:42.871Z–23:57:49.262Z）
- 8根78子单；founder卡1张 = FLY-2559，来自实际founder_gate holder；Lead待答31项保持折叠，读到的身份不完整继续明确提示。
- FLY-2559 跳转为 `https://discord.com/channels/1485787271192907816/1549152820345835674`，来自授权快照解析，不拼猜ID。
- fixed bundle raw40036B/hardened40263B；audit202877B；同可见模板 standalone266413B，含完整内联审计。均在各自限额内。
- `/tmp/fly2553-v5-snapshots/receipt.json` 与 document.json/index.html/standalone.html 为本轮产物；所有database handles关闭。脚本PASS `/tmp/fly2553-snapshot-final.log`。
- standalone DOM包含16个Discord数值ID链接，Linear标题slug href零命中；CSP meta/真实nonce/零占位符检查PASS。托管验证尚待完成，不能代替真实浏览器对照。
- 最终全仓build PASS `/tmp/fly2553-v5-build-all-final.log`（exit文件0）；lint PASS `/tmp/fly2553-v5-lint-recovery.log`（18既有warnings）；typed来源23/23 `/tmp/fly2553-source-typed.log`。
- `pnpm test:packages:run` 已在810bbbb7d启动 `/tmp/fly2553-v5-package-gate.log`；正在运行。新review gate首次因STAGE_PENDING被拒，未创建reviewer，需待stage事件结算后重试。

### 托管验证
- [v5只读快照预览](https://fw-reports-624a39.vercel.app/r/f23dd6efeaae92086bc1bb6c9609b80e/)；publish-report `--publish-only --no-screenshot` 返回publishOnly=true、messageId=null，没有Discord投递。
- curl实际HTTP200，266413B；1个script含真实nonce且CSP匹配，`__CSP_NONCE__`零残留；FLY-2559实际Discord链接存在、Linear长slug href零命中。证据 `/tmp/fly2553-v5-hosted.headers`、`/tmp/fly2553-v5-hosted.html`。仅证明托管结构，不声称浏览器交互/手机展开通过。
- 逐块对照见 `v5-comparison.md`，Lead手工v5与同模板实数据版可供QA对照。渲染时间/数据来源边界见上。

### 精确头CI发现的巡检mock修正
- a80bc13b0 的 CI run34911438317，TeamLead4/4：234文件通过/1失败，2665测试通过/6失败。失败全部在epic-residual-scan.test.ts：全模块mock没有导出新增readChildThreads，巡检因此返回transient epic_scan_failed。原始证据 `/tmp/fly2553-ci-teamlead4.log`，不记为宿主争用。
- 只将该mock改成partial mock：attention仍用fixture，child thread使用真实只读实现。没有修改生产代码或放宽6项业务断言。
- GREEN `/tmp/fly2553-scan-ci-recovery.log`：20/20，通过缺失scope、巡检receipt、500-item guard、读取失败/结构错误等原有测试。此前源代码构建/预览不受此测试修正影响；最终提交头需新CI/审查。
- 完整package gate进程仍存活，在claude-runner首包内；起始头810bbbb7d，后续测试mock修正发生在运行期间，不能宣称此次聚合为最终头验证。原始聚合结果仍须保留。

### 代码审查HIGH修正（当前验证中）
- Bridge恢复后，Lead说明旧request被自动重新登记为4db38aaa-ccc6-4b47-b108-0669d09bb1a5；同gate d1c9e34b，round2，reviewedHead5f1a1a72d，有效CHANGES_REQUESTED。此前CLI的未注册错误是当时观测，服务已恢复，不再重试旧注册。
- HIGH `founder-review-round-silently-dropped`：真实founder_review/brainstorm轮次通过mailbox checkpoint提供身份，不存在workflow gate holder；一律跳过旧mailbox gate会错误显示confirmed empty。
- RED `/tmp/fly2553-round-red.log` 两个真实CommDB场景均因candidate为空失败；修正只保留classification=legacy且checkpoint为founder_review/brainstorm的记录。current/excluded及旧ship仍不重复进入首屏，分类读取失败仍显式incomplete。
- GREEN `/tmp/fly2553-round-green.log` 来源25/25，通过实际SQL读取→来源→完整page生成→HTML首屏链路，检查EPX-2、真实thread链接及不再显示空状态。
- 三个非阻塞advisory已报告Lead：gate-count-before-node-filter、founder-named-under-waiting-lead、undefined-red-css-var。当前未扩改这些建议。
- 旧5f1a1a72d CI15/15 green，不替代修正后新头CI/审查。新lint/build/Epic全量已启动，结果待续。
- 本地原全仓gate ollnHS仍运行。中间receipt：claude-runner failed30（console显示20，保留差异），comm failed3（console显示1），TeamLead14355pass0failed+onTaskUpdateRPC，自动retry中。不能按只有RPC的合格artifact接受整个聚合；详细红回执保持原状。

### HIGH修复验证
- `/tmp/fly2553-round-epic-all.log`：29文件440项全部通过，包括两种容量测试、源码来源与巡检。
- 全仓build `/tmp/fly2553-round-build.log` exit0；lint `/tmp/fly2553-round-lint-green.log` exit0、18既有warnings；修复一次新增测试import排序，未改断言。
- 2026-09-15T02:12:41.164Z–02:12:45.760Z，复用同一授权快照pair+当前Linear：8根78子单；founder2项（FLY-2559真实ship + 1条明确founder checkpoint身份未知，保持未知不猜链接），Lead31。raw40086B、hardened40313B、inline standalone259419B、audit200805B，仍≤80KiB/512KiB；receipt在/tmp/fly2553-round-snapshots。
- 宿主Comm adopt-inflight失败以原文件定向复核5/5通过 `/tmp/fly2553-host-comm-recovery.log`，没有改test或生产代码。原聚合仍红，runner超时文件恢复及TeamLead自动retry待结果。

### 最终验收口径（Lead当前裁定）
- 回执1fa0dc82及f2656837：只修HIGH；MEDIUM/LOW写follow-ups.md。一次push（milestone-last）、一次新头review；新头CI15/15与effective APPROVED是本PR完成依据。
- 原本地全仓ollnHS记录为 interrupted-under-contention / not relied on，不作为前置gate。保留所有原始red receipts，不重跑、不编辑；此前已启动的定向恢复记录不涂绿聚合。Lead确认隔离CI运行同套件，不需要额外独立gate。
- HIGH修复预览：https://fw-reports-624a39.vercel.app/r/e9beceaf60a27859d0a4fdaf610d7f93/ （publish-only，messageId=null），同可见v5模板含完整审计。最终CI与审查仍需绑定新头。

## 历史记录（非当前头通过证明）

实现提交 75cbeb027；不是最终审查/CI头。

- 设计审查 c41ec5ec-eac1-4cb5-911c-027fda9a142e：effective/raw APPROVED，9条非阻塞建议已报Lead。
- C3裁定 9f38ecff：E1 60子单及真实生产读视图≤80KiB；满长note/judgment/history扩展fixture保持512KiB、不得减信息。
- C4/C6裁定 5ac5dde3：直接readonly读取生产DB，不调用snapshot-owner；本节点本地产物和CSP验证，QA/Lead负责托管。
- TDD红：clarity 3失败（旧顺序/278623B）；SQL新增3失败；attention分区1失败；预算优先级1失败。日志分别 `/tmp/fly2553-clarity-red.log`、`/tmp/fly2553-db-red.log`、`/tmp/fly2553-attention-red.log`、`/tmp/fly2553-budget-red.log`。
- 绿：`pnpm -r build` PASS；`pnpm lint` PASS（18 warnings）；Epic+route 29文件425项 PASS；CommDB 14项 PASS。日志 `/tmp/fly2553-build1.log`、`/tmp/fly2553-lint1.log`、`/tmp/fly2553-epic-all1.log`、`/tmp/fly2553-db-green.log`。
- E1原样8根60子单：278623 → 81830 B。每子单完整事实和展示规则入现有无损sidecar；保留旧总览Cell出处，删除的只是四段HTML总览。
- 扩展60子单68条满长note/60judgment/20history：264844 B（加托管meta265158 B），信息没有缩短。

## 生产只读证据
命令：`node engineering/doc/FLY-2553-epic-page-clarity/render-readonly.mjs`。
2026-09-14T18:15:21.788Z 至 18:15:25.202Z，8根73子单。
- HTML 46527 B；本地加真实nonce/CSP 46754 B；audit 156933 B。
- founder显示1项（身份未解析，保留未知提示）；Lead待答30项，默认折叠。读取时 holder0、mailbox31、Linear founder_review0；来源原始统计见 `/tmp/fly2553-readonly/receipt.json`。
- 产物 `/tmp/fly2553-readonly/index.html`，同目录有hash绑定audit文件。CSP meta存在、nonce已替换、无外部script/iframe/img src。
- 此为实时只读窗口，不声称两个数据库是原子快照。所有database handle均已关闭。
- 生产schema落后：缺ship_judgment_opinion（现有reader明确缺失）；publication缺新增digest列，验收脚本仅查询已有freshness列，不伪造列或迁移DB。
- fixture与代码零人名；生产唯一姓名来自Linear FLY-1098原始Epic标题里的姓名。未引入姓名替换表，已向Lead询问4eea26b4，不声称生产全文零命中。
- Chrome使用隔离profile启动exit134，尚无真实手机/桌面PNG；不把DOM/CSS测试充当实浏览器验收。产物已可交QA/Lead。

## 尚未完成
全仓 `pnpm test:packages:run` 正在运行，日志 `/tmp/fly2553-packages1.log`；代码审查、PR、精确头CI与needs_review尚未进行。
Lead instruction 5b6fd7cd-f3a0-4eb1-ae5f-2c183e96817e要求开PR前合main的独立容量测试timeout热修复。
本单收到前已对同一个测试增加JSON文档上限判据（没有调timeout）；已问972b041b如何保留该必要语义调整，收到回复前不再编辑该测试。

## 后续裁定与修正
- 972b041b：Lead确认保留75cbeb027容量循环的JSON硬上限语义调整；FLY-2556负责timeout，开PR前合main。
- 4eea26b4：F13零人名适用于代码、fixture、labels/generated copy；Linear源标题照抄原文。源标题有姓名不构成此项失败，不做姓名替换表。
- 同一裁定确认Chrome sandbox exit134后，本节点CSP结构验收足够；host/mobile由QA/Lead验收，HTML路径已交付。
- 代码审查c17ce446注册成功（request ffc4337e，头86a1633a0），仍待结果；后续ce34cb295已使其成为旧头审查，不能用于最终验收。
- ce34cb295：自查发现09:00:00Z与09:00:00.999Z按字符串排序会选错最新问题，改为解析时间值比较；TDD日志`/tmp/fly2553-latest-red.log`、`/tmp/fly2553-latest-green.log`，61项attention测试PASS。
- 全仓package suite开始于上述修正前，运行中的结果不声称修正后的exact-head证明。

## 代码审查与锁定补修
- c17ce446 最终读取回执为 round2/request0c2d960c，effective/raw APPROVED，reviewedHeadSha=44a9a26c07e0c72f156c8e3464946a18ca0bb523。以结构化回执为准，取代前文尚待审查的状态。
- Lead 8c7bab4f裁定仅补三项：CSS共享卡片回归、报告前缀不得排除founder checkpoint、publisher超限测试饱和量；其余五项进PR follow-ups，最终新头复审非HIGH不再扩改。
- 135236ba5 完成这三项。CSS/前缀新增失败测试均先红后绿；publisher 270000/600000字符场景再次真正跨过上限，原拒绝/保留上一页断言保留，另证明缩减后完整history Cell仍在sidecar。
- `/tmp/fly2553-publisher-green.log` 27项 PASS；`/tmp/fly2553-prefix-green.log` 15项 PASS。
- 待写PR的五项follow-up：runner_lifecycle founder consent分类、unknown事项分区策略、unprotected legacy gate虚挂、Markdown诊断分区、验收脚本输出权限。
- 仍未push；等待FLY-2556 PR1190合入main，合并后一次push并注册单一新头review，再开非draft PR与exact-head CI。

## 全仓结果与相关断言恢复
- 全仓 `pnpm test:packages:run` 已结束，exit 1；TeamLead 1114文件中2失败/1112通过，14335测试通过/2失败/7跳过。日志 `/tmp/fly2553-packages1.log`；package receipt `/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/flywheel-package-gate-dKasKs/summary.json`。该聚合结果保持红，不以focused恢复改记全绿。
- 两项失败均由 `/tmp/fly2553-aggregate-red-repro.log` 复现：lead-note-e2e旧正则把必需无判断占位句当作残留判断；materialize预算断言在9月9日生成后使用9月3日时钟重渲染，523138B变为524318B。
- ca632a399仅调整这两项测试：清空后验证无实际 `data-lead-written-at` 元素且占位句存在；容量断言使用生成时钟，保持512KiB上限不变。
- `/tmp/fly2553-aggregate-recovery.log` 两文件7测试PASS（含真实CLI写入/清空/稳定token与两种容量场景）。最终验收仍需合main后新头审查与精确头CI。

## 合main前本地收尾（43e24088d）
- `pnpm -r build` PASS `/tmp/fly2553-build2.log`；`pnpm lint` PASS `/tmp/fly2553-lint4.log`，18既有warnings。前一轮lint仅新增测试长行格式红，43e24088d修复。
- Epic目录+lead-note-e2e：29文件401测试PASS `/tmp/fly2553-epic-all2.log`；bridge route+publisher：2文件50测试PASS `/tmp/fly2553-routes-final.log`；Comm命令+attention DB：2文件24测试PASS `/tmp/fly2553-comm-final.log`。
- 18:59:19–23Z生产direct readonly实时视图：8根74子单，raw49428B/hardened49655B，audit163784B；founder2项（身份缺失明确保留unknown）、Lead30项折叠。CSP/nonce/no external src结构断言PASS；仍为本地HTML，不声明托管200/手机视觉已验收。
- 生成物 `/tmp/fly2553-readonly/index.html` 与同目录receipt.json；旧schema缺ship_judgment_opinion继续明确missing，无迁移/数据库复制。
- 全仓红回执保持原状；PR1190仍OPEN，等待合入后同步main、单一最终头review与CI。

## Founder v5 返工首批（2026-09-14 23:17Z；未完成）
- 新授权：Lead instruction 1f730e22-cb8c-46b1-8465-8733f922aa47；现有 PR1194 继续更新，旧 QA PASS 不能证明新版式。
- 已读取仓内 build-mock.py/mock2，curl 成功保存 v5 参考到 /tmp/FLY-2553-reference-v5.html。Web open 失败不作为不可达证据。
- TDD：/tmp/fly2553-v5-red.log 11通过/2新断言失败；后续 /tmp/fly2553-v5-focused.log 新版式、短Linear、子单链接生成到渲染 3通过。
- TDD：/tmp/fly2553-materialize-thread-red.log 证明绑定读取从未调用；green.log 1通过。绑定已接到 route 与 residual scan 的统一 materialize。
- TDD：/tmp/fly2553-review-noise-red.log 证明 code_review holder 被误收；green.log 1通过，改为只接 founder_gate holder。尚需全面对账 legacy mailbox gate 与 founder_named 来源。
- TDD：/tmp/fly2553-child-binding-red.log 证明畸形 guild 被拼成URL；green.log 2通过。缺失/冲突/读取错误保持 missing Cell，后续补负向覆盖。
- /tmp/fly2553-v5-typecheck2.log tsc --noEmit exit0（晚于链接接线，早于最后 CSS/附录整理）；不等于最终检查。
- Chrome DevTools new_page 被 approval policy=never 拒绝，未执行；本地 headless Chrome exit -6，无截图。不能声明手机/桌面视觉已验。
- 全Epic suite /tmp/fly2553-v5-epic-all.log 运行中（exec session84836）；包含修改过程中的头，仅用于失败盘点，最终需静止头重跑。
- 可见层已去旧总览、移判断到展开卡内、精简计数、移逐卡审计到附录；保留审计内容及 nonce。尚待新版式全部断言调整、完整计数/节点文案/短标题核验、实际只读快照、托管、全仓检查、新头review/CI、needs_review。

## HIGH修复托管与原始receipt附件
- 新预览首次curl502，保留该瞬时失败；随后curl200，259419B，1个真实nonce script与CSP匹配、零占位符。URL e9beceaf60a27859d0a4fdaf610d7f93；仍无浏览器视觉通过声明。
- 原始机器JSON receipt按字节原样附在同目录 `.receipt` 文件（扩展名仅用于避免格式化改变原始证据）：host-claude-runner-receipt.receipt、host-comm-receipt.receipt、host-teamlead-receipt.receipt。未改complete/failed/errors字段，不用汇总口径覆盖原值。
- SHA256依次：dbd21d50c3397155a985fabd7acc4ab3853053459ddd22d8a682cc613f32c759；550a5c3754a63a8fa2d08a0a0486e7cd42524b41e11a8cb6593fee822b130d2a；5c6b397d9275bc14ef920cf5d7930459d38e4e8d5e5662ea01aac12cd96b65d0。
