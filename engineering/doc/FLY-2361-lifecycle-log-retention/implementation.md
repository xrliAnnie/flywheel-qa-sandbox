# FLY-2361 生命周期日志有界化 — 实施记录
Issue: FLY-2361 (https://linear.app/geoforge3d/issue/FLY-2361/lead-载体观测-brainlifecyclejsonl-无界增长20-mb天lead两位常驻-codex-lead-3-天各-286)
日期: 2026-09-13
基于: research.md

## 当前授权

Lead 在问题 f26ba51a-8055-4bf1-a8f9-7259eee826a3 回复：没有上游设计，本单 simple_code / plan_only；短计划写 progress，直接实现大小/年龄轮转与 poll 降频，对应测试，不重启真实 Lead。此前提交的 plan.md 是已被此裁定替代的提案，保留评审 blob 不改写，不把它标成获批设计。

迟到设计评审 578946d6-4ca3-4a86-b376-a2ec2b457dc9 的 HIGH `raya-runbook-attempt-grep-breaks` 有效：首个 attempt 必须保留。实际实现按频道保留首次 attempt、首次 ok、失败后恢复 ok；所有失败逐条写。既有首次 online→attempt→ok 测试保持，重复轮询另作聚合验证。

## 日志合同与读取

- 活跃 lifecycle.jsonl 2,000,000-byte 阈值，每次完整事件追加前轮转，最多超过阈值一条事件。最多 7 个编号归档，共至多约 16 MB 加 8 条事件；首次遇到旧超大文件整体归档，历史大文件在后续数量/年龄淘汰前可能暂时超过此预算。
- 活跃文件创建满 24h 后下一次日志写入时轮转，归档 mtime 满 7 天后下一次日志写入时清理。仅固定编号，不扫描任意目录；无 daemon/timer。现有平台 birthtime 可用；birthtime 不可用时回退 mtime，持续写入可能延后年龄轮转，但大小与归档数限制仍生效。
- 锁竞争/轮转失败沿用 fail-open，保留新事件并输出 deferred 日志；故障期间大小上限可能暂时失守。I/O/不安全路径错误显式记录。日志故障与 heartbeat 写入互相独立，不以 JSONL 是否写成功改变巡逻心跳。
- gateway_poll_summary 每五分钟最多一条，包含 start/end、attempt/ok/fail 总计以及原 v1 身份 envelope，由现有调用触发；空窗口不写。窗口计数仅在成功追加后清零；generationLost/shutdown 方法刷新剩余窗口。生产并无 shutdown() 调用点，进程直接退出（包括常规 SIGTERM）可能丢失最后不足五分钟的成功计数，已经追加的失败/状态变化不受影响。
- heartbeat 字段与逐次更新频率保持。各频道首次 attempt 保留激活手册断言；后续单次挂起应看 heartbeat 的 attempt/result 时间，不能把 JSONL 没有逐秒 attempt 当作停机。summary 的 attempt 与 ok+fail 差用于辅助追溯，不作为新 RED/GREEN 规则。
- 人工回放按 lifecycle.jsonl.7 到 .1，再活跃文件读取；编号可能有空缺。retention 是数量和年龄任一触发即淘汰，故障风暴不会采样失败，但可能缩短可追溯时间。任意失败洪峰的“永久无损”与固定字节预算不能同时保证。

## 验证边界

模拟 24h 测试统计所有文件真实新增字节，核对 86,400 次 poll、8 次失败、9 次首次/恢复成功、500 条 messageConsumed、288 个窗口总计。另用改前 heartbeat 合同对照实际 patrol decision，覆盖正常、上游错误、恢复、poll stall、heartbeat stall、turn stall。复用 fleet sensor suite 验证它的 alive 输入不变。

真实上线后的连续 24h 主机观测尚未执行；由后续 QA/部署窗口获得，不把模拟当作生产验收。本实现不更改巡逻阈值、不启动/停止真实服务。没有数据库 migration。

回滚：旧 observer 继续写同名 JSONL/heartbeat，字段兼容；已有编号归档仍可读，旧 observer 不会继续清理/轮转，故回滚后不承诺持续有界。

## 实测记录

2026-09-13 本地验证：24h 模拟重跑为 **155,999 bytes / 808 events**，全部计数断言通过。另一次 3,500 条失败突发跨大小轮转，逐条时间/分类/状态及顺序零丢失。轮转工具 19 项通过；observer/patrol/fleet-sensor 联合聚焦运行 78 项通过，另 24h/重启/heartbeat 合同 3 项通过、失败突发 1 项通过（重叠用例不重复宣称总数）。既有 `bash scripts/__tests__/flywheel-log-rotate.test.sh` 14 项通过。

`pnpm lint` exit 0（既有 warnings）；`pnpm -r build` exit 0。`pnpm test:packages:run` 首轮 exit 1：config 包 drift-scan 1 项、fly1981-final-ledgers 2 项超时，config 821 项通过；后续包未完成。上述两文件使用单 worker 原限时复核 38/38 通过，不能把首轮全包结果改写为绿。降低 worker/包并发重跑相同全包入口后，config 824 项通过；claude-runner 1,268 项通过、2 项跳过，但出现未处理的 `[vitest-worker]: Timeout calling "onTaskUpdate"`，全包入口仍 exit 1，后续包未运行。旧 HEAD d1b585e49 的 CI run 34788560665 全绿，不改写本地失败。

首次 24h 测试同步 I/O 跑了 271 秒，触发 120s test timeout 和 Vitest onTaskUpdate timeout，结果为失败；测试增加每 300 次轮询让出 event loop、600s 上限后重跑 165 秒通过，生产代码未为此改动。

角色要求的 codex:rescue 已尝试，但创建线程失败：`sandbox-exec: sandbox_apply: Operation not permitted`。Lead 问题 f0d59054-7aa5-4a46-8014-886ca47303af 明确批准以最终 HEAD 的 Bridge-registered cross-family review_code gate 满足代码审查要求；没有绕过沙箱或使用 raw codex exec。

## 恢复后的 main 同步

按 Lead 指令 2e017921-3335-4f8c-b42c-b88618afea1f 合入 origin/main 0c923c697，merge commit 2253afa5d，无冲突、无额外功能修改。同步后 `pnpm lint` / `pnpm -r build` exit 0；config 轮转 19/19，observer/retention/patrol/fleet sensor 80/80（包含完整 24h 模拟与失败跨轮转），shell 轮转 14/14。全包宿主争用已有一次隔离重跑失败回执，本次不重复全包重跑；新 HEAD 的 review/CI 回执记录在 PR。
