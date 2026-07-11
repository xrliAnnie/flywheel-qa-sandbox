# FLY-1142 swap-sensor 改看真实内存压力 — 调研

Issue: FLY-1142 (https://linear.app/geoforge3d/issue/FLY-1142/fix-swap-sensor-改看真实内存压力-freepercent-swapout-delta弃用只涨不缩的-swap-水位-根治)
日期: 2026-07-10
基于: exploration.md

> 本文钉死"真实内存压力信号怎么读、怎么算"的**硬技术事实**——与 brainstorm gate 4 个决策无关,无论 Lead 怎么拍都成立。最终信号组合策略(决策 2)按推荐写并显式标注「待 gate 确认」。

---

## 1. `vm_stat` 输出结构与字段语义

本机实测(macOS,Apple Silicon 48GiB):

```
Mach Virtual Memory Statistics: (page size of 16384 bytes)   ← page size 在 header
Pages free:                    14248.   ← 完全空闲
Pages active:                 698049.   ← 活跃使用中(不可立即回收)
Pages inactive:               685708.   ← 最近未用,可回收(算作"可用")
Pages speculative:             10443.   ← 预读页,可回收
Pages throttled:                   0.
Pages wired down:             541835.   ← 锁定内核内存(不可回收)
Pages occupied by compressor: 1133442.  ← 压缩内存占用的物理页
Swapins:                     9212899.   ← 累计换入(计数器)
Swapouts:                   15351310.   ← 累计换出(计数器)← thrash 信号源
```

**内存回收性分类**(决定 free% 分子):
- **可用(可立即满足新分配)**:`free` + `inactive`(+ 可选 `speculative`、`purgeable`)。
- **不可回收**:`active` + `wired` + `compressor occupied`。

issue 明确给的定义:`free% = (Pages free + Pages inactive) / total`。本文据此实现;`speculative` 是否并入分子留作 plan 的次要调参(默认**不并入**,与 issue 字面一致,保守)。

## 2. ⚠ page-size 陷阱(本单最容易踩的坑)

| 来源 | page size |
|------|-----------|
| `vm_stat` header「page size of N bytes」 | **16384** |
| `sysctl hw.pagesize` | **4096** |

两者在 Apple Silicon 上**不一致**。校验:`hw.memsize / 16384 = 51539607552 / 16384 = 3,145,728` pages,与 vm_stat 各桶之和(~3.08M,差 ~2% 为内核保留/不可见页)**同量级**;用 4096 得 12.58M,差 4×,**对不上**。

**结论(硬规则)**:
- 若要把页数换算成字节 → **必须**用 vm_stat header 里解析出的 page size,**绝不能**用 `hw.pagesize`。
- **更优:根本不换算字节,用纯页数比**(见 §3 方案 C)——page size 完全不进入公式,免疫此陷阱。

## 3. free% 算法(三种,推荐 C)

设 vm_stat 各桶页数为 free/active/inactive/speculative/throttled/wired/compressor。

- **方案 A(memsize 法)**:`total = hw.memsize / pageSize(vm_stat header)`;`free% = (free+inactive)/total`。需可靠解析 header page size + 读 hw.memsize。
- **方案 B(注入 header page size 换算)**:同 A 但强调 page size 只能来自 vm_stat header。
- **方案 C(纯页数比,推荐)**:`total = free+active+inactive+speculative+throttled+wired+compressor`;`free% = (free+inactive)/total`。**page size 不进入公式** → 天然免疫 §2 陷阱,无需读 memsize/pagesize,单次 `vm_stat` 即可算。分母是"vm_stat 可见总页数"(略小于物理总量,但作为**相对**压力指标稳定且单调对齐)。

采用 **C** 作主实现;A 可作单测里的交叉校验(允许 ~2% 偏差)。

## 4. swapout-delta 算法(thrash 信号)

`Swapouts` 是**自 boot 单调累计**的换出页计数器(和 swap 水位一样"只涨"),但我们用的是它在**两个采样点之间的增量**:

```
swapoutDelta(t) = Swapouts(t) - Swapouts(t-1)
```

- `delta > 0` → 采样间发生换出 = **正在** thrash(内存压力把页往 swap 挤)= 危险。
- `delta == 0` → 无换出 = 不 thrash = 该维度健康。**这就是与"存量水位"的本质区别:存量只涨不缩,增量能归零。**
- **首次采样**(无前值)→ delta 未知 → 记为 0(保守,不因无历史误触发),仅记录基线。
- **计数器回绕/重启**(delta < 0)→ 记为 0 并重置基线(不误判为健康信号)。

> 采样节奏 = 现有 LeadWatchdog `onPollComplete` tick(fleet-sensors.ts piggyback,零新 timer)。delta 就是相邻两次 tick 的差。

## 5. swap `usedPct` 的去留

- **弃用**其作为触发/解除信号(根因所在)。
- **保留**为人类可读显示:`lastWatermark`(fleet-sensors.ts:127)→ `currentWatermark`(plugin.ts:6275)喂 server-loss 通知。
- 取舍(轻微依赖 gate 决策):(i) `lastWatermark` 改报 free%(更有意义);或 (ii) 额外读 `sysctl vm.swapusage` 仅供显示,free% 与 swap 水位都报。**推荐 (i)**:主信号是 free%,显示也报 free% 最一致,省一次 sysctl。plan 里 finalize。

## 6. 注入 seam(`FLYWHEEL_SWAP_SENSOR_CMD`,issue 要求保留)

现状:该 env 覆盖 `sysctl vm.swapusage`,注入 swapusage 格式替身(machine-watermark.ts:66-69)。

新 sensor 主读 `vm_stat`,故 seam 改为**注入 `vm_stat` 输出**(同一 env 名,内部 seam 非公开 API,无向后兼容包袱):

```ts
const override = env.FLYWHEEL_SWAP_SENSOR_CMD?.trim();
const { stdout } = override
  ? await execFileAsync("/bin/sh", ["-c", override], { timeout: 5000 })
  : await execFileAsync("vm_stat", [], { timeout: 5000 });
```

QA 三场景全靠它注入假 `vm_stat`(含自定义 `Pages free/inactive` 与递增/静止的 `Swapouts`)。任何 probe/parse 失败仍 `→ null`(skip tick,不误判为健康)。

## 7. 迟滞状态机改造(阈值语义翻转 + 双信号)

现 `SwapPressureMonitor` 单信号单向(usedPct 越高越危险)。新 `MemoryPressureMonitor` 双信号,free% **越低越危险**(语义相对 usedPct 翻转):

```
dangerNow   = (free% < FREE_LOW)  OR  (swapoutDelta > 0)      ← 待 gate 决策2确认(推荐 OR 触发)
healthyNow  = (free% >= FREE_HIGH) AND (swapoutDelta == 0)     ← 待 gate 决策2确认(推荐 AND 解除)

normal → dangerNow 连续 2 tick → "trigger"(置 pressure)
pressure → healthyNow → "clear"(解 pressure);否则留在 episode(迟滞带,永不再 trigger)
null 读数 → "none"(probe 失败 ≠ 恢复,保持状态)
```

- 沿用现有 2-tick 确认迟滞(FLY-1048 多帧先例)。
- 阈值 env(新)建议:`FLYWHEEL_MEM_FREE_LOW_PCT`(默认 ~10)、`FLYWHEEL_MEM_FREE_HIGH_PCT`(默认 ~20)。依据:实测健康 41–50% free、有负载时 22%、真 OOM 应 <10%。`FREE_LOW < FREE_HIGH` 校验(反了则 clamp,类比现 swapThresholds 的 clamp)。
- 旧 `FLYWHEEL_SWAP_PRESSURE_HIGH/LOW_PCT` 弃用(不再读;stopgap 三行由 ship 阶段撤)。

## 8. restart-safety lift 改判(fleet-sensors.ts:157-168)

- 现:`if (usage.usedPct < th.lowPct) liftSensorHold()`。
- 改:out-of-pressure 时,`if (healthyNow) liftSensorHold()`——即 free% 回到 FREE_HIGH 以上 **且** swapoutDelta==0 才 lift stranded hold。重启后即使 swap 水位仍 96%,只要真实压力健康就清掉疤留下的 hold。
- `recoveryProbe("swap_pressure_high") = !monitor.inPressure`(fleet-sensors.ts:380)语义对新 monitor 仍成立(重启后 normal → resolve 工单),不改。
- ⚠ swapoutDelta 需要"上一采样"才有意义。restart 首 tick delta=0(无前值)→ 若 free% 已健康即可 lift(不被"无 delta 历史"卡住);这正是要的自愈行为。

## 9. 现有测试与影响面

- `packages/teamlead/src/bridge/__tests__/machine-watermark.test.ts` — 全面重写:parseVmStat / free% 三方案 / swapout-delta(首采样/递增/静止/回绕) / 状态机(翻转阈值 + 双信号 OR/AND + 2-tick + null hold) / page-size 陷阱回归(注入 16384-header 假 vm_stat)。
- `packages/teamlead/src/bridge/__tests__/fleet-sensors.test.ts` — 更新 swapTick 用新信号 + restart-safety lift 改判 + 三验收场景(尤其"疤"场景:swap 水位高但 free% 健康 → 不置 hold)。
- ARC wiring(plugin.ts:5991-6081, 6203-6275)、`swapPressureRepair`、`setFleetPressureHold(set_by="swap-sensor")` 保持不变。

## 10. 待 brainstorm gate 决策(见 exploration §7)

技术上均可任一选;本文按推荐(C 纯页数比 / OR触发·AND解除 / lastWatermark 报 free% / --bridge-only 本单)写,gate 返回后据 Lead 拍板在 plan.md finalize。
