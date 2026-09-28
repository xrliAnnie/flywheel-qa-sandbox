# FLY-2965 班车与窗口核对解耦 — 探索
Issue: FLY-2965 (https://linear.app/geoforge3d/issue/FLY-2965/病根-定时班车-restart-servicessh-的非生产-tmux-残留只读审计对-tmpcmuxsock-跑-list)
日期: 2026-09-27
基于: 无

## 当前裁定与范围
以 founder 2026-09-27 10:22 PDT 的根因修复裁定替换最初的超时/频道告警方案。本阶段只设计，禁止实现、重启生产、派后继、合并；生产验收等下一班定时班车。

## 已核对的事实
- worktree 基线 `636f427a6`；design TURN epoch=1，execution `d9a77fb6-c8fe-495b-a7bd-1e160c11e606`。
- 班车日志：00:01:06 后到 08:54:42 才记下 pid=50474 socket=/tmp/cmux.sock sessions=<unreadable>。暂停新任务始于 08:54:43；09:02:58 进入窗口核对；09:20:29 核对结束；09:20:30 写版本；09:20:56 恢复新任务。
- 当前 lsof 证明 `/tmp/cmux.sock` 属于 PID 97815 的 `/Applications/cmux.app/Contents/MacOS/cmux`；正确协议 ping 0.183s 成功。该结果不证明事故当时 app 健康。
- 审计从同用户、ppid=1、名称像 tmux 的进程枚举所有 Unix socket，然后对每个路径发 tmux list-sessions。持有某 socket 的描述符不证明它是 tmux 监听端点。
- `tmux_rescue_probe` 已有默认 3 秒包装；最初“无超时”的描述与源码不符。被杀的原始子进程及当时堆栈未保留，不能编造 wrapper 失效原因。
- 可见性 barrier 是 17 个 Lead、4 并发分批、1320s 总预算；每个目标执行两次含全局清单的核对。日志测得此阶段 1051s。不是每个目标真正需要等 949s，也不是已经证明 cmux 主线程死锁。

## 最小方案方向
删掉班车对未知协议端点的主动残留审计。它不提供停进程、部署或回滚的授权；保留现有 QA teardown 隔离责任。R1此处曾提出删barrier由巡检接手，现已撤回：7/17没有巡检覆盖。R3保留全体复核与必要收敛重试、每批共享两次采样，放在代码/普通派工恢复后，不建后台队列。保持部署身份、voice、Lead 启动和 admission owner 合同，窗口证明仍须实际核对，不能用 PID 健康冒充可见。

## 待研究
确认全局窗口读取代价、现有巡检调用与失败语义；复现错协议连接；核查事故 wrapper 的有效版本和证据限制；制定完整隔离班车验收与反例。
