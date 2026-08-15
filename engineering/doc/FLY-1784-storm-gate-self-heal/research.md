# FLY-1784 restart-storm gate 自锁无自愈 — 调研

Issue: FLY-1784 (https://linear.app/geoforge3d/issue/FLY-1784/infra复盘-restart-storm-gate-自锁无自愈-bridge-plist-keepalive-30s-使60s-内-3)
日期: 2026-08-15
基于: exploration.md

---

## 1. Gate 现状(`scripts/restart-storm-gate.py`,FLY-1501 W3)

stdlib-only Python(Bridge / Node / v2 kernel 全挂时仍可用),per-child 文件账本,`flock` 串行。

### 1.1 文件布局(`~/.flywheel/restart-ledger/`)

| 文件 | 内容 |
|---|---|
| `{child}.jsonl` | 启动事件账本,每行 `{"seq":n,"ts":ISO}`,seq 连续性强校验,坏行整本隔离到 `ledger-quarantine/` |
| `{child}.state` | 状态机,shape **严格校验**(`_validate_state`,`set(value) != expected` → `DataFailure`) |
| `{child}.lock` | flock 串行锁(默认 0.25s deadline → EXIT_LOCKED) |
| `{child}.controlled-waves.ndjson` | lead.* 受控换代审计(与本单正交) |

### 1.2 状态机(现状)

```
active ──(窗口内启动数 > max)──> held_alert_pending ──(告警 sent/queued_transient)──> held_alert_attempted
  ^                                                                                        │
  └────────────────────────── 人工 resume / arm-controlled-wave(唯一出口)◄────────────────┘
resumed ──(下一次 gate 调用规范化)──> active(last_resumed_seq 保留)
```

- 状态名只有 4 个:`active` / `held_alert_pending` / `held_alert_attempted` / `resumed`(`STATE_NAMES`, gate:46-51)。
- `_gate()`(gate:698-752):held 两态**短路返回 EXIT_HELD(3),不写 ledger** → refused 启动不计窗**已是现状**;`held_alert_pending` 时顺带重试 hold 告警。非 held:append 事件 → `_evaluate_brake`。
- `_evaluate_brake`(gate:651-680):`relevant = seq > last_resumed_seq AND ts >= now-window`;`len > max` → 写 `held_alert_pending` + 立即尝试告警。
- `_resume`(gate:922-960):held → `{"state":"resumed","last_resumed_seq":last_seq}` → 旧事件全部出窗。**没有任何代码路径自动调用它。这就是全部病灶。**
- 阈值 env:`FLYWHEEL_RESTART_STORM_WINDOW_SEC`(默认 600)/ `FLYWHEEL_RESTART_STORM_MAX`(默认 5)。生产 `.env` 无覆盖 → **600s / >5 生效**(issue 写的 60s/3 不成立)。
- exit codes:0=放行, 2=锁忙, 3=held, 4=invalid。wrapper 对非 0 一律不启动;**对 held 是 `exit 0`**(wrapper:192-194)→ launchd 按 ThrottleInterval 继续每 30s 重拉(= 自然的 gate 评估 tick,自愈机制可以白嫖)。

### 1.3 调用方(gate 的 child 面)

| child | 调用方 | 备注 |
|---|---|---|
| `bridge` | `flywheel-bridge-wrapper.sh:175` | 本次事故主角;plist `KeepAlive=true` + `ThrottleInterval=30`(实测 `plutil -p`) |
| `voice-bridge` | `flywheel-voice-bridge-wrapper.sh` | 同构 |
| `quota-monitor` | `flywheel-quota-monitor-wrapper.sh` | 同构 |
| `cmux-watcher` / `cmux-autostart` | `flywheel-cmux-autostart.sh` 等 | 同构 |
| `lead.<daemon_key>` | `scripts/lib/lead-restart-lifecycle.sh`(restart-services 波次) | 另有 `arm-controlled-wave`(预期换代不计窗);**held 同样只有人工出口** |

所有 child 都是 launchd KeepAlive 监管 → **自锁形态对全部 child 同构**。

## 2. 2026-08-14 当晚铁证时间线(修正版)

| 时刻 (PT / Z) | 事件 | 证据 |
|---|---|---|
| 23:33 | `launchctl submit` 重启风暴开始(雷 1,另单) | bus log |
| 23:35:21 (06:35:21Z) | 窗口内第 1 次启动(seq 165)= episode 起点。**此时 gate 未 held**,23:35–23:44 Bridge 被风暴本身反复杀/拉 | `bridge.jsonl` seq 165 |
| 23:35:51→23:44:32 | seq 166–170,间隔混合 30s(KeepAlive)与 2–4min(restart lock 串行的 wave) | `bridge.jsonl` |
| **23:44:32** (06:44:32Z) | **seq 170 = 第 6 次 > 5 → gate 转 held**。meta-alert 桌面+文件写成(marker mtime 06:44:32,正文 "crashed 6 times…run restart-storm-gate.py resume bridge") | `~/.flywheel/meta-alert/restart_storm_bridge.txt` |
| 23:44:33 | **Discord hold 告警投递成功**(unified alert channel) | claims.db:`restart_storm_hold … state=sent, attempt_count=1, 06:44:33Z` |
| 23:44–23:55 | wrapper 每 30s 被拉起 → gate EXIT_HELD → "not writing PID marker";**ledger 零增长**(170 之后无事件) | wrapper log + `bridge.jsonl` |
| 23:52 | Annie 手动 remove launchd job(风暴源头拆除)。**此后 gate 仍 held——无自愈** | 事故报告 |
| 23:55:1x | 人工 `resume bridge`(靠 8-13 事故记忆找到配方) | 事故报告 |
| 23:55:41 | seq 171 = resume 后首次放行,Bridge 起来 | `bridge.jsonl` + /health |

净结论:gate 判断全对、告警全通,**唯独 held→恢复这一步只有人工路径**;若当晚没人记得配方,Bridge 会无限 down。两周内第二次(8-13 FLY-1726 部署事故同形态)。

## 3. 告警链细节(自愈设计要复用的部分)

- `_attempt_hold_alert`(gate:583-622):meta-alert(`restart_storm_{child}`,10min debounce,桌面 osascript + 本地文件)+ `lead-alert.sh --kind restart_storm_hold --severity severe --signature {episode_key} --strict-delivery`。
- `lead-alert.sh`:**直连 Discord REST(不依赖 Bridge)**,claims.db 跨进程去重(signature → event_id),失败落 queue/deadletter。`--strict-delivery` 时 stdout 单行结果:`sent|duplicate|queued_transient|dead_lettered|config_error`;gate 认 `sent|queued_transient` 为「已尝试」。
- 路由:`--lead bridge` 无 per-lead 配置 → `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`(#flywheel-alerts)。
- **signature 语义对自愈的影响**:hold 告警 signature = `episode_key`(每个 episode 唯一 → 每次 hold 恰好一条,天然去重)。自动 resume 告警需要自己的 signature(如 `{episode_key}__autoresume__{k}`),否则被 claims 吞。

## 4. 兼容性约束(设计的硬边界)

1. **`.state` shape 不可扩展**:`_validate_state` 是 exact-set 校验。若新代码往 `.state` 里加字段,**回滚后旧代码读到新 shape → `DataFailure` → EXIT_INVALID → wrapper 不启动 Bridge** = 一次回滚炸弹。⇒ 自愈的记忆必须放**独立 sidecar 文件**(旧代码从不读它,回滚零影响)。
2. **状态名不可新增**:`lead-restart-lifecycle.sh:188-190` 用 jq 白名单校验 `.state ∈ {active,resumed,held_alert_pending,held_alert_attempted}`,新状态名会让 restart 波次把 gate 读成 `status_invalid_json` fail-closed。⇒ 自动 resume 必须复用现有 `resumed` 状态写法(与人工 `_resume` 同形)。
3. **status JSON 加 key 安全**:消费方(`lead-restart-lifecycle.sh`)用 jq 按名取 `.state`/`.ledger_seq`,additive key 不影响;仓内测试随改随更。
4. **exit code 语义不可变**:wrapper 分支按 0/126/127/其他 处理;自愈放行必须走现有 EXIT_OK 路径。
5. **hold 时刻可零 schema 推导**:held 期间 ledger 不增长 ⇒ **最后一条 ledger 事件的 ts == 触发 hold 的时刻**,天然持久、无需在 `.state` 里记 `held_at`。

## 5. 测试基建

`scripts/__tests__/restart-storm-gate.test.sh`(566 行 hermetic harness):fake `meta-alert`/`lead-alert` bin(`FAKE_LEAD_RESULT` 可控返回)、`run_expect` exit-code 断言、独立 `--root` 临时目录。**时间旅行手法**:直接向 `{child}.jsonl` 写入回填 ts 的事件行 + 手工放置 `.state`,即可让「hold 已过 N 分钟」在测试里即时成立;sidecar 同理。另有 `qa-fly1501-restart-gate-e2e.sh`(真 wrapper 面 E2E)可扩。

## 6. 退避参数论证

目标:探测要比人工快(那晚 20 分钟),又不能在真·crash-loop 下放大风暴。

- **base=300s(5min)**:首次探测在 hold+5min。当晚若已上线:23:49:32 首探(风暴未拆,≤3min 内再 held,梯子+1)→ 23:57 前后二探 → 风暴 23:52 已拆 → Bridge 起来,**比人工路径(23:55)同量级,且不依赖任何人记得配方**。
- **factor=2, cap=3600s(60min)**:5→10→20→40→60→60…。真·永久 crash-loop 稳态代价 = 每小时一次探测(每次 ≤ max+1=6 个启动,间隔 30s,约 3 分钟)+ ~2 条告警/小时。不设终态(理由见 exploration §4.3:终态=同病复发)。
- **stick window=1800s(30min)**:自动 resume 后 30min 内再次 hold → 梯子 +1;超过 30min 才 hold → 视为新故障,梯子归零。人工 `resume`/`arm-controlled-wave` → 删 sidecar(梯子归零,操作员意志优先)。
- 每个数字给 env knob(沿用 gate 现有 `FLYWHEEL_RESTART_STORM_*` 风格),默认值如上;**不加 disable 开关**(exploration §4.2)。

## 7. 残余风险

- **自动放闸放进一个正在删代码/换 build 的窗口**:restart-services 波次期间 Bridge 本来就会被 bootout/bootstrap,gate 对波次启动照常计数;自动 resume 最多让 Bridge 在波次间隙多活一段——与人工 resume 的风险同形,且波次有自己的 health gate。
- **sidecar 损坏**:按 ledger quarantine 同款处理(改名隔离 + meta-alert + 视为空梯子)。fail-open 到「更早探测」,风险被 hold 窗口本身封顶。
- **时钟回拨**:delay 判定用 `max(0, now - hold_at)`;回拨最坏效果 = 推迟探测,不会提前放行风暴。
