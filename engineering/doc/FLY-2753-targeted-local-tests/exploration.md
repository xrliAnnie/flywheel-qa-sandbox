# FLY-2753 本机定向测试守则 — 探索
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-18
基于: 无

## 问题

implement、qa、engineer 三份 runner 守则把本机 `pnpm test:packages:run` 当成交卷前硬门，并围绕 `PACKAGE_GATE_RECEIPT`、`onTaskUpdate` 补跑未到达包。十几具 runner 并发时，这条本机全量门重复 exact-head CI 已覆盖的全量包套件，导致 1–2 小时的宿主争用与零提交等待。

## 锁定目标

- 本机仍跑全仓 `pnpm lint`。
- 本机只 build/typecheck 改动影响到的包。
- 本机定向测试选择规则必须可执行：覆盖改动文件所在包，以及直接依赖这些改动的测试文件；新增 `scripts/__tests__/*.test.sh` 仍逐个运行。
- 全量包套件只由 PR 的 exact-head CI 负责；CI 绿才是全量证据，任一 job 红都必须处理。
- 删除三份守则中的本机 `pnpm test:packages:run`、`PACKAGE_GATE_RECEIPT`、`onTaskUpdate` 例外与未到达包补跑要求。
- 只改验证合同及其生成投影，不改 CI、package gate 实现或其他条款。

## 方案比较

1. **三份 domain 手册 + 直接消费者（采用）**：只改 implement/qa/engineer 的既有验证段，并同步改写直接锁定旧文本的三组测试/fixture；canonical phase protocol 保持平台职责，不加入 Flywheel 仓库专属命令。`sync-phase-protocols.mjs --check` 证明 managed projections 无漂移。
2. **canonical protocol + 三份手册验证段**：会把 `pnpm lint`、workspace filters、`scripts/__tests__/*.test.sh` 注入所有项目的 implement/qa 平台层，并在 domain 再写一遍。实测 implement prompt 对 FLY-2533 的 10% 增长门只剩个位数字符余量，双写必破预算，否决。
3. **抽取新的共享验证片段**：可进一步消除三份手册的文字重复，但会新增生成器与迁移面，超出本单“不要顺手改别的条款”的范围。

## 验收边界

静态合同测试先证明当前文本不满足新规，再做最小文案修改。最终用三份守则 grep、phase protocol sync check、相关 shell 合同测试、lint、受影响 teamlead build/typecheck 与 exact-head PR CI 分别证明本地定向和全量责任边界。此改动不涉及 UI、数据库、服务重启、部署或真实凭据。
