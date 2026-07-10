# FLY-1081 三条通知路去 Simba 化 — 调研

Issue: FLY-1081 (https://linear.app/geoforge3d/issue/FLY-1081/fix-重启更新wrapper-三条通知路仍写死-simba-迁到-infra-botfly-915-痛点-3927-只迁了一条)
日期: 2026-07-09
基于: exploration.md

> Brainstorm gate 已过（Tadashi 2026-07-09 批 Option C），新增两条硬要求：
> ① `deploy_failed`（severe）必须 **@-mention Annie**（warning 级不 @）；
> ② grep-zero 精确化：`SIMBA_BOT_TOKEN` 全清，`DISCORD_BOT_TOKEN` 只在三条通知路里禁（它是 per-lead botTokenEnv 的合法通用默认名，不全局动）。
> 本调研的目的：把 Option C 落地需要的每个机制事实核清楚，让 plan 可以照着建。

## 1. 可复用面（全部已在生产验证过）

### 1.1 `lead-alert.sh` 的完整能力（FLY-83/182/927/929/954 叠加态）

| 能力 | 位置 | 对本 issue 的意义 |
|---|---|---|
| 接缝解析 + 拒回落 | lead-alert.sh:156-157, 242-258 | issue 点 1/2 的唯一实现，直接复用 |
| unified 双 env 时跳过 projects.json | lead-alert.sh:165-166, 223 | 系统级身份 `--project flywheel --lead <x>` 无需注册 lead（D4 先例） |
| claims.db 跨进程去重 + `--signature` | lead-alert.sh:260-320 | deploy 告警必须带分钟级 signature，否则默认按天签名会吞掉同日第二次不同故障 |
| 队列(transient) / dead-letter(permanent) 分级 | lead-alert.sh:338-395, 447-460 | 5xx/429/000 → queue 由 Bridge drain 重投；4xx/no-token → dead-letter + meta-alert |
| meta-alert 逃生（Discord-independent） | lead-alert.sh:136-142；meta-alert.sh（桌面 + `<state>/meta-alert/<reason>.txt`，每 reason 覆写 + 10min debounce） | 「fail-loud 但绝不静默」的兜底 |
| token 走 curl stdin config 不进 argv | lead-alert.sh:423-433 | 安全惯例，新调用方自动继承 |
| mentions 全抑制 | lead-alert.sh:423（`allowed_mentions: {parse: []}`) | ⚠️ 与硬要求 ① 冲突 —— 需要加 opt-in 旁路，见 §3 |
| `--strict-delivery` 机器可读结果 | lead-alert.sh:32-36, 59-63 | 本 issue 调用方不需要（通知失败不 block 部署），不用 |

### 1.2 kind 枚举的双面契约

- shell 侧：lead-alert.sh:105 的 case 白名单。
- TS 侧：`packages/teamlead/src/LeadAlertNotifier.ts:62` `ALERT_EVENT_TYPES`（`AlertEventType` union，payload.eventType 类型）。注释（:124,136）明确惯例：**shell 加 kind 必须同步 TS union**，否则 queue 里的新 kind 在 drain 侧是未知类型（无 runtime 校验但破坏共享类型面）。
- 先例：`bridge_wrapper_fail`（D4）、`bin_integrity_drift`（FLY-954）、`notify_digest_failed`（FLY-929）都是这么加的。

### 1.3 队列 drain 语义（Bridge 侧，决定 @-mention 的第二条路）

- `LeadAlertNotifier.drainQueue()`（LeadAlertNotifier.ts:692-850）：读 `~/.flywheel/alert-queue/*.json` → 解析为 `AlertPayload & {queueReason, queuedAt}` → 剥掉 queue 元字段后按原 payload 重投。**没有 eventType runtime 白名单**（malformed/aged/permanent-reason 三类才拦）。
- mentions：`sendDiscord` 的 `allowed_mentions` 只有两态 —— legacy `{parse: []}`（:887）或 unified+tickets 的 `{users: [ticket.ownerUserId]}`（:999，owner = infra bot，由 plugin 的 owner map 在 alert() 前算好）。**payload 里没有任何「@ 任意用户」字段** —— 即使 body 文本里写了 `<@id>`，drain 重投时也不会真正 ping。

