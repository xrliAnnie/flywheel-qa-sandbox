# FLY-1081 三条通知路去 Simba 化 — 探索

Issue: FLY-1081 (https://linear.app/geoforge3d/issue/FLY-1081/fix-重启更新wrapper-三条通知路仍写死-simba-迁到-infra-botfly-915-痛点-3927-只迁了一条)
日期: 2026-07-09
基于: 无

## 1. 症状与问题

Annie 2026-07-09 在频道里看到 **Simba（GeoForge3D 的 CoS bot）** 发 Flywheel 的重启告警：

> ⚠️ Lead sub-lead 旧 supervisor (PID xxx) 60s 后仍未退出，跳过重启避免双启动

这正是 FLY-915 PRD 痛点 #3 /「铁律：**Simba 绝不再发 Flywheel 全局通知**」（PRD §7.2 ⑤）的未完成部分。FLY-927 建了发送方身份接缝（`FLYWHEEL_ALERT_SENDER_TOKEN_ENV`）但只接进了 `lead-alert.sh` 一条路；FLY-929 (W3b) 只迁了**例行**通知（✅/🔄/⏳），⚠️/🚨 刻意留在 Simba（见 §3 历史决策线）。

## 2. 代码审计（ground truth，2026-07-09 逐行核实）

### 2.1 四个 Discord bot 身份（生产 `~/.flywheel/.env`，已用 `/users/@me` 实测）

| env 名 | Discord 身份 | 用途 |
|---|---|---|
| `FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN` | **flywheel-alerts-dispatcher** | FLY-927 D2 单一告警发送方（#flywheel-alerts 工单） |
| `CLAUDE_INFRA_BOT_TOKEN` | **claw-infra-bot** | FLY-929 例行通知发送方（#flywheel-notify） |
| `CODEX_INFRA_BOT_TOKEN` | **codex-infra-bot** | 告警频道 ARC 处理者（FLY-871） |
| `SIMBA_BOT_TOKEN` | **Simba - Chief of Staff** | GeoForge3D CoS —— 本 issue 要清零的 |
| `DISCORD_BOT_TOKEN` | **Simba - Chief of Staff**（同一 app 的另一 token 值） | ⚠️ 回落到它 = 仍然以 Simba 发言 |

关键实测：`DISCORD_BOT_TOKEN` 与 `SIMBA_BOT_TOKEN` 值不同但解析到**同一个 Discord 身份**。所以 `${SIMBA_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}` 这条链两级都是 Simba —— issue 要求「不许回落 Simba/`DISCORD_BOT_TOKEN`」必须两级一起禁。

生产接缝现值：`FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN`、`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=1518793447165661254`（#flywheel-alerts）、`FLYWHEEL_NOTIFY_CHANNEL=1521630422918758472`（#flywheel-notify）均已设置。

### 2.2 三条未迁路 + 调用点清单

**路 1：`scripts/restart-services.sh`**（restart-services.sh:89-90 硬编码源头）

```
SIMBA_BOT_TOKEN="${SIMBA_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}"
NOTIFY_BOT_TOKEN="${SIMBA_BOT_TOKEN}"
```

三类发送函数，落点全部 = `DISCORD_CORE_CHANNEL`，token 全部 = Simba：

| 函数 | 消息类别 | 调用点（行号） |
|---|---|---|
| `notify_routine()` | ✅/🔄/⏳ 例行进度 | 598, 1165, 1246, 1256, 1279 — **已迁 claw-infra-bot**（FLY-929 W3b②），但 env 缺失时**静默回落** `notify_discord`（=Simba）→ restart-services.sh:137 |
| `notify_discord()` 直调 ⚠️ | 需人注意的警告 | 213, 220, 613, 846（Annie 看到的那条）, 859, 910, 1151, 1226, 1235, 1268, 1276 |
| `severe_alert()` / 直调 🚨 | 需人救的严重故障 | 115, 632（bp_fail_loud 覆盖）, 1107, 1116, 1132, 1149, 1154, 1175 |

**路 2：`scripts/update-flywheel.sh`**（update-flywheel.sh:39）

```
NOTIFY_BOT_TOKEN="${SIMBA_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}"
```

只有 `severe_alert()`（🚨 self-ship marker blocked ×3 处：update-flywheel.sh:140, 157 + notify_discord 定义）。落点 `DISCORD_CORE_CHANNEL`（写死默认值 `1487340532610109520`）。

**路 3：`scripts/flywheel-bridge-wrapper.sh`**（flywheel-bridge-wrapper.sh:102）

`bp_fail_loud` 的 Discord 腿：**主路已迁**（FLY-927 D4 → `lead-alert.sh --kind bridge_wrapper_fail`，走接缝 + claims 去重）；但 lead-alert.sh 缺失/失败时的**直 curl fallback** 仍用 `${SIMBA_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}` → core channel。

### 2.3 bootstrap 顺序（issue 关注点 #4，已核实无障碍）

`flywheel-bridge-wrapper.sh` 在**任何**通知路径运行之前（port preflight 在 line 110）就已 `set -a; source ~/.flywheel/.env`（line 46-49，且 .env 缺失 = fail-fast exit 1）。所以 Bridge 未起时，`FLYWHEEL_ALERT_SENDER_TOKEN_ENV` / `FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN` / `CLAUDE_INFRA_BOT_TOKEN` 在 wrapper 内**全部可解析**——早期通知路径不需要例外，直发 Discord REST（现状机制）+ 接缝解析即可正确署名。`restart-services.sh`（line 76-85 source .env）与 `update-flywheel.sh`（line 30）同理。

### 2.4 复用面：`lead-alert.sh` 已有的解析与 fail-loud 语义（FLY-927 D2/D3）

- lead-alert.sh:156-157 读接缝；lead-alert.sh:243-247：接缝**已设但解析不到** → 报错、**拒绝**回落 per-lead token → 走 no-token dead-letter（+ Discord-independent meta-alert）。这就是 issue 要求「照抄」的语义。
- lead-alert.sh:165-166：unified channel + sender env 双设时完全不需要 projects.json —— 系统级身份 `--project flywheel --lead bridge` 可用（D4 先例）。
- 附带能力：claims.db 跨进程去重（`--signature` 支持分钟级）、queue/dead-letter 分级、meta-alert 逃生、token 走 curl stdin config 不进 argv、mentions 全抑制。
- 测试先例：`scripts/__tests__/lead-alert-fly927.test.sh`（断言「接缝解析失败 → 拒回落」）、`scripts/__tests__/bridge-wrapper-fail-loud.test.sh`（sed 抽真函数 + fake curl/lead-alert 驱动）。

### 2.5 SIMBA_BOT_TOKEN 现存引用全集（grep 2026-07-09）

生产代码 4 处 = 本 issue 三条路（restart-services.sh:89-90 / update-flywheel.sh:39 / flywheel-bridge-wrapper.sh:102）。
其余全部是**测试 fixture / 注释**，需要一并改名才能 grep-zero：

- `scripts/__tests__/update-flywheel-queue.test.sh:47`（置空 export）
- `scripts/__tests__/bridge-wrapper-fail-loud.test.sh:66`（fixture token）
- `packages/teamlead/scripts/__tests__/fly231-companion-launch-plan.test.sh:60`、`restart-env-propagation.test.sh:63-69`、`manifest-roundtrip.test.sh:79,93`（fixture botTokenEnv 名）
- `packages/teamlead/src/__tests__/`：LeadAlertNotifier.test.ts / LeadWatchdog.test.ts / LeadWatchdog-fly1048-multiframe.test.ts / ProjectConfig.test.ts（fixture env 名，可改 `TEST_COS_BOT_TOKEN` 之类中性名）
- `packages/teamlead/scripts/claude-lead.sh:53`（注释示例）

注：`DISCORD_BOT_TOKEN` 作为 per-lead `botTokenEnv` 的**通用默认名**（flywheel-lead-wrapper.sh:97,142、projects.json 契约、test-deploy 等）是另一个概念，**不在本 issue 清零范围**——但在三条通知路里作为 fallback 的用法必须随 Simba 一起删（同一 Discord 身份）。已知相邻债：生产 `.env` 里 `DISCORD_BOT_TOKEN` 的值仍是 Simba token，作为 per-lead 默认继续存在；是否改值/退役属 ops 范畴，不进本 issue。

## 3. 历史决策线（为什么之前「故意」没迁，为什么现在推翻）

1. **FLY-929 exploration §3.6（Tadashi 拍板 #4，2026-07-07）**：severe/⚠️ 路径**不动**——「最后防线必须走最久经考验路径，新 token 配错 = 死机告警静默失败 = 最糟形态；927 统一发送方门禁时带 fallback 再换」。bridge-wrapper 🚨 留给 927 统一治。
2. **FLY-927 D4** 兑现了一半：bridge-wrapper 主路改道 lead-alert.sh，但按「带 fallback 再换」保留了直 curl Simba fallback；restart-services / update-flywheel 的 ⚠️/🚨 完全没动。
3. **FLY-929 标 Done** 时 W3b「通知迁移」只覆盖 routine —— issue 判定为不完整，正确。
4. **现在推翻的依据（FLY-1081，Annie 2026-07-09 直接质询）**：回落/保留 Simba 正是 bug 本身。且当年「新 token 不可靠」的前提已消失——接缝 + dispatcher/claw-infra-bot 已在生产跑了多个版本（lead-alert.sh 全量告警、notify_routine、token report 都在用），meta-alert（桌面 + 本地文件，Discord-independent）作为兜底逃生已存在。fail-loud ≠ 静默失败：解析不到 → dead-letter + meta-alert，Annie 仍会知道。

## 4. 设计选项

### Option A：只换 token，落点不动（最小改）

三条路保留各自 curl，token 改为接缝解析（抽共享 lib），⚠️/🚨 仍发 `DISCORD_CORE_CHANNEL`。

- ✅ 改动最小、频道视觉零变化。
- ❌ 与 PRD §3.1 路由规则冲突（无 thread 的 infra 问题应进 #flywheel-alerts 工单队列，core channel 本不该收这些）；dispatcher bot 是否有 core channel 发言权限未知（它为 alerts 频道而建）——需要 ops 加权限，反而多一步；每个脚本仍各自维护一份 curl + 分类逻辑，「复用 lead-alert.sh」只复用了 5 行解析。
- ❌ 不解决刷屏/去重：restart 失败风暴仍无 claims 去重。

### Option B：⚠️/🚨 全部改道 `lead-alert.sh`（PRD 对齐，推荐的主体）

restart-services / update-flywheel 的 `notify_discord`(⚠️ 直调) + `severe_alert`(🚨) 改为调 `lead-alert.sh --project flywheel --lead <deploy|updater|bridge> --kind <新 kind> --severity <warning|severe> --signature <分钟级+上下文>`（D4 先例的推广）。发送身份、频道（#flywheel-alerts）、fail-loud、去重、queue 全部免费继承，脚本内不再有第二份 curl/解析。

- ✅ 「统一走 927 接缝 + 复用 lead-alert.sh 解析逻辑、不各写一份」的最强形态；PRD §3.1 落点归位（告警 → 工单队列，bot 可 ARC）。
- ✅ fail-loud 语义照抄且只有一份实现。
- ⚠️ 行为变化：⚠️/🚨 从 core channel 挪到 #flywheel-alerts（发送者从 Simba 变 dispatcher）——这是 PRD 明文的目标状态，但 Annie 的「看告警的地方」会变，需要 Lead/founder 知情确认。
- ⚠️ 需要给 lead-alert.sh 的 kind 枚举加 deploy 类 kind（+ LeadAlertNotifier.ts TS union parity，惯例见 lead-alert.sh:90-104 注释）。

### Option C：B + routine 补刀 + wrapper fallback 例外（完整方案，= 本探索推荐）

在 B 的基础上补齐另外两个 Simba 残留：

1. **routine 的静默回落删除**：`notify_routine` env 缺失时不再回落 `notify_discord`（=Simba），改为 log ERROR + meta-alert + 继续部署（通知失败绝不 block deploy）。发送身份维持 FLY-929 契约（claw-infra-bot → #flywheel-notify），不另开新接缝（PRD §7.1 就是这个身份，YAGNI）。
2. **bridge-wrapper 直 curl fallback**（lead-alert.sh 本身坏掉时的最后一腿，Bridge 已 down）：token 改为**就地接缝解析**（`FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 间接展开，语义与 lead-alert.sh:243-247 逐字一致：解析不到 → 只走 meta-alert，绝不回落）。落点保留 core channel（**例外并写清理由**：此腿只在告警管线自身故障时运行，宁可发错频道也不丢「Bridge 起不来」；这是 issue 点 4 允许的显式例外）。解析逻辑是否抽 `scripts/lib/` 共享——倾向**不抽**：fallback 腿要最小依赖面（多 source 一个文件 = 多一个故障点），5 行内联 + 单测锁行为即可；lead-alert.sh 自身不动。
3. **grep-zero**：三条路 + 全部测试 fixture/注释改名（中性名如 `TEST_COS_BOT_TOKEN`）+ 新增 sentinel 测试（拼接字符串避免自匹配）纳入 `scripts/__tests__/`，防回潮。

## 5. 关键设计点（无论选哪个都要处理）

- **通知失败绝不 block 部署**（FLY-739 原则）：所有 lead-alert.sh 调用 `|| true`；fail-loud 指「报错 + dead-letter + meta-alert」，不是「abort restart」。issue 验收「接缝解析失败 → 报错退出」按 lead-alert.sh 语义落实（该脚本 config_error exit），部署脚本自身不因通知失败退出。
- **去重签名**：deploy 类告警必须带 `--signature`（分钟级 + 语境，如 `supervisor-stuck-<lead>-YYYYmmddHHMM`），否则 claims.db 的默认「按天」签名会把同一天内两次**不同**失败吞成一条。
- **kind 设计**：倾向加 2 个——`deploy_failed`（severe，需人救）/ `deploy_degraded`（warning，部分失败/跳过/超时）。TS union（LeadAlertNotifier.ts `ALERT_EVENT_TYPES`）同步。
- **真机验收**：触发一次真重启（搭下一个 batched restart 窗，避免专门扰动生产）→ 截图证明发送者为 infra 身份 + Simba 零发言；bridge-wrapper 早期路径用注入方式验（fake lead-alert.sh 缺失 + 假 curl，测试先例已有）。

## 6. 待 Lead 确认的问题（brainstorm gate）

1. **落点变化**：⚠️/🚨 从 core channel 迁到 #flywheel-alerts（Option B/C，PRD §3.1 对齐）是否接受？还是保守选 Option A（只换身份、留 core）？
2. **「Claude Infra Bot 发出」的验收口径**：#flywheel-alerts 的发送者是 **flywheel-alerts-dispatcher**（927 D2 生产现值），不是字面 claw-infra-bot；routine（#flywheel-notify）才是 claw-infra-bot。按现有两身份分工执行，验收口径 = 「infra 身份发出 + Simba 零发言」，可以吗？
3. 新 kind 命名 `deploy_failed` / `deploy_degraded` 有没有更贴近 927 工单语义的偏好？
