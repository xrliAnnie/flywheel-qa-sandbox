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
