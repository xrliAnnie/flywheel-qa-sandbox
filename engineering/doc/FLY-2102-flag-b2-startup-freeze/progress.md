---
issue: FLY-2102
phase: implement
phaseCursor: 3/4
updated: 2026-08-28T19:50:20.985Z
nextStep: Push the refreshed exact head and request exact-head code review
chunks: []
pointers: {}
---

# FLY-2102 progress
**phase**: implement (3/4)
**next**: Push the refreshed exact head and request exact-head code review

## Rebase conflict audit

当前 `origin/main=5ec16b2273b1586c1dac15d9ba92a030e34f5c79` 已是分支祖先。
以下 hunk 在重放时逐项手写合并，没有整文件采用 ours/theirs：

- `packages/config/src/feature-flags/resolve.ts`：保留 FLY-2100 的
  `projectStoreManaged` / `scopedStore` / `valueClocks` DTO，同时保留 FLY-2102
  删除 `flag_store` bypass 后的 ready-only 语义。
- `packages/teamlead/src/StateStore.ts`：保留 FLY-2100 scoped rows 与 FLY-2104
  scope-aware clock/changelog；删除 FLY-2102 退休的 `.env` fallback seed 路。
- `packages/teamlead/src/bridge/flag-store-runtime.ts`：保留 project overlay 与
  FLY-2104 clock readiness；删除 bypass mode/branch。
- `packages/teamlead/src/__tests__/flag-routes.test.ts` 与
  `packages/teamlead/src/bridge/__tests__/flag-store-runtime.test.ts`：把旧
  `FLYWHEEL_FLAG_STORE=0` fixture 改成“输入被忽略”，并保留无 scoped clock 时
  `no_clock:degraded` 的 fail-closed 契约。
- `packages/teamlead/src/bridge/flag-routes.ts`：删除重放后残留的
  `runtime.mode === "bypass"` 409 分支；project scope/CAS 写入路径保持不变。
- `packages/config/src/__tests__/fly1981-final-ledgers.test.ts`：保留当前 authoring
  contract、`PROJECT_STORE_MANAGED_FLAGS` 与 founder-policy regex，去掉过时的精确文案。

树级符号计数（`origin/main` → `HEAD`）均不变：
`PROJECT_STORE_MANAGED_FLAGS 30→30`、`applyScopedFlagValueChange 13→13`、
`listScopedFlagValueRows 4→4`、`scopedStore 12→12`、
`listFlagValueClocks 8→8`、`valueClocks 22→22`、
`commitFlagScan 14→14`、`renderFlagScanReport 3→3`。

## Rebase QA evidence

- FLY-2102 structure 46/46，CI structure 通过；config 全量 44 files / 695 tests；
  teamlead 冲突触点 3 files / 75 tests；两包 typecheck 均通过。
- `pnpm lint` exit 0；`pnpm -r build` 通过，且 teamlead build 删除 stale
  `dist/bridge/publish-broker`。
- `pnpm test:packages:run` 唯一失败为未改动的 `packages/core` 两条真实
  Terminal/AppleScript 测试，host 返回 `com.apple.hiservices` connection invalid。
  排除 core 后 21 包继续执行；teamlead 高并发下 9637 tests 通过、四个无关文件
  出现 6 个 5s timeout + 1 个 mock 串扰，四文件单 worker 重跑 40/40 全绿。
- 发布路径：workflow structure 18/18、registry preflight 5/5、pack/install/publish
  dry-run 9/9、payload pipeline 29/29。真实 `--founder-local` preflight 使用隔离 npm
  cache 后到达 npmjs，并仅因当前 `@flywheel-ai/onboard@0.1.0` 已发布而按设计拒绝；
  本单不越界 bump 版本，也未执行任何 publish。
