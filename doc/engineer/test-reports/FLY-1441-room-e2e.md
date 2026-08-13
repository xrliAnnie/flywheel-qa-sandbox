# [docs][FLY-1441] 529 房内 Discord E2E 房测报告(第八轮接力段,PARTIAL)
Issue: FLY-1441 · PR #690(head a883a51c 冻结)· 房 = slot 1 bridge @19871 · 2026-07-23
执行:runner 911c9d34 · master token 走房内 Bearer(七轮排障终解)· 全部证据 = slot DB 只读(`?mode=ro`)+ bridge.log + Discord API(TEST_BOT_TOKEN_1)

## 结论一览

| 断言 | 结果 | 证据 |
|---|---|---|
| A. pre-Gate 静默(到终点 Gate 前零 ship 呈现) | ✅ PASS(双 run 样本) | run#1 `1c52bdb0`(FLY-135)implement/qa 阶段实查:0 holder / 0 evidence 行 / 0 ship_ready 事件 / 整房无 CommDB question 文件 / thread 1529988492560433262 全程只有阶段状态消息;run#2 `bbeefc69`(FLY-202)同样(qa verdict 故意未提交,长驻 pre-gate 样本) |
| #690 `ship_parked` 生命周期 | ✅ PASS | implement 完成(route=needs_review)→ session **ship_parked**(非 completed 非 awaiting_review);QA 期间零「待批」语义、零 gate_timed_out;`evidence.headSha` → `sessions.pr_head_sha` COALESCE 持久化实测成立 |
| B-unbound 分支(合同内 fail-closed) | ✅ 行为符合设计 | run#1 qa PASS → 同秒 claim→gate_opened→holder(runner_ship/git_head/**unbound**;evidence 子表 1 行 qa_passed,head 与 holder 一致)→ materializer 冻结 question_intent → **零 question 零卡(founder 静默正确)** |
| epoch=1 scanner 让位 | ✅ PASS | 两 run 全程 `ship_ready_*` 事件 = 0(旧通知器对 holder 世代零发射) |
| qa_fail kickback + H2 同 exec 复用 | ✅ PASS(意外活体) | run#3 真 Opus QA runner 自发 FAIL → loop_iteration 记账 → implement attempt2 复用同一 execution 65ab0f4f,session 未被 terminalize(ship_parked 保持)—— R2-H2 合同实证 |
| B-bound / C(Chrome-as-Annie 批准)/ D(唯一性)/ land 线 / ④看门狗 | ⛔ 未完成 | run#3 `019eabcc`(FLY-136)bound 正路驱到 qa attempt2 时楔死(下述),接力点见 `~/.flywheel/qa-handoffs/RESUME-fly1441-room-e2e.md` |

## 真发现(需 Lead 定级,均为 #690 交付面)

1. **`rebindWorkflowGateCarrier` 无暴露面**:StateStore 原语齐全(26598,receipt 表+原子事务),但全仓零调用方 —— 无 HTTP 路由、无 CLI(对照:loop-reentry 有两段路由)。unbound holder 的修复路径在生产形态不可达。
2. **unbound 零 Lead 告警**:`gate_carrier_unbound` 只写 run 事件,workflow_alert_outbox 零行 —— 设计合同(R4:unbound → fail-loud 告警 + rebind 指引)未接线。#1+#2 合并 = unbound holder 是静默永久搁置(founder 静默是对的,但 Lead 也不知道)。
3. **head 字段易踩坑**(文档级):completion 的 head 只认 `payload.evidence.headSha`(event-route:708-714);`pr_head_sha` 键静默忽略 → 绑定必失败落 unbound。建议在 complete 合同文档/错误信息中明示。

## 楔死记录(诚实边界)

run#3 驱动到 qa attempt2 时:qa/1 的真 Opus runner(已出 verdict)仍在 worktree 乱动 → 我 kill 其进程防 head 漂移 → 撞上引擎对该 exec 的 retest-wake 语义 → qa/2 新 exec `5a974b0a` session 直接 `failed`、dispatcher 循环 `engine_execution_dead`、3 分钟无自愈。**此楔为我的操作诱发**(kill 时点选错),非 #690 缺陷;解楔需 Lead 侧处置或新棒重驱(接力单含完整命令底稿)。

## 房内环境发现(限制节)

- **stale tmux 同名壳挡 runner spawn**(3 次复现:FLY-135 implement / FLY-136 qa×2):旧 cmux session 存在时新 runner 不出生,Bridge capture 对 `runner-test-slot-1:pending` 空转 + IdleWatchdog 误报 idle。房测前应清同名旧壳。
- slot 1 role=cos(交接单已报 Lead;断言测 Bridge 侧物化+卡+绑定,与 Lead role 正交)。
- credential 明文只在 runner 进程 env(`ps eww <pid>`),hash=纯 sha256(已对照验证);sql.js 库外部写会被覆盖,只读查询必须 `?mode=ro`。
- RoundtableThreadManager 在房内持续 Discord 429(轮询限速),噪音不阻断。

## 交接

续跑指引(bound 正路 B/C/D、land 线、④)全在 `~/.flywheel/qa-handoffs/RESUME-fly1441-room-e2e.md`(含命令底稿、head 字段合同、activation payload 形状、credential 提取法)。护栏全程遵守:不碰生产、不 merge、不 ship;#690 冻结 worktree 未动(本报告在独立 docs 分支)。
