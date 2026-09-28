# FLY-2965 班车与窗口核对解耦 — 实施验收证据
Issue: FLY-2965 (https://linear.app/geoforge3d/issue/FLY-2965/病根-定时班车-restart-servicessh-的非生产-tmux-残留只读审计对-tmpcmuxsock-跑-list)
日期: 2026-09-27
基于: plan.md, review-result.md

## 根因(实施后确认)

| 层 | 根因 | 修法(不是外加超时/告警) |
|---|---|---|
| ① 协议错配 | restart 的只读残留审计把「ppid=1、名字像 tmux 的进程持有的任意 Unix socket」当 tmux server,发 `tmux -S <path> -N list-sessions`;9-27 命中 cmux app 的换行 JSON 控制 socket `/tmp/cmux.sock` | 整段审计、其 `tmux-qa-residue-flywheel-session` 告警与 `FLYWHEEL_TMUX_AUDIT_ALLOWLIST` 退役(旋钮墓碑 FLY-2965)。它从不参与部署/回滚授权,也从不清理进程 |
| ② 结束条件依赖外部进程 | `_tmux_rescue_bounded_exec` 用管道收输出并等 EOF;tmux 客户端经 SCM_RIGHTS 把 stdio 交给对端,对端不放手时杀掉客户端也结束不了 probe(设计期 `protocol-repro.json`:1s 预算实测 3.154s,直到人为关对端才返回) | 匿名 0600 文件捕获(显式绝对 TMPDIR 或 /tmp,立即 unlink),以受管子进程被回收为结束,按回收瞬间 fstat 长度 `os.pread` 回放;捕获/启动/回放基础设施故障统一 125 |
| ③ 可见性核对昂贵 | 1051s 不是在等 cmux 事件:17 个 Lead 每个都跑一次含两次全舰 surface 枚举的单目标核对(每批 2·N·W 次 cmux 调用) | cmux-sync 新增 `--verify-agents-visible`:每次采样只读一遍全舰,逐目标沿用原判据;barrier 每批先逐 Lead 证 carrier,再对通过者一次共享 cmux 证明,只重试未收敛者 |

实施中新发现的一个潜伏缺陷(同属②):旧 wrapper 在子进程已退出后 `killpg`,macOS 返回 EPERM,Python 以默认 rc=1 崩溃 —— 对 `has-session` 调用方而言正是「session 不存在 → new-session」的误读。新实现容忍 `PermissionError` 且基础设施异常只给 125(下表 B2 的 RED 输出即此崩溃)。

## 验收矩阵(plan Chunk 4)

| 用例 | 执行 | 结果 |
|---|---|---|
| A 协议错配负例 | `tmux-server-rescue-fd-escape.test.sh` 真 tmux 客户端对「收描述符但不说 tmux」的私有 Unix socket;`test-restart-services.sh` 1b:真实 restart 全流程挂真 listener + ppid=1 假 tmux server 持有该 socket | 修前(RED):restart 对该 socket 发了 `lsof -a -p 777777` 与 `tmux -S <sock> -N list-sessions`;修后:零 lsof、零 `tmux -S`、listener 零连接,部署照常完成 |
| B 输出 fd 逃逸 | 同文件,peer 用 `recvmsg(SCM_RIGHTS)` 扣住 stdout/stderr,真实 `tmux_rescue_probe` | 修前:超时用例 8.16s(等 peer 释放)才返回;已退出子进程用例 Python 崩溃 rc=1;真 tmux 8.16s。修后:peer 仍持有描述符时 probe 已返回(124 带部分输出 / 0 带子进程输出) |
| C 正常与错误输出 | 同文件 | 非零码/信号 128+n/空输出/stdin=/dev/null/NUL 二进制/8 MiB/超时部分输出全部保持;peer 持续追加时只回放固定长度前缀 |
| D 完整班车模型 | `test-restart-services.sh` 2a:真实 `restart-services.sh` 主流程(外部 seam 隔离) | 共享 cmux 证明开始时 deployed-sha 已是新 HEAD、普通 admission 已 resume;成功清 marker、锁释放。批次超时:代码仍部署、派工已恢复、Lead 记 visibility-unproven、marker 保留、状态 degraded、锁释放 |
| E 真失败负控 | 既有 FLY-1655 stale Bridge identity、no-voice-bridge、admission-pause 用例 | 仍不推进 deployed-sha / 仍走原失败路径(全绿) |
| F rollback 与部分失败 | `rollback-r4.test.sh`、`restart-services-admission-pause.test.sh`、barrier 单元用例、顺序断言 | carrier 失败/缺窗/未知分别计数,cmux 缺席特例与 marker 语义不变;首次 resume 失败 → 诊断后补试成功(2 次调用)/ 再失败留给 TTL(恰 2 次、无循环);rollback 顺序 Lead→voice→resume→barrier→守卫补试;cutover owner 由 `ADMISSION_PAUSE_RELEASE_ON_EXIT` 守卫不释放(静态断言 + `resume_admission_best_effort` 自身拒绝) |
| G 独立窗口核对 | `test-cmux-sync.sh` 新增 5 例(mock cmux/tmux) | pass/fail/inconclusive 逐目标独立;权限不可用、subject 漂移只影响本目标;全舰读失败每个目标各得一条 inconclusive;参数错误零 cmux 调用。529 真机核对留给 QA |
| H 非生产完整路径 | 同 D(不是 `--dry-run`) | 通过 |
| I 下一班生产 | 独立 updater 自然窗口 | 待观测(本节点不重启生产) |
| J 调用计数与收敛 | cmux-sync 计数用例 + barrier 单元用例 + 本机生产只读实测 | 17 目标:W=10/100/200 时每批 birth 枚举 20/200/400 = 2W,read-screen = 2×live(20/34/34)(R0 本地实测;QA 返工后 CI 用例保留 W=10/30 两档以守 Script D 容量,见 qa-rework-1-disposition.md);首批全绿恰 1 批、carrier 34 次、批次预算 240s;迟到收敛第 2 批只重判该 Lead 并清失败;先 confirmed fail 后 unproven → 仍 fail;末轮 carrier 漂移拒绝 pass;超时/截断/不支持/缺项/多项/重复/rc 冲突/缺 report/report 非数组/多文档全部 unproven、不回退逐 Lead 扫描;挂死批次由 bounded-run 终止(rc=124)。真实耗时见下「生产只读实测」 |
| K refresh 寿命 | 代码审读 | 后台 refresh 在 5s/10s 后启动;新 barrier 最少含 carrier 双采样(间隔 5s)+ 批次双采样(间隔 5s)再加后续收尾,寿命仍覆盖;launchd 清理形状下的真机确认留给 QA |
| L 捕获安全 | fd-escape 用例 | 共享偏移不被移动;TMPDIR 缺失/不可写/相对路径均 125 且子进程未运行;无 cwd 回退;捕获文件 0600、子进程运行时已 unlink、无残留 |

## 生产只读实测(Lead 批准,question 6ee103dd)

条件:各只跑 1 次、外套 `timeout 120`、严格只读(不取 mutator lease、不 reap/关窗、不对 `/tmp/cmux.sock` 发 tmux 协议)。2026-09-27 14:21–14:22 PDT,本机。

| 命令 | 负载(load avg 1/5/15m) | 结果 | 耗时 |
|---|---|---|---|
| worktree `flywheel-cmux-sync.sh --verify-agents-visible` × 17 个生产 Lead(与班车候选同一 17 个) | 15.84 / 10.97 / 12.72 | rc=0,17/17 pass | **70.7s** |
| 生产主仓 `9262c8dae` 原脚本 `--verify-agent-visible --target flywheel-flywheel-eng-lead`(旧单目标,对照) | 9.88 / 10.24 / 12.28 | rc=0,pass | **38.4s(仅 1 个 Lead)** |

读法:旧路径每个 Lead 一次就要约 38s(两次全舰 surface 枚举),9-27 班车 17 个 Lead 4 路并发加重试实测 1051s;新入口一次核完 17 个用 70.7s,且当时负载更高。这只是 cmux 半边;班车 barrier 另有逐 Lead 的 carrier 双采样(4 路并发,每批约 6s)与末轮 carrier 复验,整段预计 2–3 分钟量级,待下一班定时班车实测。

## 未完成与交接

- **I / K / 整段 barrier 真机耗时**:按单子规定等下一班定时班车与独立 QA。
- **I / K 真机项**:按单子规定等下一班定时班车与独立 QA。
- `tmux-server-rescue-real-tmux.test.sh` 在本机高负载时基线与补丁都会偶发失败(7 轮对照:基线 1 次失败,补丁 0 次;另有高负载时补丁 2 次失败),属既有负载敏感抖动,见 test-selection.md。
