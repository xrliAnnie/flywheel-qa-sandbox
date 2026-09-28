# FLY-2965 班车与窗口核对解耦 — 调研
Issue: FLY-2965 (https://linear.app/geoforge3d/issue/FLY-2965/病根-定时班车-restart-servicessh-的非生产-tmux-残留只读审计对-tmpcmuxsock-跑-list)
日期: 2026-09-27
基于: exploration.md

## 结论与证据强度

| 发现 | 判定 | 依据与限制 |
|---|---|---|
| 把 cmux 控制端点当 tmux server 查询 | 已证代码路径错误 | restart-services.sh:748–837 把 lsof 所有 n/ 路径转为 tmux -S，未证明监听协议；事故日志明确记录 /tmp/cmux.sock |
| cmux socket 所属 | 当前已证 | lsof PID 97815，txt=/Applications/cmux.app/Contents/MacOS/cmux；ping rc=0、0.183s。原 PID 50474 已无 lsof 结果；不能回推事故瞬间 owner |
| 64360 是 tmux 子进程 | 推翻 | Lead 原始 ps 记录表明它是 Python - 3 tmux… 包装器，存活到 08:50:44；被 TERM 的是 Python |
| 根本没 timeout | 推翻 | 975822f 的 restart 文件 hash 与当前受管文件一致；helper 的 communicate(timeout=timeout) 已存在，超时后 killpg，再无期限 communicate() |
| 包装器为什么可以超过时限 | 本机真 tmux + 协议模型已复现 | evidence/protocol-repro.py：tmux 向健康行协议服务器发二进制数据及 2 个 SCM_RIGHTS 描述符；客户端退出 -9 后管道仍开；释放服务端描述符才 EOF；1s wrapper 用时 3.154s，随人为关闭对端才返回 124 |
| 事故当时 cmux 内部栈 | 未证明 | 无 sample/spindump，不能说主线程锁死或 I/O 死锁；当前 ps 在 Runner sandbox 返回 Operation not permitted。无需为证明已知错误再次向生产 socket 发 tmux |
| 可见性额外等待 | 已证调用拓扑与时间 | 09:02:58→09:20:29=1051s，17 候选；4 并发、1320s deadline、多轮重试、成功项再 carrier 校验；949s 是某批剩余预算而非 cmux 实际响应时长 |
| 同步器历史问题的关系 | 有放大路径、无同因证明 | FLY-2652/2656/2770/2829 是历史节点补建、账本和窗口数量问题；窗口越多全局查询越贵，但不能据此断言此次 9h 是同一死锁 |

SCM_RIGHTS 是 Unix socket 传递文件描述符的机制：对端可持有客户端输出管道的另一份引用。EOF 是“所有写入端都关闭”的信号，不等于子进程已经退出。模型主动用 recvmsg 持有描述符以确定性复现管道所有权逃出子进程组；这不是事故 cmux 接收实现的逐字复刻。旧 wrapper 以管道 EOF 判断收尾，恰好把外部 peer 的生存期带回探测关键路径。

外部协议来源：[cmux 官方 CLI 文档](https://cmux.com/docs/api)，2026-09-27 核对：/tmp/cmux.sock 是 app 控制入口，接受以换行结束的 JSON 请求，不是 tmux 协议。仅用于协议事实；事故判断以本机日志与 Lead 原始记录为准。

## 事故记录与有效载体

Lead 回答 question 636563a8-8c87-4f98-a0c1-112fd7487174：
- 07:27:45Z：64318 ppid=64317，restart-services；64360 ppid=64318，Python - 3 tmux -S /tmp/cmux.sock -N list-sessions。
- 09:19:53Z：64360 etime=02:18:46；15:51:51Z：etime=08:50:44。15711 为 update-flywheel。
- 15:54:42Z founder 指令下 TERM 64360，班车继续。没有抓取 64360 的子进程或堆栈。
- 当前受管 restart SHA256=e55a3de1abd037aa926cbc62651e58d405a9eb6ab19f2bad972e7ff6011b51d0，与 git show 975822f5d:scripts/restart-services.sh 一致。helper 按 FLYWHEEL_RUNTIME_DIR/scripts/lib 路径 source；无法证明当夜启动瞬间的 helper hash/环境。

日志节选在 evidence/incident-log.txt。该记录将“代码错误可复现”与“事故内部状态未捕获”分开，不声称掌握缺失的现场堆栈。

## 可见性为什么昂贵

scripts/lib/agent-visibility.sh:567 起：先两次 carrier 证据，间隔 5s；再 run_verify_agent_visible。后者再次间隔 5s，执行两次 _verify_sidebar_once(target,durable)。每次读取全体工作区、cmux_attach_birth_records，并对每个工作区调用 list-pane-surfaces，再核验目标的真实 pane、客户端、屏幕与回执。每个目标都会重做全局扫描。restart 将此按 4 个一批覆盖 17 个 Lead，失败/不确定项重试至公共 deadline；它并非“被一个 cmux view 事件唤醒的等待”。

FLY-2643 已实测成功尾延迟 84/88/91/121/158s；现有 240s 子预算和 1320s 整批预算是在承受重复成本。R1删除证明方案已因7/17巡检覆盖缺口撤回。R3保留全部候选，每批共享两次采样、逐目标判断；按R2评审证据保留必要收敛重试，仅未pass目标进入后批。先记录代码/恢复普通派工，锁仍等既有预算内诊断。

## 现成替代责任与消费者

- scripts/lead-patrol-snapshot.sh:460–506 已对所属 Lead 执行 visible 核对，生成 LEAD_VISIBILITY，fail→FINDING-CANDIDATE，inconclusive→UNAVAILABLE。不以 carrier pass 冒充 visible。
- packages/teamlead/src/bridge/lead-patrol-registration.ts / lead-patrol-config.ts / lead-patrol-snapshot.ts 接入既有巡检，pin 源码并在部署根调用。设计不另起后台进程、不增加队列、不增加频道消息。
- cmux watcher 已有独立收敛和恢复责任。restart 保留它的受管重启及已有 refresh；本单不放松窗口必须真实可见的产品合同。
- do_restart_all_leads 的启动、配置、token、carrier 结果仍决定 Lead 启动健康，不能被“以后巡检”吞掉。
- rollback 路径也调用同步 barrier，必须同改；否则出错恢复仍会被同一窗口核对拖住。
- lead-restart-status.json 的 codeDeployedSha/leadsRestartStatus/failed/skipped/total 是既有输出。不得在移除可见性核对后把旧的可见性全绿含义沿用；R2保持原healthy包含visible语义，不新增R1字段。
- 只读残留审计从不参与部署/回滚授权，从不清理进程；删掉它不影响 QA teardown 已有的资源所有权约束，也不删除真正的 tmux rescue 能力。

## 最小主义取舍

1. 删除部署无权解释的外部协议查询，不添加 cmux.sock 特例 denylist（自定义路径会绕过）。
2. 修已有 Python 收尾的管道生命周期错误，不叠新 watchdog、不调高/调低生产时限。
3. R2保留全部visible复核，批次共用两份采样。部门巡检只作补充。拒绝简单在 barrier 后加 &：旧 sidecar、父进程清理、launchd 生命周期与 admission 所有权会形成新问题。
4. 暂不改 cmux app、不做 watcher 大重构、不新建跨轮缓存、不加告警。

## R1纠正
claude-lead.sh:3228与lead-rules-bundle.sh:441证明仅dept进入patrol，7/17无该覆盖，事故3个都在其中。详见review-round1.json；R2不删复核、不改healthy含义、不删retry marker。

## R2评审补充：收敛等待不是重复采集

FLY-2643 plan147-149与restart barrier注释证明refresh的5s/10s后台调度返回不代表完成，首批subject_drift或暂缺视图不能作为最终失败。Lead问题6b8154c1-6b34-4c1c-a79d-7c2e3b667293明确撤回删除重试要求；R3保留pending子集重试、原1320s deadline及末轮carrier预留，只消除每个目标重复扫描全局的成本。restart_on_exit没有resume调用，R3新增的是诊断结束后仍有lease时再调原幂等resume一次，异常退出仍沿用TTL，不声称原来有EXIT恢复。
