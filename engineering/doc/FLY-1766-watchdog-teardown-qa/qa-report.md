# FLY-1766 QA·PR #838 拆看门狗全家 — 独立回归验证报告

Issue: FLY-1766 (https://linear.app/geoforge3d/issue/FLY-1766/qafly-1560-独立回归验证-pr-838-拆看门狗全家founder-直令)
日期: 2026-08-14
基于: 无(独立 QA 卫星单;不读实施体转述,逐条自跑)

---

## 0. 结论速览

**VERDICT: PASS** —— 四条被测主张(残留守卫 / 探针双读 / rider 锚点 / 回归面)全部独立复现,
9 个突变全部按预期变红,生产零触碰。附 **4 条 advisory + 2 条 INFO**,**均不阻塞 merge**。

> 本单是卫星复核,**verdict 不进引擎**。#838 的 merge 硬门(FLY-1573 开关 a–d 证据)与本报告无关,
> 我没有验证它、也没有推动它 —— 那一栏仍然是空的。

| # | 验收项 | 结果 | 关键证据(可复跑) |
|---|---|---|---|
| 1 | 残留守卫真实性 + 阳性对照 | ✅ PASS | 23 命中 / 3 文件 = 逐条对上豁免清单;守卫 7/7 绿;**5 个突变全红**、还原后回绿 |
| 2 | 探针 v1/v2 双读 | ✅ PASS | 套件 **30/30**(含真 producer 交叉验证);修前/修后 A/B 因果基线;**活体生产只读实跑** |
| 3 | rider 锚点(首 tick 不烧锚) | ✅ PASS | 自建 50-tick 重放 5/5,逐 tick 点名;生产接线核实竞态真可达;anchor-burn 突变两套 harness 全红 |
| 4 | 回归面(删掉的职责有去处/已判死) | ✅ PASS(代码面) | 9 条职责逐条落地核对,含 ack-policy 内联 **bind 元数+取值逐一对齐** |
| 5 | 套件 / build / lint / CI | ✅ PASS | 53/53 + 30/30 + 2/2 + 改动测试文件 14/14(122 断言);CI **9/9 绿 @ 精确 head** |
| 6 | 破坏性验证 | ✅ PASS | 9 个突变(守卫 5 / rider 1 / 探针 3),全部按预期红,全部还原,工作树 tracked diff 为空 |

**Advisory(建议修,不拦车)**:F1 Lead 巡检规则仍把已死事件说成活的 · F2 两个 infra-bot 的
identity 提示词仍点名 LeadWatchdog · F3 探针套件的最强证据会静默跳过、且不在 CI 里 · F4 一条注释腐化。

---

## 1. 环境与口径(先把仪器说清楚)

| 项 | 值 |
|---|---|
| 被测 | PR #838,branch `flywheel-FLY-1560`,head `a30e4c70f330843f71e55913881dd6a96060702e` |
| head 核对 | `gh pr view 838` → `headRefOid` 逐字一致、`isDraft:false`、`mergeable:MERGEABLE` |
| merge-base | `97dec19bd35f02e57befdf5ed15a00900f399786`(修前基线取自这里) |
| 规模 | 152 文件,+3775 / −6917(净删 3142 行) |
| 隔离验证载体 | **独立 detached worktree**(scratchpad `frozen-838`),node_modules 只读 symlink 自 1560 worktree |
| 共享 worktree | `~/Dev/flywheel-FLY-1560` **一次都没写、没 checkout**(遵 `feedback_readonly_retest_frozen_head_in_shared_worktree`) |
| 分支写入 | **零 commit 到 `flywheel-FLY-1560`**(head 已绑卡,不许漂移) |
| 生产 | 只读 `curl /health`;跑前 `ok=True buildSha=f3a27971e`,跑后同值;load 22.57 → 15.02(**未加压**) |

**为什么没开 529 房**:本单三个运行时面分别是 ① 一个 shell 探针、② GatePoller 的一个 rider、
③ `/health` 的 schema。① 我用**真 producer 编出来的 artifact** + **活体生产 JSON** 验了;
② 我用**真 GatePoller 类**驱动验了;③ 是源码契约。529 房能加的唯一增量是「真重启后看 v1→v2 翻面」,
而那必须在 merge 之后、且本 PR 的 merge 本来就被 FLY-1573 硬门卡着 —— 见 §7 诚实边界。

---

## 2. 验收 1:残留守卫是真的,不是摆设

### 2.1 我自己跑 grep,不看转述

```
grep -ri watchdog packages/teamlead/src   →  23 命中 / 3 文件
  20  src/bridge/__tests__/fly1560-teardown-guard.test.ts     ← 守卫自己的字符串常量+正则
   1  src/bridge/__tests__/gate-poller-lead-reconcile.test.ts ← expect(plugin).not.toContain("RunnerIdleWatchdog");
   2  src/__tests__/fixtures/lead-panes/idle-product-lead.txt ← issue 明文豁免的夹具
```

逐行看过:**没有一条是活代码**。与 PR body §7.1 的豁免清单**逐条对上**,没有第四类。

### 2.2 守卫本体是可执行谓词,且不会烂掉

`fly1560-teardown-guard.test.ts` 遍历整个 `teamlead/src` 树,豁免只有三样:自己、`fixtures/` 目录、
一张 **精确路径 → 逐字行** 的 allowlist。而且它还反过来断言「每条声明的豁免必须真的还命中」——
**过期的豁免会大声失败**,不会静默变宽。这一条设计得很干净。

### 2.3 突变检验(我自己做的阳性对照,不采信 PR 里那句)

| 突变 | 期望 | 实测 |
|---|---|---|
| M1 往 `bridge/rescue.ts` 尾部注入一行含家族词的注释 | 红 | ✅ 红(残留巡查) |
| M2 重新创建已删的 `bridge/LeadWatchdog.ts` | 红 | ✅ 红(物理删除断言) |
| M3 删掉改名幸存者 `BridgeEventLoopGuard.ts` | 红 | ✅ 红(幸存者断言) |
| M5 把被豁免那行改写(不再逐字匹配) | 红 | ✅ 红(变成 offender) |
| M5b 把被豁免那行整行删掉 | 红 | ✅ 红(`expected [] to deeply equal [Array(1)]` = 过期豁免大声失败) |
| — 全部还原 | 绿 | ✅ 7/7 绿 |

### 2.4 已声明的盲点(是边界,不是缺陷,但要写下来)

- 任何**名字叫 `fixtures` 的目录**整个跳过 —— 我放了个 `src/bridge/fixtures/qa1766-probe.ts`
  (含 `leadWatchdogTick` + `// watchdog`),守卫**不报**。这比 PR body 只声明了一个夹具文件要**宽**。
- 只扫 `.ts/.tsx/.js/.md`。我放 `src/bridge/qa1766-probe.sh` 含家族词,守卫**不报**。
- 作用域只有 `packages/teamlead/src`(= issue 验收 1 的原文范围),全仓其余靠人工 keep-list。

守卫**在 CI 里跑**(`unit-tests` job 三个 teamlead 分片),不是本地一次性。

---

## 3. 验收 2:探针双读 —— 我把被跳过的那条最强证据逼着跑起来了

### 3.1 先说一个 PR body 与干净环境不一致的地方(F3)

按 PR body,`bridge-liveness-probe.test.sh` 是「**30/30(含真 producer 交叉验证)**」。
我在干净 checkout 上第一次跑,拿到的是:

```
[TEST] — T12 real-producer cross-check skipped (teamlead dist not built)
bridge-liveness-probe: PASSED=29 FAILED=0
```

**29 + 1 静默跳过,而且跳过不计失败。** 被跳过的恰恰是「拿真 `buildLivenessManifest` 输出喂探针」
这条唯一能抓住 producer/consumer 漂移的断言 —— 手写 fixture 天生抓不到它。

我没有绕过去,而是**自己从冻结源码编了那个 artifact**(`esbuild --format=esm`,匹配
`packages/teamlead/package.json` 的 `"type": "module"`;第一次编成 cjs 时 `require()` 拿到空
namespace、T12 直接 FAIL —— 这本身证明这条断言是**真会红的**,不是空过绿),然后:

```
[TEST] ✓ T12 real buildLivenessManifest output: fresh healthy, hung owner flagged
bridge-liveness-probe: PASSED=30 FAILED=0
```

**30/30 成立** —— 但成立的前提是「dist 已构建」。见 §6 F3。

### 3.2 双读的四个读点(源码逐点核)

`_manifest_filter='((.liveness // .watchdogs) // {})'` 被这四处全部使用:
`liveness_manifest_valid` / `w1_liveness_unhealthy_reason` / disabled-lanes 派生 / stalled-leads 派生。
schema 接受 1 或 2;**legacy v1 故意不判 freshness**(`(( schema < 2 )) && return 0`);
v2 额外强制 W-1 字段完整性(`switch: required` / freshness 枚举 / `in_flight_age_ms` 类型)。
`scripts/check-flag-truth.ts` 同样双读(`body.liveness ?? body.watchdogs`),其套件 2/2。

### 3.3 因果基线:修前**真的会 page**,修后不会(不是「先后」,是对照)

instrument:同一份 body,分别喂 **merge-base 的探针** 和 **PR head 的探针**,各自用**各自那一代的
env 旋钮名**(修前是 `FLYWHEEL_WATCHDOG_MANIFEST_*`,修后是 `FLYWHEEL_LIVENESS_MANIFEST_*`),
驱动到真实 page 阈值(grace 1min × degraded 3 次)。
v1 body 由 **merge-base 的 `watchdog-health.ts` 真 producer** 生成(第一版我手工从 v2 削出来的 v1
缺 `w4_lead_blocked`,导致修前探针也 degraded —— 那是**我的 fixture 错**,已弃用并换成真 producer)。

```
BEFORE  | 真 v2 manifest          | verdict=degraded 5 | pages=1
          ↳ 🚨 Bridge 可达,但 watchdog manifest 缺失或不完整 — 安静不能证明没事(FLY-1393)。
AFTER   | 真 v2 manifest          | verdict=ok         | pages=0

BEFORE  | 真 v1 manifest(真 producer) | verdict=ok    | pages=0     ← 仪器自证:修前探针对自己那代是绿的
AFTER   | 真 v1 manifest(真 producer) | verdict=ok    | pages=0     ← rollout 窗口另一侧也安全
```

事故场景**实锤复现**:部署后 Bridge 发 `liveness`+v2、探针还是旧的 → 每 tick 把健康 Bridge 读成
「manifest 缺失或不完整」→ page founder。修后消失,且**两个方向都不误报**。

### 3.4 活体生产只读实跑(真数据,不是 fixture)

今天的生产 Bridge(`buildSha=f3a27971e`,pre-1560)`/health` 顶层键 = **`watchdogs`(v1)**。
把 PR head 探针以只读姿态(独立 state 文件 + `_probe_post` 改写进本地日志 + 不带 bot token)
对准它:

```
live /health top-level manifest key: watchdogs(v1)
AFTER   | fresh state | verdict=ok | pages=0
BEFORE  | fresh state | verdict=ok | pages=0
```

**新探针读今天的真生产 v1 manifest = 健康、零 page**,不会在部署前那一侧造成回归。

> 自曝一个我自己的仪器 bug:第一版这个脚本让两代探针**共用同一个 state 文件**,于是 BEFORE 在第二
> 次跑时把 STALLED_COUNT 从 1 累加到 2、越过阈值发了一条 W-2 stalled page,看起来像「两代行为不同」。
> 其实两边默认阈值都是 2,**是我的 harness 污染**。改成各自独立 state 后两边一致。写在这里,是因为
> 如果我不查这一步,就会报一个不存在的差异。

### 3.5 W-1 换驱动是真的换了(不是首尾打点糊弄)

`HeartbeatService.check()` 里:`livenessGeneration = runLivenessChain ? tracker.started() : undefined`,
`finally` 里只在 `livenessGeneration !== undefined` 时 `completed(generation)`。
`LivenessCheckTracker.completed()` 又只在 `activePasses.delete(generation)` 成功时才刷新 —— 于是:

- 被 single-flight **跳过的 tick 不会刷新 completed** → 变 `stale`,**不会假 fresh**;
- **别的 generation 替不了仍挂起的 owner 清 in-flight** → 挂死的 owner 老实报 `in_flight` + 年龄。

`livenessWiring.liveness` 初值 `false`,只在 tracker 真交给 HeartbeatService 之后(plugin.ts:6547)
才翻 `true` —— 不会出现「wired:true 但没人驱动」的假健康行。

---

## 4. 验收 3:rider 锚点

### 4.1 竞态是真可达的(不是纸面担心)

`plugin.ts`:`gatePoller.start()` @ **8026**;`runnerQuotaScanPassHolder.current=` @ **9539**;
`leadReconcilePassHolder.current=` @ **9693**。两者之间有 **49 个 `await`** —— 事件循环会让出多次,
慢启动超过一个 3s tick 就会有未装配的 tick 落下来。生产两个 readiness 探针都真接了
(`onLeadReconcileReady` / `onRunnerQuotaScanReady`,plugin.ts:7473/7475),不是死配置。

### 4.2 我自己写的 50-tick 重放(逐 tick 点名,不复用实施体断言)

`qa1766-rider-replay.test.ts`(只在隔离 worktree,不进 PR)记录**精确触发 tick 号**:

| 场景 | 期望 | 实测 |
|---|---|---|
| N=7,第 13 tick 装配 | `[13,20,27,34,41,48]` | ✅ 一致 |
| N=200(生产 cadence),第 5 tick 装配,**无** ready 探针(= 修前语义) | 50 tick 内一次不跑 | ✅ `[]` |
| 同上,**有** ready 探针 | 装配即跑 | ✅ `[5]` |
| N=3,第 30 tick 装配 | 绝不早于 30 | ✅ min=30 |
| 慢 pass 卡住 20 个 tick | 只跑 1 次,释放后下一 tick 续 | ✅ 1 → 2 |

第 2/3 行就是内建的阴阳对照:**唯一变量是 ready 探针**,修前语义会把开机那轮对账推迟整整一个
cadence(生产 = ~10 分钟)。

### 4.3 cadence 等价性(PR 说「N≈200×3s≈10min」,我去查了旧值)

merge-base `LeadWatchdog.ts:45` `DEFAULT_LEAD_WATCHDOG_INTERVAL_MS = 10 * 60_000`,
`onPollComplete` 在 `cycleCompleted` 时触发 = 每 10 分钟一次。
新:GatePoller `everyNTicks=200` × `pollIntervalMs=3000` = 600s = **10 分钟**。**等价成立。**

### 4.4 突变

把 `riderDueThisTick` 改成「未 ready 也先烧锚」(即修前 bug):
**我的 5 条重放红 3 条 + 实施体的 8 条红 1 条**,合计 4 红;还原后 13/13 全绿。

---

## 5. 验收 4:删掉的每个职责,去处或死刑逐条落实

| # | 被删职责 | 裁定 | 我的独立核实 |
|---|---|---|---|
| D1 | RunnerIdleWatchdog 的 idle 巷 | **判死** | `runner_idle_detected` 在 head **零非测试引用**(发射器、路由、消费者全无) |
| D2 | 额度 / 登录扫描(搭车件) | **搬 GatePoller rider** | `makeRunnerQuotaScanPass` 里 quota+auth **两条都在**,1h/session 节流门(`intervalMs`)保留 |
| D3 | Lead pane blocked 四 kind 的进程内发射 | **路径死,kind 活** | 四个 kind 在 `alert-kind-copy.ts` / `lead-alert.sh` / `pane-blocked-classifier.ts` **三处都在** |
| D4 | LeadWatchdog 上挂的 5 条 rider | **搬 `lead-reconcile-pass.ts`** | 顺序逐字为 lease → identity → outbox → **fleetSensors → alertHub.reconcile**(明文依赖没反) |
| D5 | `onLeadRecovery` 实时钩子 | **申报删除** | 生产零引用;只剩 `AlertChannelHub.ts:12` 一条**过期注释**(→ F4) |
| D6 | 45s stall 降级引擎 | **判死** | `runner-status.ts` 里 `setInterval/setTimeout/Date.now()` **一个都不剩**(纯 capture + heuristic) |
| D7 | account-switch watchdog | **判死** | 全仓零引用(只剩守卫测试里的字符串) |
| D8 | `LeadHealthProbe`(Codex Lead 30min 静默推断) | **判死** | `healthProbe` 全仓零非测试引用 |
| D9 | `lead-event-ack-policy.ts` | **内联冻结值** | 旧函数恒返 `null`/`false`;内联后 SQL bind **3 参数还是 3 参数**,取值 `0/null/null` 与旧式求值**逐一相等** |
| D10 | `HeartbeatService` | **不动** | diff = +20/−7,非注释增量**只有 W-1 tracker 接线**,收尸/对账逻辑一行未改 |

**替代面**(设计 §9 的「换成的」)在代码里都能指到实体:runner 自己报停(FLY-1571 hook)、
mailbox 租约重投 + 死信(FLY-1573)、Lead 到点巡检(FLY-1687 `onLeadPatrolTick`)、
HeartbeatService 收尸、quota daemon + 搬家后的 runner 扫描。

**残余盲区**(设计 §9 已申报、founder 已拍板接受,我只是复述并确认代码与之一致):
进程活着但癔症式卡死、Lead 卡在非额度非登录的 blocked 弹窗 —— 在巡检间隔内无人主动发现。

---

## 6. 发现(4 条 advisory + 2 条 INFO,均不阻塞 merge)

### F1 [MEDIUM-low] Lead 巡检规则仍把两个已死事件说成「Bridge 会推给你」

`packages/teamlead/lead-rules-base/runner-patrol-rules.md:45`:

> Reactive detection already exists (Bridge pushes `runner_idle_detected`,
> `session_stuck`/`session_orphaned`, gate events to your inbox).

在本 head 上:`runner_idle_detected` **零发射器**(本 PR 删的);`session_stuck` 已被 FLY-1570 删,
代码里就写着 `// Legacy persisted event; no longer emitted.`;只有 `session_orphaned` 还活着。
**三个里两个是死的。**

- 这个文件在 `lead-rules-bundle.sh:365` 被 emit,**每个 Lead 的规则包都带它**,不是单个 Lead 的事。
- research.md §8 **点名要求改写这个文件**(「runner-patrol-rules.md:45 等」),PR §7.2 也声称扫过
  Lead 规则 —— 这是**声明范围内的漏网**,不是范围外。
- 同一个 PR 把 `doc/qa/qa-context.md` 改成了「它已退役,再出现说明有人把它复活了」→ 仓库里现在对
  同一个事件有**两句互相打架的话**。
- 风险面:Lead 被告知「反应式检测已经有了」,可能少做那次主动点名 —— 恰是 FLY-1687 巡检要替掉的失效模式。

### F2 [LOW-medium] 两个 infra-bot Lead 的 identity 提示词仍点名 LeadWatchdog

```
.lead/claude-infra-bot-lead/identity.md:61  你自己挂了:launchd KeepAlive 会拉起 + LeadWatchdog 会在 Alerts 报你
.lead/codex-infra-bot-lead/identity.md:45   (同上)
```

- `.lead/<LEAD_ID>/identity.md` 是 `claude-lead.sh:819-820` 的**首选运行时提示词来源**(FLY-26)。
- 两个 agentId 都在 `~/.flywheel/projects.json` 的生产舰队里。
- 本 PR **一个 `.lead/` 文件都没碰**。
- 拆完之后 Lead 自己挂了的兜底是 launchd KeepAlive + `lead-alert.sh` + FLY-1687 巡检,**不是** LeadWatchdog。

### F3 [LOW] 探针套件最强的那条断言会静默跳过,而且整个套件不在 CI 里

- `T12 real-producer cross-check` 在 `packages/teamlead/dist` 缺失时打印一行 `—` 就跳过,**不计失败**;
  干净 checkout 上因此是 29 + 1 skip,而 PR body 写的是 30/30。
- `scripts/__tests__/bridge-liveness-probe.test.sh` **没有被 `.github/workflows/ci.yml` 引用**
  —— merge-base 与 PR head 都没有(**是既有缺口,本 PR 没有让它变差**)。
- 也就是说:本单最核心的修复(探针双读)的证据链,今天**没有任何自动门在守**。
- 建议:① skip 改成硬失败或在测试里就地 build;② 把这个套件接进 `script-tests` job(它已经有
  `check-flag-truth.test.sh` 的先例)。

### F4 [LOW] `AlertChannelHub.ts:12` 注释仍把 `onLeadRecovery` 写成活钩子

同一段注释后半句已经更新成「`reconcile`, run from the GatePoller lead-reconcile rider」,
前半句还留着 `onLeadRecovery` 这个已删钩子(顺带一个 `the the` 重复词)。

### F5 [INFO] PR body 与代码的两处口径差(代码更完整,不是缺陷)

- §1.3 列了 **9** 个退役 env;`truth.ts` 里 `retiredBy: "FLY-1560"` 实际有 **16** 条
  (多出 `FLYWHEEL_LEAD_WATCHDOG_INTERVAL_MS`、探针那 4 个 `FLYWHEEL_WATCHDOG_MANIFEST_*` /
  `_STALLED_ESCALATE_MIN` / `_DISABLED_REMINDER_MIN`、`FLYWHEEL_QUIET_*` 等)。
  我逐个 grep 过:**16 个退役名在非测试、非墓碑代码里零活消费者**,新名全部已注册。墓碑做得比 body 说得好。
- §5 说 HeartbeatService「行为零改动;仅 4 处注释」;实际还加了 W-1 tracker 接线(+20/−7)。
  research §6 是明说了的,只是 PR body 那一栏没跟上。

### F6 [INFO,与本 PR 无关,顺手看到的生产事实]

活体 `/health` 里 `claude-infra-bot-lead` 的 W-2 inbox 心跳 `freshness: "stale"`,
`last_success_at = 2026-08-13T23:09:11Z`(约 17 小时)。其余 15 个 Lead 全 `fresh`。
这跟 #838 无关(修前修后探针对它的判定一致),但值得 Tadashi 单独看一眼。

---

## 7. 诚实边界(我**没有**验的,以及为什么)

1. **没做真机重启 / 没开 529 房。** v1→v2 的翻面只能在 merge + 部署后于生产观察;而 #838 的 merge
   本来就被 FLY-1573 硬门卡着。我用「真 producer artifact + 活体生产 v1 JSON + 修前/修后 A/B」把这一面
   能在 merge 前证的都证了,**但这不等于生产切换实测**。部署后仍应看一眼探针首个 tick 是否安静。
2. **本地没跑 `pnpm -r build` / `pnpm lint`。** 宿主 load 22+,按既有纪律(全量套件会压穿生产宿主并
   影响生产 Bridge)不在这台机上跑全量。**我依据的是 CI 的 Quick Gate(build + typecheck + lint)
   在精确 head `a30e4c70f` 上绿** —— 这是外部证据,不是我本地实测,特此标明。
3. **没复现 PR 说的「17 文件 / 259 测」那一组。** 我跑的是本 PR **改动/新增的全部 14 个 teamlead 测试
   文件 = 122/122**(单线程,不加压),外加 CI 的 teamlead 三分片全量绿。
4. **守卫作用域边界**见 §2.4:`fixtures/` 目录整个跳过、只扫 4 种扩展名、只管 `teamlead/src`。
   全仓其余靠人工 keep-list —— F1/F2 就是我在人工那部分捞出来的。
5. **merge 硬门(FLY-1573 a–d)完全不在本单射程内。** 我没验、没推、也不为它背书。
6. **`.lead/` 与 `lead-rules-base` 的改动会不会引出别的回归**,我只做了字符串层面的事实核对,
   没有跑 Lead 真机会话去看行为差异。

---

## 8. 复跑清单(任何人可原样重放)

```bash
# 0. 隔离载体(绝不碰 1560 共享 worktree)
cd ~/Dev/flywheel && git worktree add --detach <scratch>/frozen-838 a30e4c70f330843f71e55913881dd6a96060702e
ln -s ~/Dev/flywheel-FLY-1560/node_modules <scratch>/frozen-838/node_modules   # 各 package 同理

# 1. 残留守卫 + 突变
grep -ri watchdog packages/teamlead/src            # 期望 23 命中 / 3 文件
cd packages/teamlead && ./node_modules/.bin/vitest run src/bridge/__tests__/fly1560-teardown-guard.test.ts   # 7/7
printf '\n// watchdog\n' >> src/bridge/rescue.ts && <重跑>   # 必红,然后还原

# 2. 探针(先编真 producer,否则 T12 静默跳过)
esbuild packages/teamlead/src/bridge/liveness-manifest.ts --format=esm --platform=node \
  --outfile=packages/teamlead/dist/bridge/liveness-manifest.js
env -u CODEX_INFRA_BOT_TOKEN TMPDIR=/tmp/ bash scripts/__tests__/bridge-liveness-probe.test.sh   # 30/30
TMPDIR=/tmp/ bash scripts/__tests__/check-flag-truth.test.sh                                     # 2/2

# 3. rider(独立重放脚本见本单 harness/ 目录)
./node_modules/.bin/vitest run src/bridge/__tests__/gate-poller-lead-reconcile.test.ts \
                              src/bridge/__tests__/lead-reconcile-pass.test.ts

# 4. 套件
TMPDIR=/tmp/ bash scripts/__tests__/fly1674-residue.test.sh                                      # 53/53
gh run view 31808341250 --json headSha,conclusion    # a30e4c70f… / success(9/9)
```

A/B 与活体只读的 harness 全文见同目录 `harness/`。