### 1.4 例行通知路（FLY-929 W3b②，维持不动的部分）

`restart-services.sh:125-138 notify_routine()`：`CLAUDE_INFRA_BOT_TOKEN` + `FLYWHEEL_NOTIFY_CHANNEL` 双设 → claw-infra-bot 直发 #flywheel-notify；**任一缺失 → 静默回落 `notify_discord`（=Simba）**。要改的只有回落分支。

### 1.5 环境事实（生产，2026-07-09 实测）

- `FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN`（→ flywheel-alerts-dispatcher）、`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`、`CLAUDE_INFRA_BOT_TOKEN`（→ claw-infra-bot）、`FLYWHEEL_NOTIFY_CHANNEL`、`FLYWHEEL_FOUNDER_USER_ID` 全部已设。
- `DISCORD_BOT_TOKEN` 与 `SIMBA_BOT_TOKEN` 值不同、Discord 身份相同（Simba - Chief of Staff，`/users/@me` 实测）。
- 三个脚本都在任何通知路径前 `set -a; source ~/.flywheel/.env`（restart-services.sh:76-85；update-flywheel.sh:30；flywheel-bridge-wrapper.sh:46-49 且 .env 缺失 fail-fast）→ **bootstrap 顺序无障碍**（issue 点 4 答案：无需例外架构，wrapper 直发 REST + 接缝解析即可正确署名）。

## 2. 调用点 → 新形态映射（plan 的输入）

### 2.1 restart-services.sh

| 行 | 现状 | 类别 | 新形态 |
|---|---|---|---|
| 89-90 | `SIMBA_BOT_TOKEN`/`NOTIFY_BOT_TOKEN` 定义 | — | 删除（grep-zero 源头） |
| 100-110 `notify_discord()` | Simba → core | — | 删除函数，调用点分流到下面两个新函数 |
| 115 `severe_alert()` | `notify_discord "🚨"` | — | 改调 `alert_severe`（→ lead-alert.sh） |
| 125-138 `notify_routine()` | infra 或回落 Simba | routine | 保留主路；回落分支改 log ERROR + meta-alert（`notify_routine_unconfigured`），部署继续 |
| 213, 220, 613, 846, 859, 910, 1151, 1226, 1235, 1268, 1276 | `notify_discord "⚠️ …"` | warning | `alert_warning` → lead-alert.sh `--kind deploy_degraded --severity warning` |
| 632（bp_fail_loud 覆盖）, 1107, 1116, 1132, 1149, 1154, 1175 | 🚨/severe_alert | severe | `alert_severe` → lead-alert.sh `--kind deploy_failed --severity severe --mention-user $FLYWHEEL_FOUNDER_USER_ID` |

新 helper（脚本内 ~15 行，不是第二份解析 —— 解析在 lead-alert.sh 里）：

```bash
# 通知失败绝不 block 部署（FLY-739）；lead-alert.sh 自带 fail-loud/dead-letter/meta-alert
alert_warning() { # $1=signature-slug $2=title $3=body
    "${FLYWHEEL_DIR}/scripts/lead-alert.sh" --project flywheel --lead deploy \
      --kind deploy_degraded --severity warning --title "$2" --body "$3" \
      --signature "$1-$(date -u +%Y%m%d%H%M)" >/dev/null 2>&1 || true
}
alert_severe() { # 同上 + --kind deploy_failed + --mention-user
    "${FLYWHEEL_DIR}/scripts/lead-alert.sh" --project flywheel --lead deploy \
      --kind deploy_failed --severity severe --title "$2" --body "$3" \
      --signature "$1-$(date -u +%Y%m%d%H%M)" \
      ${FLYWHEEL_FOUNDER_USER_ID:+--mention-user "$FLYWHEEL_FOUNDER_USER_ID"} >/dev/null 2>&1 || true
}
```

（`--lead deploy` 是系统级身份，unified 双 env 下不查 projects.json；与 D4 的 `--lead bridge` 同一惯例。）

### 2.2 update-flywheel.sh

