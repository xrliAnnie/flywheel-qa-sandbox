# FLY-1071 收尾状态 — implement phase 交付边界

日期: 2026-07-09
基于: plan.md(同文件夹);Tadashi 当晚两次裁定(CommDB f81f1fa6 / 275f4845)

## 已完成(证据全在本文件夹)

| 项 | 状态 | 证据 |
|---|---|---|
| Task 0 前置核对 | ✅ | task0-*.txt(负载门触发过一次,10min 复查回落后继续) |
| Task 1 W5 修复 | ✅ | frontmatter 根因修复(identity.md,commit 04878b8c)+ 手补安装;fresh start 15:53:12 起 43min 零 crash(修复前 64 轮连崩);task1-w5-recovered-{log,pane}.txt |
| Task 3.2 W5 逐层验证 | ✅ 4/4 | task3-w5-verify.txt(活 pid / window 活 pane_dead=0 / pane 跑 claude CLI / log 无新 crash) |
| Task 4.1 探针①(正向 @claw) | ✅ | msg 1524918656428019753;pane 17s 收到 inbound;claw 按防刷屏纪律用 ✅ react 应答(API 核验);task4-probe1-* |
| Task 4.2 探针②(负向无 mention) | ✅ | msg 1524919889872031796;133s 观察:pane 零痕迹、频道零回复、零 reaction;task4-probe2-* |
| Task 5.1-5.3 Send 收紧操作卡 | ✅ 已交付 | task5-send-tighten-card.md;Tadashi 已 relay Annie(手机可操作) |
| Task 6.1 演练脚本 | ✅ 备好未跑 | task6-drill-fire.mjs(preflight 三道门:env 指针 / routing+tickets / owner 等效渲染必须恰好=claw);运行被 W4 前置门挡住 |

## 递延项(Tadashi 裁定:W4 今晚不强推,排到 Annie 下次在机器前的裸终端窗口)

W4(codex-infra-bot-lead)stop/start 需 launchctl,FLY-913 护栏对 runner 和 Lead 一视同仁地拦,
护栏指定路径 =「由人工在裸终端处理」→ 归 Annie。W5 已活着处理工单,W4 挂着不阻塞关键路径。

| 项 | 前置 | 现成执行物 |
|---|---|---|
| Task 2 W4 fresh login | Annie 跑 handoff stop | task2-w4-launchctl-handoff.sh(stop/start 两步);login 顺序纪律见 plan Task 2 |
| Task 3.1 W4 verify-windowed-lead | Task 2 | 命令在 plan Task 3.1(5 层只读,期望 5/5 PASS) |
| Task 4.3 探针③(@Codex 不串) | Task 2 | **TODO 待 W4 修复后跑**:同探针①的加固 curl 模式,content 带 <@1523219324561522831>;判据 = W5 pane 无处理 + W4 pane 出现 inbound(一帖双侧) |
| Task 6.2-6.4 演练运行 | Task 2 + 探针③ | bash -c 'set -a; source ~/.flywheel/.env; set +a; node task6-drill-fire.mjs'(脚本自带拒发门);五点验证 + 硬证据边界见 plan 6.2/6.3 |
| Task 5.4 收紧后回归探活 | Annie 完成 Send 收紧(Tadashi 会通知) | 同探针①格式,标「收紧后回归 可删」;dispatcher 200 + claw 正常收 |

## 只报不修(Tadashi 各记 follow-up,plan 已批边界)

1. codex-infra 的 alertChannel=1523499324573749249(私有频道)与 C6 §4「应指统一 Alerts」偏差(FLY-871 家族遗留);
2. FLY-513:全局 codex symlink 解析进 ~/.codex-infra-bot,updater churn 风险(wrapper 每轮 WARN,含 ln -sfn 修复指引)。

## 本 PR 为何现在开(不等 W4)

W5 修复的 durable 落点 = 本分支 identity.md 随 PR merge → 生产 git pull。在 merge 前,修复只存在于
手补的 ~/.claude/agents/ 副本;wrapper 进程一旦重启(launchd 重拉)会用生产 main 的**旧源**覆盖手补,
crash-loop 立即回归。尽快 merge 是收敛该风险的唯一途径(exploration §3 方案 A 原文风险项)。
W4 递延项全部是 ops 动作,不含任何 repo 改动,不受本 PR 边界影响;执行物(handoff 脚本/演练脚本/
探针③配方)已全部随本 PR 落盘,任何会话按本文件即可续跑。
