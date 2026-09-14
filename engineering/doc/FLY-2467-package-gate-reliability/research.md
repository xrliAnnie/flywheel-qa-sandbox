# FLY-2467 全包门可靠性 — 调研
Issue: FLY-2467 (https://linear.app/geoforge3d/issue/FLY-2467)
日期: 2026-09-14
基于: exploration.md

## 已核实
依赖安装成功，锁文件不变。Vitest 3 本地 dist 的 createRuntimeRpc 抛出精确 worker timeout；未找到公开 VITEST_RPC_TIMEOUT 配置，不能杜撰环境变量。teardownTimeout 仅关闭等待，不能声称它直接修改 RPC 超时。采用有界 forks pool 降低负载，设置 teardownTimeout=60000，不动 testTimeout/hookTimeout。
官方说明：https://v4.vitest.dev/config/teardowntimeout 。本地版本源码是选项可用性的最终依据。
run 34801435161 main 573159a15：teamlead 3/3 failure，其余两片 success。
GitHub 默认返回重跑后的最新 attempt：34801838159 当前三片 success，测试步骤 446/477/508s；34802927701 当前三片 success，测试步骤 484/634/551s。不能用这些最新绿覆盖先前红，后续收集 attempt 1 日志做近24h基线。
## 选择
四片是首选，若精确头实测不满足每片<400s，按文件用时均衡；不能仅靠理论 3/4 缩放宣称验收。
聚合顺序 build 完成后逐包运行，独立 run 目录保存日志与 JSON 收据，继续所有包；真失败仍 exit 1。不新增全局锁服务或修改生产路径。

## 首轮收据补充（2026-09-14）
已下载三个指定 run 的 attempt 1 原始日志，保存在 /tmp/FLY-2467-evidence/<run>-attempt1.log；结构化摘录 baseline-summary.json。采用最终全套 Duration（不混入前置 mutation 对照用例的预期失败输出）：

| Run | 1/3 | 2/3 | 3/3 | 3/3结果 |
|---|---:|---:|---:|---|
| 34801435161 | 458.20s | 522.01s | 545.57s | 339文件通过，4058测试通过，1跳过；onTaskUpdate timeout |
| 34801838159 | 444.99s | 476.35s | 516.84s | 339文件通过，4056测试通过，1跳过；onTaskUpdate timeout |
| 34802927701 | 482.99s | 633.77s | 571.73s | onTaskUpdate timeout；完整计数见原始日志 |

这些记录证明此问题存在，但不把整个历史 workflow 的其他失败归类成RPC伪影；例如34801435161 heavy还有独立失败。2026-09-14本地基线 pnpm -r build exit 0，尚未实施任何行为改动。