- :39 `NOTIFY_BOT_TOKEN` 定义 + :40-45 `notify_discord()` 删除；:46 `severe_alert()` 改调 lead-alert.sh（`--lead updater --kind deploy_failed --severity severe --mention-user …`）。调用点 :140, :157 两处 🚨 不变。
- 注意 sourceable 测试模式（`UPDATE_FLYWHEEL_SOURCED=1`）：helper 定义须在 source 段内可注入（现 notify_discord 就是顶层定义，替换等价）。

### 2.3 flywheel-bridge-wrapper.sh

- :95-101 主路（lead-alert.sh `--kind bridge_wrapper_fail`）不动。
- :102-107 直 curl fallback：token 从 `${SIMBA_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}` 改为**就地接缝解析**（bash 间接展开，语义逐字对齐 lead-alert.sh:243-247）：

```bash
local sender_env="${FLYWHEEL_ALERT_SENDER_TOKEN_ENV:-}"
local token=""
[[ -n "$sender_env" ]] && token="${!sender_env:-}"
if [[ -z "$token" ]]; then
  log "ERROR: fallback curl cannot resolve FLYWHEEL_ALERT_SENDER_TOKEN_ENV='${sender_env}' — refusing legacy fallback" >&2
  return 0   # meta-alert 已在本函数前面发过（桌面+文件），不再有 Discord 腿
fi
```

- 落点保留 core channel（gate 批准的显式例外：此腿只在告警管线自身故障 + Bridge down 时运行）。
- 为什么不抽 `scripts/lib/` 共享 lib：这条腿的存在意义就是「lead-alert.sh 坏掉时还能响」，多 source 一个文件 = 多一个共因故障点；5 行内联 + 单测锁语义（照 bridge-wrapper-fail-loud.test.sh 的 sed 抽函数法）成本更低。lead-alert.sh 自身逻辑零改动（除 §3 的 mention flag 与 kind 白名单）。

## 3. 硬要求 ①（deploy_failed @Annie）的机制设计

冲突点：lead-alert.sh 直发与 Bridge drain 两侧都刻意抑制 mentions（§1.1/§1.3）。

**直发侧**：lead-alert.sh 加 opt-in `--mention-user <snowflake>`（校验 `^[0-9]{17,20}$`，非法即忽略并 log）：
- CONTENT 前缀 `<@id> `（文本可见，drain 重投时也保留在正文里）；
- `allowed_mentions` 从 `{parse: []}` 变 `{users: ["<id>"]}`（只放行这一个人，其余仍全抑制 —— 保持 FLY-927 R1 #7 的原意：抑制的是 body 里意外携带的 id/角色，不是显式点名）；
- 不传 flag = 现状字节不变（byte-compat）。

**queue/drain 侧**（直发失败 5xx/429/网络时的重投路径）：queue 记录加可选字段 `mentionUserId`；`LeadAlertNotifier.sendDiscord` 的 `allowed_mentions` 合并 `[ticket.ownerUserId, payload.mentionUserId]`（去重去空）。TS 面改动极小（payload 可选字段 + 一处合并），且 legacy 路径（两字段都无）字节不变。若不做这半边，deploy 失败风暴 + Discord 瞬断的组合下，恢复后 drain 出的 deploy_failed 只有文本 `<@id>` 不真 ping —— 恰是「部署挂了 Annie 必须当场知道」最需要响的场景，所以做全。

## 4. grep-zero 清单（硬要求 ② 口径）

`SIMBA_BOT_TOKEN`（scripts/ + packages/ 归零）：

