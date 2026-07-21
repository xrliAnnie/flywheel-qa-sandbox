# FLY-1393 看门收编 — 独立 QA phase 报告(三段式 QA)
Issue: FLY-1393
日期: 2026-07-21
基于: plan.md · qa-report.md(implement 阶段预检)· FLY-1391 watchdog-minimum-set.md(验收基线)

> 本文是三段式 pipeline 的 **QA phase** 独立验证记录(与 implement 阶段自写的 `qa-report.md` 预检区分)。
> 复核 head:`1d7482e71`(PR #660)。所有测试均在**干净 env** 下独立复跑(不信 CI、不信预检)。

## 结论(本轮 = 三段式 QA 第一轮)

**verdict = FAIL(PASS-except-w1-absent)。** 一条 Tadashi 已裁定的 MEDIUM(`w1-absent-mapped-to-dead`)
**真机复现确认**,须由 implement 修;其余能力面(代码/脚本/单测/变异 + 两条 real-tmux 真机段)全 PASS。

**唯一 FAIL(必修,已裁定):`w1-absent-mapped-to-dead`**
- 位置:`gate-poller.ts:3844` —— `if (verdict === "dead_pin" || verdict === "absent") return "dead"`。
- 错在:`absent` 只表示「按查到的窗名没有窗回应」,**CommDB tmux_window 映射过时时健康 runner 也返回它**
  (与 registry `park_biased_handoff` / FLY-1329 A1 同一纪律:只有 `dead_pin` 是死亡正证据)。把 `absent` 判死 →
  健康但映射过时的 runner 被误发 `stale_approved_ship_dead` 告警。
- 应改:只 `dead_pin → "dead"`;`absent` 落到 `indeterminate` 分支(diagnose + 幂等 reWake,不宣告死亡)。
- **真机复现(见 §七)**:真 tmux 出 `absent` → 生产映射判 `dead` → 真 `reconcileStaleApprovedShip` 发死亡告警
  (`deadAlerts=["E-absent"]`,`rewoken=[]`)。复现即正确(Tadashi c8ae71ba)。

**Tadashi 定的时序(fb07924c):** 先发本 FAIL qa-result → TURN 给 implement 修 absent≠dead → 修完我
**定向复测 + 一次性满跑三注入真机 E2E**(隔离房:杀进程→W-1 / 停投递循环→W-2 独立通道 / kill -9 隔离房 Bridge→
外部探针指测试通道)→ PASS 才开 approve gate。24h soak 保留为 ship 后补充观察,不替代。

**另一道门(Codex code review)**:当前 head 无 APPROVED 记录 —— 因 absent 修复会动 head,code review
应在 implement 修完的**最终 head** 上跑(避免白跑旧 head),与三注入 E2E 同轮。

## 一、复跑的测试(干净 env,TMPDIR=/tmp)

| 套件 | 结果 |
|------|------|
| `flywheel-config`(全包) | **527/527 PASS**(30 files) |
| teamlead 靶向:watchdog-minimum-set / watchdog-health / stale-approved-ship-reconciler / inbox-loop-health-checker / zombie-gate-watchdog / gate-poller-checkpoint-park / LeadWatchdog / HeartbeatService / stuck-escalation / runner-idle-watchdog-quota-scan / legacy-delivery-watchdog-policy | **200/200 PASS**(9 files) |
| config 特征标:feature-flags-drift / feature-flags-registry | **25/25 PASS** |
| `scripts/__tests__/bridge-liveness-probe.test.sh`(W-2 外部探针) | **20/20 PASS** |
| `scripts/__tests__/check-flag-truth.test.sh` | **2/2 PASS**(需 TMPDIR=/tmp,否则 tsx IPC pipe EINVAL) |
| CI(PR #660,9 jobs) | 全 SUCCESS |

**env 污染陷阱(记录给复现者):** QA runner shell 继承了 `FLYWHEEL_ZOMBIE_GATE_RESOLVE=0` /
`FLYWHEEL_CHECKPOINT_WATCHDOG=1` / `FLYWHEEL_WATCHDOG_JUDGE=1` / `FLYWHEEL_RUNNER_BACKEND=codex`。
带 `FLYWHEEL_ZOMBIE_GATE_RESOLVE=0` 直跑靶向套件会让一条 **Z1 低层算法测试**误红(它直调 env 驱动的
`zombieGateResolveEnabled`)—— **不是代码缺陷**;`env -u ...` 干净复跑即 200/200。CI 无此 env,故绿。

## 二、代码级证据(逐条能力)

### W-1 进程存活探测 —— 中心 bug 已修
- `RunnerIdleWatchdog.ts:274-279`:legacy 投递看门狗关停时,只有 `status === "idle"`(bare-shell)且
  `watchdogLivenessEnabled !== false` 才继续发射;`waiting`/`unknown` 结构性不可达,`liveness=off` 全静音。
  W-1 从 legacy 关停半径移出、由独立 `FLYWHEEL_WATCHDOG_LIVENESS`(default-on)门控 —— 正是 FLY-1391 §4 的分类纠正。
- 非告警 piggyback(runnerQuotaScan)不被 legacy 门连带关掉;stuckDetector(检测簇)仍随 legacy 关(批 2 退役)。

### G-1 死亡告警 —— 四态 probe + durable-accept
- `stale-approved-ship-reconciler.ts`:`isAlive`(布尔)→ `probe`(alive/dead/indeterminate);
  `indeterminate` 与 probe error 均 fail-closed(diagnose + 幂等 reWake,**不宣告死亡**);
  `alertDead` 返回 durable-accept,`deadAlerted` dedup **仅在 accepted 后**写 —— 修掉「首投失败→永久静音」。

### W-2 投递循环心跳 —— 独立 failure domain
- in-Bridge `InboxLoopHealthChecker` + 外部 `bridge-liveness-probe.sh`(独立进程/通道);
  manifest per-Lead 行、degraded 桶、stalled 桶(per-Lead 粒度、成员 update 不误 all-clear)、disabled 桶
  互不遮蔽 —— 20/20 shell 覆盖。

### W-3 外部漂移 —— 静态合同
- manifest `w3_external_drift.observation === "static_contract"`,`switch = required/no_switch`;校验器强制。

### W-4 活着但干不了活 —— episode 前置 gate
- LeadWatchdog blocked 巷判 `watchdog_blocked` 置于 `episodeKind`/recovery/cooldown/notifier 写入**之前**
  (无幽灵 episode);Runner 侧 session_stuck 同样 gate 于 dedup 之前;`blocked=0` 四面静音。

## 三、假开关(issue 明列 DETECTION_GAP_SCAN / STUCK_FOUNDER_PAGE)—— 两条均诚实

- **形态 A(已固化 default-on 的死 flag)**:`DETECTION_GAP_SCAN` / `STUCK_ERRORSIG` / `DETECTION_ESCALATION`
  → 进 `RETIRED_FLAGS` tombstone。独立 grep 证:三者在生产 src **零布尔 gate 读取**(仅注释残留);
  drift 测试 line 137「no retired tombstone is still read as a production boolean gate」主动守。
  真值脚本正控:tombstone → FAIL「删这行」、unknown → FAIL、clean → PASS。
- **形态 B(有读取、组件生产零馈送)**:`STUCK_FOUNDER_PAGE`(stuck detector 生产零馈送)
  → registry 标 `retiring: "FLY-1393"` + 进 manifest `RETIRING_WATCHDOGS`;
  plugin.ts:3772 `stuck_founder_page_killswitch: legacyDeliveryWatchdogsOn` —— manifest 的 `effective_enabled`
  跟真实馈送闸(`RunnerIdleWatchdog.ts:218` 同一 legacy 闸)同源,生产 legacy=off → 诚实报 `false`。
  **注意(诚实 caveat)**:真值脚本**静态层**放行 `STUCK_FOUNDER_PAGE=1`(它是已注册 flag);
  形态 B 的诚实**只由 `--live` manifest 层强制**(retiring 巷 `effective_enabled=true` = FAIL)。
  即验收③「检查脚本化」对 STUCK_FOUNDER_PAGE **必须跑 `--live`** 才成立,静态检查不足。

## 四、退役巷生产硬关(env=1 不能复活)—— 已行为级证明

- zombie(Z1):`gate-poller.ts:3600-3670` 生产 wrapper `zombieOn = retiredWatchdogLaneEnabled(...)` 恒 false,
  且向低层算法强灌 `FLYWHEEL_ZOMBIE_GATE_RESOLVE:"0"`;新反例测试(env=1 → wrapper 无 Z1 outcome)证明硬关。
- checkpoint-park:`gate-poller.ts:2106-2127` `checkpointWatchdogEnabled()` = `retiredWatchdogLaneEnabled(...)` 恒 false → 早 return。
- legacy_delivery_watchdogs / checkpoint / zombie → manifest `retiring[].effective_enabled=false`(生产)。

## 五、变异测试(证明断言非空过)

`validateWatchdogManifest` 四变异:
- GOOD → ok=true
- retiring `stuck_founder_page` `effective_enabled=true` → **FAIL**(假开关复活即红)
- 缺 `w1_process_liveness` 行 → **FAIL**
- W-2 lead 缺 `freshness` → **FAIL**(正是预检抓的 HIGH bug,现被强制)
- `w1 wired=false` → **FAIL**(「显示但没接线」被抓)

## 六、未执行(不得外推)—— 交给真机 E2E / ship 观察

- 真 runner kill(留 bare shell)→ W-1 落账 + Lead/Discord 收件。
- 停单 Lead inbox loop(fault seam)→ in-Bridge checker + 外部探针各自 episode、恢复、互不遮蔽。
- kill -9 Bridge 阻重生 ≥5min → 外部探针真 @Annie(FLY-1082 回归)。
- manifest 破坏 → `watchdog_manifest_degraded` 页 + 恢复 all-clear(真 /health)。
- 批 1 ship 后 24h claims/alert 账本零假警报 soak。
- **Codex code review(当前 head)**。

在以上完成前,本报告只证明代码 + 隔离 harness + 脚本 + 变异,不证明全部能力级 + 意图级验收已完成。

## 七、真机段(real tmux)—— 本轮已跑的两条

evidence 脚本:`qa-evidence/repro-w1-absent.ts`、`qa-evidence/repro-w1-idle.ts`(隔离 tmux socket,自建自杀,零生产接触)。

### 7.1 `w1-absent-mapped-to-dead`(预期 FAIL,已真机复现)
```
REAL tmux verdicts: live=alive absent=absent
mapped (gate-poller.ts:3843-3845): absent → dead
RECONCILER on absent-runner: deadAlerts=["E-absent"] rewoken=[]
⇒ absent(健康 runner 映射过时)被误发 stale_approved_ship_dead;应 diagnose+reWake。
```
端到端经真 `probeRunnerProcessLiveness`(真 tmux 查不存在的窗 → `absent`)+ 真 `reconcileStaleApprovedShip`。

### 7.2 W-1 idle 发射(正向,PASS)
```
real capture-pane of settled bare shell → detectTerminalStatus => idle
real waiting pane ("Do you want to proceed? [y/N]") → waiting
W-1 gate(RunnerIdleWatchdog.ts:274-279 逐字):
  legacy OFF + liveness ON + idle     → EMIT
  legacy OFF + liveness ON + waiting  → SILENT
  legacy OFF + liveness ON + unknown  → SILENT
  legacy OFF + liveness OFF + idle    → SILENT
```
真「Claude 进程被杀、只剩 bare shell」→ 分类 idle → W-1 发射;waiting/unknown/liveness=OFF 静音。

### 7.3 本轮未跑、留给修复后最终 head 一次性满跑(§六 + Tadashi fb07924c)
- 杀进程→W-1(隔离房真 runner,三锚杀进程,留 bare shell)+ Lead/Discord(测试通道)收件。
- 停投递循环→W-2 in-Bridge checker + 外部探针各自 episode / 恢复 / 互不遮蔽。
- kill -9 **隔离房自起 Bridge**(绝不动生产)→ 外部探针 page **测试通道**(不真 @Annie)。
- absent≠dead 修复的定向复测;当前 head 的 Codex code review。
- 生产库前后 integrity + 指纹零残留核对。
