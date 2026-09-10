# FLY-2453 自动合并窄口开关 — 验收
Issue: FLY-2453 (https://linear.app/geoforge3d/issue/FLY-2453/2309b45-自动合并窄口开关founder-一句现在放开-现在停止切换开着时同时过三道闸机器判纯文档-人声明-pure-docs)
日期: 2026-09-09
基于: plan.md

## Implement attempt 3：QA claim994 授权凭据降级

Lead指令04e67442（rework fd03c6ab、TURN epoch19）限定修复两种stored auto状态。提交 `a19524447`：没有控制事件时返回 `{mode:'dry_run', degraded:true, reason:'receipt_missing'}`；控制事件revision与flag row不同则返回相同降级状态及 `reason:'revision_mismatch'`。类型联合增加两个reason，现有卡片enrichment/renderer直接展示；三闸和控制写入逻辑不变。

Founder可见行为：两种授权凭据异常都保持dry_run，手机flag卡分别显示「已降级（receipt_missing）」或「已降级（revision_mismatch）」。

- TDD：缺事件案例在原reader返回degraded:false而红（`/tmp/fly2453-a3-missing-red.log`）；修复后补齐卡片共用时钟所需changelog fixture，真实reader、enrichment、HTML全部通过。revision案例使用真实apply生成控制事件，再仅推进flag row revision；原reader同样红（`/tmp/fly2453-a3-revision-red.log`），最小分支修复后整份flag套件12/12通过（`/tmp/fly2453-a3-green.log`）。两个案例均保持mode=dry_run。
- 卡片变异：仅移除renderer降级提示，两个新期望都在真实HTML上失败，driverexit1、2 failed/10 skipped；`/tmp/fly2453-a3-card-mutant.log`。恢复renderer后五份相关套件81/81退出0（`/tmp/fly2453-a3-focused.log`），涵盖runtime、通用卡片、report controls与窄口gate。
- 完整门禁全部exit0：`pnpm lint`、`pnpm -r build`、`pnpm typecheck`、`bash scripts/__tests__/auto-narrow-rollback-precheck.test.sh`，以及精确 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 npm_config_workspace_concurrency=1 pnpm test:packages:run`。日志 `/tmp/fly2453-a3-{lint,build,typecheck,rollback,packages}.log`，退出码汇总 `/tmp/fly2453-a3-gates.json`。
- 本次完整包命令包含claude-runner46文件1138通过/2跳过、TeamLead907文件12334通过/6跳过、voice60文件649通过，所有包均完成；本轮没有旧的real-TUI或onTaskUpdate RPC失败，不需要补验代替聚合收据。未新增测试文件，沿用现有CI分片。
- 整合最新main：5cbd540f1带入FLY-2454/2446/2460，按Lead回答184e09fc使用普通merge，提交 `2ecdb6bae`，不rebase/force。三处冲突最小合并：registry保留双方条目与文案（27项）；retention保留双方表（127引用保护、188总表、185去retired）；Discord选项同时保留signal与nonce/enforceNonce。旧计数分别125/26先红，按真实并集修正后通过。
- 上述完整包绿收据属于整合main之前。按Lead184e09fc明确要求，整合后不重跑本地全仓，只重建config依赖并跑冲突文件和本单窄口套件：config2文件68测试exit0、TeamLead10文件130测试exit0，日志 `/tmp/fly2453-a3-merged-{config-build,registry,focused}.log`。最终合并头以fresh exact-head CI14/14为完整回归门禁，不把合并前全包收据冒充合并后全包。
- 原头cf065cff2的review d797c330 APPROVED与CI34418034145 14/14是上一批收据。本轮按Lead6cba7250裁定以已授予的TURN推进，不再等待投递失败的正式wake；最终milestone-last后一次普通push，另取新头review与CI14/14。
- 限制与未做：本轮只有隔离StateStore和真实HTML断言，未重发529；沿用attempt1真机证据。此前截图工具受限的披露仍适用，没有新增截图收据。未改生产DB/flag/Discord，未merge/ship/部署/重启服务。其余审查follow-up依既有裁定保留，完整本轮意见以fresh review为准。

## CI 重复失败与两条追加必修意见

前一冻结头 `b0aa0f66fd5c7f8380737422fd37b06fb0b261d9` 的审查 gate `616f449f-0dc8-48f4-bd32-1ca30aa62102` / request `156db11b-69fa-49d4-887b-84fc471e9282` 为 APPROVED；CI run `34413665275` 两次均在 heavy job 的 TmuxAdapter helper payload 测试失败（第二次 job `102677591004`）。这些收据不替代本轮新头门禁。

Lead 回答 `562076fb-6624-41e8-88a0-13a83a9c9c76` 授权分支2b：确认降级卡片改动不执行于 `ensureRunnerSession` 路径后，只让该测试使用固定时钟，保留 `deadlineMs: 1` 与原断言。相对旧绿头9bb58b9e5，claude-runner无代码差异，config变化是擦除的类型字段；真实墙钟可能在进入helper前耗尽1ms。提交 `f4d12d10e` 仅改该用例，以 finally 恢复 Date.now。TmuxAdapter170/170与claude-runner46文件1138通过/2跳过均exit0，日志 `/tmp/fly2453-clock-tmux-green.log`、`/tmp/fly2453-clock-claude-runner.log`。

Lead 回答 `15c4feec-a03d-434a-9d57-6196d2aae8d1` 将以下两条 advisory 改为本轮必修，提交 `7c84a748d`：

- `wilson-negative-breaks-opinion-insert`：21个机器可批但人工拒绝的样本，Wilson下界浮点误差为 -1.1731740316366828e-17，真实StateStore意见插入被 `confidence_lower BETWEEN 0.0 AND 1.0` 拒绝。下界限制到[0,1]；N=5..200全窗口零成功数值测试与N21真实插入测试通过。RED日志 `/tmp/fly2453-wilson-red.log` 与 `/tmp/fly2453-wilson-insert-red.log`，不是只检查输出文字。
- `projector-resets-posting-delivery`：真实reconciler等待POST期间投射批准，旧projector把posting重置pending，测试观察到第二次POST。现在保留posting/uncertain状态及退避/错误字段，仅排入banner；原POST可绑定消息，扫描恢复同一消息后补banner。回归断言POST一次、最终delivered且banner已写，RED `/tmp/fly2453-projector-red.log`。这是隔离StateStore与模拟Discord effect，不是真529证据。
- 八个窄口套件79/79通过，`/tmp/fly2453-required-focused.log`。没有新增测试文件，既有CI分片继续收录。
- 本轮完整静态门禁 `pnpm lint`、`pnpm -r build`、`pnpm typecheck` 与 `bash scripts/__tests__/auto-narrow-rollback-precheck.test.sh` 均exit0；日志 `/tmp/fly2453-required-{lint,build,typecheck,rollback}.log`。
- 精确完整包门禁 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 npm_config_workspace_concurrency=1 pnpm test:packages:run` exit1（`/tmp/fly2453-required-packages.log`）：claude-runner45文件通过/1失败、1137通过/1失败/2跳过。唯一失败为未改动的 `codex-tui-nudge-probe self-check`，真实Codex v0.153.2显示usage warning且observed=nomenu/expected=menu；不是本轮固定的TmuxAdapter用例，也不是RPC错误。相同代码此前全runner1138通过/2跳过exit0；按Lead要求只隔离复测一次，probe2/2exit0，`/tmp/fly2453-required-supplement-probe.log`。Lead回答 `ed56de38-63f5-4c6c-98a8-de1ce7d4b206` 裁定为host-environment并要求不改探针、以新头CI14/14为最终权威。完整红值仍保留，不以隔离绿替代；未声称已经证明具体竞态原因。
- 未完成包已全部串行补验：gemini12文件157通过；edge111文件通过/6跳过、1313测试通过/14跳过；headphone6文件54通过；TeamLead907文件12333通过/6跳过；voice-bridge60文件649通过。五包均exit0，本次TeamLead无RPC错误。日志 `/tmp/fly2453-required-supplement-<包名>.log`，汇总 `/tmp/fly2453-required-supplements.json`。这些补验不改写前述完整命令exit1。
- 其余六条本轮建议保留follow-up：retry-before-projection-reports-poison、metrics-unbounded-scan-in-write-lock、auto-raw-without-receipt-not-degraded、unprojected-feedback-cross-run-gap、no-index-for-head-rework-veto、engine-owned-not-asserted。
- 未做：未写生产DB/flag/Discord、未重发529消息、未merge/ship/部署/重启；卡片视觉限制沿用下节披露。

## QA claim 988 返工：损坏 flag 的降级提示

Lead 指令 `8d59d3d5-f7f9-4189-943b-9f48a3d10af4` 限定只修硬门 2（TURN epoch17，implement attempt2）。代码提交 `0851045df`；该批次不修改批准计划、三闸或审查 advisory。后续追加必修见上节。

Founder 可见变化：存储的窄口 flag 值损坏时，卡片明确显示 `flywheel: dry_run` 和「已降级（invalid_raw）」；损坏值仍不能开启自动批准。

- 根因：`readAutoNarrowRuntimeControl` 在 codec 抛错时只返回 mode，丢失降级状态；卡片 enrichment 提前重新解析 raw，抛错后也丢失该项目的控制状态。reader 现在返回 `degraded` 与可选 `reason`，卡片取相同 reader 的有效 mode 和状态，不以损坏 raw 推导有效值。通用 flag 的解析和空值守卫保持原行为。
- TDD：6 种损坏 raw（garbage/AUTO/true/1/空字符串/on）、健康 dry_run/off、默认无行、通配符不继承与授权 auto 共11项。新增期望在旧实现全部失败；reader 修复后卡片链路仍红；完整修复后11/11通过。日志 `/tmp/fly2453-degraded-red.log`、`/tmp/fly2453-degraded-card-red.log`、`/tmp/fly2453-degraded-final-focused.log`。
- 卡片变异：只移除 renderer 的降级文字，6种损坏 raw 在实际生成的 HTML 上全部断言失败（6 failed/5 passed，exit1），恢复实现后11/11通过。日志 `/tmp/fly2453-degraded-mutant.log`。不是只检查类型或静态源码。
- 回归：runtime套件与窄口套件合计42/42；通用卡片renderer/report-controls31/31。日志 `/tmp/fly2453-degraded-focused.log`、`/tmp/fly2453-degraded-render.log`。没有新增测试文件，沿用既有CI收录套件。
- 最终 `pnpm lint`、`pnpm -r build`、`pnpm typecheck`、`bash scripts/__tests__/auto-narrow-rollback-precheck.test.sh` 均exit0；日志 `/tmp/fly2453-degraded-final-{lint,build,typecheck,rollback}.log`。早期构建因 public raw 的 nullable 类型失败，恢复原空值守卫位置后上述完整静态门禁重新通过。
- 完整包门禁 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 npm_config_workspace_concurrency=1 pnpm test:packages:run` 已退出1：claude-runner46文件通过、1138 passed/2 skipped、零断言失败，但出现1个 `[vitest-worker]: Timeout calling "onTaskUpdate"`。gemini随后只启动未完成，不能称全包通过。完整日志 `/tmp/fly2453-degraded-final-packages.log`，退出码汇总 `/tmp/fly2453-degraded-final-gates.json`。按此前Lead e3236876/f06a9fee对同签名RPC的裁定，保留失败结果，串行补验全部未完成包，最终以新头CI14/14为门禁；已报告本次结果。
- 未完成包已全部串行补验：gemini-agent12文件157通过、edge-worker111文件通过/6跳过且1313测试通过/14跳过、voice-headphone6文件54通过、voice-bridge60文件649通过，四包exit0。TeamLead907文件通过、12330测试通过/6跳过、零断言失败，但1个同签名onTaskUpdate RPC错误，exit1；不记为完整包绿。本轮没有重现之前的性能断言失败。日志 `/tmp/fly2453-degraded-package-<包名>.log`，退出码汇总 `/tmp/fly2453-degraded-package-completion.json`。新头CI与review仍需推送后取得。
- 视觉限制：隔离 StateStore + 真实 reader/renderer 生成 `/tmp/fly2453-degraded-card.html`；隔离 headless Chrome 启动exit134，浏览器MCP返回 `MCP tool call requires approval, but approval policy is never`。没有截图验证收据；HTML测试不等同于视觉验收，限制已报告Lead。
- 未做：未写生产DB/flag/Discord，未重复529消息，未merge/ship/部署/重启服务。该批次时8条审查advisory作为PR follow-up；随后两条改为必修，处理结果见上节。新头review与CI需推送后重新取得，旧头9bb58b9e5的批准与14/14不替代本轮。

## Implement attempt 2：Lead 指定 A/B 返工

返工 `rework:876f7993f157886e96bfb0f1b599f8372a471f9190756b498b66f75420701ae8`（TURN epoch12）只修复两条原 MEDIUM 意见。上次头 `bdd900a13` 的 CI14/14 与 APPROVED 是历史收据，不替代本轮新头门禁。下方原 Attempt 2 验收记录保留为历史证据；本节记录本次返工。

- A：完整投递成功的受 generation/state/内容/emoji/banner 保护提交点将 attempt 归零；失败或仅局部成功不归零。真实 reconciler 连续8轮成功后原代码 attempt=8，新增测试期望0而红；修复后下一轮一次暂时失败仍能退避重试，成功后再次归零。既有连续8次失败耗尽上限测试仍绿。
- B：snapshot 刷新只更新期望意见；已有 posting/uncertain 投递保留恢复状态、退避时间和错误信息。两种状态的 metrics-only 刷新原代码均变 pending 而红；修复后真实 reconciler 在相隔至少30秒的两次稳定 frontier 零结果扫描前不 POST，刷新也保留首次零扫描证据。posting 是同一丢响应恢复路径的崩溃中间态。
- TDD 记录：`/tmp/fly2453-reworkA-red.log`、`/tmp/fly2453-reworkA-green.log`、`/tmp/fly2453-reworkB-red.log`、`/tmp/fly2453-reworkAB-green.log`。最终 StateStore approval22/22 通过（单进程 forks）；测试使用隔离 StateStore、真实 writer/reconciler 与假 Discord effect，不是本轮真实529证明。
- 本轮 `pnpm lint`、`pnpm -r build`、`pnpm typecheck` 与新增 shell 回退预检均退出0；日志 `/tmp/fly2453-rework-{lint,build,typecheck,rollback}.log`。没有修改批准计划、schema、控制入口、三闸、统计策略或其他审查建议。
- 本轮精确完整命令 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 npm_config_workspace_concurrency=1 pnpm test:packages:run` 退出1（`/tmp/fly2453-rework-packages.log`）。此前各包均通过，包括 claude-runner46文件1138通过/2跳过，本轮未在该包重现RPC；TeamLead904文件通过/1失败，12296测试通过/1失败/6跳过，另有已知onTaskUpdate RPC错误。唯一断言失败是既有FLY-2339性能测试：4271投影身份约2001ms，阈值1000ms。完整聚合不能称绿。
- 性能归因：同一当前测试隔离9/9退出0（`/tmp/fly2453-rework-perf-focused.log`）；返工前bdd900a13归档TeamLead隔离副本、共享当前依赖并补root tsconfig后9/9退出0（`/tmp/fly2453-rework-perf-base.log`）。没有改测试阈值或无关生产路径。这是隔离复测证据，不替代原完整失败；Lead f06a9fee-e1bd-4025-88bf-723df2890543 已裁定B：本地完整门禁负载/RPC限制，保留红值和对照收据，不修改阈值，以新头CI14/14为最终门禁。唯一未完成包补验 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 pnpm --filter flywheel-voice-bridge exec vitest run`：60文件649测试通过、退出0（`/tmp/fly2453-rework-voice.log`）。

- 本轮三道整闸变异重新执行，baseline绿、gate1/gate2/gate3均在writer及unit负例被杀死，driver退出0：`/tmp/fly2453-rework-mutants.log`。

- 补充执行Lead a04fce20要求的六次串行对照（无其他本体测试并发），branch与merge-base04ff8800各3次，六次原文件均9/9、exit0，各阶段原1000ms断言全过。整个用例耗时：branch 1512.91/1403.07/1137.80ms；merge-base 1145.91/2343.08/1587.70ms。这六个数字是整个多阶段用例的耗时，不是受1000ms阈值约束的单个projector区间；没有改测试或阈值。原始JSON/log：`/tmp/fly2453-perf-{branch,merge-base}-{1,2,3}.{json,log}`，汇总`/tmp/fly2453-perf-six-receipts.json`。两臂均未复现性能失败，沿用f06a9fee已作出的B裁定。

## 结论

Attempt 2 修复保留 v4 已批准设计，补齐拒绝审计、旧 schema 回溯兼容、updater 回退预检、整闸 writer 变异及 CI 登记。Founder 可见行为：默认 dry_run 每卡给机器意见；当前 founder 原话授权 auto 后，只有三闸同时通过的卡由引擎代批；停止恢复 dry_run。

此文件冻结本地验证证据。新头 CI 与代码审在推送后记录于 PR #1138；本文件不预先声称它们通过。旧头 f6e55b05e 的 CI run34333340245 非绿，旧 R3 APPROVED 不替代新头评审。

## §12 验收证据

以下均为本轮隔离测试或包测试；不冒充生产结果。

- 三态与三闸：QA shadow `qa-tristate`、`qa-writer-gates` 验证 off 零投递，dry_run 有意见但零 source，auto 三闸全过才写一次；生产 writer 不信任 caller 的 auto 值。StateStore approval 套件19项通过，覆盖真实两库 source→projection→land 激活及四线证据。
- 独立负例：整道 gate1/gate2/gate3 分别替换为 true；每个 mutant 必须让对应 writer 负例与 unit 负例失败，baseline 先绿。driver 复制到临时目录，原源码不改；CI teamlead 1/3 显式执行。529 driver 仅 manual-only。
- 控制与停止：route18项通过，stage/apply 六种拒绝各写一行真实 fleet denied 审计，成功 stage 一行；只记录有限引用和原因，不存凭据。`qa-c1-stop` 覆盖开启 TTL 边界和停止无年龄过期，原消息顺序保护保留。
- QA harness 语义修正：原样运行40/41。旧 STOP 用例错误要求四小时前 STOP 覆盖一分钟前 OPEN；Lead 65eadca8 裁定 plan §4/11 优先，只将该用例改为409 message_order_conflict，并保持 auto。测试注释引用裁定及计划；分支新增对应回归。更正后8文件41/41、退出0。没有削弱 ordering。
- 崩溃、重放、并发与 banner：`qa-recovery`、StateStore approval 全部通过；source 提交后才标记，投影回滚保留重试，founder 拒绝及待处理输入阻止代批；无投递 intent 的卡不可自动批准。
- 每卡意见：StateStore approval 测试覆盖 materialize/bootstrap、持卡 Lead 身份、PATCH/emoji、退避上限及游标公平性。统计 `qa-stats` 验证200人工卡窗口、precision/Wilson、样本不足与自动样本排除。
- schema/retention：`qa-c0-schema`、StateStore schema 与 retention sweep 套件通过；四表保留，append-only与负向输入保护成立。main 新 account_switch_action_receipt 与本单四表同时登记。
- 回溯：`fly2396-retro-report` 原13项通过，pre/post-deploy fixture 完全未改；查询由 source receipt 联接自动审计排除自动样本，旧快照仅加 TEMP 空审计表。影子表及 retention consumer 脚本16/16。
- 回退：新增 `auto-narrow-rollback-precheck.test.sh` 通过。调用实际 default_deploy，未投影 auto source 在 merge/restart 前拒绝；其他项目收据不能代替，精确收据存在则放行。原 updater36/36通过；不删除 C0 或证据，不自动切 flag。
- B2/B4、land、materializer、flag 与强度二回归包含在 TeamLead905文件运行内，零断言失败；RPC限制见下节。

## 完整门禁与环境限制

`pnpm lint`、`pnpm -r build`、`pnpm typecheck` 均退出0。lint保留既有warning；并未通过修改规则清零。新增 shell 测试、CI枚举和CI结构检查退出0。approved plan内容未改。

`VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 npm_config_workspace_concurrency=1 pnpm test:packages:run` 精确聚合退出1：claude-runner46文件、1138 passed/2 skipped，零断言失败，但出现 `[vitest-worker]: Timeout calling "onTaskUpdate"`。不能称完整聚合全绿。Lead e3236876 裁定此为已知 harness artifact，要求未完成包逐包验证并披露，exact-head CI为最终权威。

未完成包依次执行 `VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 pnpm --filter <pkg> exec vitest run`：

- flywheel-gemini-agent：12文件/157测试，exit0。
- flywheel-edge-worker：111文件通过、6文件跳过；1310测试通过、14跳过，exit0。
- flywheel-voice-headphone：6文件/54测试，exit0。
- flywheel-voice-bridge：60文件/649测试，exit0。
- flywheel-teamlead：905文件通过；12294测试通过、6跳过，零断言失败，但同一 onTaskUpdate RPC超时，exit1，已单独报告95e258d1。此收据不记为完整包绿。

逐包原始命令/退出码：`/tmp/fly2453-package-completion-records.log`；各包日志 `/tmp/fly2453-package-<pkg>.log`。完整聚合 `/tmp/fly2453-packages-final2.log`；harness `/tmp/fly2453-qa-harness-corrected.log`。没有改 timeout 或 skip；原包配置自行跳过的用例如实计数。

## 合入与评审边界

按 Lead c1b93402 裁定拒绝force push；分支保留原远端历史，通过68d57730c合入main。稍后的main227058c73再经只读 `git merge-tree --write-tree HEAD origin/main` 验证退出0，无冲突。只允许一次普通push和一次新头review，review中不push；若阻断发现则停报。

非阻断 follow-up：429重试、hardcoded declared_by；旧R3另有自动拒批诊断、指标索引、sweep时间戳、读点登记与窗口常量建议，均已报告，不在本轮扩展。

## 未做

本轮未改生产flag、未写生产数据库、未按真实ship卡、未部署或重启服务、未请求ship approval、未合并PR。仅合入main到工作分支。529真实Discord证据沿用用户指定的attempt1 claim970，不重发；本轮没有独立重新获取这些消息或测量生产flag，因此不声称当前生产验收。实现阶段不派发QA。
