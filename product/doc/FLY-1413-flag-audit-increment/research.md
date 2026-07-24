# FLY-1413 新增开关补审 — 调研

Issue: FLY-1413 (https://linear.app/geoforge3d/issue/FLY-1413/flag治理清存量-55-个新增开关补审-逐条圈选留清动态化像-fly-1136-那批)
日期: 2026-07-22
基于: exploration.md

## 1. 基线怎么取的(可复现)

```bash
# FLY-1136 基线(该 PR 未合 main,只能从分支取)
git show dc62daac:product/doc/FLY-1136-feature-flag-audit/snapshot.json   # 103 flags

# 当前 registry
node product/doc/FLY-1413-flag-audit-increment/extract.mjs                # 148 flags
```

按 `registryNameSet` 做集合差:**新增 62 · 消失 17**。

消失的 17 个(= FLY-1136 圈选后真的清掉了,证明那轮闭环了):
`account_self_heal` · `alert_threads` · `attribution_hold_align` · `auto_repair` · `codex_lead_read_deny` · `detection_escalation` · `detection_gap_scan` · `founder_approval_ack` · `founder_image_approval` · `lead_pane_readiness` · `notify_digest_expect` · `pane_multiframe` · `reply_to_card` · `roundtable_enabled` · `roundtable_reply_in_thread` · `stuck_errorsig` · `xhs_review`

## 2. 62 个的结构分布

| 维度 | 分布 |
|---|---|
| 类别 | kill_switch 33 · feature 27 · governance_gate 2 |
| 极性 | 默认开 40 · 默认关(opt-in) 22 |
| 值类型 | 布尔 48 · 数值/字符串 12 · 枚举 2 |
| 可切换性 | 已可秒切(direct) 15 · conversational 22 · readonly 25 |
| 生产 `.env` 显式设过的 | **9**(其余 52 个没显式配置、用代码默认值,1 个是 per-project 配置) |

9 个被显式设过的(下表「生产配置值」= 磁盘 `.env` 里写的,不等于进程内活值,见 §8.1):

| flag | 环境变量 | 默认 | 生产配置值 |
|---|---|---|---|
| `checkpoint_watchdog` | `FLYWHEEL_CHECKPOINT_WATCHDOG` | 关 | `=0` 关 |
| `cmux_linked_view` | `FLYWHEEL_CMUX_LINKED_VIEW` | **开** | `=0` **被显式关掉** |
| `cmux_view_invariant` | `FLYWHEEL_CMUX_VIEW_INVARIANT` | 开 | `=1` 开 |
| `quota_daemon_cutover` | `FLYWHEEL_QUOTA_DAEMON_CUTOVER` | 关 | `=1` **被显式打开** |
| `three_stage_codex_design_toggle` | `FLYWHEEL_THREE_STAGE_CODEX_DESIGN` | 关 | `=0` 关 |
| `skill_framework_mode` | `FLYWHEEL_SKILL_FRAMEWORK_MODE` | superpowers | `=split` |
| `workflow_template_dispatch` | `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH` | 关 | `=1` **被显式打开** |
| `workflow_claims_write` | `FLYWHEEL_WORKFLOW_CLAIMS_WRITE` | 关 | `=1` **被显式打开** |
| `workflow_claims_read` | `FLYWHEEL_WORKFLOW_CLAIMS_READ` | 关 | `=1` **被显式打开** |

## 3. 🔴 关键发现 A:13 个是死壳 —— 环境变量在,但代码写死了关

FLY-1393 把一批旧看门狗正式退役。退役的做法不是删变量,而是让读取函数**无条件返回 false**:

```ts
// packages/teamlead/src/bridge/watchdog-minimum-set.ts:41
export function retiredWatchdogLaneEnabled(
	_env: WatchdogEnv = process.env,
	_envVar?: RetiredWatchdogEnvVar,
): false {
	return false;          // ← 参数全部带下划线前缀 = 根本不看
}
```

```ts
// packages/teamlead/src/bridge/legacy-delivery-watchdog-policy.ts
export function legacyDeliveryWatchdogsEnabled(env = process.env): false {
	return retiredWatchdogLaneEnabled(env, LEGACY_DELIVERY_WATCHDOG_ENV);
}
```

**在终点验证(不是看标签)**:

| 断言 | 取证点 |
|---|---|
| `checkpoint_watchdog` 恒关 | `gate-poller.ts:2258 checkpointWatchdogEnabled()` 直接 return 上面那个 false;`maybeEmitCheckpointParkAlert()` 第一行 `if (!this.checkpointWatchdogEnabled()) return;` |
| `legacy_delivery_watchdogs` 恒关 | 函数返回类型就写死 `: false` |
| `park_watch` 恒关 | `plugin.ts:7973 onParkWatchTick: legacyDeliveryWatchdogsOn ? parkWatchTick : undefined` —— 恒 `undefined`;`runParkWatch` 全仓唯一生产调用点就是这条,`grep -rn runParkWatch` 除测试外无他 |
| 活 Bridge 也这么报 | `curl localhost:9876/health` 的 `retiring[]` 里 `park_watch` / `legacy_delivery_watchdogs` / `checkpoint_watchdog` 全部 `effective_enabled:false` —— 抓屏已落盘 `evidence-bridge-health.json`(带捕获时间 + Bridge 启动时间,可复核) |

**第二批(Codex design review R1 BLOCKER-2 抓出来的,第一轮我漏了)**:同一个总闸下面还挂着投递签收那一整条。逐条追到终点:

| 断言 | 取证点 |
|---|---|
| `delivery_ack` 恒关 | `lead-event-ack-policy.ts:9` `deliveryAckEnabled() = legacyDeliveryWatchdogsEnabled(env) && env.FLYWHEEL_DELIVERY_ACK !== "0"` —— **左边那半恒 false,整个与式恒 false**;生产 wiring `plugin.ts:4536` 同样写成 `legacyDeliveryWatchdogsOn && …` |
| 4 个签收旋钮恒死 | `delivery_ack_timeout_ms` / `delivery_max_redeliver` / `delivery_max_transport_failures` / `ack_late_window_ms` 只在 `LeadEventDeliveryCoordinator` 构造函数(`lead-event-delivery.ts:86/91/95/99`)里读;该 coordinator **全仓只有一个实例**(`plugin.ts:4528`)且 `enabled` 恒 false → `deliver()` 直接旁路、`reconcile()` 首行 return |
| `delivery_unconsumed_v2` 恒关 | 唯一生产读点 `plugin.ts:7213` 在 `gapScanTick`(定义于 7205)内;`plugin.ts:7993 onGapScanTick: legacyDeliveryWatchdogsOn ? gapScanTick : undefined` —— 恒 `undefined` |

→ 死壳合计 **13 个**:3 个硬关的开关(`checkpoint_watchdog` / `legacy_delivery_watchdogs` / `park_watch`)+ 10 个「自己没被硬关、但唯一消费者接在死巷道后面」的(4 个 park 旋钮 + `delivery_ack` + 4 个签收旋钮 + `delivery_unconsumed_v2`)。这是本单最实的「清」批。

**这次漏判的教训**:我第一轮对 `park_watch` 做了终点追踪(一路 grep 到调用点恒 `undefined`),但对 `delivery_ack` 只看了注册表描述就归了「动态化」。**同一个根因下的其他分支必须一起扫**,不能追完一条就以为覆盖了 —— 现在 `DEAD_BY_DEPENDENCY` 每条都强制带一条从读点到 hard-off 根的 `chain`,写不出链条就 throw。

**对本单管线的影响(必须处理,否则现状写错)**:`extract.mjs` 只按 `.env` 的开关语义折算,会把 `park_watch` 报成「ON(默认)」—— 和运行时事实相反。所以本单给 extract 加一张 **具名 runtime-hard-off 覆盖表**(照抄 FLY-1136 `ACTIVATION_OVERRIDES` 的可复核写法:每条带 flag 名 + 取证文件行 + 理由,加载时断言 flag 名存在于 registry,写错名字直接 fail)。

## 4. 🔴 关键发现 B:14 个离「能秒切」只差一层分类,不是差代码

一个 flag 能不能被控制台秒切,判定在 `packages/config/src/feature-flags/direct-toggle.ts`:

```ts
metadata.source === "env" && metadata.scope === "bridge_global" &&
(valueKind === "bool" || (valueKind === "enum" && enumValues?.length)) &&
metadata.toggleable === "direct" && metadata.category !== "governance_gate" &&
!metadata.dormant &&
metadata.readTimings.every(t => t === "call_time" || t === "dotenv_live")
```

按这条谓词把 62 个逐个归到**真正的阻碍**上:

| 真正的阻碍 | 个数 | 要花多大力气才能动态化 |
|---|---|---|
| A 已经能秒切 | 15 | 无 —— 已经是目标状态 |
| B per-project 配置(ConfigLoader 按文件 mtime 重载) | 1 | 无 |
| C 治理门(谓词硬排除,永不进批量切换) | 2 | 不该动 |
| D 值类型是自由字符串,被 API 结构性拒绝 | 12 | 中 —— 要给 stage 层加带边界的数值校验 |
| E 读点真的在启动/构造时捕获 | 15 | 大 —— 要逐个改读点(FLY-1405 的正题) |
| **F 读点已经是 call-time,只是注册表标成了 readonly/conversational** | **14** | **小 —— 改注册表分类 + 补一条 direct-toggle 证明测试** |

(D 组 12 里有 4 个、F 组原本的 17 里有 3 个,已因 §3 第二批死壳判定移进「清」,不再计入这里。)

F 组这 14 个是 FLY-1405 **性价比最高的一段**:
`receipt_foundation` · `receipt_activation_dry_run` · `park_biased_handoff` · `prune_park_guard` · `readopt_parked_roles` · `codex_gate_wait` · `quota_degraded_switch` · `three_stage_codex_design_toggle` · `issue_gate_supersede_mode` · `ask_hygiene` · `stuck_pane_confirm` · `commdb_protection` · `zombie_reconcile` · `disposition_receipt`

**诚实的限定**(不要读成「14 个都能一行改完」):

1. **分类不全是技术判断,也有政策判断。** `receipt_foundation` 的注册表注释明说「行为读取是 call-time」却仍标 readonly,理由是 `=0` 属于事故态、会每小时刷告警,**故意**不做成随手可切。这类要 Annie/Tadashi 拍,不是技术问题。
2. **每个转 direct 都必须补 `directToggleProof`** —— 注册表把它列为 direct 的**必填**字段:一条证明「进程内改 `process.env` 后下一次真实读取能读到新值、不需要重建对象」的测试。
3. **🔴 最重要的限定:call-time ≠ 能被控制台切热(Codex R1 HIGH-2)。** 控制台的 direct apply 明确只改**跑着的 Bridge 自己的** `process.env`(`flag-toggle.ts` 头注释原话:「an env flag toggle must mutate the RUNNING Bridge's own process.env」)。所以读点在**别的进程**里的,改分类没用:

   | flag | 读它的进程 | 后果 |
   |---|---|---|
   | `codex_gate_wait` | Runner 进程(`packages/claude-runner/src/codex-daemon-client.ts`) | 改 `.env` 只影响**之后新起**的 Runner;已经在跑的不变 |
   | `quota_degraded_switch` | 独立的配额守护进程(`account-heal/quota-monitor.ts`) | 要那个进程自己重读配置,Bridge 侧改分类无效 |
   | `claude_account_identity_check` | Runner 进程 + 配额守护进程 | 同上,而且跨两个进程 |
   | `cmux_linked_view` | Bridge + cmux shell 脚本 | 脚本那半每次调用现读(等于已经动态),Bridge 那半不是 —— 两半脾气不同 |

   本单的做法:extract 按读点文件路径派生 `processOwners`,只有**所有**消费者都是 Bridge 的才标 `bridgeOnlyConsumers:true`;不满足的在卡片上用 🔌 明写「这条不是改个分类就能热切」。62 个里 **50 个**是纯 Bridge 消费者,其余 12 个跨进程。

## 5. 🔴 关键发现 C:4 个环境变量当开关用,却没注册进 registry(漂移)

用 Tadashi 的 env 侧清单(`/tmp/flag-inventory-env.md`,444 个 `FLYWHEEL_*` 变量 @`948275e3`)和 registry 交叉核对。他那份是**另一个口径**(扫的是所有环境变量,含 timeout/token/目录等 391 个非开关项),所以只取他判定为 opt-in / kill-switch 的 53 个来对:

| 变量 | 代码里的读法 | 在 `truth.ts` | 在 `registry.ts` |
|---|---|---|---|
| `FLYWHEEL_ALERT_ROUTING` | `infra-event-router.ts:162` `process.env.X === "1"` | ✅ | ❌ |
| `FLYWHEEL_ALERT_TICKETS` | `LeadAlertNotifier.ts:684` + `stuck-escalation.ts:582` `=== "1"` | ✅ | ❌ |
| `FLYWHEEL_QUOTA_QA_INJECTION` | `quota-monitor-runtime.ts:444/454` `=== "1"` | ✅ | ❌ |
| `FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED` | `plugin.ts:6468` `=== "1"` | ✅ | ❌ |

`grep -c` 这四个名字在 `registry.ts` 里 = **0**。它们进了真值 allowlist(所以漂移检查不会报),但没进注册表 —— 结果是**控制台看不见、逐条审计也漏掉**。

前两个(`ALERT_ROUTING` / `ALERT_TICKETS`)在生产 `.env` 里是 `=1`,即**开着的、没被审过的、控制台看不见的**功能开关。这不是理论问题。

**反向也核了一遍**:registry 里有 16 个环境变量不在 Tadashi 的清单里。逐个看读法,全部是他的扫描器模式覆盖不到的写法 —— `defaultOn(env, "X")`、`positiveEnv("X", 默认值)`、`(args.env ?? process.env).X`、`env().X`(工厂函数),不是字面 `process.env.FLYWHEEL_X`。**这一侧不是漂移,是扫描器口径**。已实测 4 个样本(`WATCHDOG_LIVENESS` / `SHIP_CI_GUARD` / `PARK_N1_MS` / `EXTERNAL_MERGE_RECONCILE`)确认。

→ 结论:registry 仍是主源;env 清单适合当交叉源。漂移方向是**单向的**:env 里有 4 个开关没进 registry。这 4 个**单列一节**,不进 62 条圈选(它们不属于「新增 62」,属于「压根没登记」)。

**但这 4 个不是一类东西(Codex R1 HIGH-3)** —— 一开始我给它们同一套「补登记 / 清掉」选项,那是错的。按 `truth.ts` 里它们自己的定位分三类,选项也分开:

| 变量 | 类别 | `truth.ts` 原话 | 该给什么选项 |
|---|---|---|---|
| `FLYWHEEL_ALERT_ROUTING` | 内部运维杆 | "internal ops lever: D1 responder-based alert routing …, default-off" | 转正 / 维持内部杆 / 清掉 |
| `FLYWHEEL_ALERT_TICKETS` | 内部运维杆 | "internal ops lever: 🎫 ticket schema header …, default-off" | 同上 |
| `FLYWHEEL_QUOTA_QA_INJECTION` | **刻意不登记的 QA 接缝** | "internal **QA-only** safety lever: explicit env=1 **plus** an isolated-pane marker" | **不给「补登记」** —— 把故障注入放进控制台等于给它一个不该有的入口 |
| `FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED` | **刻意不登记的运维接缝** | "internal ops lever: opt-in reap of **unattributed** Chrome, default off" | **不给「补登记」** —— 认不出归属的 Chrome 可能是 founder 自己开的窗口 |

前两个在生产是 `=1`(开着),问的是「转正吗」而不是「漏登记了」;后两个默认关、生产没设,**留在代码里不进控制台本身就是设计意图**。

## 6. 🟡 发现 D:1 个默认开的兜底开关被显式关掉,没有记录原因

```
# ~/.flywheel/.env:138
FLYWHEEL_CMUX_LINKED_VIEW=0
```

- 它是什么:FLY-1272 的 cmux 窗口拓扑修复。开着 = managed tab 用 exact-one-window link 拓扑;`=0` = 回滚到修复前的 grouped legacy 拓扑。
- 注册表默认是**开**,生产被显式**关**了。
- `.env` 那一行**没有注释**;`grep -rn CMUX_LINKED_VIEW` 在 `engineering/doc/` / `product/doc/` 下只有 FLY-1272 自己的 research 和 QA 脚本,**没有任何地方记录为什么生产要关它**。

→ 「为什么是这个状态」如实标 **UNKNOWN**,不编。这条要 Tadashi 补事实。同批的 `cmux_view_invariant` 反而是 `=1`(和默认一致),两条一起看更像是有意为之的中间态,但没有证据。

## 7. 顺手看到、但明确不在本单动的

`~/.flywheel/.env` 里 `FLYWHEEL_SWAP_PRESSURE_LOW_PCT` 出现了两次(`=95` 然后 `=99`),按 dotenv 后写覆盖先写,实际生效 `=99`。这是**值配置**不是 flag(在 Tadashi 那 391 个里),按 Lead 的指示不混进圈选。记在这里给运维,不进 HTML。

## 8. 现状怎么写才不骗人

### 8.1 「现值」是磁盘值,不是活值(Codex R1 HIGH-1)

第一版卡片上写的是「现状」,这个词**过度声称**了。extract 读的是磁盘上的 `~/.flywheel/.env` 和各项目 `config.yaml`,它**不知道**跑着的 Bridge 进程内 `process.env` 是不是还是旧值 —— 如果某个值改过、相关进程还没重启,进程里的活值和磁盘值就是两回事。仓库里正式的 resolver(`resolve.ts`)本来就把 `bridgeEffective` / `fileEffective` / `displayEffective` 分成三个概念并显式报 divergence,正说明这个区分是真的。

本单不去接活值(交付时 Bridge 未必可达,接了反而多一个会假绿的依赖),而是**把措辞改准**:卡片那一栏改叫「**配置里写的值**」,并在页面顶部用一条醒目提示写明「这不等于跑着的进程里的活值,要看活值查控制台」。

### 8.2 三段各有独立取证

1. **配置里写的值** —— 来自 snapshot(按该 flag 自己的语义折算),标注是「显式设过」还是「跑默认」。
2. **运行时是不是真的生效** —— 死壳那 13 个由具名覆盖表标红说明,**压过**第 1 段。这是本单相对 FLY-1136 新加的一层,每条带一条从读点到 hard-off 根的取证链。
3. **改了怎么才生效** —— 立刻生效 / 要重启 Bridge / 要重启各 Lead / 下次命令行调用;跨进程消费者另用 🔌 标出。这一列 Tadashi 明确要求保留。

### 8.3 决定要绑在事实版本上(Codex R1 HIGH-6)

注册表两天涨了 10 个,这张表交付当天很可能又变。所以圈选结果不能是一张飘着的清单:页面把 `注册表内容哈希 + 基线 commit + 本次审计条数` 拼成一个**事实版本串**,同时写进浏览器本地存档的键和导出 markdown 的抬头。作用有两个 —— 重新生成一版之后旧的「已过目」勾不会串过来;下游执行单能核对「这份决定是基于哪一版事实做的」。

第 2 段之外的运行时行为(比如某个默认开的 flag 是否真的在跑)**没有独立验证**,卡片上按 FLY-1136 的做法标「运行未独立验证」,不冒充事实。
