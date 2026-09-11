# FLY-1949 评审并发 — 调研
Issue: FLY-1949 (https://linear.app/geoforge3d/issue/FLY-1949/评审并发-review-全局并发写死-2-提高并做成可配置founder-直令)
日期: 2026-09-10
基于: exploration.md

当前代码证据：

- review-request-coordinator.ts enqueue() 仅等待同 execution predecessor，再调用 runJob；没有 maxConcurrent/acquireSlot/releaseSlot。
- plugin.ts coordinator wiring 注释明确 no coordinator-wide concurrency ceiling。
- 既有测试 starts ten distinct executions without a coordinator-wide concurrency ceiling 验证十个不同 execution 在任一 round 完成前都已启动；redrive 测试覆盖跨 execution 并行与同 execution 串行。
- packages/config/src/model-config.ts 使用 FLYWHEEL_MODELS_CONFIG 或 ~/.flywheel/models.json，并以文件 stat 信息缓存快照；若 Lead 保留配置需求，可复用，但尚未设计或获批。

验证尝试：focused vitest 命令未执行测试，因为本 checkout 未安装依赖（Command vitest not found）。正在 pnpm install --frozen-lockfile；此错误不能算测试失败或通过。

历史 FLY-2037 QA 报告仅作为定位材料，不作为本 HEAD 的验证结果。未验证生产当前部署或 FLY-1884 真实排队情况。

最新本机验证（2026-09-10）：pnpm install --frozen-lockfile 完成；首次安装后 focused 测试因 flywheel-core 未构建而 collection 失败（no tests）。随后 pnpm -r build exit 0。构建后重跑：

```sh
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/review-request-coordinator.test.ts -t "starts ten distinct executions|redrives distinct executions concurrently|keeps two requests from the same execution serial"
```

结果 3 passed / 119 skipped，exit 0。日志 /tmp/fly1949-build.log 与 /tmp/fly1949-focused.log。本次只证明既有调度行为，未实现热配置，未运行全仓 lint/package tests，也不代表生产验收。

继续核验：完整 review-request-coordinator.test.ts 套件 122/122 passed（exit 0，2026-09-10 23:01 PDT），日志 /tmp/fly1949-coordinator.log。覆盖当前 coordinator 全文件回归，不替代全仓测试或生产证明。
