# FLY-2361 生命周期日志有界化 — 实施计划
Issue: FLY-2361 (https://linear.app/geoforge3d/issue/FLY-2361/lead-载体观测-brainlifecyclejsonl-无界增长20-mb天lead两位常驻-codex-lead-3-天各-286)
日期: 2026-09-13
基于: research.md

状态：待设计评审。未经 APPROVED 不实施；评审绑定后不修改本计划。

## 1. 锁定范围与合同

仅修改现有日志轮转工具、resident observer 及相应测试/文档；不新增 daemon、数据库表、环境开关或巡逻判定规则，不部署、不重启服务。

- lifecycle 活跃文件大小阈值 2,000,000 bytes，保留最多 7 个编号归档；每文件可超阈值至多一条完整事件。已有超大文件首次写入前整体归档，不读取/截断历史内容。
- 活跃文件在创建满 24h 后的下一次写入轮转；归档最后写入满 7 天后在下一次写入删除。使用文件 metadata 与注入时钟，固定检查 7 个名字；无写入时不新增唤醒。保留同时受数量和年龄限制，故障风暴下数量先触发。
- 成功轮询按频道首次成功及 failed→ok 恢复写 `gateway_poll_ok`；重复成功不写，attempt 不逐条写。所有 `gateway_poll_failed` 和原有非 poll 事件继续逐条写，字段与顺序保持。
- 每五分钟追加一个跨频道 `gateway_poll_summary`，包含窗口 start/end、attempt、ok、fail 计数，身份字段沿用 v1 envelope。由现有 observer 调用驱动；到期才 flush，空窗口不写，无新 timer。generationLost/shutdown 刷出不足五分钟的窗口。重启新建窗口，未落盘成功计数可能随非正常退出消失；失败/状态变化在事件发生时已独立写入。
- heartbeat 每次调用仍更新，包括被抑制的成功 poll；lastLifecycleEvent 保持原方法事件名，summary 不覆盖此字段。日志失败与 heartbeat 写失败分开处理并记录错误，轮转锁冲突沿用现有 fail-open append 合同。
- 每天 ≤2 MB 指正常稳定轮询工作负载的实际总新增 JSONL 字节（包括归档），不以删除/轮转制造低增量。故障任意多与无限期零丢失不可能同时有界；失败不采样，保留窗过期按声明策略删除。

## 2. 实现顺序（每项先 RED 再最小实现）

1. 在 config 的既有 log-rotate 测试中增加 opt-in 活跃年龄轮转/归档到期清理：扩展可选 maxFileAgeMs / maxAgeMs / nowMs，默认不启用，所有检查在既有旋转锁内。活跃出生时间采用 birthtimeMs；不可靠时使用保守 metadata fallback 并验证，不每次 append 重置年龄。覆盖年龄边界、无效参数、重启、旧大文件、锁冲突、非普通文件。保持默认工具现有用例通过。
2. observer 集成 strict appendRotatedLogSync，默认上述阈值；拆分日志与 heartbeat 写入错误边界。保持 brain 0700/文件0600及符号链接防护。覆盖写失败时 heartbeat 仍推进、轮转后事件完整、错误日志可见。新增内部测试注入参数仅用于边界测试，不开放环境配置。
3. 测试后实现按频道状态与周期总计；旧 JSONL 序列断言同步更新。重复失败保留、跨频道失败不会被其他频道成功掩盖、恢复准确记一次、计数/时间边界/退出 flush/重启与旧文件兼容均有执行证据。heartbeat 不随日志降频。
4. 添加 24h 注入时钟工作负载测试：每秒 attempt+ok，另含约 500 条 messageConsumed 和少量生命周期/失败，统计实际所有 JSONL 文件字节并验证 <2,000,000；另测高频失败完整性，不对它声称日总写入小于 2 MB。测试按事件逐次比较旧 heartbeat 合同和新 heartbeat，并把两者送入实际 patrol 评估函数，对 healthy/upstream_unavailable/poll_loop_stalled/heartbeat_stalled/turn_stalled/身份异常及恢复比较 decision。
5. 运行已有 fleet-sensors 用例；补充消费者清单中 plugin.ts 的 launchctl alive 数据源，确认传感器不依赖事件采样。文档记录归档阅读顺序、retention 边界、回滚：旧版 observer 继续读写同名 heartbeat/JSONL，归档保持可人工读取，回滚将停止新轮转，不声称继续有界。
6. 全仓验证、代码评审、PR 与 handoff。更新 progress；里程碑 engineering/doc/milestones/FLY-2361.md 为最终提交。代码 gate 必须绑定最终 HEAD；必要修复后重新评审。完成命令 `complete --route needs_review --pr <N>`，随后遵守 TURN/park，不自行推进 QA。

## 3. 验证与交付边界

聚焦命令使用 `pnpm --filter flywheel-teamlead exec vitest run <paths>`，config 包按实际 package name 执行；核对实际用例数。全仓命令必须执行：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`；每个新增 scripts/__tests__/*.test.sh 必须执行（当前计划不新增 shell 测试）。失败如实保留，不以聚焦绿冒充全仓绿。

设计审查使用注入的 review_design gate + request-review；代码审查遵循 runner contract 的 review_code gate + request-review，以及角色指定的 codex:rescue（定位当前可用入口后执行，不使用 raw codex exec）。

实现可交付的 24h 证据是可重复模拟测试。真实部署后的连续 24h 日增量、失败/状态变化对照需要独立 QA/部署窗口；本 implement 不请求服务重启，不把本地测试标成生产验收。
