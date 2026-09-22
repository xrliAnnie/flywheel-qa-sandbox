# FLY-2694 cos 落地 Flywheel — 实施证据

Issue: FLY-2694 (https://linear.app/geoforge3d/issue/FLY-2694/raya-并仓s1-packagescos-落地-flywheel-仓包名-flywheel-raya-cos接入-workspace)
日期: 2026-09-17
基于: plan.md

## 身份与来源

- Raya 来源 commit: `90e433e87a68287ed59ba64f2584e3a6bc0da151`
- Raya `packages/cos` 来源 tree: `d72da8b9667a2a848ff26ce521b914a657fa4583`
- Flywheel 最后一个产品/测试代码 commit: `8a630c42b8ce6020e2b15b7dd9e60741d963438a`
- 搬运校验:120 个上游 `src/**` 文件集合相等且逐 blob hash 相同；Flywheel 另加一份
  `package-contract.test.ts`，所以包内 `src/**` 共 121 个文件。

## 本地判据

在 `8a630c42b8ce6020e2b15b7dd9e60741d963438a` 上：

- `pnpm install --frozen-lockfile --offline`:通过。
- `pnpm -r build`:通过；日志包含 `packages/raya-cos build: Done`。
- `pnpm --filter flywheel-raya-cos test:run`:56 files / 317 tests，通过。
- `pnpm typecheck`:通过；日志包含 `packages/raya-cos typecheck: Done`。
- `pnpm lint`:exit 0；22 条均为仓内既有、与本单无关的 warning。
- `node --test scripts/__tests__/raya-cos-cli-dist.test.mjs`:5/5 通过。
- `bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`:325 个 shell suite 全部分类，
  82 个根 Node suite 全部登记。
- `bash scripts/__tests__/ci-structure.test.sh`:通过。
- `pnpm --filter flywheel-config test:run`:57 files / 867 tests，通过；
  `fly1981-final-ledgers.test.ts` 12/12 通过，整文件约 4.1 秒。
- lockfile 结构比较:`LOCKFILE OK: exactly one new importer, zero new resolutions`。

## package-gate

`41d09ae7b126ba9b00067353f8f417f179a9ee60` 的机器 receipt 已明确包含：

- package: `flywheel-raya-cos`
- script: `vitest run`
- status: `passed`
- files:56/56
- tests:317 passed / 0 failed

该次全仓 aggregate 在随后几个既有包遭遇宿主争用型 wall-clock 失败后按 Lead 指示停止；
六个失败目标均以单 fork 独立复跑通过。Lead 明确裁定不重启本地 aggregate，最终 aggregate
权威为精确头 CI。`41d09ae7` 到 `8a630c42` 的产品/包代码未变，唯一代码差异是
`packages/config/src/__tests__/fly1981-final-ledgers.test.ts` 的扫描过滤；因此该 receipt 继续作为
CoS 包级证据，`8a630c42` 的 aggregate 由精确头 CI 单独证明。

## 精确头 CI

- `41d09ae7b126ba9b00067353f8f417f179a9ee60` 的两次 light 尝试都明确执行
  `packages/raya-cos test:run`，并显示 56 files / 317 tests 全绿；随后既有
  FLY-1981 全仓扫描触发固定 15 秒超时。
- Lead 批准把该扫描的 AST 输入限为文本含 `FLYWHEEL` 的候选文件，不改超时；
  拼接构造 fixture 和过滤前后命中集合逐一相等测试防止过滤变成假守卫。
- `8a630c42b8ce6020e2b15b7dd9e60741d963438a` 的首次 workflow run
  `35314864117` 因 GitHub Actions billing/spending-limit 在 runner 启动前失败，所有 job
  `steps=[]`，不是代码 verdict。该基础设施事实按 Lead 要求保留。
- 计费恢复后在**同一精确头**重跑 run `35314864117` attempt 2；结论为 success：
  - Quick Gate: https://github.com/xrliAnnie/flywheel/actions/runs/35314864117/job/105507019091
  - Unit (light): https://github.com/xrliAnnie/flywheel/actions/runs/35314864117/job/105507541457
  - CI OK: https://github.com/xrliAnnie/flywheel/actions/runs/35314864117/job/105512209557
- light 日志明确出现 `packages/raya-cos test:run$ vitest run`、
  `Test Files 56 passed (56)`、`Tests 317 passed (317)`；同一日志中修复后的
  `fly1981-final-ledgers.test.ts` 12/12 通过（整文件 13.111 秒，目标测试 7.165 秒，
  固定 15 秒超时未改）。

## 范围

- 已逐条核对上游 plan §14：六条修订分别落在 S4、S3、§7A、§11、§10.4、§10.5，
  不改变本 S1 包落地边界。
- 未修改任何 Raya / updater 既有脚本；未修改 Raya 仓；未部署、未重启、未接运行时消费者。
- FLY-2657 独立推进；本单没有等待或修改它。
