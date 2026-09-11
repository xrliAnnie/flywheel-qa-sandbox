# FLY-2393 项目 beta 分频 — 实现记录
Issue: FLY-2393 (https://linear.app/geoforge3d/issue/FLY-2393/1143b6-bridge-按项目分频独立泳道只阻塞-3每项目-beta-分频目标态不阻塞-flywheel-only-每周-release)
日期: 2026-09-10
基于: plan.md

## 实现基线

实现接入 HEAD f3dbcb5c683eb400ccc8dc7f57ba9f709efdd2ab，TURN implement epoch=2。
实时 check 9c9dff1e-394c-4874-8096-b0a9e1aedc68 确认 R2 effective reviewVerdict=APPROVED。
plan.md 字节保持不变。

Lead 对 question bedfb3f4-ab23-42bf-bbb5-ac06f8b68df0 裁定：允许仅给 payload-promote / payload-promote-commit / payload-activation 三个 workflow 的 concurrency 增 queue:max，其余行不动；须 YAML 校验，PR 描述单列三处 diff。待 C3/C5 执行。

## C1 配置（进行中）

新增共享 beta_release parser 与 ConfigLoader/type/export 集成。缺块保持 undefined；显式块默认 24h；1–168 安全整数；workflow basename/token env/未知字段拒绝且不回显输入值。
Bridge canonical-root reader 每次重读配置，独立隔离解析失败；缺文件=unconfigured；拒绝跨 root symlink、非法仓库、缺少/共用凭据；不读取频率 env override，不回退 GH_TOKEN。
GitHub numeric repository/workflow 身份核验与持久绑定仍待 C2/C3；调度和 UI 尚未接入。

TDD：首次 vitest 缺失是环境错误，不算红灯；锁文件安装后缺模块红灯→默认行为绿灯；非法配置断言红灯→校验绿灯；ConfigLoader 默认不一致红灯→共享 parser 绿灯；Bridge source 缺模块及凭据/缺文件行为红灯→绿灯。

已验证：
- pnpm --filter flywheel-config test:run：51 files / 791 tests PASS。
- pnpm --filter flywheel-config build：PASS。
- pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/beta-release-config-source.test.ts：3 tests PASS。

尚未执行全仓 lint/build/test、code review、PR、handoff。以上不是调度器完成或真实双项目发布证据。

## C2 持久化基础（进行中）

StateStore 复用现有连接接入 betaSchedules store；additive 建 beta_schedule_lanes / beta_schedule_occurrences 两张表。以项目/绑定/到期时间唯一约束配合 immediate transaction 占 active；完整 64hex occurrence key；保留冻结 40hex source。状态更新比较 expected state，重复 prepared→dispatching 只有一个赢家。succeeded/exhausted 才能清 active 并推进所属项目的网格；运行态拒绝结算。

TDD：缺 betaSchedules 红灯→重开 DB 与重复 reserve 绿灯；非法 source/未来 due 红灯→校验绿灯；缺 transition 红灯→竞争/结算绿灯。保留策略当前 schema 测试发现两张未分类表；注册为 protectedCurrentOrReference 并同步 production fixture 及 146/207 固定数量。

已验证 teamlead typecheck PASS。初始依赖全仓 pnpm -r build PASS（发生于本块完成前，不能替代最终 HEAD build）。C2 仍缺频率重算、完整调度器、重试/回执状态机和 fake-clock 验收矩阵；未对外 dispatch。

2026-09-11 continuation: restored the issue-labelled salvage stash (6fdc3e1d0702a06b13441e15af39197fe06b0015) without conflicts. Added persisted interval revision and idle due calculation: change frequency from the last due/activation anchor, coalesce missed periods, freeze active occurrences, and preserve the settlement cursor when frequency has not changed. Missing due API test failed before implementation; it now passes, including backward clock and long-running settlement. Added a 48h ledger check yielding 8 versus 2 reservations for 6h/24h. This tests storage/time semantics, not GitHub publication or a running scheduler.

Recovered retention tests had two remaining stale numeric assertions (205/202); updated to 207/204 for the two protected beta tables. Targeted StateStore beta + retention suites: 35 tests PASS. Teamlead typecheck PASS. Logs: /tmp/fly2393-c2-final.log and /tmp/fly2393-c2-typecheck.log. C2 remains incomplete: scheduler, bounded retry, receipt validation, owner observations and lifecycle integration are still required.

## C2 调度循环与回执边界（进行中，2026-09-11）

新增可注入 transport 的 60s 调度循环；4 个并发项目 worker；同实例重入合并；按 projectName 遍历；每 POST 前重读 owner 并重核绑定。prepared 暂停后恢复原 due；重启观察已知 live run；未知响应保留 occurrence/SHA，完成 run 查询后按 2/5/15 分钟退避，5 次或存活期限后保留未知请求而不伪结算。特别测试证明旧失败 run 不足以清掉后续未知 POST。已全部终态的失败可耗尽后推进下一网格。

删除/非法配置项目继续按冻结 lane 观察在途，禁止新 POST；删除后结算使用原 interval。新增严格回执结构/身份校验（project/repo/workflow/run/key/source），有效回执存 result_json。not_activated 记录失败并消费周期，不计发布；下一周期可再检查激活。covered_by_newer 的 ancestry 仍由尚待实现的 GitHub adapter 负责，不能拿当前 fake transport 测试充当真实 ancestry 或 publication 证据。

TDD：缺 scheduler 红灯→48h 8/2 与 legacy/paused 绿灯；未知重试/暂停后 prepared 恢复红灯→绿灯；旧 run 终态错误耗尽未知 POST 红灯→保留 active 绿灯；删除项目不结算红灯→冻结 lane 继续观察绿灯；not_activated 占住周期红灯→持久结果/下一周期绿灯。最终 14 定向 tests PASS（8 scheduler、1 receipt、5 store），teamlead typecheck PASS。日志 /tmp/fly2393-scheduler-final.log、/tmp/fly2393-scheduler-typecheck.log。

待续：C2/C3 真实 transport 的 10s abort、Retry-After/错误分类、分页/所有重复 run/安全 zip、冻结凭据绑定、durable owner 观测及低频 attention；C3 receiver 与 publisher 结果文件；C4 plugin/UI；C5 全仓验证和 code review。尚未接入 plugin 或对外发布，不报告完整 A1/A11 已验收。

## C3 GitHub transport 与受限 artifact（进行中，2026-09-11）

新增 beta-release-github.ts：显式项目凭据（不 fallback GH_TOKEN）、metadata 数字 repo/workflow 绑定、完整 owner variables 分页、固定 2026-03-10 API 与 api.github.com、每次请求 10s timeout、JSON 响应 2MiB 上限、错误不带响应/credential 内容。dispatch 精确三个 inputs，200 workflow_run_id + 同仓 URL 才 accepted；204/异常保持 unknown。分页查 workflow runs 并逐个重新 GET 已知/重复 run，核对 repo/workflow/event/ref/title；成功才下载 receipt。绑定新增 tokenEnv 字段，仅变量名持久化，供重启/删除项目后继续核对原 run。

Artifact：锁定 yauzl 3.4.0 与 @types/yauzl 3.4.0；首次 GitHub API redirect manual，第二次仅精确后缀白名单 HTTPS blob/actions storage，剥离 Authorization/cookies，不跟随二次跳转。下载实际流量≤64KiB；lazyEntries/strictFileNames/validateEntrySizes、唯一 regular receipt.json、声明与实际展开≤4KiB，无落盘。测试拒绝 zip-slip/绝对路径/symlink/多文件/encryption/bomb/伪造 size/损坏 zip/非法 JSON/abort；成功 receipt 严格绑定 tuple。covered_by_newer 增 GitHub compare ancestry 检查，仍待该分支专门回归。

官方依据（2026-09-11 查阅）：https://docs.github.com/en/rest/actions/workflows （200 返回 workflow_run_id/run_url/html_url）；https://github.com/thejoshwolfe/yauzl （安全解析选项）。

TDD：缺 adapter→metadata/owner 绿灯；tokenEnv 重启丢失红灯→加列持久化绿灯；缺 head/dispatch→精确输入/204 绿灯；缺 observe→分页/重复 run 绿灯；缺 ZIP parser→安全反例绿灯；成功 run 缺 artifact 红灯→受限下载与合法 receipt 绿灯；畸形 variables 被当 legacy 红灯→schema fail-closed 绿灯。新增超时与 Retry-After 元数据断言。最终 22 tests PASS（GitHub 7、artifact 1、store 6、scheduler 8），biome 8 files PASS，teamlead typecheck PASS。日志 /tmp/fly2393-adapter-final.log、/tmp/fly2393-adapter-biome.log、/tmp/fly2393-adapter-typecheck.log。

未完成：scheduler 尚未消费 Retry-After/持久化 attention cooldown；binding 重新接入/排空 operator 合同、covered_by_newer 与额外分页/大流量 mutation tests；C3 workflow receiver 与 publisher result-file；C4 plugin/管理台与视觉；C5 全仓 gates/review/PR。没有真实 GitHub dispatch/部署，未声称双项目已上线。

## C2/C3 限流恢复和 publisher 结果（2026-09-11）

调度观测写回 lane 的 owner/status/reason/observedAt/pollAfter；429 Retry-After 与 attention 冷却持久化，重启不提前 poll。dispatch 错误先保留 dispatch_unknown 与原 occurrence，再记录冷却；不会因错误响应丢弃潜在外部请求。恢复测试先红（重启多 poll 一次）再绿。已绑定 lane 具备持久冷却；首次尚未绑定项目的错误与全局配置读取异常仍待生命周期接入时补齐。

payload-release.mjs 新增可选 --result-file：从重新 readManifest + validateManifest 后的 active beta entry 生成 {outcome,publishedVersion,publishedSourceCommit,publishedAt}，新发布 published、同源 dedup/committed 重放 no_change。仅显式要求结果时执行附加读取与严格来源检查，既有 CLI 默认行为保持。结果临时文件+rename 写入；失败不留下上一轮 result。测试先缺文件红灯，再真实 endpoint fixture 下发布/dedup 绿灯。

验证：payload-release-pipeline.test.sh 44 PASS / 0 FAIL（含原 force、CAS、撤回、客户 promote 回归）；scheduler/store 15 tests PASS；GitHub 7 tests PASS，新增 covered_by_newer ahead 接受/diverged 拒绝；teamlead typecheck PASS。日志 /tmp/fly2393-result-green.log、/tmp/fly2393-recovery-green.log、/tmp/fly2393-recovery-typecheck.log、/tmp/fly2393-ancestry.log。

下一步重点 C3 workflow receiver/preflight/冻结来源与 receipt helper、客户三个 workflow 仅 queue:max 授权 diff、结构测试同步；随后 C4 生命周期/管理台和 C5 全仓 gates/review/PR。当前仍未部署或触发真实发布，phase 不完成。

## C3 workflow receiver（2026-09-11）

新增 beta-schedule-receipt.mjs 纯 receiver 契约与实际 git ancestry helper。完整 project/key/SHA 输入、main、owner 与 force 互斥验证；legacy schedule 保留6h，paused不发布，人工路径保留。真实 temp git 两次 commit 验证排队后 main 前进仍可发布冻结祖先；同 SHA no_change、已发布后代 covered_by_newer、无关源拒绝。输出不改 manifest 指针。

beta workflow 拆为无锁 preflight、eligible && activated 的同组 publish job、严格只生成/上传 not_activated receipt 的 job。trusted main checkout 的 receiver/publisher/release-contract 先保存在 runner.temp；验证冻结 SHA 之后才 checkout 该 SHA，发布和回执执行保留的可信脚本。已有覆盖 beta 不再 install/build。仅 Bridge 路径启用 publisher result-file，legacy/人工保持原默认/force CLI。run-name 完整 schedule key，三个新增输入只通过 env 传递；成功 run 上传精确 receipt artifact。

按 Lead bedfb3f4-ab23-42bf-bbb5-ac06f8b68df0 授权，payload-promote / payload-promote-commit / payload-activation 的 diff 各仅新增一行 queue:max，其他行不变；cancel-in-progress 保持 GitHub 默认 false。beta publish job 显式同组 queue:max/cancel-in-progress:false；停用/未激活请求不入锁。实际跨 workflow/job 锁与真实队列验收仍按 R2 residual 留待授权环境，不冒充已实测。

S3 改为解析 YAML 的 job/admission/activation/receipt 权限校验及 mutation tests；S8 解析 run 与 github-script 执行正文，同时禁止 inputs 与 github.event.inputs 原文插值；S7 beta main guard由真实内嵌 preflight执行负例覆盖，其他发布 guard保持。现有CI调用的 release-workflows-structure.test.sh 现在运行两个新增 mjs suite，因此新增 receiver/结构测试进入既有发布CI。

TDD：缺 receiver/helper 与 source assessment 红灯→绿灯；旧 workflow 顶层共享锁红灯→job边界绿灯；嵌入JS换行语法红灯→转义修复绿灯；三个customer队列未保留红灯→仅 queue:max绿灯。最终结构门禁23 PASS、其中新增 helper/实际内嵌脚本/祖先关系与 mutation共8 tests PASS；pipeline44 PASS；biome3 files PASS；git diff --check PASS。日志 /tmp/fly2393-receiver-structure-final.log、/tmp/fly2393-receiver-pipeline-final.log、/tmp/fly2393-receiver-biome-final.log。

下一步 C4 Bridge plugin启停与只读管理台、持续错误/首次接管排空边界补强，再全仓 lint/build/packages tests、review、milestone最后提交、PR和needs_review交接。当前尚无PR，无生产配置/发布/部署变更。

## C4 生命周期与只读管理台（2026-09-11，视觉证据待补）

createBetaReleaseRuntime 接入 plugin：在 management console 可选初始化之外启动，shutdown await stop 后再停止其余服务；每 tick 读取 canonical 配置，store getter 跟随 StateStore 连接恢复。真实 config文件→GitHub stub→持久lane→6h到期POST集成测试通过；未启动管理台也运行。roster读取失败先红（未处理reject）再绿（安全错误码、下tick恢复）。

新增 betaRelease management provider，仅同步读缓存/DB；projectBetaSchedules 按项目合并，betaSchedule 为 optional，schemaVersion不变。DTO 包含 owner、配置/有效频率、nextDue、active run URLs、最近真实版本/时间、更新时间/状态；不含凭据绑定。两tick旧观测变unknown；legacy明确有效6h；缺workflow显示尚未激活/目标24h。HTTP边界检查字段与github.com运行链接。

现有项目页节奏区新增只读panel，所有派生文本esc，运行URL仅github.com合法路径，外链noopener noreferrer；无按钮/输入或新写API。DOM测试先缺panel红灯→实现后发现模板正则转义语法红灯→修复绿灯；恶意label/version及javascript: URL均不能变可执行内容。

验证：runtime/scheduler/provider12 tests PASS；完整 management-console-* + fleet-console-html 11 files/93 tests PASS（包含新DOM安全测试）；teamlead typecheck PASS。日志 /tmp/fly2393-runtime-integration-green.log、/tmp/fly2393-management-family.log、/tmp/fly2393-c4-typecheck.log。局部biome已执行，仅剩一条测试fixture字符串warning，最终全仓gate还未跑。

视觉缺口：真实源码生成 /tmp/fly2393-beta-console.html（显式fixture数据），Chrome MCP拒绝 requires approval / policy never；独立temp profile的本地headless Chrome exit134，未产截图。已问Lead question 6a05af77-6274-43fa-9b55-68f7b60eaf69 请求授权环境取证。DOM通过不能替代截图，未宣称视觉验收完成。

待完成审计：首次接管前排空检查、unknown预算耗尽后的低频轮询/首次未绑定错误冷却、owner观测刷新、强负例与回滚runbook；全仓gate/review/PR及视觉证据。继续实现，不phase_complete、不标goal完成。

## 最终边界补强与全仓验证启动（2026-09-11）

初次接管先由GitHub adapter查queued/in_progress/waiting/pending/requested，未排空不bind；排空后再次核owner。active观察前刷新owner。未知提交预算耗尽仍保留active并15分钟低频poll；尚未绑定的认证错误增加进程内15分钟冷却。对应红灯→绿灯记录 /tmp/fly2393-drain-red.log、/tmp/fly2393-api-drain-red.log、/tmp/fly2393-unbound-red.log 与 green logs。

Lead视觉裁定已采纳（question 6a05af77-6274-43fa-9b55-68f7b60eaf69）：提交fixtures/beta-console.html，真实视觉验收归QA，不阻塞实现handoff；PR需含精确延期说明。未再重试截图。

全仓 pnpm lint 已执行并修复本分支格式/导入错误；第二次PASS（既有16 warnings），日志 /tmp/fly2393-full-lint-final.log。pnpm -r build PASS，日志 /tmp/fly2393-full-build.log。pnpm test:packages:run 正在执行，session 72616，日志 /tmp/fly2393-full-packages.log；不能先写测试全部通过。新增mjs测试由现有release-workflows-structure.test.sh接入CI。没有新增shell测试文件。

packages总门结果：未改动的flywheel-comm dependency.test.ts在全仓并行压力下5000ms超时（2226 passed / 1 failed / 2 skipped），总命令提前退出。按Lead限制，仅隔离复跑该文件一次，42/42 PASS（/tmp/fly2393-dependency-isolated.log），未修改该测试。为覆盖提前退出后未执行的包，启动7个剩余包的pnpm -r --no-bail test:run（session16524，/tmp/fly2393-remaining-packages.log）；保留原始全仓失败，不写“全仓packages全绿”。

## 审查前合同核对（2026-09-11）

补齐计划§8错误日志去重：按project/reason/occurrence记录一次，恢复后可重新记录；错误响应正文不入日志，roster读取失败同样去重。新增双项目故障→重复→恢复→再失败回归，先红后绿；scheduler13/13 PASS（/tmp/fly2393-log-dedup-final.log）。变更后pnpm lint PASS与teamlead build PASS（/tmp/fly2393-lint-dedup.log、/tmp/fly2393-build-dedup.log）。

剩余packages进程16524继续运行。claude-runner结果1253 passed/3 failed/2 skipped，失败为未改动的async-exec-file 500ms、prompt-overflow.real-tmux 5s、runner-env-isolation.real-tmux 5s超时，另有onTaskUpdate RPC超时；保留原日志，不将其称作绿灯，不扩修无关测试。gemini-agent158、voice-headphone54通过；edge-worker及后续包继续执行。代码审查与exact-head CI仍待完成。

## R1 指定凭据修复（2026-09-11，替换实现体）

接续 head 45a8a175d，TURN implement epoch=5。Lead 交接 `[lead-instruction 8fe67a6d-291f-439b-ab7b-cee74f9f4319]` 确认 code R1 APPROVED（request 598da911-f14b-418b-b993-19a27393e162，gate e584a4fa-6f0f-4670-acbd-586256b39b8a），但指定修复两个涉密 MEDIUM。未触碰 stash 或已批 plan.md。

- 由运维的 Bridge 进程环境 `FLYWHEEL_BETA_ACTIONS_TOKEN_ENVS` 提供逗号分隔显式允许集，项目 YAML 只能选择其中变量；缺失/非法允许集 fail closed。canonical 配置读取、共享凭据比较和 HTTP token 读取都先检查，旧持久化绑定同样不能绕过。没有读取或修改实际生产环境。
- S4e 恢复 beta 与 promote 的单文件 secret allowlist；新增临时 workflow 副本 mutation 回归，插入任意未知 secret 必须让实际 S4e shell 片段失败。
- TDD：越权 selector getter 被读取红灯→读取前拒绝绿灯；配置 source 错将异常归 config_invalid 红灯→credential_missing 绿灯；S4e 未拦未知 secret 红灯→拦截绿灯。最终 19 focused tests PASS；release-workflows-structure 23 PASS/0 FAIL（含 9 个 node tests）。日志 /tmp/fly2393-credential-red.log、/tmp/fly2393-source-allowlist-red.log、/tmp/fly2393-s4e-red.log、/tmp/fly2393-security-focused.log、/tmp/fly2393-s4e-green.log。

全仓 lint/build/packages 正在本次变更上重新执行，尚不能称为通过；R2、PR、exact-head CI 与 handoff 仍待执行。运维激活步骤已更新到 runbook.md；频率配置来源未改变。

### Plan follow-ups 补充：code R1 非阻塞建议（不改 pinned plan 字节）

按上述 Lead 裁定，下列七项只归档，不修复、不开单：attention 泳道显示 unknown；legacy lane 硬编码 6h；receipt 合同三份副本缺 drift guard；submit 吞非 BetaGitHubError；credential_shared 覆盖已诊断原因；revision 计算后未读取；bind 每 tick 开写事务。此表不声称问题已解决，不扩入本次修复范围。
