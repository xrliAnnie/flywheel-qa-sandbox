# FLY-1456 62 flag 逐条定值执行 — 调研

Issue: FLY-1456 (https://linear.app/geoforge3d/issue/FLY-1456/flag治理清存量eng-62-flag-逐条定值执行-按-hl-盘点圈选-删固化动态化承接-fly-1413)
日期: 2026-07-24
基于: exploration.md

本文全部事实为 2026-07-24 在分支 `flywheel-FLY-1456`(已 fast-forward 到 `c3dd2475` = origin/main)上实测(grep / 读源码 / snapshot.json)。

## 1. flag 退休机制全链(现成基建,FLY-1243 已走通)

1. **registry**:`packages/config/src/feature-flags/registry.ts` — `FEATURE_FLAGS` 数组,每 flag 一个定义块(envVar、default、readSites、toggleable 等)。删除 = 删定义块。
2. **墓碑**:`packages/config/src/feature-flags/truth.ts:292` `RETIRED_FLAGS = [{ envVar, retiredBy }]`。加墓碑后 `validateFlagTruthEnvironment` 对 `.env` 里的残留行报「已退役假开关,删这行」——**生产 .env 清理由 check-flag-truth 体系托底**。
3. **drift 双向守卫**:`packages/config/src/__tests__/feature-flags-drift.test.ts` — 正向:生产 `src`(4 个 SCAN_DIRS,排除 __tests__/dist)里出现未注册的 `FLYWHEEL_*` 布尔 gate → fail;反向:已注册 flag 的 readSite 文件必须真含该 envVar。**删 flag = 两侧必须同步**:registry 定义删掉的同时,生产读点也必须清零,否则正向守卫红。
4. 相关测试:`feature-flags-registry.test.ts`(计数/存在性)、`feature-flags-resolve.test.ts`、`flag-truth.test.ts`。

## 2. 13 条死壳的实测读点(生产 src,排除 tests/registry/truth)

死因共同根:`watchdog-minimum-set.ts:41` `retiredWatchdogLaneEnabled(_env, _envVar): false { return false; }` — 参数带下划线根本不看,返回类型写死 `false`。`legacy-delivery-watchdog-policy.ts:11` `legacyDeliveryWatchdogsEnabled(): false` 直接转发它。

### 2a. park 家族(5 条)

| envVar | 读点 | 死法 |
|---|---|---|
| `FLYWHEEL_PARK_WATCH` | `park-watch.ts:181`(`==="0"` 早退) | `runParkWatch` 唯一 wiring 是 `plugin.ts:8055` `onParkWatchTick: legacyDeliveryWatchdogsOn ? parkWatchTick : undefined` = 永远 `undefined` |
| `FLYWHEEL_PARK_N1_MS` | `park-watch.ts:183` | 同上 |
| `FLYWHEEL_PARK_N2_MS` | `park-watch.ts:107` | 同上 |
| `FLYWHEEL_PARK_QA_N3_MS` | `park-watch.ts:186` | 同上 |
| `FLYWHEEL_PARK_WATCH_EVERY_N_TICKS` | `plugin.ts:8058`(cadence IIFE) | 喂给的 tick 本身从不被 wire |

`startParkWatch` / `runParkWatch` 无 park-watch.ts 之外的调用者(除 plugin.ts 的死 wiring)。

### 2b. delivery 家族(6 条)

| envVar | 读点 | 死法 |
|---|---|---|
| `FLYWHEEL_DELIVERY_ACK` | `lead-event-ack-policy.ts:13`(与总闸相与)· `plugin.ts:4529`(secret boot 预检)· `plugin.ts:4607`(coordinator `enabled:`) | 三处全部 `legacyDeliveryWatchdogsOn && …`,左侧恒 false |
| `FLYWHEEL_DELIVERY_UNCONSUMED_V2` | `plugin.ts:7295`(`gapScanTick` 内) | `gapScanTick` wiring `plugin.ts:8075` 被总闸钉死 `undefined` |
| `FLYWHEEL_DELIVERY_ACK_TIMEOUT_MS` | `lead-event-delivery.ts:86` | coordinator 构造时读,但 `enabled` 恒 false(:82 `options.enabled ?? deliveryAckEnabled()`,plugin 传入的就是恒 false 表达式) |
| `FLYWHEEL_DELIVERY_MAX_REDELIVER` | `lead-event-delivery.ts:91` | 同上 |
| `FLYWHEEL_DELIVERY_MAX_TRANSPORT_FAILURES` | `lead-event-delivery.ts:95` | 同上 |
| `FLYWHEEL_ACK_LATE_WINDOW_MS` | `lead-event-delivery.ts:99` | 同上 |

活的投递权威是 `LeadInboxRuntime`(`plugin.ts:4484` 附近无条件构造,注释「FLY-1373: comm.db is now the one durable Lead-delivery authority」),走 `receipt_foundation`(FLY-1392),与这 6 条无关 —— FLY-1413 四层取证结论,本次复核一致。

### 2c. 总闸 + checkpoint(2 条)

| envVar | 出现点 | 性质 |
|---|---|---|
| `FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS` | `watchdog-minimum-set.ts:9`(`RETIRED_WATCHDOG_ENV_VARS` 字符串表)· `legacy-delivery-watchdog-policy.ts:8-9`(`LEGACY_DELIVERY_WATCHDOG_ENV` 常量) | **无真实 env 读**——`retiredWatchdogLaneEnabled` 忽略参数。字符串只是「可发现的迁移墓碑」 |
| `FLYWHEEL_CHECKPOINT_WATCHDOG` | `watchdog-minimum-set.ts:10`(同上表)· `plugin.ts:3921`(传名给恒 false 函数)· `gate-poller.ts:2277`(`checkpointWatchdogEnabled()` 同模式) | 同上,无真实 env 读 |

`RETIRED_WATCHDOG_ENV_VARS` 第三项 `FLYWHEEL_ZOMBIE_GATE_RESOLVE` **不在 62 范围内**(baseline 侧),本单不动。

`legacyDeliveryWatchdogsOn` 在 plugin.ts 的下游穿透(20+ 处):`retiringWatchdogEnabled` 状态表(:3927,7 键)→ watchdog 状态上报(:4589)、GatePoller opts(:8042/8052/8055/8075)、misroute patrol(:8111-8112)、其他子系统(:6328/:7620/:10641/:10883)。**这决定了壳删除不动这个布尔本身**(它不读 env,不违反 drift 守卫)。

gate-poller 的 checkpoint patrol:`checkpointWatchdogEnabled()`(:2273)+ `maybeEmitCheckpointParkAlert`(:2289,首行 early-return)—— patrol 主体唯一可达自该谓词,属「随 PR 可局部删除」的死代码。

### 2d. 测试/脚本残留面

`scripts/`、`packages/teamlead/scripts/`、`lead-rules-base/` 对 13 个 envVar **零命中**。残留只在 `packages/*/src/**/__tests__/`(留给实现时逐个收敛,FLY-1243 §4 同款)。

## 3. quota_daemon_cutover 固化点(实测)

裁决:keep@1,固化 = 把 retired 写死后删 flag(Tadashi 取证:关 = 旧 account-switch 路由复活 = 回退)。

| 位置 | 现状 | 固化后 |
|---|---|---|
| `quota-daemon-cutover.ts:10-14` `quotaDaemonCutoverEnabled` | `env.FLYWHEEL_QUOTA_DAEMON_CUTOVER === "1"` | 函数删除 |
| `quota-daemon-cutover.ts:20-43` `resolveQuotaDaemonBridgeMode(poolConfigured, env)` | cutover ? retired 真值表 : legacy 真值表 | 恒返回 retired 真值表;`poolConfigured`/`env` 入参随之收敛(caller `plugin.ts:5666`) |
| `plugin.ts:473-474` import · `:5921` `quotaDaemonCutover: quotaDaemonCutoverEnabled` | 传谓词给 createBridgeApp | 消费者是 account-switch 路由:`account-switch-route.ts:121` `if (deps.cutoverEnabled?.())` → 410 retired。固化 = 路由**无条件 410**(与今日生产行为逐字节一致) |
| `scripts/setup-quota-monitor.sh:172,351` | `set_env_key FLYWHEEL_QUOTA_DAEMON_CUTOVER (1)` | 两行删除(脚本不得再写墓碑 var,否则 check-flag-truth 报错) |
| 生产 `.env` | 显式 `=1`(snapshot: `set:true,value:true`) | ship 时删该行(墓碑机制会主动提示) |

**这是 4 个 PR 里唯一改变「形状」的**:去掉理论上的 env 回退口。生产 =1,行为零变化;不可再经 env 回退 legacy 正是裁决本身(「关=回退,不能关」)。

## 4. 生产 .env 实况(snapshot.json 取证)

62 条里显式设过的 9 条中,涉及本单动作的 2 条:

- `FLYWHEEL_CHECKPOINT_WATCHDOG`:显式设(值 false)→ PR-3 墓碑后由 check-flag-truth 提示删行。
- `FLYWHEEL_QUOTA_DAEMON_CUTOVER`:显式 =1 → PR-4 墓碑后同上。

其余 12 条死壳生产未显式设 → 无 .env 清理需求。

## 5. FLY-1240-1243 模式提炼(照抄的先例)

- **粒度**:按内聚单元一个 PR(1240=删 founder-image-approval、1242=删 lead-pane-readiness、1243=批量 11 条固化 default-on)。隔离审:每 PR 独立 Codex review + 独立 QA。
- **TDD 顺序**(FLY-1243 plan §1):先 config 包(registry + drift/resolve/registry 测试)→ 再生产读点 → 再收敛 teamlead 测试(删 `=0` sentinel,off 路径不存在)→ 全仓绿。
- **最终裁判**:drift 正向守卫 —— 退休 envVar 在生产 src **零**残留,注册表**零**定义,两侧同步才过。
- **冲突教训**(#588):多个 PR 同触 registry.ts → 串行落地,后续 PR rebase。
- **验收 grep**(FLY-1243 §6 同款):`grep -rE "FLYWHEEL_(…)" packages/*/src` 排除 __tests__ = 零命中。

## 6. FLY-1405 接口(动态化交接)

FLY-1405 = 全部 138 flag 逐读点迁 call-time + 评估文件监听/云源,**等 FLY-1150 store**。本单只输出「幸存者标记」:执行台账里逐条给出 `1405 迁移候选?` 列(死壳删除后不再出现在 138 里,减轻 1405 面)。分开做、先删后迁 —— issue 原文。

## 7. 风险清单

1. **registry.ts 串行冲突**(4 PR 同文件)→ 计划内串行,明确顺序。
2. **测试面未知量**:13 个 envVar 在 `__tests__` 的命中数未逐个清点(实现节点第一步清点;FLY-1243 同款收敛法)。
3. **FLY-1413 docs 构建脚本的 registry 哈希守卫**(`build-tab.mjs` guard 2)会因 registry.ts 变更失配 —— 那是 docs 目录里的一次性归档脚本,不在 CI;**不动它,不重跑它**(归档物冻结在 #682/67b35748)。
4. **PR-4 形状变化**:legacy account-switch 回退口移除,rollback 只能 revert PR(不能 env 翻)——按裁决这是特性不是缺陷,但 ship 说明里必须写明。
5. **RESERVED 误伤**:`workflow_template_dispatch` 的 readSites 也在 plugin.ts / dispatcher 一带;4 个 PR 的 diff 必须与这两条 flag 的读点零交集(验收 grep 双向确认)。
