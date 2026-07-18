# Task 2 轨A Phase-2 — 真 slot Bridge 演练摘要

日期: 2026-07-11 · driver: scripts/qa-fly-1182-track-a2.sh · 结果: **13/13 PASS**(两轮连跑一致;完整输出 task2-a2-13checks.log;bridge 日志 task2-a2-bridge-*.log,selfheal 轮日志零 post 失败)

## 覆盖(需要活 Bridge 进程的项)

| 项 | 场景 | 结果 |
|---|---|---|
| #12 (2.10) | 真 flywheel-comm CLI account-rotation-notify → POST /events → account_rotation 文案真落隔离频道 | ✅ D1 |
| #14 服务端 (2.9) | /api/rescue 无 token → 401;quota kind + actorBackend claude → 403;unbound 目标 → 200 ok:false no_pending_quota_stuck_alert(准入守卫活的);**真 bot-claim /api/account-switch 在活 Bridge 进程内执行完整切换**(gen 1→2、scratch Keychain 真翻到 beta)+ 🔧 帖由活 Bridge 真发进隔离频道 + 文案带 FLY-1182 翻活措辞 | ✅ D2.1-D2.6 |
| #13 (2.11) | **真重启恢复**:Bridge 完全停掉后写 due pending → 全新 boot → watchdog tick 执行(gen 2→3) | ✅ D3 |
| #16 (2.12) | **dormant boot**(self-heal env 不设):/api/account-switch 与 /api/rescue quota kind 都 409 self_heal_disabled(单 flag 契约);全程零状态变更 | ✅ D4.1-D4.3 |

## 隔离面

- Bridge = 本 worktree 代码,slot-1 端口 19871、TEST_BOT_TOKEN_1、隔离频道 test-flywheel-alerts;
- TEAMLEAD_DB/STATE_DIR/COMM_DB/alert-queue/claims.db 全 slot 本地;account-heal 全套 scratch 旋钮(dormant 轮也设——皮带加背带);
- 生产 Keychain/状态/频道零接触。

## 排障记录(qa-report 素材)

1. **tsx IPC pipe EINVAL**:TMPDIR 在 runner-state 深路径下超 unix-socket 104 字节上限 → Bridge 子进程 TMPDIR=/tmp(已知环境坑,和 codex-lead-runtime TMPDIR 假失败同族)。
2. **Discord post 403(真 finding,环境级)**:生产 ~/.flywheel/.env 的 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN` 会被任何 source 过 .env 的父进程带给 slot Bridge → 单一 sender 链解析成生产 dispatch bot(不在测试频道)→ postToThread 403。**slot Bridge 必须显式 pin `FLYWHEEL_ALERT_SENDER_TOKEN_ENV=TEST_BOT_TOKEN_N`**。这也曾让首轮 D2.5 被频道里旧消息假绿——修后以 bridge 日志零 post 失败为准。529 Room 未来用房者应注意(写进 qa-report follow-up)。

## 与 module 轮(45/45)合并后的轨A 剩余

- 2.9 的 **LLM 侧**:由真 Codex InfraBot session(真 LLM)自主执行 claim→读账本→逐目标 rescue 的决策链 + 牺牲 session 被真翻活(close+resumed successor / lead kickstart)。