| 文件 | 处置 |
|---|---|
| scripts/restart-services.sh:89-90 / update-flywheel.sh:39 / flywheel-bridge-wrapper.sh:102 | §2 迁移中删除 |
| scripts/__tests__/update-flywheel-queue.test.sh:47 | 置空 export 改为中和接缝 env（`FLYWHEEL_ALERT_SENDER_TOKEN_ENV=""` 等） |
| scripts/__tests__/bridge-wrapper-fail-loud.test.sh:66 | fixture 改 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV="TEST_SENDER_TOKEN" TEST_SENDER_TOKEN="tok"`，断言随 §2.3 新语义更新 |
| packages/teamlead/scripts/__tests__/{fly231-companion-launch-plan,restart-env-propagation,manifest-roundtrip}.test.sh | fixture env 名改 `TEST_COS_BOT_TOKEN`（纯改名，行为不变） |
| packages/teamlead/src/__tests__/{LeadAlertNotifier,LeadWatchdog,LeadWatchdog-fly1048-multiframe,ProjectConfig}.test.ts | 同上纯改名 |
| packages/teamlead/scripts/claude-lead.sh:53 | 注释示例改中性名 |

`DISCORD_BOT_TOKEN`：只删三条通知路里的 fallback 用法；`flywheel-lead-wrapper.sh:97,142`（per-lead botTokenEnv 默认名/导出名）、`restart-services.sh:891`（把 per-lead token 以 `DISCORD_BOT_TOKEN=` 名注入 Lead 子进程）、test-deploy.sh 等**合法用途不动**。

防回潮：新增 `scripts/__tests__/simba-grep-zero.test.sh` sentinel —— 对 `git ls-files scripts packages` 全量 grep 拼接模式（`'SIMBA''_BOT_TOKEN'`，避免自匹配），非零即 FAIL；同时断言三条通知路文件里无 `DISCORD_BOT_TOKEN` fallback 形态（精确到 `${SIMBA` / `:-${DISCORD_BOT_TOKEN` 模式，不误伤 :891 的合法注入行）。

## 5. 测试面（形态先例）

| 新/改测试 | 先例 | 覆盖 |
|---|---|---|
| `restart-services-notify.test.sh`（新） | bridge-wrapper-fail-loud.test.sh 的 sed 抽函数 + fake lead-alert.sh/curl | alert_warning/alert_severe 路由到正确 kind/severity/signature/mention；notify_routine env 缺失 → 不 curl、meta-alert 被调、rc=0 |
| `update-flywheel-queue.test.sh`（改） | 自身（UPDATE_FLYWHEEL_SOURCED=1 sourceable） | severe_alert 改道后 marker-blocked 流仍绿；无 Simba env 也能跑 |
| `bridge-wrapper-fail-loud.test.sh`（改） | 自身 | S-fallback 场景：接缝可解析 → curl 带新 token；接缝不可解析 → **零 curl** + 函数 rc=0 |
| `lead-alert-fly927.test.sh`（扩） | 自身 | `--mention-user`：content 前缀 + allowed_mentions users；非法 id 忽略；不传 = byte-compat |
| `LeadAlertNotifier.test.ts`（扩） | 自身 | payload.mentionUserId 合并进 allowed_mentions；两字段皆无 = 现状断言不变 |
| `simba-grep-zero.test.sh`（新） | reverse-compat sentinel 惯例 | §4 防回潮 |

CI 接入：`scripts/__tests__/` 由现有 shell-test runner 全量执行（与既有 *.test.sh 同机制），无需新接线。

## 6. 风险与边界

1. **dispatcher token 失效 = ⚠️/🚨 只剩 meta-alert（桌面+文件）**。这是 gate 里明确接受的取舍（fail-loud ≠ 静默；dead-letter + meta-alert 留痕）。缓解：lead-alert.sh 的 no-token 路径本来就 fire meta-alert；FLY-696 账号自愈体系与告警频道 bot ARC 是同一 token 的日常消费者，失效会先在别处被发现。
2. **消息落点变化**（core → #flywheel-alerts）：gate 已批；QA 验收时要向 Annie 说明「以后重启⚠️/🚨在 alerts 频道看」。
3. **claims.db 去重误吞**：分钟级 signature + 语境 slug 已防同日不同故障互吞；同一分钟内同 slug 重复 = 有意去重（launchd 抖动场景，D4 同款）。
4. **通知量**：deploy_degraded 进 alerts 工单队列会触发 bot ACK/ARC 流程（FLY-368/871）——这是 PRD 期望行为（bot 先处理），不是回归。
5. **不在本 issue 范围**：`.env` 里 `DISCORD_BOT_TOKEN` 的值仍是 Simba token（per-lead 默认用途）；Bridge `/api/reports` 的 sender（FLY-929 已迁）；standup sender 的非-CoS 约束（PRD §7.1 保留项）。
