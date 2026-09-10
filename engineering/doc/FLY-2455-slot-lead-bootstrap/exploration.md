# FLY-2455 529 房启动诊断 — 探索
Issue: FLY-2455 (https://linear.app/geoforge3d/issue/FLY-2455/529-房台架-test-deploysh-起不来-529-slot-lead卡在-qa-launchd-topology-校验)
日期: 2026-09-08
基于: 无

## 要交付的结果

529 slot（隔离的测试房）必须能从干净 main 启动：Bridge（处理消息与任务的服务）的 `/health` 返回 200，Lead（房内负责接收指令的智能体）在线并收到一条真实测试消息，随后只拆除本 slot。失败时必须说明具体 label（系统任务名）、plist（系统启动配置）、manifest（启动器发布的运行记录）或 socket（进程之间的私有通信地址）哪一项有误。

本节点只完成根因调研、可实施方案、设计评审和可批注 HTML。真实起房、修改程序、拆房、CI、合并由后续节点按自己的权限执行；本节点不派发这些节点。FLY-2352 重启演练与 FLY-2398 的证据跑不是本单验收的替代品，也不在本单执行。

## 已知输入与仍需核实的内容

- issue 给出两个独立失败：FLY-2107 QA `703a3dc0` 和 FLY-2398 QA `310a846e`，前者在 merge-base `ee113cab9` 仍失败。这证明需调查公共启动链；尚不能单凭末尾错误确定具体病因。
- 本工作树初始 HEAD `d7b75c755`，工作树干净，2026-09-09 03:04Z 后取得 design TURN epoch 1。
- 现有 `qa_launchd_lead_verify` 只在 manifest 同时有 pid/socket 后查询 launchd。wrapper 早退时最终输出的三个字段都可能为空，无法解释真正的早退原因。
- FLY-2174 已删除 alerts 分支的两条重复身份注入；不得把历史 `--alerts` 错误直接当成本轮根因。
- 本节点在临时目录独立执行现有 host-tmux gate（未启动任何服务），当前选中 `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`，版本 3.7c、arm64，gate 返回 0。FLY-2248 的旧路径漂移现在不能直接复现。
- 已向 Lead 询问两次失败的原始 stderr/lead.log 路径及配套拆房隔离单，questionId `99a93a6a-6751-4021-99ca-bf5210c5710d`。继续独立审计，不把待答当阻塞。

调研后更新：已找回 FLY-2107 原始 stderr 与 transcript，main arm 的 PID 相等而 socket/main 探测失败；详细证据与 hash 见 research.md。Lead 确认隔离单 FLY-2454，并通过 question `c80a599e-0a9f-464b-80fe-d85c2fa17c75` 接受诊断先行、台架安全后复现、根因代码前增量设计评审；不要求 design 越权取得 body 退出证据。

## 三种方向

1. **推荐：修复已证明的启动输入失配，保留严格校验并补失败诊断。** 从真实日志确认最早失败项；对该生产代码路径写失败回归；按原本成功 stdout 合同返回。收益是恢复真正可用的房，且下次可直接定位。代价是必须区分启动器、拓扑、应用收件三个阶段。
2. 增加等待时长或跳过 topology。拒绝：没有 PID/socket 的长期早退不会因加时自行恢复；跳过还会把失联 Lead 当成成功。
3. 用 `--no-lead` 或替换成另一种载体。拒绝作为验收：Bridge-only 能支持部分研究，但不能证明本单要求的 slot Lead 收件；切换载体会隐藏原故障并扩范围。

## 设计必须保留的约束

- canonical projects 是 Lead 身份唯一来源；不得把 token 放入 manifest、日志或 HTML。
- 主 Lead 与 extra Lead 复用同一函数，诊断须带具体 slot/agent/label，不靠显示名做身份判断。
- 已有 Codex 载体与 Claude 载体不能混用 readiness 判据。修复 Claude 路径时保护 Codex 的现有合同。
- topology 成功仍要求 launchd PID = manifest PID，且同一私有 socket 的 `main` 会话可访问。HTTP 200 不能替代此条件，PID 存在不能替代收到消息。
- 失败诊断必须在清理前取证；采用字段白名单，不透传 `.env`、完整 plist 环境、manifest launchEnvironment 或未净化日志。
- 本单不修拆房隔离漏洞。在配套隔离修复证明成立前，QA 必须先审查起房的 stale-reclaim、失败 trap、正常拆房全部出口；任何可能触及非 slot 进程的路径不可在这台生产主机上执行。可等待依赖或使用隔离主机，不能用忽略安全检查凑验收。
- 不修改生产部署状态、launchd 任务、全局 tmux、生产 bot 身份或生产告警通道；合并与 updater 部署继续分离。

## 成功证据的层次

1. 主因证据：相同 QA 参数、干净 main 的精确 SHA、stderr 和最早 wrapper 错误，明确它在 launchd/plist/PID/socket/应用哪一层。
2. 自动化证据：真正执行生产 helper/wrapper 的失败与修复对照；负路径错误点名具体项；成功 stdout 不变；无凭据外泄。
3. 真机证据：修复 head 的完整启动、健康 200、Lead 身份与在线证据、唯一测试消息的发送和消费关联、完整拆除及非 slot 对照。
4. 集成证据：当前 main 可干净集成、最终 PR head 的 CI 绿。零表格 ship report 保留可重跑命令、起拆用时、限制和回滚界线。
