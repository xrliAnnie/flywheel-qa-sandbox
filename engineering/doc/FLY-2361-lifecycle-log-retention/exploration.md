# FLY-2361 生命周期日志有界化 — 探索
Issue: FLY-2361 (https://linear.app/geoforge3d/issue/FLY-2361/lead-载体观测-brainlifecyclejsonl-无界增长20-mb天lead两位常驻-codex-lead-3-天各-286)
日期: 2026-09-13
基于: 无

任务要求：日志按大小和天数轮转；成功轮询改为状态变化和五分钟计数，失败逐条保留；消费者 RED/GREEN 判定不变。

当前基线 26ebc4931：`ResidentCodexLeadLifecycleObserver.emit` 每个 poll attempt/result 均 append JSONL，再原子替换 heartbeat。没有日志大小或年龄限制。FLY-2239 research.md 记录的约 20 MB/天是历史测量，本轮未读取生产日志，也未重启服务。

当前 implement TURN epoch=1 属于本执行，工作树没有 FLY-2361 上游文档或账本。已通过问题 f26ba51a-8055-4bf1-a8f9-7259eee826a3 向 Lead 核对 pinned plan；批准前不写实现。

关键约束：成功 poll 的日志降频不能降低 heartbeat 的刷新频率；轮转失败不能阻止 heartbeat 更新。失败和状态变化不采样，保留窗内完整可追溯；有界 retention 不代表永久保存。任意高频失败的无损日志不可能同时承诺每天总写入恒小于 2 MB，验收应分别证明正常工作负载日增量与故障事件完整性，并明确压力场景的保留窗。
