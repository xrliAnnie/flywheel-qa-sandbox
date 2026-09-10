# FLY-2456 真机演练发现(非路书缺陷,进 drill-report)

## F1 slot 体内的 codex daemon runtime 把停体记录写进生产 kill-ledger(R1 @ main, attempt 7)
- 生产 `~/.flywheel/kill-ledger/20260910.ndjson`(及 state/ 镜像)含 execId=1fda8b28(slot-4 的 precondition 会话)的行:15:15:53.127Z SIGTERM pgid 45645 `daemon_group_signal` + 15:15:53.132Z SIGTERM pid 45645 `daemon_child_signal_fallback`;15:26:20.943Z SIGTERM pgid 64375 / 15:26:24.103Z SIGKILL pgid 64375 `daemon_group_signal`。
- slot 自己的账本(qa-evidence/slot-4/20260910T152625Z/kill-ledger)只有 Bridge 侧 adapter 写的 15:15:41/51 pgid 45645 与 15:15:52 window close;两者时间戳不同 = 两个写者。
- 目标 pgid 45645(precondition 体)与 64375(slot 的 `codex app-server --listen unix:///tmp/flywheel-test-slot-4/state/cdx-sock/...`,ppid 40113)都是 slot 进程 → 本次无生产伤亡;但 runner 侧 daemon runtime 的 ledger 路径解析到了生产 state dir = env/state-dir 泄漏,与 FLY-2352/2174「test-slot 误伤生产 codex(env 走漏)」同族。写路径泄漏证明 runner 侧读的是生产环境;若目标 pgid 解析也走同一泄漏,就是 2352 的误伤路径。
- attempt 6 同形已证:生产账本含 execId=e8d35e7f(attempt 6 的 precondition 会话)4 行 — 14:54:47.838Z SIGTERM pgid 23411 + .842Z pid 23411 fallback;15:05:13.813Z SIGTERM / 15:05:16.904Z SIGKILL pgid 42471。两次 attempt 稳定复现,不是偶发。

## F2 拆房后 slot CommDB 被某组件按 slot 路径重建(R1 attempt 12)
- 16:42:20Z `test-teardown.sh 4` 完成;16:42:29.039Z `/tmp/flywheel-test-slot-4/state/comm/test-slot-4/comm.db` 重建,`mailbox_migration_meta`=mailbox_v1 completed_at 2026-09-10T16:42:29.039Z,25 张表全空。即 comm 包的 CommDB 打开器(带迁移)被某进程以 slot 路径调用。
- 已排除: 驱动自身(工具 readonly/fileMustExist)、生产 Bridge 日志无该 slot 字样、runner-stop-notify 日志 16:42 无行、生产停体账本 16:42 无行、projects.json 无 test-slot 项、strength-two 路由只探端口。
- 待查方向: 拆房后仍持有 slot env 的 runner 侧一次性进程(PRE 体 d8c77f87 的 daemon/notify 链)在退出路径上打开 CommDB;或生产 Bridge 某周期任务遍历 `~/.flywheel/test-slots.json`。
- 处置: 驱动 #9 守卫归档+清除;证据 `r1-aborted-20260910T1630Z/late-residue-*/`。

## F3 slot Bridge 的 workflow_engine_escalation 告警文件写进生产 alerts 目录(R1, 17:14–17:30Z)
- `comparisons/alerts-live-after.json` pollution=9:`alert-deadletter/2026-09-10T17-14-04-{118,236,250}Z-flywheel-test-4-workflow_engine_escalation.json`、`17-19-04-{117,194,205}Z`、`17-30-38/39-{979,074,086}Z`,leadId=flywheel-test-4(slot 的 Lead id),classification=managed。基线里已有 3 个同 leadId 的历史文件(mailbox_dead_letter ×2、login_expired ×1,来自更早的 slot 轮次)。
- 含义: slot Bridge 的告警死信路径解析到生产 `~/.flywheel/alerts/`,与 F1(runner 侧账本路径)同族但在 Bridge 侧——slot 隔离对「告警/死信」目录不生效。本次无生产伤亡,是写路径泄漏。
- 处置: 进 drill-report;修法方向=alert outbox/dead-letter 目录随 FLYWHEEL_STATE_DIR 隔离(与 2174/2352 的 env 隔离同一修)。

## F4 R1 认回结果(修前 main, HEAD d6cda1fc)
- 有资格体 0/2:B1(8798137e,woken 体)与 B2(316a116c,running 体)在 cycle 1/2 后 sessions.status=failed,last_error=`Codex recovery exhausted after 2 attempts`;slot 日志:B1 `workflow capability drift`,B2 `immutable launch snapshot does not match rehydrated context` → `recovery owner failed before commit`。换体情况分两种:B1(woken 体,有在途返工)在 cycle 1 后 11 分钟(17:26:50Z)走返工路径 `rework_delivery_replacement_pending → execution_dead_rolled_back → rework_replacement_materialized` 铸了替身;B2(普通 running 体)exhausted 后**没有换体**(无 successor)。即 FLY-2352 标题的「换体」只对有返工在途的体成立。B3(0c1c8174,ship_parked 非 holder)`reown_skipped_not_turn_holder`(reason turn_holder_changed_before_recycle),符合预期的阴性对照。
- 路书分类器把三具都判 other(B3 有 reown_skipped_not_turn_holder 事件却未判 skipped_not_holder;B1 预期 replaced 但 main 根本不换体)= 分类器缺陷 #15,不影响上面的事实读数。

## F5 R2 认回结果(修后 main⊕#1128, HEAD 85d516e6c)——#1128 单独不能让真机重启后的 Codex 体认回成功
- 有资格体 0/2(与 R1 相同)。`final-observe.json` capabilityDriftEvents=0(R1 的 `workflow capability drift` 在修后头上消失——#1128 的直接目标达成)。但 B1(3835df15)与 B2(8914c4c2)在 cycle 1 后 `reown_revive_started(attempt 1, liveness alive, gateHeld)` → 秒级 `reown_revive_failed reason="recovery owner failed before commit"`;attempt 2(17:45:10Z)时体已 absent(adapter 在 attempt 1 失败后关了窗)→ 再失败 → 17:50:10Z `episode_exhausted`,sessions.status=failed(B2 `Codex recovery exhausted after 2 attempts`,B1 `zombie: tmux window runner-test-slot-1:pending dead`——woken 体的替身窗口从未绑定)。B3(ship_parked 非 holder)正确 `skipped_not_holder`。
- 空白: 「recovery owner failed before commit」的上一行原因(R1 为 `immutable launch snapshot does not match rehydrated context`)在 R2 未被捕获(#17,slot 日志随拆房丢失)。因此只能陈述:修后头仍在 recovery owner 提交前失败,是否仍是 launch snapshot 不匹配**本轮未验证**。
- 对 FLY-2352 卡的含义: 合入 #1128 只去掉 capability drift 一个症状,重启后在飞 Codex 体仍全灭且不换体;要让认回成功还需第二处修(recovery owner 提交前的失败点)。建议 founder 不以「修好了」为由按卡;可以按「去掉一个症状」为由按,但要知道结局没变。
