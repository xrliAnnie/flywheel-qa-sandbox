# FLY-1142 真机验收证据 — implement 阶段

Issue: FLY-1142 (URL 不可得,只写 issue 号)
日期: 2026-07-10
基于: plan.md §6

## ① 真压力 → hold 置上(两支路各证一次)

`scripts/qa-fly-1082-fleet-alerts-e2e.mjs`(真 dist + 隔离 529 频道)run marker `[QA1082-115057]`,VERDICT **PASS(38/38)**:

- **free-low 支路**:注入 free 5% × 2 tick → hold 置上(`set_by=swap-sensor`)、`RunnerAdmission.tryAdmit()` 真拒绝(`reason=pressure_hold`)、每个 Lead 收到降载通知、真 Discord 工单落在隔离频道(msg `1525299400455229474`)。
- **swapout 支路(①″)**:free 45% 健康 + Swapouts 递增(baseline + 2 个 delta 样本 = 共 3 样本)→ hold 置上;admission 拒绝。

## ② 压力解除 → hold 自动清(Tadashi 硬要求,不许假绿)

- free-low episode:free 回到 45% 且 Swapouts 静止(delta=0)→ **同进程当场 clear**,hold 消失、admission 恢复放行、工单安静 resolve(不需要第二个恢复样本)。
- swapout episode:计数器归静止 → delta=0 → **立即 clear**。

## ③ scar 场景(今晚事故形态)→ 不置 hold + stranded hold 自动清

- 预置旧 durable `swap-sensor` hold + 全新 FleetSensors 实例(模拟 Bridge 重启)+ 注入「free 45% 健康 + 巨大但**静止**的累计 Swapouts(15,351,310,即事故当天真实值)」:
  - 第 1 个样本:delta 无基线 → `healthy=null` → **不 lift**(重启撞上 thrash 时不会被单个好看的 free% 样本骗开)。
  - 第 2 个静止样本:delta=0 → `healthy=true` → **lift**,admission 放行。
  - 全程零新工单、零降载广播 —— 疤本身再也不能武装传感器。

## ③′ 运行时无 sysctl 依赖(根因证伪)

- `machine-watermark.test.ts`「with NO override it executes vm_stat and NEVER sysctl」:PATH 放记录调用的 `vm_stat`/`sysctl` stub,空 env 调 `readMemoryPressure({})` → **只执行了 vm_stat,sysctl 零调用**(无 override 的命令选择级证明,不压在 override E2E 上)。
- grep sentinel 单测:生产源码不再含 `vm.swapusage` / 旧 `readSwapUsage` / `SwapPressureMonitor` / `parseVmSwapUsage` / `swapThresholdsFromEnv` 符号。

## 校准 soak(plan §6-5,两支路)

`evidence-soak-script.mjs` 跑真 `vm_stat`(无注入),生产 watchdog 节奏 30s × 8 样本,窗口 = 生产 fleet 高负载(load ~20,今晚 78-spike 事故后的恢复期):

- free% 全程 23.0–27.5%(远高于 LOW=8);
- swapoutDelta 每个可算样本都是 **0**(MIN=0 在 30s 节奏下无噪声,不需上调);
- `maxConsecutiveFreeLow=0`、`maxConsecutiveSwapout=0`、零 trigger。
- **SOAK VERDICT: PASS**(完整样本见 `evidence-soak-calibration.txt`)。快速下降的 2-tick 确认由单测 + E2E 注入序列证明。

结论:provisional 默认 `FREE_LOW=8 / FREE_HIGH=15 / SWAPOUT_MIN=0` 直接 ship,不改。

## 回归

- `machine-watermark.test.ts` 31 用例 + `fleet-sensors.test.ts` 26 用例 + `server-loss.test.ts` 全绿。
- `bash scripts/test-restart-services.sh` **67/67**(含 5 个新 hermetic 顶层执行断言:SHA match/mismatch、plugin pending、`--bridge-only` dry-run 零副作用、真跑 bounce 时 build=0/Lead=0/两 SHA 冻结/无 deploy 通知/无 set -u 崩溃)。
- `python3 scripts/hooks/test-flywheel-restart-guard.py` **136/136**(含 `--bridge-only` 三个合法形态)。
- teamlead 全量 vitest:与本 diff 相关的文件全绿;5 个失败文件均为高负载下的超时型 flake(real-tmux / 120s bash-suite / 5s mock-transport 预算),与改动文件零交集,以 CI 干净机器为仲裁。

## 备注(ship 阶段待办,不在本 PR)

- 撤 `~/.flywheel/.env` 三行 stopgap(`FLYWHEEL_SWAP_PRESSURE_HIGH_PCT=99` / `FLYWHEEL_SWAP_PRESSURE_LOW_PCT=99`),fix 上线后用 `restart-services.sh --bridge-only` 重启 Bridge 生效。
- 旧 env 键已不再被读(新键 `FLYWHEEL_MEM_FREE_LOW_PCT` / `FLYWHEEL_MEM_FREE_HIGH_PCT` / `FLYWHEEL_MEM_SWAPOUT_MIN_PAGES`)。
