# FLY-2334 审查体资源上限与同头复用 — 实施计划
Issue: FLY-2334 (https://linear.app/geoforge3d/issue/FLY-2334/引擎urgent-跨族审查体跑-vitest-无线程上限17-worker03-09gb且同-head-重复起审-7-路审查并发把整机打到)
日期: 2026-09-04
基于: 无

## 范围

仅修改跨族 Claude 审查体启动与 review request coordinator，不恢复全局审查并发槽位，也不改 Bridge/Lead 生命周期。

## 实施

1. 审查体子进程固定覆盖 `VITEST_MAX_THREADS=4`、`VITEST_MIN_THREADS=1`；prompt 要求只跑改动相关文件的单包测试，禁止 `pnpm -r`。
2. code review 请求冻结可信 head 后，若同 project、issue、repo、head 已有 `running` job，则把新 execution 的 open gate 持久绑定到该 job，并由同一判决应答所有绑定 gate，不再启动第二个 reviewer。

## 测试

- `claude-review-runner.test.ts`：恶意继承值仍被覆盖为 4/1。
- `review-request-coordinator.test.ts`：两个 execution 对同 issue/head 并发请审，只产生一次 reviewer invocation，两个 gate 收到同一判决。
- 单包 focused tests、`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`，以及仓库内全部 `scripts/__tests__/*.test.sh`。

## 上线与回滚

改动随 Bridge 常规发布生效，无 schema 外部迁移步骤；StateStore 启动时幂等创建绑定表。回滚代码后旧绑定表可安全保留，不影响旧版本读取。
