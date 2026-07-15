# FLY-1142 swap-sensor 改看真实内存压力 — 探索

Issue: FLY-1142 (https://linear.app/geoforge3d/issue/FLY-1142/fix-swap-sensor-改看真实内存压力-freepercent-swapout-delta弃用只涨不缩的-swap-水位-根治)
日期: 2026-07-10
基于: 无

---

## 1. 问题(一句话)

fleet swap 传感器把 **swap 水位(usedPct)** 当"内存危险"的触发/解除信号,但 macOS swap **只涨不缩**——一次 OOM 留下的高水位是"昨天的疤",机器早已健康却永远回不到解除阈值以下,于是 `pressure-hold` 卡死、**挡掉全部 runner 准入 8+ 小时**(`/api/runs/start` 也走同一 `tryAdmit`)。当前靠 `.env` 里 `HIGH=99/LOW=99` 的拐棍压着,本单要把拐棍换成真修。

## 2. 卡死机制(准入链路,代码级坐实)

```
/api/runs/start (runs-route.ts:323)  ┐
run-dispatcher.ts:664                 ├─→ RunnerAdmissionController.tryAdmit()
                                      ┘        (runner-admission.ts:228)
   └─ pressureHoldProbe() 非空 → { admit:false, reason:"pressure_hold" }   ← 挡准入
          probe = () => store.getFleetPressureHold() ? detail : null       (plugin.ts:3012)
```

`fleet_pressure_hold` 是 StateStore 里一条 **durable 单行**(id=1,StateStore.ts:1424)。只要这行在,`tryAdmit()` 就对每个新 runner 返回 `pressure_hold`。这行**只有** `liftSensorHold()` 会清(fleet-sensors.ts:172)——而清的条件坏了。

## 3. 根因(两处坏阈值,都锁在"只涨不缩"的 swap 水位上)

### 根因 A — 触发/解除信号本身是单调水位 (`machine-watermark.ts:120-143`)

`SwapPressureMonitor.tick()` 拿 `usage.usedPct`(swap 已用百分比)当状态机输入:

- trigger:`usedPct >= HIGH(80)` 连续 2 tick;
- clear:`usedPct < LOW(65)`。

macOS swap 是**存量水位、只涨不缩**(不重启不回收)。13:07 那次 OOM 把 swap 顶到 ~94%,之后机器早健康了(实测 41–50% free、swapout-delta=0、零 thrash),但 `usedPct` 是昨天 OOM 留的疤,**永远回不到 LOW(65) 以下** → `tick()` 永远不发 `"clear"` → hold 永不自动解。

### 根因 B — restart-safety lift 也 gated 在同一坏阈值上 (`fleet-sensors.ts:157-168`)

Codex R1 HIGH-1 曾补的"重启后自愈"逻辑:Bridge 重启后 monitor 内存态从 `normal` 起(`inPressure=false`),durable hold 行还在,于是尝试 lift——**但只在 `usage.usedPct < th.lowPct` 时才 lift**。stranded 场景里 swap 水位仍 94% > LOW,`if` 恒为 false → 不 lift。**这就是 21:11 那次普通重启也没清掉 hold 的原因**(实测印证)。

> 注:`recoveryProbe("swap_pressure_high")`(fleet-sensors.ts:380) = `!swapMonitor.inPressure`,重启后 monitor 是 normal 就 resolve 工单——但它只 resolve **告警工单**,不 lift **hold 行**。hold 的解除完全压在坏了的 lift 上。

### 根因 C — stopgap 拐棍 (`~/.flywheel/.env:134-136`)

```
FLYWHEEL_SWAP_PRESSURE_HIGH_PCT=99
FLYWHEEL_SWAP_PRESSURE_LOW_PCT=95     ← 被下一行覆盖
FLYWHEEL_SWAP_PRESSURE_LOW_PCT=99
```

把两阈值顶到 99,让"只涨不缩"的水位极难越过 HIGH、也极易掉到 LOW 下——治标不治本,真 OOM 时也几乎不再预警。本 fix 上线后必须撤掉这三行。

### 根因 D — 缺 sanctioned「纯 env 改动重启 Bridge」路径 (`restart-services.sh`)

restart-services.sh 按 **changed-files** 决定是否重启 Bridge(`classify_changes` line 497-534,`packages/teamlead/*`→restart_bridge)。`~/.flywheel/.env` 不在 git 里 → 无 code-delta → `DEPLOYED_SHA==HEAD` 直接 `exit 0`(line 468-482),**永不重启 Bridge**。今晚撤 stopgap 改 .env 后,只能走 guard-bypass 手动 kickstart。需要一条正当的 `--bridge-only`(env reload)路径。

## 4. 真实压力信号(实测,来自 `vm_stat`)

本机实测(2026-07-10,Apple Silicon 48GiB):

```
sysctl vm.swapusage : used = 19793.62M / 20480M = 96.6%   ← 存量水位(疤,不可靠)
vm_stat header      : page size of 16384 bytes            ← ⚠ 关键
sysctl hw.pagesize  : 4096                                ← ⚠ 与 vm_stat 不一致!
hw.memsize          : 51539607552 (48 GiB)
Pages free=14248  inactive=685708  active=698049  wired=541835  Swapouts=15351310
```

### ⚠ page-size 陷阱

`vm_stat` 用 **16384** 计页,`sysctl hw.pagesize` 报 **4096**。用 16384 累加 `free+active+inactive+…` ≈ `memsize/16384` ≈ 3.14M pages **对得上**;用 4096 会差 4×。**结论:必须从 vm_stat header 解析 page size,或用纯页数比例(免疫 page size)——绝不能用 hw.pagesize。**

### 两个真实信号

1. **free%** = `(Pages free + Pages inactive) / Σ(所有页桶)`。纯页数比 → 免疫 page size。低 = 危险。issue 说今晚健康时 41–50%。
2. **swapout-delta** = 两个采样点之间 `Swapouts` 计数器的**增量** = 是否**正在** thrash。`Swapouts` 本身也是累计计数(只涨),但它的**增量能归零**——这正是与"存量水位"的本质区别:不 thrash 时 delta=0。

> swap `usedPct` 不是全无用:它可作为**人类可读的显示信息**保留(server-loss 通知里的 `lastWatermark`),但**不再当触发/解除信号**。

## 5. 方案方向

| # | 改动 | 文件 |
|---|------|------|
| 1 | 新 `readMemoryPressure()`:跑 `vm_stat`,解析 page size + 算 free% + 取 Swapouts;`SwapPressureMonitor`→`MemoryPressureMonitor`:tick 用 free%(低阈触发/高阈解除,语义翻转)+ swapout-delta(>0 触发/=0 解除)。保留 `FLYWHEEL_SWAP_SENSOR_CMD` 注入 seam。 | `machine-watermark.ts` |
| 2 | swapTick 用新信号;**restart-safety lift 改判**「真实压力健康」(free% 高 + swapout-delta=0)才 lift stranded hold,不再 gated 在 usedPct。 | `fleet-sensors.ts` |
| 3 | 撤 stopgap 三行(fix 上线后)。 | `~/.flywheel/.env` |
| 4 | 补 sanctioned `restart-services.sh --bridge-only`(env reload)。 | `restart-services.sh` |
| — | 更新单测。 | `__tests__/machine-watermark.test.ts`, `__tests__/fleet-sensors.test.ts` |

**信号组合(推荐,安全侧)**:**OR 触发**(free% 危险 *或* 正在 thrash 任一成立即 hold,宁保守)+ **AND 解除**(free% 回升 *且* swapout-delta=0 两者都健康才解,避免抖动过早解)。沿用现有 2-tick 迟滞。

## 6. 验收(issue 给的三场景,用 `FLYWHEEL_SWAP_SENSOR_CMD` 注入 vm_stat 替身)

- ① 真压力(低 free% / 持续 swapout)→ hold **置上**;
- ② 压力解除(free% 回升 / swapout 归零)→ hold **自动清**;
- ③ **swap 水位高但 free% 健康(今晚这个疤场景)→ 不置 hold**(新 sensor 根本不看 swap 水位,天然通过)。
- \+ 全回归绿 + Codex xhigh review。

## 7. 待 Lead 确认的设计决策(brainstorm gate)

1. **`--bridge-only` scope**:本单一起做,还是拆子单?(issue 说"本单或拆子单")。推荐**本单一起**——同一事故的完整闭环,改动小。
2. **信号组合**:同意「OR 触发 / AND 解除 / 2-tick 迟滞」的安全侧默认?还是要更精细(加权 / 只认 swapout)?
3. **命名**:`SwapPressureMonitor`→`MemoryPressureMonitor` 重命名(诚实)是否可接受?durable 行的 `set_by="swap-sensor"` 保持不变(兼容 stranded 行 attribution + liftSensorHold 匹配)。
4. **stopgap 撤除时机**:确认由 **Implement/ship 阶段**在 fix 上线后撤 .env 三行(design 阶段不碰生产 .env)。
