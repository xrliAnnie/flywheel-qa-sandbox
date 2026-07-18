# Task 2 轨A — 隔离全链 QA 摘要(module-driven 部分)

日期: 2026-07-11 · harness: scripts/qa-fly-1182-track-a.mjs · 结果: **45/45 PASS**
(完整逐项输出见 task2-track-a-45checks.log)

## 覆盖(FLY-696 §8 编号 → 结果)

| §8 项 | 场景 | 结果 |
|---|---|---|
| #1 全链 | 真 cap fixture→parse→enqueue→watchdog→**真 scratch Keychain 切换**(security 读回)+ FLY-865 显示身份 + 账本 stamped + alert row 不 resolve | ✅ S1.0-S1.11 |
| #3 通知 | 🔧 记录 + 🟡 digest **真落隔离 529 频道**(Discord re-fetch 验证;digest 走真 postInfraNotifyDigest 路径) | ✅ S2.1-S2.2 |
| #4 529 不误切 | throttle-529-live fixture → 零 pending / 零切换 / keychain 不动 | ✅ S3.1-S3.3 |
| #5 双触发 | (a)双 Lead (b)Lead+Runner (c)bot-claim vs watchdog 跨 deadline 两幕 —— **恰一次 committed switch、generation 恰 +1**;watchdog-wins 后 late claim 拒(=409 形态)+ 账本相邻性放行 + 每目标救援 exactly-once | ✅ S4.1-S4.8 |
| #6 runner-only | 只 runner 观察 → 照切(runner 身份 metadata) | ✅ S5.1-S5.2 |
| #7 fail-closed | (a)活 holder 持锁→executor 上抛、tick 捕获、pending 保留重试、状态零变 (b)security 读回损坏→verify 拒→**回滚回 alpha**、store/.active 零变 | ✅ S6.1-S6.3 |
| #8 argv 零泄密 | 真切换期间 ps 采样(8 次)→ 假凭据 marker 零出现 | ✅ S7.1 |
| #9 ambiguous | gauge 模糊 → null → needs_human | ✅ S8.1 |
| #10 weekly | weekly 挑 weeklyResetAt 最近;both → weekly 主导 | ✅ S8.2-S8.4 |
| #11 全废 | needs_human + 最早 reset、profile bin **零调用**(绝不 re-login) | ✅ S8.5-S8.6 |
| #13 重启恢复 | durable pending 由"重启后"的全新 tick 执行 | ✅ S11.1 |
| #16 byte-compat | self-heal off → needs_human + 原文案、零 pending | ✅ S12.1 |

## 红线铁证(生产零污染)

- E.1 真 Keychain item hash 前后一致(1c5bbff8 → 1c5bbff8)✅
- E.2/E.3/E.4 真 claude-accounts.json / pending / .active 前后一致 ✅
- E.5 真 ~/.claude.json 的 oauthAccount(显示身份)前后一致 ✅(整文件 hash 因活 session 环境写入天然抖动,以 oauthAccount 块为准)
- fail-closed 硬闸:任何隔离旋钮缺失/落到 root 外/service 名等于生产名 → harness 拒跑(S0.1)

## FLY-1182 新机制的集成级验证(顺带)

- onSwitchCommitted → bindQuotaSwitch 在真切换流程中 stamped switched_generation=observed+1(S1.11)
- account_switch 不 resolve usage_limit alert row(S1.11)
- watchdog-wins 时序:late claim 拒 → 账本相邻性核过 → 每目标翻活准入 exactly-once(S4.6-S4.8)
- switched 文案 = InfraBot 翻活版(flag-removal 契约,S1.10)

## harness 首轮 6 个失败的分诊(全为 harness 自身 bug,引擎零缺陷)

1. S1.8:假池 identity 文件名/字段错(应 oauthAccount.json + 含 organizationName)
2. S6.1:锁 holder 用了死 pid + at 用 ISO 字符串(契约是数字 ms);且直调 executeSwitch 绕过了 watchdog 的 catch 层 —— 修正为生产形态(tick 捕获、pending 保留)
3. S6.3:stub 毒化了快照 → 改为只损坏目标凭据的读回(忠实模拟「写没生效」),回滚后正确回 alpha
4. S8.2/8.3:selectNextAccount 返回账号名字符串,非对象
5. E.5:整文件 hash 被活 claude session 的环境写入干扰 → 改为只核 oauthAccount 块

## 剩余轨A 项(需 529 Room slot Bridge + 真 Codex InfraBot session)

- 2.9 #14 bot 交叉互救真路径 + 翻活演练(牺牲 session)
- 2.10 #12 account-rotation /events 链
- 2.11 #13 的真 Bridge 重启形态(durable 语义已在 S11.1 证)
