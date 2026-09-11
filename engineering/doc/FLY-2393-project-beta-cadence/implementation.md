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
