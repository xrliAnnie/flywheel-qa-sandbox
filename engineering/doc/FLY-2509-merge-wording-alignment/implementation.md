# FLY-2509 合并措辞对齐 — 实施记录
Issue: FLY-2509 (https://linear.app/geoforge3d/issue/FLY-2509)
日期: 2026-09-10
基于: plan.md

设计 R2 APPROVED：request 0a7da0e2-8f69-4aae-959b-ceb84e944b1c，gate d9b74647-2006-4c27-b1f9-73ebf910dc2b。计划自此保持原字节。

## 改动前基线

- pnpm lint：exit 0，15 warnings；pnpm -r build：exit 0。
- pnpm test:packages:run：exit 1，flywheel-comm 2262 passed / 2 failed / 2 skipped；后续包不能记为已通过。
- runner-stop-declaration-race.test.ts :: keeps an undelivered older edge when the newer derivation commits second：expected sent/sent，actual stale/sent。
- commands/__tests__/dependency.test.ts :: reports no_active_roots from real materialization over successful HTTP：5000ms timeout。
- 两文件孤立复测一次 47/47 passed，不能覆盖全包失败事实。
- core 的两个真实 Terminal.app 用例在本环境探测后 skipped：Terminal.app cannot be resolved；没有环境开关，不保证其他环境也跳过。
- 原始日志：/tmp/FLY-2509-{lint,build,packages}-baseline.log，/tmp/FLY-2509-baseline-failures-focused.log。
- Lead instruction 91366725-f229-4806-ac17-979550218dd3：上述失败属主机并发竞争；保留红色 receipt，孤立只测一次，修改后全套最多再跑一次，不改 timeout/exclusions，PR 披露，exact-head CI 为准。

## 实施约束

只改 gate.ts caution 字符串，条件 args.checkpoint === "approve_to_ship" && approved !== true 不变。历史 fixture 只更新本任务的合并权限和 ship path 行，其他字节对照原版本不变；对应测试名称说明 fixture 的有界演进。生产生效仍依赖正常部署和新的 workflow snapshot / runner provisioning。

## TDD 与检查

- RED：Blueprint/角色 8 failed / 18 passed；合同版本 1 failed；gate caution 1 failed / 23 passed。失败均为本任务预期旧语义/版本，而非加载失败。
- GREEN：Blueprint fly208/generalized/fly1188/fly191 四文件 62 passed；codex-home 全文件 164 passed；gate 全文件 24 passed。
- 修改后 pnpm lint：exit 0，15 warnings；pnpm -r build：exit 0。
- fixture 仅行 40、41、72（authority、ship 后报告、only path into main）变化，逐字节确认所有其余行不变。gate.ts 逐字节确认只有 caution literal 变化，predicate 不变。
- 独立替身实际制造并解决同一行冲突，技术 merge 双 parent 正确，未调用审批 stub、未问 Lead；没有改 main 或推送。负向 ship 决策拒绝且没有执行。详见 bench.md。
- 没有新增 shell 测试；无渲染、迁移、数据库或部署面。

## 全仓措辞 sweep

使用 git grep 覆盖所有 tracked 文件（含 .claude/.flywheel），并对 packages/scripts/doc/engineering/doc 使用 rg --hidden；原始输出 /tmp/FLY-2509-wording-sweep.txt。活动 runner 角色、合同、Blueprint 和 gate 回复已无不区分合并方向的审批或禁止语句。

剩余命中逐类保留：FLY-2506 的锁定计划/探索/实施历史引文；FLY-1505/1625 等历史设计与旧 workflow snapshot；codex-home/Blueprint 的负向正则；FLY-1062 release runbook 禁止 merge/ship 自动触发客户 release（约束客户 release，不禁止技术合并）；companion-safety-contract 禁止 companion 执行任何代码/仓库操作（无写权限角色）；hook-payload 禁止代请求者执行 merge/approve/gate（事件本身无 ship authority）；DirectEventSink/CodexFounderPreflight 的 ship/landing 注释。未修改这些不同权限域或历史资料，不声称原始字面 grep 零命中。

## 修改后完整验证结果

pnpm test:packages:run 仅再执行一次，exit 1。flywheel-comm：156 files passed / 1 failed，2263 tests passed / 1 failed / 2 skipped，1 unhandled error。

- cli.test.ts :: check :: should output answer when responded：5000ms timeout。
- Vitest worker：Timeout calling onTaskUpdate。
- 两个基线失败用例本轮通过。新失败未归为旧用例或忽略；孤立复测 cli.test.ts 一次，exit 1，55 passed / 2 failed，另有同样 onTaskUpdate timeout。孤立失败为 ask :: FLY-1715 runner ask/check/gate/ack use ingest nudges without reading the disk master token 与 check :: should output JSON with --json（均 5000ms timeout）；原 full-run 失败用例在此轮通过。
- 这些失败涉及未修改的 ask/check 路径；唯一 comm 生产变更是 approve_to_ship 非结构化回复的文本 literal。没有改 timeout/exclusions，没有继续重跑完整套件或孤立文件。日志 /tmp/FLY-2509-packages.log、/tmp/FLY-2509-cli-focused.log。
- 按 Lead 已给出的 host-contention 类别裁定继续准备交接，保留全部红色 receipt，以最终 HEAD CI 作判断；此文不宣称本地全套通过。因 recursive 首包失败，后续未运行到的包也不计为通过。

PR #1157；最后 milestone 提交后冻结 HEAD，正式 code review 与 exact-head CI 结果通过 comm report 提供，不在审查期间改写分支。没有新的可复用角色记忆需要写入；本次经验已落本 issue 证据。
