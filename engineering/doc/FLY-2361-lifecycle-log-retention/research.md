# FLY-2361 生命周期日志有界化 — 调研
Issue: FLY-2361 (https://linear.app/geoforge3d/issue/FLY-2361/lead-载体观测-brainlifecyclejsonl-无界增长20-mb天lead两位常驻-codex-lead-3-天各-286)
日期: 2026-09-13
基于: exploration.md

## 当前代码与消费者（2026-09-13 仓内检索）

| 路径 | 证据与影响 |
| --- | --- |
| packages/teamlead/src/lead-backends/codex/resident-codex-lead-lifecycle.ts | 唯一生产 JSONL writer；同时维护 heartbeat；poll attempt/ok 全量写入 |
| packages/teamlead/src/bridge/resident-codex-lead-patrol.ts | 读取 brain/heartbeat.json；使用 updatedAt、lastGatewayPollAttemptAt、lastGatewayPollStatus、activeTurn 与身份；不读取 JSONL |
| scripts/resident-codex-lead-recover.sh | 读取 heartbeat 作为恢复守卫；不读取 JSONL |
| scripts/lib/qa-launchd-lead.sh | 读取 heartbeat 作为 QA 身份/活性证据；不读取 JSONL |
| packages/teamlead/src/bridge/fleet-sensors.ts / plugin.ts | BOT 传感器使用 probeBots 的 alive；plugin 的 probeInfraBots 调 probeLaunchdJobAlive（launchctl print），不读取 JSONL |
| engineering/doc/FLY-2259-raya-brain-cutover/activation-runbook.md §4.7 / plan.md | 首启激活读取 JSONL tail 并 grep online、gateway_poll_attempt、gateway_poll_ok；必须保留各频道首次 attempt 和首次 ok，重复 poll 才聚合 |
| engineering/doc/FLY-2239-codex-lead-cutover/ | JSONL 是人工事后追溯材料；降频后追溯须同时查看编号归档，成功次数取 summary |
| resident-codex-lead-lifecycle.test.ts | 直接读取 JSONL 的现有代码测试；首启序列断言保持，新增重复轮询汇总断言 |

初次检索 `packages scripts` 漏掉了激活手册。迟到设计评审指出后扩展：`rg -n 'lifecycle.jsonl|heartbeat.json|gateway_poll_|lastGatewayPoll|lastLifecycleEvent' packages scripts engineering/doc doc --glob '*.md'`（代码另行不限制扩展名检索）。FLY-2216/2239 的其他引用是设计/历史观察记录。范围是当前仓库，不声称已检查仓外人工脚本。

## 复用点

`packages/config/src/log-rotate.ts` 提供 rotateLogIfNeeded / appendRotatedLogSync：编号归档、mkdir 锁、陈旧锁恢复、strict no-follow append。默认 10 MiB / 3 份；目前仅按大小，没有按天数。可向此工具添加可选年龄限制，保持现有调用者默认行为，并由 observer 显式启用。年龄检查/清理必须在相同轮转锁内，不能另建 daemon 或递归扫描目录。

## 验证要求

真实临时文件 + 注入时钟覆盖：24h 正常轮询累计字节（含归档，不用轮转隐藏写入）、重复失败逐条记录、按频道恢复状态、停止/重启、大小/年龄边界、已有大文件、符号链接、轮转/I/O 失败时 heartbeat 独立推进。对同一事件流比较改前 heartbeat 合同与新 heartbeat，调用实际 patrol 判定函数比较完整 decision。现有 fleet sensor suite 证明 alive 输入的 RED/GREEN 合同。

生产 24h 是后续 QA/部署观察证据，模拟 24h 不冒充生产验收。
