# FLY-2465 Codex 舰队切号 — 实施台架证据
Issue: FLY-2465 (https://linear.app/geoforge3d/issue/FLY-2465/2371-根治-codex-舰队级自动切号限额信号-按最早重置挑号-切-codex-重起被收的体全池打满才发-founder)
日期: 2026-09-09
基于: plan.md

可执行入口：`bash scripts/qa-fly-2465-codex-quota.sh`。2026-09-09 20:51Z 执行结果：1 文件、6 场景全部通过，14.99 秒。入口打印临时 JSON receipt 路径；本次为 `/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/fly-2465-bench-evidence.Zo0DTh/receipt.json`。

台架使用真实本机 HTTP event/review/runs 路由、真实 StateStore SQLite、quota runtime/coordinator、安装器、恢复客户端及 outbox 消费器。每个正向场景先创建六个独立 workflow run、启动六个 Node 子进程并确认退出，再从 HTTP 注入重复 usageLimited 信号；恢复必须实际调用 terminate/start，并启动六个新子进程。新进程逐个越过严格合成 refresh-token authority 的刷新边界，最后六个都能继续工作。

| 场景 | 断言与结果 |
| --- | --- |
| business 打满 | 一个 generation incident、六个 targets；一次成功 probe 后切 school，六个恢复；usage_limit 一条、founder 零条；恢复 1060ms |
| queued → running | 六次 202 后 targets 均保持 queued；真实 launch commit 后重放同一 reservation 得 200，再确认六个实际存活绑定；915ms |
| SIGKILL 刷新中断 | 子进程持共享账号锁刷新候选、留下 durable workspace/process metadata 后被 SIGKILL；重建 runtime/coordinator，从原 SQLite 状态及磁盘 orphan 恢复候选，然后真实安装/恢复六具；严格合成 authority 接受后续刷新；1258ms |
| 全池打满 | 三份新鲜显式 quota100 窗口；founder 一条、usage_limit 一条；probe 零、terminate/start 零；六次真实 dead-node replacement guard 均拒绝 |
| probe 失败 | 一次失败 probe；canonical 字节不变、terminate/start 零、blind replacement 零；usage_limit 一条 |
| generic429 | 真实 review bind/observe HTTP 路径拒绝非 quota rateLimitExceeded；incident/probe/restart 均零 |

TDD 集成 RED 曾暴露两个真实契约缺陷：异步 observe 后仍用旧时钟导致新观察失效；真实 generalized start 返回 `workflowRunId`，恢复客户端只认 `runId` 导致六具已活但永久 starting。分别由 coordinator/recovery 所有者修复；同一台架现为 GREEN。全池场景另纠正了夹具把已退出 PID 标成 active 的陈旧库存数据。

验证边界：协议 CLI 是隔离的可执行 Node 合成器，不是在线 Codex 服务成功证明。Linear issue 查询被 fixture 拦截；调度器使用真实子进程但不是 tmux/生产 adapter；liveness 使用真实 PID；outbox 接收方是临时文件而非 Discord。SIGKILL 针对刷新持锁进程，重建 runtime/coordinator 时复用已打开的 SQLite Store，不声称整个 Bridge 进程崩溃重启。未读取或写入真实 `~/.codex`、生产数据库，未使用真实凭据。本文件仅记录实施台架，完整仓库 gates、独立审查、在线受控 QA 由主实现节点分别登记。

2026-09-09 21:09Z 补验：恢复客户端改为必需 readiness 后，台架注入真实 `runtime.readiness()`；与 retention 文件合跑 31/31 通过（14.72 秒）。新增 15 张 quota 表（含延迟创建的 canonical observation）均登记为 `protectedCurrentOrReference`，不新增任何删除策略；专门的保护测试先因 `schema_unclassified` RED，登记后 GREEN。retention consumer gate 的 Node 测试亦通过。
