# FLY-2391 默认发布与否决 — 实施记录
Issue: FLY-2391 (https://linear.app/geoforge3d/issue/FLY-2391/1143b4-auto-ship-on-silenceopt-out-fail-closed-状态机-否决窗口绑不可变候选delivery)
日期: 2026-09-14
基于: plan.md

## 当前实现边界

最新Lead裁定要求完整I1–I6、最终一个非draft PR及精确HEAD round2 review；不存在foundation-only完成路径。已有存储、endpoint控制信箱/执行器/严格策略、auto workflow、manual decision CLI/workflow和rebind CLI的分批fixture证明；activation workflow、受控rebind调度、Bridge scheduler/Gateway/authoritative activation/accounting/report仍未全部接通。无最终PR/CI/review/QA/生产验收，activation OFF。续跑以progress.md为游标，下文按批次保存历史收据。

## 第一份存储交付时的历史边界

按Lead裁定，先交付存储/状态机，再独立交付endpoint/Discord app及运行时连接；完整I1–I6不缩减。当前实现包含冻结周期、送达与动作收据、auto/manual claim与结果核对、事务内来源失效、启动恢复入口、默认关闭的SQLite项目开关。scheduler、Gateway、endpoint/workflow执行、activation epoch生命周期和外部记账投影尚未接入，因此没有生产发布验收。

全仓build、TeamLead typecheck、lint（18 warnings）、retention consumer守卫已通过。聚合包测试仍在运行；代码review question 1e80e742-ec6f-4f60-a9da-ec3aa1494585已注册、尚无有效verdict。PR/CI/QA/激活均未完成。以下各节是逐批执行历史，早期“尚未实现”描述不能替代本节及progress.md的当前状态。

## 初始执行范围与授权（历史）

Implement TURN epoch=2，execution `aea5195f-7ea6-4ee6-bf74-5e9f8e80ecb5`，run `da6b7743-891e-424f-a121-1bf7ffdb0c44`。实时 check 设计 question `5876cd77-e030-4bc3-b87c-c5abf81d4458` 返回有效 APPROVED。

完整 I1–I6 均保留。尚无实现完成、全仓验证、代码评审、PR、QA 或激活证据。具体生产时刻未批准；测试中的时刻只作 fixture。

## I1 配置子块

新增 strict customer_release parser、项目 YAML 接入与类型/函数导出。缺省 mode=off；observe/canary 必须显式填写时区、上午通知/下午截止、至少 120–480 分钟的最小窗口、policy digest、Discord 身份及 executor 数字身份。canary 必须提供 founder enable receipt 引用，但解析不验证其权威、不授予 activation。凭据仅配置环境变量名；非法输入不在错误中回显。

TDD 及验证（2026-09-14）：

- 初次测试因未安装依赖报 vitest not found，不计行为红灯；`pnpm install --frozen-lockfile` 成功，lockfile 不变。
- 安装后新测试确认缺少 customer-release-config 模块而红；实现后 5 个用例通过。
- `pnpm --filter flywheel-config typecheck` 成功。
- `pnpm --filter flywheel-config test:run`：54 files / 830 tests passed。
- `pnpm --filter flywheel-config build` 成功。
- 5 个变更 TypeScript 文件 Biome check 与 git diff --check 成功。

I1 的 policy/store/StateStore/flag/retention 尚未实现，I2–I6 尚未开始。

## I1 周期存储子块（后续进展）

新增 CustomerReleaseStore（StateStore 同一 SQLite connection）、周期与事件类型、两张 additive 表及受保护 authority retention 分类/fixture。reserve 在 immediate transaction 内冻结 B0 deriveBetaCandidate 的完整身份，按 project+weekStart 去重；新 revision/epoch/同周改日不会替换原候选。cancel 附 expected revision，周期取消与失效事件一起提交。DB trigger 禁止改写冻结身份、已有窗口时间、已有失效 latch 与事件。此子块尚未提供后续准备、开窗、claim、手动 action 或网络执行器，不作为完整状态机交付。

验证（2026-09-14）：

- 6 个初始存储测试先因 store 模块缺失而红，新增实现后绿。
- StateStore 接入测试先因 customerReleases 缺失而红，接入与 retention 注册后绿。
- 最终存储 8 个用例包含独立数据库连接、重开读取、同周唯一、候选冻结、重复迁移、非法身份、审计失败创建回滚、取消失败回滚、取消不重开和 immutable trigger；尚未覆盖真正双进程竞争或 T03–T20。
- retention 回归暴露 authority 与总表数的精确断言需从 40/228/225 更新至 42/230/227；新增两表名称断言，保持 fixture 与真实 StateStore schema 全量比对。保留先前三次失败收据于本执行 /tmp 日志；没有降低断言范围。
- 最终 `vitest run customer-release-store + StateStore.release-readiness + fly-2006-database-retention-sweep`：3 files / 49 tests passed。
- `pnpm -r build` 成功（在 StateStore 接入前）；接入后 `pnpm --filter flywheel-teamlead typecheck` 成功。
- `pnpm lint` exit 0，3731 files，18 warnings；未宣称零警告。
- 仍未运行全仓 package aggregate gate，尚未进入 code review/PR；I1 剩余 policy/状态转移、flag 和其余审计表仍待实现。

## I1 准备策略与负面信号持久记录（后续进展）

`beginPreparation` 在同一 immediate transaction 内调用同步 B3 evaluator，读取其已持久的最新 verdict，并核对 frozen source/base/deployed SHA、green 与最多 30 秒新鲜度；缺失/被替代/过期/未来时间/hold/unknown/取证异常均取消周期。只有通过时才写 preparing、latestVerdictId 和 prepare_requested 事件，供后续调度器消费。当前还没有 dispatch 副作用。

`invalidate` 对 claim 前工作取消；对 committing/commit_unknown/published 只写 post_claim_intervention 和 sticky invalidatedEventSeq，保留真实执行状态。重复旧 revision 不重复记账，后续事件不清除第一条 latch。实际 T13 重试及 T11 授权仍待接入此 latch，不能把本子块称为完整 T20/撤版路径。

TDD：prepare 的 11 个新测试先因方法缺失红，随后绿；4 个 invalidation 用例先因方法缺失红，随后绿。另有取证期间取消→返回 green 的确定性交错测试，先暴露 revision conflict 会回滚取消，修复为复读当前状态后保留取消。最终 customer-release-policy 12、customer-release-store 12、StateStore.release-readiness 10，共 34 tests passed。日志位于本执行 `/tmp/fly2391-{prepare-red,latch-red,evaluation-interleaving-red,preparation-latch-green}.log`。完整 I1–I6 及最终全仓验证/PR gates 仍未完成。

## Artifact 与单次通知窗口存储（后续进展）

新增 completePreparation/startNotice/markNoticeUncertain/openWindow 与 customer_release_notices。完整最终 artifact 由 B0 deriveVetoBinding 派生并核对原冻结 beta；准备回读 hash/等价性收据通过后，binding、唯一 notice intent、prepare receipt 和事件同事务提交。notice 引用、内容摘要、channel/app/bot/founder、固定截止与最小窗口不可改写。sending/uncertain 不允许再 startNotice；只能恢复原消息或取消。窗口只接受精确身份/摘要、访问及 Gateway 健康、30 秒内探测与足够剩余时间的送达收据。开窗事件失败会回滚 delivery receipt 和 openedAt。

这些 receipt 类型是内部 adapter 结果，不是可直接接收 runner/HTTP 声明的授权接口。真实工作流结果查询、Discord 消息/权限/Gateway 探测、模糊发送扫描恢复、周期 health runtime 与按钮入口尚未接入；因此这里的 fixture 通过不等于真实送达或自动发布可用。

验证：初始 21 个测试因方法缺失而红，实现后绿；新增截止不可改写用例暴露缺失 trigger，补齐后与开窗失败回滚一起通过。完整 focused 回归为 notice 22 + policy 12 + store 12 + readiness 10 + retention 31 = 87 tests。前两次运行均在 store 测试内部 dynamic import StateStore 处超时（5000ms，86 pass/1 fail），保留 `/tmp/fly2391-window-suite{,-r2}.log`；把该测试的静态依赖移至收集阶段，不改超时/断言/生产逻辑，`/tmp/fly2391-window-suite-r3.log` 显示 5 files/87 tests passed。类型检查与 scoped Biome/git diff check 通过。

通知表纳入 protectedAuthority，registry/fixture 精确表数同步为 43/231/228；本变更不授权 age-only 删除 receipt。累计实现已超过约1500行，已按 Lead ruling 报告两 PR 交付安排（report `c6a227e1-2683-4757-a9aa-d04c02d81692`，doorbell 中止但 durable queue row retained，不重发）。完整状态机、其余 I1–I6 与最终 review/PR gates 仍未完成，activation 保持 off。

## 否决动作与到期执行器意图（后续进展）

veto 在同一事务内校验 notice/message/full binding/current canonical founder，记录独立 action receipt、actor 事件及取消或 post_claim latch。重复 interactionId 返回原收据；身份/卡片不匹配拒绝且无状态变更。数据库写失败不返回成功。当前接口仅供未来 authenticated Gateway adapter 调用，尚无实际按钮接入；不能以此宣称生产“一动作否决”已验收。

Lead question `ae6b3c1d-14ba-4164-8734-d1ddb6f477b6` 已确认：claimNotAfter 必填、冻结于 notice/cycle，从同一个 enable-time customer_release 配置块中的 claim_deadline_local 派生，与 veto 截止处于同一当地下午且晚于 veto deadline。缺失/乱序 fail-closed。原三项待 founder 时间决定的同一配置块承载该值，15:00 PT 只是 claim deadline 候选，不增加第四个 founder 问题或独立配置面；fixture 的08:00/15:00/16:00不是生产批准。

T10 awaitAttempt 只在 veto deadline 到达后核对精确原消息的 fresh delivery 与同事务最新 B3 green，再写 awaiting_attempt + attempt_requested。超过冻结 claimNotAfter、回执失效、hold/unknown 均取消；取证中 veto 已持久时不产生执行器意图。这里不 mint permit，T11 与结果核对仍未实现。

TDD：10 个 veto 用例先红后绿；claim 配置扩展先3红、notice unknown-field先红后绿；T10 7 个用例先缺方法红后绿。notice/action/T10 合计39 tests通过。actions 表加入 protectedAuthority 与全量 schema fixture（44/232/229）。最终 config focused 5 tests、TeamLead focused（notice/policy/store/readiness/retention）104 tests 通过；config build、TeamLead typecheck、scoped Biome/git diff check 通过。完整 I1–I6、两 PR review/CI 与 handoff 仍未完成。

## 初始 Lead 范围裁定

Lead question `0e03efee-6814-49e5-a18a-b5b5dcd998bd` 已答 RULING：在完整 I1–I6 内实施独立 manual request binding（不修改 immutable auto binding）、decision writer 的显式 manifest 只读角色、weekly uniqueness 与 sticky post-claim negative latch。不缩范围。所有 activation flag 保持 off。若差异超过约 1500 行，拆为 storage/state machine 与 endpoints/Discord app 两个交付 PR，每个都完整评审。后续实现按此修正执行。

## T11 自动 claim 与恢复交接（后续进展）

本轮 TURN epoch=5 / activation `activation:aa2c96b1-e308-406a-aba4-60ceb616f019:f56dba39-8fdb-4c64-ae3f-4e8b48d1346a:implement:1`。重新 check `5876cd77-e030-4bc3-b87c-c5abf81d4458` 确认有效 APPROVED。按 Lead instruction `28367a0a-2a93-4ac4-bc07-2dd370cdde55`，使用精确 SHA `a9fb9bc87242c6d64bb8a7de96791ee47d2b6896` apply 旧 WIP；其唯一未跟踪文件是 customer-release-decisions.test.ts，19 个测试已保留验收语义并适配本轮接口。

新增 claimAuto 与 immutable customer_release_decisions：同连接 immediate transaction 核对 frozen binding、当前 prepared manifest/active beta、readback hash、fresh notice、当前 activation 和持久 founder enable action，再即时读取 B3 verdict。取证期间否决/源失效优先，收据失败整笔回滚；成功写 committing 与唯一 permit 后才允许调用方投递。重放返回原许可，不重算、不延长有效期，跨重开数据库仍保持一致。permit 上限30秒且不越 frozen claimNotAfter。新增表注册 protectedAuthority，完整 fixture 表数为233，非可选子集230，authority45。

首批18个T11测试确认缺方法红（39旧测试通过），实现后绿；增加重开/期限/失活artifact/未知字段负例，并恢复19个真实StateStore测试。组合回归首次121通过/1失败，失败是新表fixture排序（保留 `/tmp/fly2391-claim-focused.log`），修正后126通过。恢复旧WIP后的claim相关80测试通过，TeamLead typecheck通过。最终合并focused回归6 files/145 tests通过，记录 `/tmp/fly2391-claim-final-focused.log`；9个变更代码/fixture文件Biome及git diff check通过。

本批只有内部状态存储/授权接口，尚无可信生产adapter提供上述证据；不将fixture视作真实founder授权。T12–T19结果/重试/手动路径、endpoint permit消费、Gateway/runtime、其余I1–I6和两PR的全仓验证/review/CI仍待完成。所有生产activation保持关闭，未调用任何客户发布或ship授权路径。

## T12–T16 提交结果核对与有限重试（后续进展）

新增 recordAttemptResult / results.ts 与 protectedAuthority 的 customer_release_attempt_results。只有已持久 decision 对应的 exact attempt/nonce/baseETag 才能记结果。未知结果进入 commit_unknown，许可过期不解除未决。published 要求 exact committed op 与版本身份一致（已withdraw也保留历史发布事实）；fenced 要求 exact abandoned op 与变化后的manifest ETag，prepared不能证明旧PUT已死。上述manifest读回仅由未来authenticated endpoint adapter提供，当前仍为内部存储接口。

明确 guard_rejected / CAS conflict 的 durable no_write 才释放到 awaiting_attempt；post-claim负面latch存在则直接取消。最多三次新claim重试，各自仍过T11即时green门，窗口不重开。旧结果幂等返回原收据状态，不更改新attempt；unknown可被最终证据替代，终态不能改写。发布/结果事件与状态、证据同事务落库；故障注入证明事件写失败会全部回滚。三本账网络投影尚未实现，release_published事件仅为其后续耐久来源。

TDD：新增8个结果测试中7个因方法缺失红，1个通用拒绝测试在缺方法时也通过，因此后者不计有效红灯。实现后27个decision测试全绿；另补最多三次fresh retry、旧结果不影响新claim及重试遇unknown取消。最终6 files / 155 tests通过（`/tmp/fly2391-result-focused.log`），TeamLead typecheck通过。Schema注册表精确46 authority / 234全表 / 231非可选表，与StateStore真实schema一致。

下一步T17/T18独立manual request与founder go；其余I1–I6（真实源失效接线、scheduler/Gateway、endpoint/workflow、accounting）和两份PR的评审/全仓验证/CI仍待完成。没有运行或开启真实客户发布。

## T17 独立手动请求与 founder go（后续进展）

新增 CustomerManualReleaseStore 与 customer_release_manual_requests。准备新的完整 B0 binding + 等价/hash回读证据后保存独立卡片身份；不覆盖 auto cycle.binding，也不修改原窗口或负面latch。go核对canonical founder、request/app/channel/message、fresh消息摘要与访问/Gateway证据，并在同事务保存actor动作、delivery、manual_ready和事件。重复interaction只回原收据；持久动作失败全部回滚。实际准备工作流/Discord适配仍未接入。

手动准备支持原周期在auto artifact形成前取消的情形。失败后新手动请求关闭旧request，旧go不会迁移或重新授权。唯一当前request由partial unique index保证，历史身份、动作和投递证明保留不可变。

测试：初始新增10个用例中9个缺方法红，1个泛化拒绝测试不计有效红灯；实现后39个decision测试通过。换新卡用例进一步暴露cycle永久唯一约束，改为历史可保留、当前唯一后6 files/167 tests通过；TeamLead typecheck通过。保留 `/tmp/fly2391-manual-{red,green,replacement-red,focused,typecheck}.log`。

本批仅T17；T18执行时manual claim及其结果重试仍待实现，不宣称手动发布端到端可用。其余I1–I6和两PR评审/全仓验证/CI未完成，activation保持OFF。

另补auto/manual跨表releaseId互斥：测试先红后修复，两种保留顺序均拒绝身份借用；完整最终focused为6 files/168 tests，typecheck/scoped Biome/git diff check通过（`/tmp/fly2391-manual-final-{focused,typecheck}.log`）。manual requests表受protectedAuthority保护；完整schema计数47 authority / 235全表 / 232非可选表。

## T18 手动执行授权（后续进展）

manual.claim复用不可变decision/result账本；执行时核对新request binding、当前prepared/active beta、readback hash、窄执行能力、canonical founder及手动卡冻结的policy/epoch和过期时间。手动卡独立保存policy/epoch，因此不借原auto周期的配置身份。即时B3必须产生同source/base的fresh持久判定；green记founder_go，hold/unknown记founder_override，许可保存原state/reasons、actor及manualRequestId。健康覆盖不放宽技术身份/权限/期限门。

no_write重试按manualRequestId独立计数，返回manual_ready；claim后新增post_claim_intervention取消后续重试，不能拿初始auto取消latch误阻止显式manual go，也不能忽略新的否决。结果仍按permit的manual binding核对。原auto binding/window始终不变。

首批11个T18用例因方法缺失红，实现后53个decision tests绿；日志 `/tmp/fly2391-manual-claim-{red,green}.log`。本批仍是内部接口，不等于endpoint/Gateway/真实手动E2E；其余I1–I6、两PR评审和全仓验证/CI尚未完成，activation保持OFF。

持久go关联负例先红，补齐accepted request与immutable action/receipt/actor/requestId连接核验后绿；手动commit结果按manual binding核对通过。最终6 files/181 tests通过（`/tmp/fly2391-manual-claim-focused.log`），TeamLead typecheck、scoped Biome、git diff check通过。下一步补I2源失效/重启取消接线及尚未完成的I1–I6，继续保留两PR交付与全部最终gates。

## I2 会被成功覆盖的来源故障接线（后续进展）

新增invalidateSource，按flywheel项目与冻结source匹配自动周期；committing/unknown/published按最新decision中的实际source匹配（支持独立manual artifact）。自动未claim取消；claim后记干预与sticky latch。manual_ready不因B3非green自动取消，保持已批准的显式founder override语义；显式veto仍由动作路径处理。

StateStore的heartbeat不健康/归因缺失、bug-label来源失败、founder扫描失败/down、B3非green verdict均在原始来源写入的同一SQLite事务里调用失效。故障后的成功写入不能恢复周期。复用B3现有heartbeat健康函数与policy读取，未另造阈值。其他项目/其他已归因source、健康样本不取消当前周期。

TDD：首批7个来源测试6红/1既有正例通过，实现后7绿；B3判定追加3个测试中2红（auto取消与postclaim latch），manual_ready覆盖语义正例通过。日志 `/tmp/fly2391-source-{red,green}.log` 与 `/tmp/fly2391-verdict-red.log`。StateStore.ts被仓库Biome配置显式排除，直接check返回No files processed，不计lint通过；本批依赖typecheck和行为回归验证该文件，未改全文件格式。

本批尚未完成I2全部接线：deployment/bug intent/gap等持久事件边界、启动恢复/scheduler/Gateway及其余I1–I6仍需继续；未启动实际默认发布，activation保持OFF。

最终验证：首次组合8 files为172通过/1既有策略测试5000ms超时（`/tmp/fly2391-source-focused.log`）；等待原测试与typecheck进程完成后，`VITEST_MAX_FORKS=1`同8文件全部173测试通过（`/tmp/fly2391-source-focused-serial.log`），原超时case为818ms。未改断言/超时/跳过。TeamLead typecheck通过；两个非排除文件Biome与git diff check通过。stage test通知遇Bridge pressure（CLI输出load1约100），事件由CLI保留deferred replay，不重复人工发送。

## I2 启动恢复存储入口（后续进展）

新增recoverAfterRestart(projectId, now)，同事务取消遗留evaluating/preparing/notice_pending/window_open/awaiting_attempt，理由bridge_restart。committing/commit_unknown连同原revision与许可边界保持原样并返回给运行时核对；不能以重启/flag关闭/许可过期宣称未发布。重复调用不重复取消事件，不影响其他项目。仅提供显式runtime启动入口，不在StateStore.create/普通读取中触发；plugin/runtime实际调用仍待后续交付。

TDD：8个启动恢复测试全部因缺方法红（10个原来源测试通过），实现后18/18通过，包含未决态保持、项目隔离、重复调用与审计失败回滚。收据 `/tmp/fly2391-restart-{red,green}.log`。scoped Biome与git diff check通过。本批不等于I2完成，deployment/持久事件边界、scheduler和其余I1–I6/两PR全gates仍待完成；activation保持OFF。

## I2 部署来源切换与锚点关闭（后续进展）

insertDeploymentEvent与upsertReleaseDeploymentAnchor在同事务比较写前/写后的最新生产来源，复用B3的deployment_events + anchor start/close联合时间线排序。新来源与候选不符或归因未知时取消auto未claim周期；已claim按许可中的实际source写postclaim干预。回滚不恢复旧窗口。迟到历史部署、历史锚点关闭、staging及其他项目不会误替代当前生产来源。现有部署去重/authoritative enrichment保留，source写入与取消事件失败一并回滚。

TDD：部署新增4个测试3红/1既有正例通过，实施后与digest-service共50测试绿；锚点新增3个测试2红/1正例通过后补实现。最终4 files/66 tests通过，包含25个来源/重启/部署用例、既有28个digest部署测试及13个readiness存储/service回归。日志 `/tmp/fly2391-deployment-{red,green-r2,focused}.log`、`/tmp/fly2391-anchor-red.log`。第一次自动编辑的预期文本断言失败，未改源码；其后测试仍为3红，不把命名为green的旧运行当通过。

尚缺其他持久事件边界/调度器/启动调用和其余I1–I6、两PR评审/全仓验证/CI。全部activation仍OFF，不调用部署或客户manifest写接口。

本批TeamLead typecheck通过（原exec进程正常exit 0，`/tmp/fly2391-deployment-typecheck.log`）；两个非排除文件Biome与git diff check通过。StateStore仍按仓库配置排除Biome，未将其计为lint检查通过。

## I2 pending bug intent 的不可恢复取消（后续进展）

insertReleaseBugIntent在同一SQLite事务内写pending并失效匹配auto候选；未归因intent使flywheel自动周期unknown。即使下一个tick前被标重复/abandoned，原周期也保持取消。使用B3现有READINESS_WINDOW_MS，窗口外的历史intent不取消今日周期；非法创建时间拒绝入账。来源取消事件失败会同时回滚bug插入，其他source不影响当前候选。

TDD：三个新行为测试全部红，实现后与既有readiness ledger/rider共48 tests通过；补历史窗口正例后，完整来源测试29/29通过。日志 `/tmp/fly2391-bug-intent-{red,green,final}.log`。此处不重新定义已finalized bug/告警阈值；它们仍由B3持久证据与即时判定消费。运行时及其余I1–I6、两PR的全部review/CI gates仍未完成，activation保持OFF。

类型检查首次发现重复导入READINESS_WINDOW_MS（该常量已有import），仅移除新增重复项后原行为测试代码不变，typecheck重跑通过。失败/恢复收据分别 `/tmp/fly2391-bug-intent-typecheck.log` 与 `...-typecheck-r2.log`。新增测试文件Biome与git diff check通过，StateStore仍为仓库排除文件。

## I1 动态开关注册与读取（后续进展）

auto_release_on_silence_enabled 默认false，纳入现有逐项目SQLite flag codec与管理面，命名wrapper每次读取项目行→全局行→默认值。customerReleaseAutoEnabled限制flywheel项目；尚未接入scheduler/plugin，不将该读取入口宣称为完整runtime。开关不是授权，claim仍要求独立founder enable证据与最新策略，后续activation撤销和epoch接线仍待完成。

依flag-authoring-runbook，新flag不接受YAML入口；配置测试证明true/false/string均拒绝，保持单一SQLite写通道。开发中曾添加该可选配置字段，读手册后移除。首轮注册回归3失败/92通过（新增条目的数量、顺序、delegated清单）；保留既有条目顺序并更新精确清单后4 files/95 tests通过。日志 /tmp/fly2391-switch-config.log 与 /tmp/fly2391-switch-config-r2.log。config build通过。首次TeamLead命令误用不存在的package filter，无测试运行；使用flywheel-teamlead重新运行，不能将空匹配exit 0当通过。

TeamLead三个文件67 tests通过（/tmp/fly2391-switch-runtime-r2.log）：默认关、下一次读取立即生效、限定flywheel，以及管理stage/apply全局/项目set/clear、reason与名册校验、无配置文件读写。8个变更源码/测试文件scoped Biome通过。全仓pnpm lint exit 0，检查3742文件、18 warnings（/tmp/fly2391-foundation-lint.log），不是无警告；未自动修复旁支文件。


## I1 双进程竞争验收补证

既有存储用例覆盖两个独立连接，但不是两个OS进程。新增scripts/__tests__/customer-release-reservation.test.mjs与专用IPC worker，两个子进程各持有独立SQLite连接。迁移完成后，父进程持BEGIN IMMEDIATE锁，等两个子进程均宣告尝试reserve才释放；不使用猜测sleep。不同slotDate/releaseId/epoch的同周请求最终返回完全相同的冻结周期，DB精确只有一条cycle和一条cycle_reserved事件。

首次真实运行通过（/tmp/fly2391-concurrency-test.log）。测试超时信号会拒绝IPC等待并进入finally关闭数据库、回收本测试子进程和临时目录。生产代码未变化；此脚本单独执行，不将它伪计入已经启动的package gate旧HEAD收据。

## Round1 code review：CI 枚举阻塞项

有效review question 1e80e742-ec6f-4f60-a9da-ec3aa1494585返回CHANGES_REQUESTED（reviewedHead 2ef65d09e51de153758d7109a3fdb5f540e901f1）；结构化完整收据见code-review-r1.json。唯一HIGH为new-node-suite-not-enumerated-in-ci。ci-shell-suite-enumeration.test.sh原样复现红灯：customer-release-reservation.test.mjs不在ci.yml。仅在既有root Node contract suites块添加该命令，原守卫随后绿：317 shell suites分类、62 Node suites枚举。收据/tmp/fly2391-ci-enumeration-{red,green}.log；没有删测试或放宽守卫。

6个MEDIUM/LOW为非阻塞建议，保留在follow-ups.md与原始收据，不冒充已解决。其中reservation-race-window-not-synchronized准确限定现有测试证据：它启动两个OS进程且在双方attempting消息后释放父锁，能证明两次保留返回同一周期；不能保证两个BEGIN IMMEDIATE已在释放前实际竞争锁，也未测量锁等待。先前“锁竞争证明”的措辞过强，今后不据此宣称确定的contended-path覆盖。

本次仅修HIGH CI接线；首轮重审仍必需。单PR/两轮review安排保持，独立本地I2/I4提交尚未接回共享分支，生产activation OFF。
## Lead 最新交接裁定与 I2 调度器本地进展

问题3a376951-b99f-4544-a11e-6b6947ed0a4d的最新裁定覆盖旧“两PR”安排：只用flywheel-FLY-2391一个分支，最终只开一个PR。两份交付改为两轮review：round1存储/状态机；批准后完成endpoint/Discord/runtime/accounting并获取fresh exact-head round2。review运行期间不push。当前round1 question 1e80e742-ec6f-4f60-a9da-ec3aa1494585仍待verdict。

为不改变运行中的聚合测试源码，本批在/tmp/fly2391-second-delivery detached checkout本地进行（同一锁定依赖安装的链接，无另开远程分支或PR）。待round1批准后将本批提交接回唯一共享分支。

新增纯customerReleaseSchedule：按明确IANA时区和本地ISO周解析固定notice/deadline/claimNotAfter，反解当地时刻须恰好一个UTC候选，DST缺口或重复均schedule_invalid；明确标记before_notice/notice_window/missed_notice，不顺延截止或补发。customerReleaseClockFailure识别大于5秒回退、大于90秒tick gap和非法时间。此处没有scheduler loop、模式/flag授权、通知或发布副作用，实际runtime接线仍待完成。

TDD：模块缺失导致suite red（/tmp/fly2391-scheduler-red.log）；实现后14tests通过。补missing timezone负例发现Intl会回退机器时区，1红/14绿（/tmp/fly2391-scheduler-missing-zone-red.log）；显式拒绝缺失时区后15/15通过（/tmp/fly2391-scheduler-final.log）。scoped Biome通过。聚合package gate仍是原共享checkout进程55135，不将本地新增测试纳入其旧HEAD收据。

两个新增文件的scoped tsc --noEmit检查通过（/tmp/fly2391-scheduler-typecheck.log）。这不是完整项目typecheck；接回共享分支后仍须跑项目与最终全仓gates。

## I4 B1 commit diff 共享提取（本地，尚未接回共享分支）

从payload-promote.mjs的commit mutation提取applyPreparedReleaseCommit，供后续受限endpoint和现有手动CLI共用。完整VetoBinding逐字段核对后才创建release entry、移动customer pointer、把当前op置committed、同版本live竞争op置abandoned；已有clean version不可覆盖。CLI保留原expected-sha判断、幂等早退、streamed readback及CAS重读绑定检查。授权、readback、完整manifest校验和CAS仍由调用方负责，本函数不授予发布能力。

新模块缺失先红；实现后9个diff测试通过。既有CLI控制回归连同diff共22tests通过（/tmp/fly2391-commit-builder-regression.log）。独立无node_modules目录导入复现裸包导入失败（/tmp/fly2391-commit-builder-standalone-red.log），改为直接引用仓库B0合同源码后import exit0。最终diff+真实CLI commit共10tests通过：一次写入、同hash幂等零额外写、错hash拒绝（/tmp/fly2391-commit-builder-final.log）；无依赖导入已纳入持久测试，扩展diff suite 10/10通过（/tmp/fly2391-commit-builder-portable.log）。

仍在detached本地checkout，未push；round1批准后才接回唯一共享分支。尚未实现release-attempts接口、能力隔离与endpoint execute/fence，不宣称I4完成。原共享checkout package gate进程55135仍在运行。

## I4 窄角色及部署入口接线（本地）

新增release-auto-executor与release-decision-writer两种独立hash能力。两hash均缺省时新角色关闭；启用其中一个却缺另一个、格式错误、彼此重复或与既有能力重复，都在admin能力判断时fail-closed。新角色可GET完整admin manifest；executor仅可GET当前合法prepared release artifact（active beta与完整B0 binding），decision-writer不可读取payload。两者在进入旧处理路径前即拒绝manifest POST（含no-op）、payload PUT/DELETE、license keys读写等，避免无diff请求绕过写限制。

Worker和Node生产入口仅接收FW_AUTO_RELEASE_EXECUTOR_TOKEN_SHA256 / FW_RELEASE_DECISION_TOKEN_SHA256，测试harness与loopback shell同步支持显式fixture token注入，缺省仍无新能力。没有配置实际环境secret、部署或激活。

TDD：初始8tests为1通过/7失败，实现handler后8/8通过。Worker/Node接线负例12tests中2失败（401≠200），补传递后五文件57tests全部通过，覆盖既有admin/customer/cleanup回归（/tmp/fly2391-capability-final.log）。新测试字符串格式整理后narrow role/Worker 9/9通过（/tmp/fly2391-capability-formatted.log）。两组失败收据分别/tmp/fly2391-capability-red.log和/tmp/fly2391-capability-wiring-red.log。此处只完成角色与只读路径；release-attempts/permit/execute/fence及releaseDecisionRequired旧入口防绕过仍待实现，I4不算完成。

## 2026-09-15 新执行接续审计

TURN implement epoch=6，execution 677c2df1-56be-483c-9b27-9887a5ba37ff。Lead 504407ab-4b10-4ae7-b674-e4f1193a8e78 转交旧 head 的有效 APPROVED；此前 CHANGES_REQUESTED 段为历史。原共享 HEAD 9916d6058 已含 CI 枚举修复。计划 §3/§8/§11 明确覆盖三个 detached 提交，现接回为 87b1d5649（调度）、7ccc170f7（共享 commit diff）、9736d217d（窄角色）；implementation.md 仅追加段落冲突，保留双方内容。

本轮实际运行：Node 三文件20/20通过；scheduler 15/15通过。日志 /tmp/fly2391-resume-node.log 与 /tmp/fly2391-resume-scheduler.log。CI 枚举守卫先报告 payload-promote-commit-shared.test.mjs 未枚举，再补既有 root Node 块后通过（317 shell、63 Node；/tmp/fly2391-resume-enumeration-{red,green}.log）。未运行 host 全包套件；未沿用旧聚合 session55135 作为当前活进程或当前 HEAD 通过证明。

完成审计仍不通过：I2 runtime.ts 仅开关读取，plugin 无生命周期接线；I3 无真实 Gateway/通知 adapter；I4 无 release-attempts.mjs/auto workflow；I5 无 executor polling、activation policy 和 rebind 接线；I6 无 accounting/report 投影。存储与 fixture 不替代这些交付。无 PR，未 push 本轮提交，未提交完成回执。

待 Lead question 83bbf6c4-ad5c-45c2-a002-2cc3bbfce01f 明确最终交付边界；默认完整 I1–I6 保持，不自行缩为 foundation。最终 fresh exact-head review 与 CI 必须等最终代码固定。生产 activation OFF。

## I4 授权信箱、单次执行和精确 fence（2026-09-15）

新增 endpoint release-attempts.mjs 并接到已认证 handler 路由。executor 仅创建 endpoint 生成 id/nonce/time 的不可变 attempt，writer 单独投递绑定完整 attempt 的短时 permit；64KiB 流式 JSON 入参上限、严格字段、schemaVersion=1 包装、create-only 写与内容相同的幂等回执。旧 beta/customer/ops 角色不能调用控制接口。配置缺失时503关闭；未绑定任何生产配置或凭据。

execute 在唯一 started create-only 竞争后复验 prepared/active beta/full tuple、ETag、artifact metadata；复用 B1 commit diff + transition/manifest 校验，在全部网络准备结束后最后复验许可，再最多一次 manifest CAS。仅明确未写入或确定CAS失败写 durable no_write；started后异常保持unknown，重放只读同op证据。真实manifest committed为成功事实，回包丢失不会重发。当前endpoint校验executor传入readback hash与immutable metadata；真实流式下载/hash核对必须由后续executor接线提供，fixture不作真实字节证明。

writer的独立fence-intent绑定decision/nonce/baseETag/full tuple；executor只能将同prepared op以CAS转abandoned。结果区分真实published/fenced/unknown；禁用或许可到期不伪称已撤销。确定性交错证明旧commit先赢→published，fence先赢→旧CAS不能覆盖，均不把cancel本地意图当成功拦截。

TDD收据：初始mailbox 22用例红（路由404）后22绿；执行新增用例确认红后累计34绿；fence新增3用例确认红后37绿。首次执行红灯中的竞态测试等待不存在的CAS导致悬挂，已通过该专属exec session 21167的Ctrl-C结束；随后把等待改为与execute返回竞争，未到CAS明确失败，重新完整红灯记录在/tmp/fly2391-execute-red-r2.log。未改断言范围、超时或跳过，未改运行中的测试文件。

最终6文件101 tests通过，日志/tmp/fly2391-control-regression.log。三个变更代码文件Biome最终通过（/tmp/fly2391-control-biome-r2.log）；首次报告4个测试箭头内赋值lint错误，改为语句块后通过。git diff --check通过。所有红灯及绿灯分别保留/tmp/fly2391-{mailbox,execute,fence}-*.log。

本批不完成I4：pending分页、Worker/serve-node/harness的releaseControl部署配置绑定、旧manifest releaseDecisionRequired gate、控制清理约束及真实executor/workflow仍待接入。I2/I3/I5/I6运行时与真实通知/记账同样未完成。未跑host全包套件、未push、未请求新review、未开PR或完成；Lead范围问题83bbf6c4-ad5c-45c2-a002-2cc3bbfce01f仍待答，完整I1–I6保持。

## I4 部署配置、旧入口硬gate和pending分页（2026-09-15）

release-control-config.mjs严格解析FW_RELEASE_CONTROL_JSON（schemaVersion=1、flywheel项目、audience、非负整数epoch、mode、enabled）和FW_RELEASE_DECISION_REQUIRED。缺配置保留默认off与旧手动部署；配置非法关闭窄执行并开启旧clean写入硬gate。canary enabled必须伴随strict policy。Worker、生产serve-node与shell测试harness均使用同一解析器，不把request参数当配置。没有写入真实环境变量、凭据或部署服务。

/admin/manifest在strict policy下拒绝新增release entry或release commitOp，返回release_decision_required。许可消费者构造的独立commit路径仍可用；合法beta reservation、原customer abandon/withdraw、no-op及清理权限不变。首轮20个配置用例由模块缺失红灯开始；初次实现后18/20通过，失败是测试使用错误的旧合同fixture（beta token放弃release、active→withdrawn）；修正为原customer权限和quarantined状态。随后beta清空pointer因有active beta被原C-1b拒绝，改用合法beta reservation证明原能力保留。最终20/20绿，未放宽生产权限或B0校验。

GET /admin/release-attempts/pending仅writer可读，每页1–100（默认50），使用R2 prefix+delimiter和opaque cursor，按truncated决定后续页。每页仅返回本project/audience/epoch且readyAt距当前不超过5秒、未有permit/started的attempt。未知query、重复参数、坏记录、超额/跨prefix/失去cursor的存储页一律拒绝。FsBucket/MemoryBucket补齐delimiter单目录分页（设计附录解释新增文件范围），cursor按最后key续读，不按删除后漂移的数组offset。未新增授权状态机或执行副作用。

核对[Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2objects)发现官方delimitedPrefixes示例无末尾斜杠；新增测试先复现503，再修为只剥离一个可选末尾斜杠且严格校验剩余UUID。两个本地适配器按文档返回无末尾斜杠，另保留有末尾斜杠兼容用例。首次整体重跑有2个测试expected数组遗漏一处旧斜杠（保留r2失败收据），校正为文档格式后全绿。这是官方接口静态核对与fixture验证，不是实际Cloudflare生产验收。

真实loopback HTTP测试启动生产serve-node并验证固定epoch/audience、durable FsBucket attempt、pending读取和旧customer clean提交403；finally等待该测试子进程exit后清理自有临时目录。最终9文件144 tests通过（/tmp/fly2391-policy-list-regression-r3.log）；12个代码文件Biome通过（/tmp/fly2391-policy-list-biome-final2.log），git diff --check通过。新增endpoint *.test.mjs由ci.yml现有通配入口（当前line1413）覆盖，无新增root Node漏枚举。

红灯收据：/tmp/fly2391-control-config-red.log、/tmp/fly2391-pending-red.log、/tmp/fly2391-list-adapters-red.log、/tmp/fly2391-r2-prefix-red.log。未运行host全包套件；无最终HEAD CI、最终review、PR或完成回执。

下一步I4/I5零构建executor与workflow、B1手动decision/rebind入口及activation workflow；随后完成Bridge scheduler/Gateway/authoritative activation/accounting/report接线与全计划验收。所有I1–I6仍保留，不把本批称为I4完成或真实activation。

## I4 零构建executor与固定workflow（2026-09-15）

新增scripts/release/payload-auto-release.mjs：候选参数严格校验；读取manifest与端点时间（偏差≤5秒），从B0派生full binding并校验digest，流式下载/hash核对后只创建一个endpoint ready attempt。token只读环境变量进Authorization，endpoint限制HTTPS或loopback HTTP origin，拒绝URL credentials/query/path，禁止redirect，网络请求有10秒timeout。没有build、upload、customer manifest POST或writer权限。

收到attempt先以O_NOFOLLOW、0600文件追加并fsync本地receipt，再等Bridge permit；输出仅cycle/release/attempt身份和结果，不打印token/nonce。execute请求只发一次，回包丢失只查询同id；started/unknown不重执行，不因workflow失败重建候选。--attempt-id可恢复已保存身份；published/fenced需验证完整manifest身份，no_write和awaiting_permit明确以非成功退出码报告。后续重试仍由Bridge的fresh claim与最多3次规则约束，本CLI不盲目重建attempt。

新增payload-auto-release.yml：main-only/dispatch-only、固定FW_AUTO_RELEASE_CODE_SHA并要求github.workflow_sha相等、所有action用40hex pin、全局payload-release queue:max、release-auto环境唯一executor凭据、无安装/构建/npm发布步骤。always上传仅含恢复身份的receipt。未创建真实GitHub environment、变量或凭据，未dispatch。upload-artifact v4的精确SHA通过官方GitHub tag API核对为ea165f8d65b6e75b540449e92b4886f43607fa02。

TDD：executor模块缺失红后15绿；加入真实HTTP CLI后首次因fixture时钟固定在7月而被5秒clock guard正确拒绝，改fixture与真实子进程使用同一当前时钟后16绿。该HTTP测试验证落盘先于execute、0600权限和输出无token。workflow缺失红后9绿（含8项pin/权限/恢复/build mutation）。新root Node两suite先触发CI枚举守卫红，补既有ci.yml列表后65 suites枚举绿。

release-workflows-structure.test.sh扩展AUTO的队列/主分支/secret白名单/输入插值检查，并执行新workflow mutation测试；原S4e snippet fixture缺AUTO变量导致首次结构suite失败，补beta-workflow-structure.test.mjs对应文件映射后24项全通过，未放宽任一白名单。上述fixture消费者扩展仅为同一结构守卫依赖，并非产品scope变化。

最终4文件82 tests通过（/tmp/fly2391-auto-final-focused.log），4个MJS文件Biome通过（/tmp/fly2391-auto-biome-r2.log），git diff --check通过。结构24/0收据/tmp/fly2391-auto-release-structure-r2.log。系统actionlint及CI固定1.7.12裸运行均不认识queue:max；旧commit workflow同样复现。下载CI固定版本darwin arm64到本任务tmp并核对官方checksums后，按仓库scripts/check-workflow-startup.mjs正式门（精确queue异常规则+独立queue验证）检查全部8个tracked workflows成功；/tmp/fly2391-auto-startup-check.log。未安装/替换系统工具，也未更改checker或其例外规则。

下一步继续I5：B1手动decision入口/rebind、activation workflow源码与Bridge executor/runtime/Gateway/authoritative activation/accounting/report。当前仍无最终PR/review/exact-head CI/QA/生产验收；未跑host全包套件。完整I1–I6保持，activation OFF。

## I5 手动decision入口与同字节rebind（2026-09-15）

新增rebindPreparedArtifact及payload-promote rebind-prepared-artifact命令。要求旧source op已abandoned、完整source binding digest一致、beta仍active、clean版本从未使用、object未tombstoned；为新的releaseId创建reserved完整tuple，前后流式验hash后转prepared。不上传、不构建、不复活旧op、不移动customer pointer；source/digest/target条件在每次CAS重读。中断于reserve后可按同id恢复，prepared重放零manifest写。cleanup先赢tombstone CAS时，重试重新判断并拒绝新claim。

payload-promote commit增加成组cycle-id/binding-digest与可选attempt-id，保留expected-sha256强校验。decision模式调用同一零构建executor、只读executor token，并要求Bridge许可trigger为founder_go/founder_override且包含actor/manualRequestId；silence_auto不能伪装成手动go。旧模式仍由原customer能力执行，strict endpoint策略拒绝时没有回退。executor的安全receipt writer提取为runAutoReleaseCommand以复用fsync/O_NOFOLLOW/0600，error不回显环境凭据。

既有manual commit workflow增加三项可选decision输入，guard要求完整身份且只准commit；legacy snapshot步骤仅legacy模式运行，commit step条件解析且只注入所选模式token。decision恢复receipt在always路径上传。原release environment/COMMIT确认/main-only/只读permissions保留；这些人工workflow条件不替代服务端的founder go验证。未配置真实environment/secret或dispatch任何workflow。

TDD：rebind模块缺失红→10绿，后补真实CLI零build/零upload/重放和cleanup-CAS交错证据；manual CLI新flag与拒绝auto permit先红后绿；manual workflow缺字段/缺隔离guard先红后5绿。预存拒绝unknown字段的expected-hash负例本身不算新红灯，正路径CLI带匹配expected hash通过后才证明新参数接通。

现有结构守卫先拒绝新增输入、conditional executor secret及pinned recovery action，按明确新合同精确扩展S13/S14和secret集合（仍拒绝其他credential/action），加入manual mutation guard。两个新增root Node suites先枚举红，补ci.yml原列表后67 suites枚举通过。

最终5文件50 tests通过（/tmp/fly2391-manual-final-focused-r2.log）；payload-promote-argv 19/0（/tmp/fly2391-manual-argv.log）；workflow structure25/0（/tmp/fly2391-manual-structure-final.log）；正式startup checker8 workflows成功。6个变更MJS文件Biome及git diff --check通过。真实CLI测试只有本地loopback endpoint/fixture许可，不是实际founder go或发布验收。各红灯保留/tmp/fly2391-{rebind,manual-decision,manual-workflow,manual-structure}-red.log及rebind-ci-red.log。

下一步activation workflow源码、受控rebind任务接线、Bridge executor/scheduler/Gateway/owner+epoch/记账与报告。完整I1–I6不缩减；最终review/CI/单PR/milestone-last/completion均未到达，未跑host全包套件，activation保持OFF。

## I5 部署配置接线（2026-09-15）

activation infra增加B4前置校验及Worker secret staging，仍只在release/main/workflow_dispatch/ACTIVATE运行。配置缺省时零B4写入，保留远端secrets；显式配置必须strict policy=true、完整合法control、互异窄能力与既有能力。关自动不能把policy改回false。decision原始key不进入Actions，仅接收Bridge所持key的SHA256；executor仅暂存原始token用于计算hash。staging先关闭legacy clean bypass，后写两项窄能力hash，最后写control；失败立即停止。未配置真实vars/secrets、部署或启用。

TDD：deployment模块缺失红，最小helper后17绿；workflow缺步骤红，接线后43聚焦测试绿。测试覆盖缺省零写、disable保留policy、缺项/重复凭据拒绝、精确wrangler参数及stdin、首步staging失败不继续。新endpoint测试被既有CI wildcard收录。一次测试参数重命名误改既有mock导致1红，恢复被使用参数后43/43（/tmp/fly2391-activation-final-r2.log）。结构守卫按新两步骤/单一executor secret扩展，25/0（/tmp/fly2391-activation-structure.log）；正式startup checker8 workflows成功。3文件Biome、diff check通过。只做本地隔离检查；没有host全包套件或真实activation证据。

剩余受控rebind dispatch、Bridge运行期/Gateway/epoch/记账等，仍完整I1–I6。最终非draft单PR、milestone-last、exact-head round2 review和CI及completion尚未进行。

## I5 受控rebind dispatch（2026-09-15）

既有prepare workflow新增默认prepare的mode选择及source-release-id/source-binding-digest。prepare仍要求beta且拒绝rebind字段；rebind要求不同的新releaseId、旧source id和64hex binding digest，并拒绝beta。首步main/input guard先于checkout。rebind分支跳过derive、历史checkout、安装和构建，只用reviewed main helper/beta能力调用已测same-byte rebind CLI。初始checkout使用固定SHA且不留git凭据；prepare的DERIVED checkout改用同一固定Actions checkout/ref来保持私有repo fetch能力，仍不接受用户source commit。

新增workflow测试先因缺mode和输入拒绝红，再连同真实rebind CLI suite14/14绿（/tmp/fly2391-rebind-workflow-final.log）。测试逐项验证legacy步骤对rebind都跳过、manifest-derived checkout、最小凭据、执行真实bash guard的partial/mixed/非法id/ref拒绝。结构25/0、startup8 workflows成功；root枚举68 Node/317 shell通过，Biome及diff check通过。没有远端dispatch/发布；Bridge调度接线仍待实现。

## I5 Bridge控制信箱客户端（2026-09-15）

新增CustomerReleaseMailbox decision-writer传输：每次只读limit=1的单页pending，校验cursor推进、完整attempt/B0 tuple/项目/audience/epoch；受信endpoint origin限定HTTPS或loopback HTTP，拒绝URL凭据/path/query/hash、redirect、超时/HTTP错误、超过4MiB响应。没有内部retry、ready创建、execute或fence执行能力。deliverPermit只投递调用方已持久化permit原体；observe要求远端attempt及permit精确一致，使用共享结果验证，null/unknown不变成no_write。requestFence仅投递精确decision/nonce/etag/binding意图；旧epoch观察保留，以便disable/epoch变化后reconcile。

TDD：模块缺失红（/tmp/fly2391-mailbox-red.log）→6聚焦绿→真实endpoint handler往返及拒绝测试。最终client8项+既有decision55项共63/63（/tmp/fly2391-mailbox-final.log），含permit已持久化但回包丢失→同体重投、真实manifest published/fenced、跨epoch旧结果回读、错误HTTP/不同permit拒绝。fixture制品元数据沿用endpoint测试，非生产字节或founder授权证据。初次TS检查因never箭头的控制流收窄报错，改明确function声明后teamlead tsc --noEmit通过（/tmp/fly2391-mailbox-typecheck-r3.log）。Biome、diff check通过。两次命令cwd/filter错误未算测试证据，最终均在teamlead正确路径执行。

还没有把客户端接到Bridge生命周期和1秒轮询/事务claim；该下一步必须坚持先远端探测、同步StateStore claim、持久permit后投递，故障不重mint。完整runtime/Gateway/activation/owner epoch/accounting/report与最终交付门仍待完成；未跑host全包套件，未部署/dispatch/激活。

## I5 持久决策优先的轮询核心（2026-09-15）

新增CustomerReleaseDecisionPump单次tick及StateStore只读unresolvedDecision/hasPostClaimIntervention。先查最早未决持久permit并读端点结果，terminal先记原事务账；null/unknown不能释放为新claim。有效期内null只重投同permit；过期、时钟回退、claim后失效或auto authority关闭时投递固定reason的精确fence intent。真正执行fence仍归executor，pump不越权。所有远端异常返回unavailable，不伪造no_write。没有未决decision才读单页pending；先远端manifest/delivery探测，再同步调用原claimAuto事务，持久permit后才投递；single-flight拒绝重叠tick。

TDD：新增Store读取断言先红、56绿；pump模块缺失红、5绿；加入真实StateStore事务穿透：远端probe期间失效先赢时无permit投递，正常路径投递已存decision。最终2文件62 tests通过（/tmp/fly2391-pump-final.log），teamlead tsc --noEmit通过（/tmp/fly2391-pump-typecheck.log），Biome/diff check与现有retention-consumer gate通过。未新增表或独立数据库生命周期。

边界：当前tick只claim自动awaiting_attempt；已持久人工decision可沿共同恢复路径回读，但manual_ready的新claim接线、真实周期scheduler/1秒cadence/backoff/lifecycle、Gateway/activation/owner epoch/accounting/report还待完成。fence intent尚需executor恢复dispatch联通。没有远端启动、生产授权或验收，完整I1–I6及最终review/CI/PR/completion仍未满足。

## I5 人工claim与executor fence恢复接线（2026-09-15）

pump新增manual_ready分支：通过原manual store唯一active索引查accepted请求，用该请求的独立manifest probe、authority、readiness evaluator调用原manual.claim同步事务，之后才投递持久permit。不会借用已取消auto窗口的receipt或auto enable旗标。人工未决permit恢复核对当前founder/project/audience/epoch/policy/executionEnabled；变更则固定意图fence，保持共同结果回读。自动运行没有manual adapter时拒绝人工新claim。

零构建executor新增operation=execute|fence（默认execute）。fence必须已有attemptId，不能创建ready；unknown结果也先验证身份再进入精确fence，不把unknown当终态。请求前持久化fence_requested恢复记录，只调用现有POST /:attempt/fence；授权仍是Bridge已写的精确intent。回包丢失只读同id；缺intent保持unknown，不回退execute。固定代码的release-auto workflow加入同一枚举及guard，fence缺attempt拒绝，保持同一队列、窄token和always恢复artifact。

TDD：真实StateStore manual pump先红后绿（含probe期间失效不投递），2files63/63（/tmp/fly2391-manual-pump-green.log）；追加人工恢复owner变更测试，pump6/6（/tmp/fly2391-manual-pump-authority.log）。teamlead tsc通过（/tmp/fly2391-manual-pump-typecheck.log）。executor fence新增mode先红，真实endpoint覆盖未启动、ambiguous started、丢fence回包与无intent，连同workflow实际bash guard共34/34（/tmp/fly2391-fence-final.log）。结构25/0，startup8 workflows成功，7文件Biome/diff check通过。均是本地隔离证据，不是生产founder go、dispatch或灰度验收。

下一步真正Bridge lifecycle/cadence/dispatch适配、scheduler、Gateway、authoritative activation/owner epoch、accounting/report。虽然workflow已能执行fence，Bridge尚未dispatch恢复job。完整I1–I6与最终单PR/milestone-last/exact-head round2 review/CI/completion继续未完成；activation OFF。

## I5 生命周期定时核心与停机失效（2026-09-15）

CustomerReleaseRuntime实现Bridge可持有的start/stop生命周期：启动先recoverAfterRestart再启单一1秒timer，unavailable指数退避上限30秒；有未决decision时只pump恢复，不推进新周期。clock rollback/tick gap先暂停claim并失效旧工作；无效数值时钟先锁住故障，待可记录有效时间后补写clock_invalid，不能静默恢复旧窗口。stop先同步pauseClaims、abort在途scheduler signal并invalidateRuntime，然后等待在途tick、执行一次仅恢复drain observation并返回结果；不把stop成功当无远端写入证明。timer unref且不重叠，重复start/stop不造额外loop。

pump在pending前和远端probe返回后检查pause，对已暴露permit仍可读回/fence。新增StateStore.invalidateRuntime区分preclaim取消与committing/unknown的post-claim intervention；restart补入manual_ready，避免accepted但未claim的旧go跨重启继续。

TDD：pump pause及lifecycle缺失先红后11绿；invalid clock故障恢复漏失效先红，补latch；真实StateStore停机/重启断言验证人工preclaim取消与已暴露permit保留。3文件71/71（/tmp/fly2391-lifecycle-final.log）。scheduler abort新增先红后lifecycle6/6（/tmp/fly2391-lifecycle-abort-green.log）。retention consumer gate ok=true/errors=[]；diff check与Biome通过。源码加入AbortSignal后teamlead tsc再次通过（/tmp/fly2391-lifecycle-typecheck-final.log）。无host全包套件、生产启动或远端副作用。

重要边界：这是可组合的生命周期核心，plugin.ts尚未构造/启动它；advance和网络adapter还须接真实scheduler/Gateway/config/activation/dispatch并遵守abort信号。authoritative owner epoch、activation证据reader、accounting/report与最终全量审计仍未完成。完整I1–I6、单非draft PR/milestone-last/exact-head round2 review/CI/completion继续保留；activation OFF。

## I5 首周期前activation权威与owner epoch（2026-09-15）

Lead question b4d0fd8a-7123-4d2d-a633-e389c30fbb51裁定：允许独立customer_release_activation状态表+append-only授权事件表，同StateStore连接且同事务invalidateRuntime；不改已审foundation的cycle FK，不伪造cycle，不新增daemon/tick。claim只认新权威，fixture仅测试且生产不可达。本批按此实施，保留原cycle events/actions结构。

customerReleasePolicyDigest使用strict配置parser并按ASCII键排序，排除摘要自引用和未来enableReceiptId，其余mode/日程/目标/凭据来源/workflow绑定都入policy摘要。customerReleaseIdentity核对声明摘要、canonical founder、固定endpoint origin/audience和两类互异凭据；只返回凭据SHA256作轮换检测，不返回raw值。

ActivationStore能在首cycle前创建epoch1 disabled状态；相同identity零写，owner/config/credential rotation使epoch单调增加、撤销enable并同事务失效旧工作。enable要求已由专用Discord adapter核实的delivered notice绑定、当前epoch/identity/owner和exact message/app/channel；有效动作写不可变事件及enable状态。disable同事务撤销与失效，重放不重复写。新事件有UPDATE/DELETE硬拒绝。输入字段严格allowlist，避免interaction token等原始字段落账。当前仍没有生产Gateway调用这些写方法。

claimActivation已只读新activation状态/当前enabled事件，拒绝旧cycle enable row替代。既有测试迁到__tests__/customer-release-activation-fixture.ts直接构造受控新表数据；生产源码零引用，无生产兼容旁路。新表均protectedAuthority；完整表fixture237、非可选234、authority49。

TDD：identity模块缺失红→3绿；activation store缺失红→2绿；disable缺失红→3绿。集成后清单fixture少两表造成1红，更新真实登记后5套件158/158（/tmp/fly2391-activation-authority-final.log），包括事务回滚、owner变化撤销、旧epoch动作拒绝和legacy启用旁路拒绝。额外字段可被写入的负例先红，补exact字段拒绝后store3/3（/tmp/fly2391-activation-fields-green.log）。retention-consumer gate ok=true；Biome、diff check通过。teamlead类型检查通过（/tmp/fly2391-activation-typecheck-final.log）。

仍缺activation真实证据bundle reader/Gateway认证与卡片投递、配置刷新调用synchronize、scheduler/dispatch适配及plugin生命周期组合、accounting/report。两表仅本地代码及fixture，不是founder启用或灰度验收。完整I1–I6与最终单非draft PR/milestone-last/exact-head round2 review/CI/completion仍未完成，activation OFF。

## I4 专用Discord Gateway传输（2026-09-15）

依据Discord官方Gateway、Gateway Events、Application及Receiving and Responding文档核对协议：INTERACTION_CREATE无需额外intent，Gateway交互仍通过HTTP callback回应，首次回应预算3秒；application的HTTP interaction URL与Gateway入口互斥。参考：https://docs.discord.com/developers/events/gateway 、https://docs.discord.com/developers/events/gateway-events 、https://docs.discord.com/developers/resources/application 、https://docs.discord.com/developers/interactions/receiving-and-responding 。

新增ReleaseInteractionGateway，复用既有ws。启动只读/users/@me、/applications/@me和/gateway/bot验证bot/app身份、无HTTP interaction URL、session start额度与固定Discord WSS origin；intents=0。HELLO/Identify/READY/heartbeat ACK建立健康状态，seq gap、session invalid、断线、心跳丢失同步调用失效adapter，重连5–60秒退避（session额度耗尽按reset等待）。每次新连接重新Identify，不resume/恢复被取消的旧周期。64KiB流式REST与frame上限，连接/请求timeout，拒绝redirect和替代端点。健康getter额外核对ACK时间，避免事件循环积压时读取过期健康。

验证项目app/guild/channel、canonical founder/member非bot、消息bot作者、action/nonce/epoch，将无token的最小action送同步commit回调；该回调必须完成durable transaction，之后才发送ephemeral HTTP成功回应。重复交互仍走事务幂等，但bounded回复缓存避免重复callback；旧session迟到的回应失败不失效新session。普通用户/非目标/旧epoch交互拒绝且不触发全局失效，防止旁人点击造成周期DoS。数据库失败或应答预算耗尽不报成功，失效当前健康。没有HTTP/runner bearer入口。

TDD：模块缺失红→4绿；非owner拒绝曾错误触发全局失效，新增健康保持断言红→修正；迟到心跳定时器健康过期先红→时间校验。最终8/8（/tmp/fly2391-gateway-verified.log），覆盖提交先于ACK、身份拒绝、gap/heartbeat/close、DB失败、重复交互、旧session响应与HTTP入口配置拒绝。使用fake socket/HTTP，未读取真实bot凭据、注册app、启动线上连接或发送消息。Biome/diff check通过，teamlead类型检查通过（/tmp/fly2391-gateway-typecheck-verified.log）。

还必须实现nonce→持久notice/完整内容摘要匹配及真实StateStore动作router、card delivery/access/30s复验、evidence reader/config刷新、scheduler/dispatch/plugin组合、accounting/report。当前commit/invalidate是待组合的同步adapter回调，不代表真实founder路径已验收。完整I1–I6与最终单PR/milestone-last/exact-head round2 review/CI/completion继续未完成；activation OFF。

## 续接代码审计与冻结卡片（2026-09-15）

执行 e6cae5c0-6c9a-448f-b5cc-eb3236dd7cae，TURN implement epoch=9。实时 check 5876cd77-e030-4bc3-b87c-c5abf81d4458 确认有效设计 APPROVED；当前分支无 PR。Lead handoff 7cdb7235-f769-4163-ae94-910cd0afab25 要求保留 30 个已有提交、审计真实进度，并按名称检查 stash。精确匹配 stash message `FLY-2391 quota-death WIP 20260914T2120Z` 得 a9fb9bc87242c6d64bb8a7de96791ee47d2b6896：仅早期 decisions 测试 89 行；当前 1092 行版本已包含其全部七组 T11 用例且更新为独立 activation 权威。因此未应用或删除 stash。

按 plan §11 的真实分块（不是历史批次标题编号）：

| 块 | 当前源码证据 | 剩余 |
|---|---|---|
| I1 | config strict parser/export、默认 off 旗标；StateStore 同连接 cycle/notice/action/decision/activation 表、保护登记；store/policy tests | 最终全仓/CI gate |
| I2 | scheduler 是纯日历函数；runtime 提供 cadence/restart；StateStore B3 写点同步失效 | 周期 advance 的真实来源/prepare 调度、plugin start/stop 组合 |
| I3 | notice/veto store、Gateway transport、冻结 card/digest | 真实 REST delivery/access/reprobe、nonce 到持久动作路由、日报接线 |
| I4 | endpoint 控制信箱/permit/CAS/fence、窄 capability、auto workflow/CLI | 最终集成与 exact-head gate |
| I5 | mailbox/pump、manual store、activation store、rebind/activation workflow | evidence reader、config/owner 同步、dispatch/recovery、plugin 组合、B0 消费者说明 |
| I6 | 源事件存在；无 accounting/report 模块或 projections 表 | 外部幂等投影、只读日报、runbook、完整验收及 PR/review/CI |

本批补 cards.ts：默认 veto 与明确 go 卡片，冻结 clean/beta 版本、source/hash、配置时区截止、epoch/nonce；禁 mentions。digest 规范化 Discord component id 与 disabled=false，绑定正文和全部按钮字段，拒绝未知组件字段及额外 embed/attachment/sticker。该模块尚无生产调用，不代表通知或 founder 路径已通电。

TDD：保留测试先报缺模块；实现后 4/4；增加 beta/当地截止要求先断言红，再补必填 timezone/beta 校验后 5/5。TeamLead tsc --noEmit 通过（/tmp/fly2391-cards-typecheck.log）。当前 customer-release 全部 focused 14 files / 230 tests 通过（/tmp/fly2391-resume-focused.log）；Biome 两文件、git diff --check 通过。不是全仓 aggregate/CI 或生产验收。activation OFF；完整 I1–I6、单非 draft PR、milestone 最后提交、最终有效 review 与 CI、needs_review completion 仍未完成。

## I3 候选动作路由与频道权限（2026-09-15）

ReleaseCandidateActions 将 Gateway 认证后的 nonce 定位到唯一持久 notice/cycle 或独立 manual request，核对当前 owner/epoch/app/guild/channel、冻结正文与按钮摘要、bot 身份后才调用原 veto/go 同步事务。veto 的完整 bindingDigest 只从数据库读取；普通交互不能提交自选 binding。首次 go 必须有独立新鲜 access/delivery probe；重复 go 由原 action receipt 幂等返回，探测暂缺不抹掉历史成功。claim 后只说已记录、正在核对提交结果。enable/disable 留给独立 activation authority 路由，候选路由拒绝它们。

Gateway 将 embeds/attachments/stickers 一并传给摘要校验，避免剥掉额外可见内容后误判原卡。真实 SQLite + fake authenticated Gateway 的三条集成链验证提交先于 HTTP callback、DB 注入失败零成功回应、额外 embed 零成功回应。不是线上 Discord 发送或 founder 点击证明。

canAccessReleaseChannel 按官方权限合同计算 everyone、合并 roles、member overwrite；核对真实 guild/channel/member、role 完整性、VIEW_CHANNEL+READ_MESSAGE_HISTORY，bot 再要求 SEND_MESSAGES。pending/timeout 或畸形数据拒绝；当前支持专用 text/announcement channel，thread 需要额外 membership 证据，当前拒绝。参考 https://docs.discord.com/developers/topics/permissions 与 https://docs.discord.com/developers/resources/message 。REST reader/送达控制器尚待接入此函数。

TDD：actions 模块缺失红→13绿；补 Gateway/SQLite 3条集成后16/16。actions+gateway+decisions 先前合计81/81；权限模块缺失红→6/6。TeamLead tsc通过（/tmp/fly2391-actions-typecheck.log），retention consumer gate ok=true/errors=[]；Biome/diff检查通过。后加集成测试仍需最终类型检查。下一步 REST 投递/回读/扫描恢复和持续探测，随后 activation/evidence/advance/plugin/accounting/report。完整任务未交付；activation OFF。

## I3 REST 投递、独立回读与恢复（2026-09-15）

ReleaseDiscordClient 使用专用 bot、固定 Discord origin、拒绝 redirect、15秒请求超时与512KiB流式读取上限。发送前验证 bot/app、无 HTTP interaction endpoint、真实 guild/channel/founder/bot membership 与有效权限。消息回读检查指定 channel/bot、无 webhook/异类消息/额外 poll或reference、冻结正文/按钮摘要；proof时间取整组探测开始时间，避免慢探测被标为新鲜。异步期间 owner/config/epoch/Gateway health变化拒绝。

POST 使用 notice 128-bit nonce 的 base36 表达（不超过25字符）和 enforce_nonce；不实现 POST 自动重试。恢复以持久按钮 nonce marker 为准，支持 Discord 不返回 nonce；有界扫描（最多10页×100条）回到最早发送时间前，重复marker、重复/乱序id、分页缺失/失败/截断一律不确认。找到消息仍必须独立 verifyMessage。官方 enforce_nonce 只在过去几分钟去重，因此不作为长期重发许可。参考 https://docs.discord.com/developers/resources/message 。

CustomerReleaseNoticeDelivery 将 transport 组合到原 store：先耐久 sending 再调用一次 POST；sending/uncertain 恢复只查原卡，0或多条不重发。回读proof与原notice所有身份/digest字段逐一比较，满足最小窗口才调用openWindow。正常probe只读 delivered 消息，失败/过期/身份漂移写同步失效事件；后续健康不能清取消。abort亦不补发或重新开窗。它仍需由真实advance/runtime调用，本批未启动bot或发线上消息。

TDD：REST模块缺失红→10/10，覆盖lost POST、nonce marker恢复、重复/截断历史、权限缺失、HTTP endpoint变更、消息/作者漂移。delivery模块缺失红→9/9；追加stale/mismatch proof用例红→加强逐字段核验后10/10。动作/权限/REST/投递四文件合计42/42。原REST新增时TeamLead tsc通过（/tmp/fly2391-discord-typecheck.log）；最终delivery tsc结果见 /tmp/fly2391-delivery-typecheck.log。完整I1–I6、runtime/plugin/activation/evidence/dispatch/accounting/report及最终PR/review/CI仍未完成，activation OFF。

## I2/I5 源证据与耐久 workflow 调度（2026-09-15）

CustomerReleaseSource 按当前部署 SHA 选择 active beta 的最大安全 betaN；同源码出现跨 base 冲突则 unknown。完整 manifest 经 B0 validator，绑定 ETag/端点server-time并检查5秒时钟容差；decision token仅GET manifest，已有beta capability仅GET精确prepared对象。deriveVetoBinding必须等于冻结candidate，再流式hash校验正式包，不在Bridge构建或修改manifest。4MiB manifest及2GiB对象流上限、超时、固定origin/禁止redirect；只保留流hash，不落本地包。核对真实handler后发现GET对象没有保证Content-Length：复现该返回形状先红，再支持缺省length；有length仍校验，所有流必须非空且完整SHA256相等。

CustomerReleaseGitHub 在dispatch前核对repo数字id/full_name/main、workflow数字id/path/active、当前main等于reviewed SHA；只支持prepare/rebind与窄auto execute/fence参数，不支持ship/merge。固定api.github.com、API版本2026-03-10、有界分页/2MiB响应/超时。observe通过dispatchId+实际mode/operation+releaseId的run-name找唯一run，再核对repo/workflow/event/branch/head_sha、run_attempt=1与创建时间；不拿其他操作的成功run当证据。prepare/auto workflow增加可选dispatch-id及hex guard，现有人工调用可留空；run-name直接带实际操作与releaseId。未改变队列、权限、环境或发布gate。官方参考：https://docs.github.com/en/rest/actions/workflows 。

CustomerReleaseDispatch在StateStore同连接append-only customer_release_events中先写workflow_dispatch_started（冻结binding和inputs、唯一dispatchId），再发POST。重新构造adapter、模糊POST或进程断在持久意图后，只observe原标记；不重复POST。周期状态/候选不合或同id内容漂移拒绝；DB失败在网络动作之前。这里的null是未证实，不是no-write；后续advance必须按固定周期时限取消/核对。

TDD：source/github/dispatch分别模块缺失红→4/7/4绿；run-title加入实际操作/候选后先4红再绿；workflow run-name结构新增断言红→11绿。source/github/dispatch/store当前27/27（/tmp/fly2391-dispatch-focused.log）；两份workflow Node tests13/13，release-workflows-structure25/0。Content-Length真实形状修正后source4/4。retention consumer gate ok=true/errors=[]（/tmp/fly2391-dispatch-retention.json），dispatch阶段TeamLead tsc通过（/tmp/fly2391-dispatch-typecheck.log）；最终stream修正类型检查见 /tmp/fly2391-source-stream-typecheck.log。以上仅隔离fixture，无线上GitHub dispatch或payload访问。

真实cycle advance尚未组合这些模块。后续还需activation卡片/证据reader/config同步、plugin start/stop、人工准备/恢复接线、accounting/report/runbook与完整I1–I6验收，最终单非draft PR、milestone最后提交、exact-head review/CI与needs_review completion。activation仍OFF。

## I2 自动周期组合与无候选周锁（2026-09-15）

CustomerReleaseAdvance 组合实际 source、readiness、dispatch journal、notice delivery：仅当前独立activation已enable、owner/policy/receipt匹配且canary+flag时推进。通知时间前不占周期；冻结本周beta→B3 green→耐久prepare→prepared全量hash回读→唯一消息→固定deadline后fresh delivery+readiness→耐久executor dispatch。permit仍仅由decision pump领取。off/observe/disabled、负面B3、owner/source/config漂移、迟到notice和过期claim都停止；一秒runtime tick的通知和workflow回读限制为30秒一次，deadline前最后一次强制新回读。

Lead question 7823f02f-099b-4a02-9ee9-46985d196824 approved bounded adapter ruling：现有不可变 customer_release_activation_events 增加 cycle_slot_missed，project+week唯一，不新增表、不伪造cycle或artifact。来源读取/选择unknown或到点无eligible beta在首次检查写周锁；同周后来beta出现、adapter重建、owner epoch变化都不重开，下一周独立。记账投影仍待实现。

TDD：无候选/来源异常2红→修复；未知deployed SHA及notice时间前推进2红→修复；最终advance15 + activation-store3 =18/18（/tmp/fly2391-advance-green.log）。覆盖green完整推进、hold/unknown sticky、off/observe/disabled/unapproved、异步owner漂移、late notice/claim cutoff、probe节流、周锁恢复及immutable UPDATE/DELETE拒绝。TeamLead tsc --noEmit exit0（/tmp/fly2391-advance-final-types.log），scoped biome与diff检查通过。无线上消息/dispatch/启用。

本批只完成自动advance组合；plugin尚未接入，activation卡片/证据reader/config生命周期、人工准备/恢复接线、accounting/report/runbook和完整I1–I6终验仍待完成。未宣称aggregate/CI/review/PR验收；activation保持OFF。

## I3/A6 activation 卡片、可信动作与投递（2026-09-15）

activationCard 明示project、policy/identity/evidence摘要、epoch与启用截止，独立enable/disable按钮和禁止mention；不借用veto/go或ship授权。ReleaseActivationActions同步验证canonical founder、Gateway目标、当前epoch/identity/policy、原message和完整card digest。enable还要求当前可信A0–A5 digest相同；disable停止新claim，unresolved时只声称继续核对结果。独立control_notice保存在原append-only activation events；写enable对应原enable_notice在同事务完成，未新增表。旧enable卡使用后不可在disable后用新interaction再次启用（先复现1红再修复）；必须新卡新动作。

ReleaseControlDelivery先写control_sending耐久意图，再一次POST。lost POST及adapter重建只从原发送时间扫描唯一nonce并独立回读；不重发。回读proof需当前owner/app/channel/bot、完整digest、healthy/access及30秒新鲜度；异步前后身份/证据/epoch变化不记录delivered授权。卡片投递失败不启用，不把该卡片状态当线上验收证明。

TDD：controls模块缺失红→动作测试绿，旧卡re-enable回归红→单次notice消费修复，control-delivery缺失2红→投递及owner-race绿。最终controls11+activation-store3+advance15=29/29（/tmp/fly2391-controls-final.log）。这些是SQLite+替身transport测试，无线上Discord消息/按钮点击或视觉验收。先期controls tsc exit0，最终含delivery的类型检查记录 /tmp/fly2391-controls-final-types.log。

仍需可信A0–A5 evidence reader、配置/凭据/owner生命周期同步、真实plugin与Gateway动作路由、控制卡创建触发、人工候选准备/恢复、accounting/report/runbook及全仓/精确head review和CI。当前代码尚未接入plugin，activation保持OFF，未达I1–I6整体完成。

## A0–A5 证据读取合同（2026-09-15）

readReleaseActivationEvidence 从可信部署目录读取 bundle.json，严格校验六阶段顺序、逐项必需证明、真实live/独立observe模式、环境/endpoint/code/policy/identity一致、精确manifest/subject/release/hash与actor/time。每项绑定同目录captured output的SHA256和HTTPS证据URL。拒绝未知字段、缺项、unknown、过期/未来、输出漂移、symlink及路径穿越。普通文件1MiB/总8MiB上限，读取使用固定长度buffer，检测文件长度/mtime/ctime及根目录身份变化；无网络、命令执行或凭据读取。

这是操作人采集收据的完整性与身份校验，不能认证输出语义、URL内容或把fixture升级为真实E2E。新增 activation-evidence.md 明示信任边界、精确格式、每阶段检查名及A6/A7未执行事实；运行时必须重新验证digest，不把历史成功缓存当当前授权。

TDD：模块缺失红；正向首次受macOS临时目录alias影响而红，将fixture规范化为真实路径（生产仍拒绝symlink路径）后11/11绿（/tmp/fly2391-evidence-green.log）。TeamLead tsc两次均exit0，最终包含有界读取的记录 /tmp/fly2391-evidence-final-types.log；diff检查通过。未采集线上证据，未启用。

接线识别待答设计细节：question 486cf1a1-175c-43f7-af1c-175ccbeedac8 请求允许无future founder receipt的staged canary解析，保持真正claim的所有现有回执/flag/身份gate；避免伪造placeholder。当前未改配置解析。下一步仍为实际lifecycle/plugin/控制卡触发、manual recovery、accounting/report/runbook和完整验证/PR。

## A6 bootstrap 最小修正（2026-09-15）

按 Lead question 486cf1a1-175c-43f7-af1c-175ccbeedac8 的明确 bounded approval，parser仅对canary显式空founderEnableReceiptId开放staging解析；不接受缺失字段、不合成placeholder、不改旗标。advance额外显式要求非空receipt后再比较耐久记录。store claimActivation仍读取enabled事件并核对actor/epoch/receipt；claimRejection仍要求enabled=true和enableReceiptValid=true。

TDD：新增空值解析用例先红，最小parser修正后config7/7，config build exit0。StateStore许可侧覆盖空收据和disabled零permit、有效收据仍可silence_auto；advance空收据不reserve/dispatch，填入已耐久收据后同epoch开窗；identity测试通过实际enable store动作再同步填入后的配置，epoch=1且授权保留。三文件81/81（/tmp/fly2391-staged-runtime-green.log）。scoped biome发现前一批advance两个未标注let，补返回类型标注后通过；无行为变化。最终TeamLead类型结果记录 /tmp/fly2391-staged-types.log。

运行时plugin、真实控制触发、人工恢复、accounting/report/runbook及全仓/最终head gate仍未完成；无线上启用或发送。本修正消除接线bootstrap循环，不代表A6已取得。

## 运行时当前授权读取（2026-09-15）

CustomerReleaseAuthority 在同步边界重新解析当前配置、canonical founder、endpoint/audience和bot/decision凭据指纹；将可信部署摘要（由composition root负责绑定运行代码、reviewed workflow及其凭据来源）加入identityDigest后同步独立activation epoch。回执复制不改identity；owner/token/deployment变化提升epoch并清旧授权。read返回当前target与CustomerClaimActivation，实际enabled仍须canary+flag+非空匹配耐久receipt+当前evidence。默认off不需要凭据/证据，不产生网络动作。

新增同事务activation.revoke：runtime_disabled事件、撤销启用记录和失效未claim周期一同提交。配置非法或当前evidence缺失/变化不在恢复后自动恢复旧grant；需新founder动作。未曾auto-enable时也要失效pending manual work（该遗漏先测试红再修复）。已claim提交仍沿现有invalidate/未决记账路径处理，不声称自动回滚。

TDD：authority模块缺失红→基础8绿；增加DB撤销失败测试，原授权与事件事务回滚并向调用者抛错；manual未enable失效用例红→修复，最终authority10+activation-store3=13/13（/tmp/fly2391-authority-final.log）。scoped biome和diff检查通过。先期TeamLead tsc exit0，最终小改后的结果 /tmp/fly2391-authority-final-types.log。

这里尚未连接实际plugin composition root；部署摘要的采集、adapter生命周期/旧连接drain、Gateway路由/控制触发、manual恢复、accounting/report/runbook及全仓/精确head gates仍待完成。以上仅SQLite与本地fixture，无线上启用。

## 实际 Bridge host 接线（2026-09-15）

新增createCustomerReleaseHost并挂入plugin startBridge/close：真实项目YAML、canonical founder、build SHA、FlagStore、B3 service供给运行会话。会话组合authority、专用Gateway、candidate/activation动作、Discord投递、source、GitHub耐久dispatch、decision mailbox/pump、advance/runtime。默认off无凭据时无网络；完整staged配置可读身份/窄pending信箱，但没有发布POST。observe仍无auto advance/permit。manual pump的技术probe/readAuthority已接，人工卡片创建/投递缓存尚未实现，不能宣称人工全链路完成。

部署绑定从严格非secret JSON和指定env credential sources采集摘要，记录格式见activation-evidence.md。每秒刷新配置/owner/当前授权；identity/StateStore连接变更先暂停旧runtime并断Gateway，使用旧会话原mailbox核对未决结果，不把旧permit交给新endpoint/token。shutdown先pause再关闭Gateway，即使Gateway失效记录出错也await runtime停止。错误报告去重，无参数/凭据输出。尚缺独立fence-workflow恢复调度，未决无法确认时继续保留，不伪称drained。

TDD：host模块缺失红→默认off/坏配置2绿；真实组合启动+owner rotation测试确认epoch变化与零写请求。测试初稿误限定所有读取都在Discord域，而真实pump需要窄信箱GET；按批准的“零permit/commit”边界改为断言所有请求为GET，未放宽生产gate。最终host3+authority10+runtime1=14/14，/tmp/fly2391-host-final.log。首次tsc发现createBridgeApp/startBridge不同词法作用域与数组下标可能undefined，已修正到实际startup作用域；第二次exit0，最终stop-order修改的检查记录 /tmp/fly2391-host-final-types.log。plugin改动仅新增两个import、host startup/close和独立无副作用B3 service构造。

无真实Discord连接、真实workflow dispatch、endpoint写入或服务重启。完整I1–I6仍待：control触发、manual投递/恢复、fence调度、accounting/report/runbook和全仓/最终head review/CI/PR。activation保持OFF。

## 窄执行器 fence 恢复调度（2026-09-15）

CustomerReleaseFenceRecovery接入真实host的pump.requestFence。先核对当前耐久unresolved permit完整相等，再通过原mailbox提交并确认fence-intent；模糊/失败响应不调度workflow。确认后重新检查未决身份，使用同一decision派生dispatchId、原claimedAt和精确cycle/release/binding-digest/attempt-id发起operation=fence。原CustomerReleaseDispatch仍先耐久意图再单次POST，重建adapter只observe。单会话30秒合并重复请求；重启允许再次确认幂等endpoint intent，但不重复workflow POST。

成功workflow observation不改变decision结果；只有现有mailbox.observe的真实endpoint终态能结束未决。身份/epoch轮换期间，host保留原会话mailbox和reviewed workflow绑定用于此恢复；没有创建替代permit、改客户指针或关闭endpoint policy。若原已review workflow不能运行，继续保留unknown等待明确处置，不把失败/超时当no-write。

TDD：新增两条真实StateStore fixture用例先模块缺失2红，恢复实现后绿。覆盖intent先于单次dispatch、精确inputs、同会话重复/adapter重建、workflow succeeded仍保留unresolved、模糊intent与替换permit零dispatch。最终decisions63+host3=66/66，exit0（/tmp/fly2391-fence-final.log）；TeamLead tsc exit0（/tmp/fly2391-fence-types.log）。所有网络均替身，无线上fence或dispatch。完整剩余仍包括控制卡触发、人工候选卡/回读缓存与恢复、accounting/report/runbook、全仓和exact-head review/CI/PR。

## 控制卡显式触发接线（2026-09-15）

ReleaseControlTrigger接入真实host会话，健康Gateway且未drain时读取可信evidenceDirectory/control.json。严格校验固定nonce/epoch/identity/evidence/expiry，enable要求canary和当前A0–A5摘要，observe不投递；disable可在证据丢失后请求，但始终是独立disable卡。触发只调用ReleaseControlDelivery，沿既有单次POST/独立回读/耐久receipt路径，不直接enable，不写旗标。相同请求30秒节流，deadline不重算。文件读取16KiB、普通文件/NOFOLLOW/固定长度buffer及mtime/ctime检查，缺失/非法均不触发。

TDD：模块缺失红→触发8绿；加文件读取边界测试后trigger9+controls11+host3=23/23（/tmp/fly2391-trigger-final.log）。首次types发现对象action被扩大为string，显式Omit<ReleaseControlNotice,...>类型修正，最终记录 /tmp/fly2391-trigger-types2.log。未在真实目录写control.json或发送Discord消息。

仍需人工候选准备/新卡投递/回读缓存与恢复、accounting/report/完整runbook、全仓/最终head gates。最终Gateway内容审计也需补查附加poll/reference字段是否与REST同样拒绝，不能只核对DTO已有正文/按钮字段。activation保持OFF。

## Gateway 附加可见内容审计修复（2026-09-15）

复现了台账记录的入口差异：REST拒绝poll/reference等，但Gateway构造action DTO时丢弃这些字段，后续digest只看到正文/按钮。新增assertReleaseMessageExtras，REST回读、卡片摘要与Gateway在投影DTO前共同调用。拒绝poll、message_reference、referenced_message、shared_client_theme、activity、call以及非空message_snapshots；原embeds/attachments/stickers空值规则一起复用。

TDD：7条原始Gateway frame用例先全部进入commit而红；修复后零durable action/零成功ACK。按既有Gateway异常路径，认证消息内容异常还触发gateway_event_invalid并失效健康证据，未将其视为普通无关用户消息。新测试初稿的healthy=true预期与既有异常路径不符，改为断言healthy=false及明确invalidate，未改变生产错误处理。最终gateway15+discord10+controls11+cards5=41/41（/tmp/fly2391-gateway-extra-final.log）；TeamLead tsc exit0（/tmp/fly2391-gateway-extra-types.log），scoped biome/diff检查通过。

该审计项已修复；人工候选/卡片/缓存恢复、accounting/report/runbook及全仓、最终review/CI/PR仍未完成。所有消息frame为本地fixture，没有线上消息或启用。

## 人工卡片耐久投递与 go 回读缓存（2026-09-15）

新增ManualReleaseCardDelivery并接入健康、非observe host会话。只处理flywheel已取消auto周期的有效waiting manual request，按冻结binding和当前policy时区重建go卡并核对已存digest。原customer_release_events记录manual_notice_sending/manual_notice_delivered，无新表；先耐久发送意图，再至多一次POST。响应丢失/adapter重建从原时间扫描原nonce，已delivery则回读原messageId，不重发。

每15秒清理并刷新同步Gateway go cache，proof需原message/digest/founder/app/channel/bot、healthy/access及30秒新鲜度；异步前后核对原request、当前target、epoch、expiry及cycle状态。失效或过期proof不缓存。收到卡不等于go，原store.manual.go仍负责真实可信动作事务；投递代码不能接受发布或mint permit。

TDD：真实manual StateStore fixture先模块缺失红；最终决策64+host3=67/67（/tmp/fly2391-manual-delivery-final.log），覆盖先落账、lost POST/restart单发、过期proof清cache、重新fresh后实际go接受。TeamLead tsc exit0（/tmp/fly2391-manual-delivery-types.log），diff通过。无线上消息。

仍缺manual候选prepare/rebind触发及accepted后的executor调度；accounting/report/完整runbook及全仓/最终review/CI/PR未完成。activation保持OFF。

## 人工 go 后执行器调度接线（2026-09-15）

ManualReleaseExecutor接入健康非observe host，复用manual pump的同一readAuthority函数。只枚举flywheel的manual_ready且accepted请求，核对当前canonical founder/epoch/policy/执行可用性和go receipt/expiry；waiting卡不会调度。精确requestId+interactionId派生稳定dispatchId，createdAt取耐久go effectiveAt，inputs绑定人工新releaseId及完整binding摘要。复用原单次dispatch journal，adapter重建只observe；30秒调度观察节流，不直接mint permit。

授权失效/过期或workflow失败只取消仍未claim的manual_ready工作；已有committing不被workflow状态冒充no-write。unresolved decision存在时不启动其他人工执行。source/technical验证和真正founder_go permit仍由现有pump/store负责。

TDD：两个真实StateStore用例先模块缺失2红；最终decisions66+host3=69/69（/tmp/fly2391-manual-executor-green.log）。覆盖waiting零调度、真实go后精确新artifact单次调度、重建不重复、没有提前permit、owner漂移取消。TeamLead类型结果记录 /tmp/fly2391-manual-executor-types.log；diff检查通过。无线上dispatch或启用。

人工准备/rebind触发仍缺失；accounting/report/完整runbook及全仓/最终review/CI/PR仍未完成。activation保持OFF。

## 人工 prepare/rebind 请求接线（2026-09-15）

ManualReleasePreparation接入真实host，读取可信manual.json并调用已有耐久prepare/rebind workflow调度。绑定已有取消周期、当前epoch/identity、固定request/expiry；prepare从cycle真实frozenBeta取输入，rebind需精确原binding摘要。工作流succeeded后读取当前manifest与完整prepared payload hash，经异步前后身份/请求/cycle检查再store.manual.prepare生成新waiting卡。没有合成go或permit，原auto窗口不重开。请求文件读取仅允许control.json/manual.json两个固定名称，仍有NOFOLLOW/大小/读取一致性边界。

TDD：两个operation用例先缺模块2红；focused2绿后加observe/expiry零调度断言并跑决策/host/control-trigger组合，结果 /tmp/fly2391-manual-prep-final.log。首次types暴露reader签名未同步，修复为固定文件名union后类型结果 /tmp/fly2391-manual-prep-types2.log。无线上工作流或文件写入。

A5 bootstrap审计发现fresh deployment无cancelled cycle；question fb4686b6-f032-4a2e-97eb-1d248ac4b581请求以真实beta预留并立即取消无窗口周期的独立manual intake，待Lead答复，不能伪称A5闭环。下一步可独立进行accounting/report/runbook与最后全仓/精确head gates。activation保持OFF。

## A5 首次人工 intake（2026-09-15）

按 Lead question fb4686b6-f032-4a2e-97eb-1d248ac4b581 明确bounded approval，新增ManualReleaseIntake读取可信intake.json：精确beta/current configured slot/epoch/identity/request/expiry。真实manifest与当前deployed SHA匹配，且候选等于实际eligible beta后，reserveManualIntake在同SQLite事务预留project/week周期、立即cancel(reason=manual_intake)、写独立manual_intake事件与请求digest。无新表、不伪造artifact/readback/receipt、不写flag；cycle.binding/window/notice均空，不能充当delivered cycle或auto-enable前提。accounting投影必须保留manual_intake分类，尚待I6实现。

相同请求重放只继续已保存cycle对应的prepare请求，不重复预留；同周不同请求拒绝，已有其他周期也不能被intake替换。host先执行intake，再由manualPreparation在无显式manual.json时读取其绑定请求，仍准备不同releaseId的waiting卡并要求新founder go。请求变化在异步后重新核对；UNKNOWN不能消费槽位。预留、取消、label任一失败整笔回滚。

TDD：模块缺失红→基本5绿，再追加真实intake→prepare→waiting且activation/permit仍空、取消失败回滚。最终intake7+host3+control-trigger9=19/19（/tmp/fly2391-intake-final2.log）。最终TeamLead types记录 /tmp/fly2391-intake-final-types.log，diff通过。无真实环境A5动作，仅SQLite/来源替身。

接下来I6 accounting/report/runbook以及完整scope审计、全仓检查、精确head review/CI与单PR。activation保持OFF，未宣称线上验收。

## I6 batch: immutable accounting ledger and source collection (2026-09-15)

- Added `customer_release_projections`, keyed by source event/target, with frozen content/digest, durable one-way create intent, independent readback before delivered, bounded retry scheduling and marker recovery after ambiguous create. No method grants release/ship authority or retries publication.
- Capture existing cycle and activation events on the same database connection. Separate event time from `capturedAt`/current snapshot; retain manual_intake origin and missed-slot no_candidate/unknown without fabricating cycles. Project proof references/digests without raw execution permit nonce or activation payload.
- Host continues bounded local capture with release mode off. Capture failure reports pending and does not change publication state. No external projection transports are wired yet.
- Registered the additive table as protectedAuthority and updated the production-table fixture. No deletion/age-only cleanup was introduced.
- TDD receipts: initial ledger module missing; capture missing method; off-mode host expected two rows, got zero. Final focused accounting+host: 10/10 (`/tmp/fly2391-accounting-host-green.log`). Teamlead `tsc --noEmit` exit 0 after collector (`/tmp/fly2391-accounting-capture-types.log`). Retention gate ok=true/errors=[]; retention root unit tests 8/8. Scoped Biome has only the existing gateway useConst warning. `git diff --check` clean.
- Remaining I6: real Linear/GitHub adapters, same-id repair/readback, external pump, readonly report/daily integration and runbook. Full I1-I6 scope audit, full repository gates, effective final review, exact-head CI and PR remain pending. Source tests are not live activation acceptance; feature stays off.

## I6 batch: readonly audit report and daily digest (2026-09-15)

- Added a deferred read transaction over existing source events, projections and cycle/result facts. Counts missing projections as pending, not merely rows already queued; both targets must be delivered for every existing source event before consistency is true. Empty history makes no consistency claim.
- The existing DigestService receives the readonly report from the actual Bridge mount. It renders a separately labelled current snapshot and up to ten cycle states, without adding audit events to daily deployment counts. Untrusted labels are escaped, unknown remains unknown, and no report method creates receipts or mutates source facts.
- TDD: missing report module, missing summary renderer. Final report/digest regression 34/34 (`/tmp/fly2391-release-report-regression.log`); additional explicit audit-section/deployment-count integration plus report tests 3/3 (`/tmp/fly2391-release-report-integration.log`). Teamlead tsc exit 0 (`/tmp/fly2391-release-report-types.log`); retention consumer gate ok=true/errors=[]. Markup assertions passed; no browser screenshot/live deployment verification performed.
- External destination design question pending: `7e2f1cc4-daf6-46e0-a673-89dfc3ddb0c0`. Proposed explicit trusted cycle/event mapping to existing Linear issue + non-PR GitHub candidate issue, missing mapping accounting_pending; do not treat this proposal as approved yet. External adapters, recovery/update/readback, external pump and final runbook remain. Full I1-I6 audit, full repo gates, review, CI and PR remain outstanding.

## I6 batch: fixed-origin external transports and recovery (2026-09-15)

- Added GitHub issue-comment and Linear comment transports with fixed origins, bounded response size/deadlines and complete bounded pagination. GitHub validates numeric repository identity and rejects PR destinations; both check the configured writer and parent record on read/update. No issue creation, workflow, release-commit or PR-approval API is exposed.
- Comment proofs recompute the digest from the actual serialized event, rather than trusting an embedded digest string. JSON HTML/fence syntax is escaped. An ambiguous create is recovered through its original marker; a known matching marker may be repaired at the same external ID only after ownership checks, followed by independent readback. Update success alone leaves pending if proof is wrong.
- TDD receipts: missing transport module and Linear constructor; known-ID repair assertion failed before implementation. Final ledger+transport suite 13/13 (`/tmp/fly2391-accounting-transports-final2.log`), teamlead types exit 0 (`/tmp/fly2391-accounting-transports-types.log`). These use mocked HTTP; no real comment was posted and no production activation was performed.
- API references checked: https://docs.github.com/en/rest/issues/comments ; https://linear.app/developers/pagination ; https://linear.app/developers/graphql . Existing repository Linear adapters supplied the matching GraphQL comment shapes.
- Lead destination ruling received on question `7e2f1cc4-daf6-46e0-a673-89dfc3ddb0c0`: one existing Linear issue and one existing non-PR GitHub issue per ACTIVATION, with every cycle event bound by immutable marker/tuple; missing mapping stays pending. No per-cycle issue creation. Accepted; durable mapping and host projection pump are next and are not yet implemented.
- Added runbook.md for approved A0–A7 order and disable → drain/fence → manifest proof → stop B4 → app rollback; updated stale activation-evidence prose about the already-implemented control/plugin entry. Runbook explicitly records the remaining mapping/pump and real-environment verification boundary.

## I6 batch: activation-bound mapping and independent accounting pump (2026-09-15)

- Implemented Lead ruling `7e2f1cc4-daf6-46e0-a673-89dfc3ddb0c0`: deployment-owned accounting.json maps `flywheel:epoch:<n>` (customer-release database epoch, not runner identity) to fixed existing Linear/GitHub issues. Strict config, canonical bounded regular-file reads, project-fixed repo and explicit writer identities. No missing/invalid mapping can create an issue or change release authority.
- Before any external lookup/send, an atomic immutable `accounting_target_bound` activation-journal event freezes both destinations and writer/repo identity. Later mapping changes for that epoch are rejected, including for subsequent source events. Tokens never enter the binding event.
- Host starts a separate audit worker. It captures existing events and projects bounded batches with retry; stalled networking does not block supervisor ticks. Stop aborts original requests and waits for cleanup. Local capture persists when release is off; external writes require explicit deployment accounting configuration.
- Fixed retry fairness after a new regression showed repeated old failures could starve untouched events: pending rows now order by retry_at before event ID. A repeated failed mapping therefore cannot monopolize the front of the queue.
- TDD receipts: missing pump module; host independent-worker assertion red; queue fairness red. Mapping fixture initially used a macOS aliased temp path and correctly failed canonical-path validation; corrected fixture via realpath, without relaxing production checks.
- Focused ledger/pump 13/13 after fairness fix; prior pump/host/transport/control regression 30/30 plus stop coverage 4/4. Full customer-release suite initially 392 passed/1 fairness assertion failed (`/tmp/fly2391-customer-release-integration.log`); after fix, 32 files/393 tests passed (`/tmp/fly2391-customer-release-integration-final.log`). Types exit 0 and retention consumer gate ok=true/errors=[]. Full lint initially failed this task's two misplaced plugin imports; final `pnpm lint` exit 0 after moving only those imports (`/tmp/fly2391-i6-lint-final2.log`), warnings retained. Full repository build is running separately; package gate/root scripts/review/CI/PR not yet claimed.
- Updated runbook mapping schema, immutable epoch binding and shutdown behavior. No real external comment, flag write, release, service restart or activation performed.

### I6 后续验证收据（2026-09-15）

- `pnpm -r build`: exit 0 (`/tmp/fly2391-i6-build.log`).
- 发布相关 root Node tests: 74/74, exit 0 (`/tmp/fly2391-root-release-tests.log`).
- 全部 payload-endpoint Node tests: 211/211, exit 0 (`/tmp/fly2391-endpoint-tests.log`).
- 顺序执行的 shell gates 均成功：release-workflows-structure 25/25；payload-promote-argv 19/19；payload-release-pipeline 44/44。整个执行 session 35992 exit 0；最后一项结尾记录 `/tmp/fly2391-shell-release-final.log`。
- 当前剩余工作：逐项批准计划审计（尤其人工 decision 新 artifact 的 fullBinding/证明是否完整进入投影）、最终 package gate、渲染验收、有效 code review、最终精确 head CI、milestone-last commit 与 PR/needs_review 回执。这些不是已完成声明。

## 批准计划最终核对修正（2026-09-15）

- 核对 PRD §5 与 §6.2 后，补齐人工 decision 新 artifact 的 fullBinding、baseEtag、结构化 readiness，以及结果 manifestEtag/manifest digest。原周期 releaseId 不再是新人工 artifact 的唯一投影身份。enable/disable 投影保留真实 actor/action ID，同时仍不复制 permit nonce 或原始凭据样字段。
- 日报用可读状态显示窗口、未确认提交和取消；展示 release version/UTC deadline 与已有候选卡的否决提示；无候选周期的 no_candidate/unknown 周也显示未自动发布原因。报告仍只读，不新增动作或计入 deployment 数量。
- 三个新具名回归先红后绿：人工 fullBinding/manifest proof、activation actor、无周期 unknown 周的呈现。相关最终测试 24/24 (`/tmp/fly2391-i6-audit-final.log`)，日报回归 36/36 (`/tmp/fly2391-release-report-facts-green.log`)；最新 full build exit 0 (`/tmp/fly2391-audit-build.log`) 与 lint 无错误 (`/tmp/fly2391-audit-lint.log`)。最终 package gate 正在 session 31894 运行，日志 `/tmp/fly2391-audit-package-gate.log`，尚无结论。
- 逐项核对见 acceptance-audit.md。可复现静态夹具生成器已保存为 render-fixture.ts，使用实际 renderer，输出 `/private/tmp/fly2391-visual/digest.html`。
- 视觉检查有明确缺口：Chrome DevTools tools/call 300s 超时；独立 Chrome exit 134；Playwright Chromium SIGTRAP，日志有 MachPortRendezvous `Permission denied (1100)`。没有 screenshot。Lead question `9f4b7d7a-f616-4aba-b62b-1bd1fcdbd4ed` 明确要求停止追查，由 QA 的授权 unsandboxed host 打开夹具验证；本节点未派发 QA、未重启服务，未把此项算通过。

## Package gate 清单修正（2026-09-15）

正在运行的 pre-sync package gate 中，claude-runner 得到 1333 passed / 1 failed / 2 skipped；失败是 kill-path inventory 数组 682 与扫描出的 684 不一致，不是 onTaskUpdate RPC 例外，整轮不能认定通过。准确缺项为 `packages/payload-endpoint/__tests__/serve-node.test.mjs:child.kill();#3` 与 `scripts/__tests__/customer-release-reservation.test.mjs:child.kill();#1`，都是测试 cleanup 的 qa-only 分类，非生产停止路径。

使用既有 scanKillPathInventory 生成器更新 fixture，仅增加两项；不改生产脚本、不放宽断言、不跳过测试。专项 `test/kill-path-inventory.test.ts` 5/5 通过 (`/tmp/fly2391-kill-inventory-green.log`)。旧 package gate session 31894 继续收集其他包的结果，失败收据保留；同步 main 后仍须完整新门禁。

最新 main `e43c4b567` 有 9 个本分支未包含提交。只读 merge-tree 唯一冲突位于 feature-flags-registry.test.ts 的 EXPECTED_WHEN_ON：auto_release_on_silence_enabled 与 codex_lead_thread_rotation 两项均须保留。未在运行中的 package gate 里切换源码版本。准备稿 `/private/tmp/fly2391-feature-flags-registry-merged.test.ts`、PR 描述草稿 `/private/tmp/fly2391-pr-body.md`；实际同步与最终 PR 仍待执行。

## main 同步与容量边界（2026-09-15）

- Lead response `41a2eb0e-bc8b-43e7-8889-ab9f240b8687` 指定：同步后执行 focused suites + lint/tsc/build，最终宿主 full package run 至多一次；PR 精确 head CI 才是 aggregate of record，不依赖宿主争用红灯，也不重复宿主全量。本节点选择不追加宿主全量，走专项和最终 CI。
- 已通过原执行会话中断 pre-sync package gate 31894；summary 未有 finishedAt，故为未完成/已中断，不是 PASS 或完整 PACKAGE_GATE_RECEIPT。已得到的 kill inventory 断言红灯保留且修复；没有把中断包装为 RPC-only 豁免。
- `da2fb65f3` 合入 main `e43c4b567` 的 9 个提交；唯一文本冲突保留 EXPECTED_WHEN_ON 的自动发布与 Lead thread rotation 两项。后续实际 config 测试发现双方各加一项后的固定总数应为 30（非29），只修正字面计数并保留逐项映射断言。修正前 149 pass/1 fail，修正后 150/150 (`/tmp/fly2391-post-sync-config-green.log`)。
- 合并后的 kill inventory 重新生成并测试 5/5 (`/tmp/fly2391-post-sync-inventory.log`)，lint 无错误、既有 warnings 保留 (`/tmp/fly2391-post-sync-lint.log`)。其余 post-sync verification、最终 review/CI/PR 尚待实际收据。

### Post-sync 交付验证（2026-09-15）

main 已同步，固定 flag 总数修正提交 `29a7eace4`。发布/readiness/flag 接线专项 45 文件、485/485 (`/tmp/fly2391-post-sync-teamlead.log`)；config 150/150、kill inventory 5/5；独立 teamlead tsc --noEmit 与完整 `pnpm -r build` exit 0 (`/tmp/fly2391-post-sync-types.log`、`/tmp/fly2391-post-sync-build.log`)；lint 无错误，保留 warnings；retention consumer gate ok=true/errors=[]；`ci-structure.test.sh` PASS。

按 Lead 容量边界，宿主不追加完整 package run；旧轮的真实清单失败及中断记录不变。最终 aggregate 以 PR 的精确 head CI 为准。后续有效 review/CI 收据记录在 PR 和 flywheel-comm 结构化报告中，避免为写验证结果而反复移动被审 head。视觉缺口与 QA 复现方式见 acceptance-audit.md。

### 精确 head CI 修复（2026-09-15）

PR #1209 的 dd1a26e7d / run 34954719199 有真实 CI 失败：两个 workflow 的 run-name 引用未声明 input；provenance 解析器拒绝新 camelCase flag；retention 将 B4 十张保护表误计为九张。本地重复得到 provenance 与 retention 两项断言失败（39 pass/2 fail），actionlint 同样报告两个未定义属性。不是 RPC-only 例外。

按 Lead responses `14de25aa-cab7-40ad-97e7-f84fe2b396a0`、`8d4c7289-1120-4d80-8a75-1a6cb11c84b6`，自动执行 workflow 使用既有 operation、prepare workflow 使用既有 mode；尚未上线的持久 flag key 统一为 `auto_release_on_silence_enabled`，provenance grammar 不变；保护表计数 50，总表数 238，排除三个 retired 后 235。历史 `review-r1.json` 保留原始评审文本，不改写既有收据；本文及现行计划使用新键。

修复后 teamlead 专项 76/76、config 专项 76/76、workflow startup 8 workflows + 4/4，lint exit 0（既有 warnings 保留）、`pnpm -r build` exit 0。日志位于 `/private/tmp/fly2391-ci-{focused-green,config-green,lint,build}.log`。未重复宿主 full package run。新 head 仍须新的有效 review 和 exact-head CI；旧 head 的 pending review 不能为新 head 背书。

### Workflow 断言同步与本地 Quick Gate（2026-09-15）

`0e14a6c9e` 的 CI run `34956360318` 中 Quick Gate 和 payload distribution 都被同一个旧断言阻断：`payload-auto-release-workflow.test.mjs` 仍要求两个 workflow 共享无效的 `inputs.mode || inputs.operation`。本地复现后，按 Lead `e4dcdde6-74b7-43e4-a9d5-c8f65f94a145` 授权，只将预期分别改为自动执行的 operation 与 prepare 的 mode；不改生产 workflow。

本地逐个执行 CI quick-gate 的所有 run steps：复用已安装依赖和本机 actionlint 1.7.12，不执行 Linux 二进制安装步骤，其余结构/启动、20 个 root Node 合同套件、build、typecheck、lint、seed、residue、package-gate 辅助测试、retention 全部 exit 0。完整日志 `/private/tmp/fly2391-local-quick-gate.log` 以 `LOCAL_QUICK_GATE_PASS` 结束。另行 release-workflows-structure 25/25（`/private/tmp/fly2391-release-structure-final.log`），相邻 workflow 套件 43/43。此收据不是 GitHub exact-head CI 或全量 package gate；两轮已失败 CI 的红灯保留。按 Lead 边界，下一次 push 后若仍有确定性 CI 失败，报告并等待，不自行再次推送。

### R2 有效评审 HIGH 修复（2026-09-15）

`a3001ccbf` 的精确 CI `34957332756` 为全 15 项 success；但有效 gate `7096b3e9-04cd-49d1-b5ae-91279f06a36b` 的 reviewVerdict 是 CHANGES_REQUESTED，不能交接。按 Lead `88ed509c-4a77-42e3-aabe-4417bd1a731d` / `ad17a4ab-ff56-46ec-afcc-76b245cbcc77`，本次只修两个 HIGH；MEDIUM/LOW 保留为 advisories，不扩大范围。

- `pending-attempts-freshness-after-unbounded-sweep`：真实 MemoryBucket 保留 64 个旧 attempt 时，原 pending limit=1 返回空、漏掉新鲜 attempt（先红）。增加端点生成的 5 秒时间分区索引；pending 至多读取与原 ±5 秒窗口相交的三个分区，总条目预算仍为原 limit，过期分区 cursor 重置。原 immutable attempt、permit、started、result 保留；索引不授予权限。覆盖真实历史索引与 authority 历史、分页、4999/5000/5001ms、旧 cursor、跨 epoch、索引写入失败。
- `bug-source-health-null-invalidates-all-cycles`：受限 token 向 GEO 建普通 issue，Bug 标签缺失/查询失败导致 Flywheel 周期取消（两项先红）。建单路由全部标签查询改为 health-neutral，包括同团队、显式 Bug 标签；真实 Bug intent 的独立行为保留。唯一生产 health writer 是独立 accounting worker 中的 canonical activation 探针，mapping 增加 Linear team/project UUID；实际 issue 归属及 Bug 标签来源必须匹配，真实源失效仍写 fail-closed 信号。映射缺失只 accounting_pending、不写 health；epoch、映射、凭据或 label 在请求中变化时丢弃旧结果。StateStore 事务再次核对 activation epoch，真实源失效后的恢复不能清除取消锁。

验证：端点完整套件 **217/217**（`/private/tmp/fly2391-r2-endpoint.log`）；发布/readiness/路由套件 **46 文件、544/544**（`/private/tmp/fly2391-r2-release-suite.log`）；专用 probe/null/error/归属/标签/epoch 与 mapping 交错、StateStore 失效及 host 接线专项 **107/107**（`/private/tmp/fly2391-r2-focused-final.log`）。独立 typecheck exit 0。本地可复现的 CI Quick Gate 全部 run steps exit 0（复用依赖及本机 actionlint 1.7.12），日志 `/private/tmp/fly2391-r2-quick-gate.log` 以 `LOCAL_QUICK_GATE_PASS` 结束；未运行宿主 full package gate。实际 Linear schema 字段对照锁定的本地 SDK 声明，真实远端/凭据/activation 未执行。

按 Lead 边界，一次 fix commit/push 后注册一次 round 3；若 R3 在同一区域提出新的 HIGH，停止并报告，不自行续修。新 head 仍需要自己的有效 review 与 exact-head CI；上一 head 的全绿收据不覆盖本次生产修复。

## Conflict rework review: two HIGH fixes — 2026-09-15

Review `5fe76d80-c002-464d-909d-e6cc00725d39` rejected `7437c1223`. Lead ruling `e3508d2d-2741-45b1-bd3d-07a5fd61e5f5` supersedes the earlier test-only scope and authorizes exactly these fixes:

- Bug-intent invalidation now imports the B3 14-day evidence constant as `RELEASE_EVIDENCE_WINDOW_MS`. The unrelated Codex-recovery constant retains its original consumers. Pinning the test clock alone would have hidden this production defect; the earlier fixture-only diagnosis was incomplete.
- Automatic-disable invalidation is explicitly scoped to automatic work. It preserves `manual_ready` and the latest manual decision in committing/unknown states. Default full-scope Gateway, identity and restart invalidation remains unchanged.

New deterministic tests cover just inside, exactly at, and just outside 14 days; off/flag-disabled manual-ready survival; automatic-window cancellation; Gateway/restart cancellation; manual in-flight preservation and Gateway intervention. Red phase: 4 failures / 48 passes. Final focused release invalidation/advance/decisions/runtime: **123/123 passed**. Teamlead typecheck and root lint passed (21 existing warnings). Final-head CI/review remain required.

Local package aggregate was stopped through its owned process handle on Lead host-contention instruction `877d46b9-8282-46df-9b8a-ffa2f90da5dc`; it is **interrupted-under-host-contention / not relied on**, with no complete package receipt. CI `34995822701` failed the three reproduced assertions on the preceding head; exact-head CI is the aggregate of record. No advisory changes, production activation or successor dispatch.

## Post-1199 synchronization and automatic failure scope — 2026-09-15

Merged main `84a65da2e` once onto `eceb689b6` after #1199 merged. Flag copy and kill-path inventory retain both branches. The combined production schema contains 243 tables, or 240 excluding the three retired tables; the focused retention test verifies the combined registry against the production fixture.

The approved scratch patch confines `automatic_advance_failed` invalidation to automatic cycles. A regression first failed because automatic schedule failure cancelled manual-ready work (1 failed/22 passed), then passed after the scoped call. Gateway/restart full-scope cancellation is unchanged.

Post-sync recursive build and lint passed (22 warnings). Focused verification: config 850, teamlead 646, kill inventory 5, endpoint 217, Node scripts 82, promote argv 19, release pipeline 44, contract vectors 22; CI structure and render fixture generation passed. See `rework-sync-validation.json` for log hashes and limits.

Per Lead ruling `40bad27b-15b8-4a7b-b106-aaf0b86115df`, the local release-workflows-structure suite is excluded after a local shell parse failure (scratch lines 546–547; copied main/#1199 line 525). Lead reports host Bash and #1199 CI green. No source fix is included; exact-head CI remains the aggregate of record. Fresh review/CI and QA retest are still required. No production activation or successor dispatch.

## Post-conflict review HIGH: stable host store identity

Review `68e7d268-1e50-4d1f-b202-42eaaf3a10af` rejected `d6b7e64a3` for `host-session-churn-per-tick`. The production `StateStore.customerReleases` getter returned a new wrapper on every access; the host identity check therefore restarted its session every second. A host regression using the real StateStore getter first failed: three ticks invoked `recoverAfterRestart` three times instead of once.

The repair caches the wrapper by raw database connection identity. Ordinary ticks reuse it; a replaced database handle yields a fresh wrapper. The production-shaped host test now proves one recovery across three ticks, a second recovery after a real owner change, and a fresh stable wrapper after host shutdown and database reopen. Host/runtime/lifecycle verification passed 12/12. Lint passed with 22 warnings. Logs: `/tmp/fly2391-host-red.log`, `/tmp/fly2391-host-green2.log`, `/tmp/fly2391-host-lint.log`; recursive build is verified before push. Fresh review and CI remain required.

Lead response `aaaa03c4-017d-4994-b2d1-7a6ba7222a07` confines the repair to this HIGH: one push and one new review; report another same-origin HIGH instead of a third repair lap. Report any fresh-head performance-only CI failure before rerunning. Production activation remains off.
