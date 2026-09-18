# FLY-2702 主机 package gate 排队 — 探索
Issue: FLY-2702 (https://linear.app/geoforge3d/issue/FLY-2702/主机吞吐-本机全量-package-gate-无并发上限今天-6-7-具体同时跑-pnpm-testpackagesrun单次)
日期: 2026-09-17
基于: 无

## 问题与证据边界
全量 package gate 是提交前的构建与全部 package 测试。每体只有一个测试 worker，不等于整机只有有限个 gate；多个 worktree 会同时运行构建和测试，争抢同一台机器。

Lead 的原始描述：2026-09-17 22:49/23:08Z 6–7 个 gate，部分超过一小时，16 个 vitest 合计 CPU 约 104%，18 核机器 load1 22–49。后续答复 b44b5250-57a1-4fce-a36e-27475cf3f6a4 补充：22:49–23:58Z 曾达 8 gate、etime 44m–1h31m、load1 95–117，出现 5s wall-clock 超时与瞬时 tmux 丢失；00:40Z 降至 2 gate 后 load 25。这是 Lead 现场记录，不是本设计重新采样或因果证明。

本设计沙箱执行 ps 被拒，见 evidence/design-host-sample.json。CPU=0 不证明死锁；多 gate 与高 load 同现支持限制入口，不能证明 N=2 已达到吞吐目标。没有重新启动全量 gate、杀进程或改动生产配置。

## 范围及成功定义
- 同一主机、同一 OS 用户，所有 Flywheel worktree 共享一条先进先出队列（FIFO：先到的先拿空位）。独立 OS 用户不在本轮协调范围，Lead 已确认。
- 名额覆盖 build、全部 packages、既有 RPC retry；只有取得名额才启动构建或 Vitest。RPC 是测试 worker 向主进程汇报结果的内部通信，既有失败分类保持不变。
- 等待 pane 显示“等待第 k 位 / 前面 m 个 / 已等 t”，另有可读账本；巡检 STEP 2 消费可核验的排队状态。
- 第 N+1 个等待且没有启动测试；正常前任释放后 ≤5 秒启动。
- 六份固定工作负载同时交卷：从首个入场运行至最后一个完成，不超过独立基线模拟 N 路时间 ×1.2；另报告包含排队的每体 wall time。无 RPC 超时假红不等于允许吞掉真实失败。
- CI 路径不变；本机提供明确 env 回退开关。N=2 是候选初值；QA 比较 2/3 后定值，不在设计阶段声称实测最优。

## 方案比较
| 方案 | 优点 | 代价与结论 |
|---|---|---|
| 每 worktree mkdir 锁 | 简单 | 无法协调全机；淘汰 |
| 主机 flock 槽位 + JSON FIFO | 复用现有 Python flock 模式 | 公平排队、陈旧记录、fork 崩溃窗口仍要另写一致性协议；不选 |
| 主机 SQLite 小账本 + 短事务 + 内核生命周期锁/运行监督进程 | FIFO 与计数原子提交，重启后有恢复依据，无常驻服务 | 需要处理进程身份、子进程残留；选用 |
| Bridge 中央调度服务 | 可复用部分机器身份 | 把本地测试绑定 Bridge 可用性、部署与 RPC；本轮不选 |

SQLite 是单文件事务数据库，短事务让多个启动者不会同时误读最后一个名额。用 Python 标准库访问，避免 gate 在 build 前依赖刚编译的 teamlead dist 或原生 Node 模块。

## 选定边界
主机账本是限流事实源，JSON 是可读投影，不能凭 JSON 授予名额。心跳只是检查线索，不能因陈旧而直接抢活进程的名额。父进程死亡但测试子进程活着时继续占位；确认整个运行进程组消失后自动回收。不设等待超时变红。

## 明确不做
不改 Vitest worker 数、RPC timeout 或 FLY-2467 判定；不调全局 Runner 并发；不做分布式/跨用户调度；不把已运行旧版本 gate 自动纳管；不把排队视为测试通过或生产部署证据。

## 审查修订
不再把沙箱不可用的ps/bootId当准入依赖；健康队列保持FIFO，冻结queued可挂起并恢复后重新排队，occupied不因心跳陈旧夺槽。排队默认关闭，巡检先部署后开启；全机关闭与逐调用env回退并存。
