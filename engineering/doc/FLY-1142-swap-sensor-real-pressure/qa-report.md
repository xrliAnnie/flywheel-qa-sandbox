# FLY-1142 swap-sensor 真实内存压力 — QA 报告（独立 QA 阶段）

Issue: FLY-1142 (URL 不可得,只写 issue 号)
日期: 2026-07-11
基于: plan.md §6 验收标准 · acceptance-evidence.md(implement 阶段)

---

## 结论

**VERDICT: PASS** — 三阶段流水线的独立 QA 阶段(与 implement 不同 session)在 PR #547
的确切 HEAD(`0236307e`)上,独立重跑单测 + 独立驱动真编译 dist 全链路 + 独立跑真
Discord E2E,全部通过。根因被证伪、三条验收序列(含 Tadashi「不许假绿」的场景②)全过,
且**事故形态此刻真实存在于本机**并被 fix 当场清除。建议 ship。

## 验的是什么(根因 → fix)

2026-07-10 事故:`SwapPressureMonitor` 用 `sysctl vm.swapusage` 的 swap 水位(usedPct)
当触发/解除信号。macOS swap 只涨不缩,一次 OOM 把水位顶到 ~94% 后永远回不到 LOW(65%)
以下 → `fleet_pressure_hold` 永远解不掉 → 挡住**全部** runner 准入 8+ 小时。

fix:传感器改读 `vm_stat` 的 **free%**(`(free+inactive)/Σ7bucket`,page-size 免疫)+
**swapout-delta**(相邻 tick 的 Swapouts 增量 = 是否**正在** thrash)。三态 health:
只在**证明健康**(free%≥HIGH 且 delta≤MIN 且 delta 可算)时才 clear/lift;unknown(首样本/
计数回退/探测失败)= `healthy=null`,**永不** fail-open 解除。

## ★ 铁证:事故形态此刻真实存在于本机,fix 当场清除

QA 跑 harness 时(2026-07-11 ~01:30 UTC)本机实测:

| 信号 | 值 | 含义 |
|------|-----|------|
| 旧信号 swap 水位(`sysctl vm.swapusage`) | **93.8% used** | 旧疤仍在——旧传感器会永久锁死这台机器 |
| 新信号 free%(真 `vm_stat` → `readMemoryPressure`) | **27.1% free** | 真实健康,远高于 HIGH=15 |

驱动真编译 dist 完整链路(真 `readMemoryPressure`(**无注入**,真跑 `vm_stat`)→
`parseVmStat` → `MemoryPressureMonitor` → 真 `StateStore` → 真 `RunnerAdmissionController`):
预置旧 `swap-sensor` stranded hold(模拟事故遗留)→ 第 1 个真样本**不 lift**(无 delta 基线)
→ 第 2 个真样本 lift(证明健康)→ admission 恢复放行 → 零误报。**这就是 8 小时封锁的
根治证明,用的是本机此刻的真实内存读数。**

## 验收矩阵(plan §6)

| # | 验收项 | 方法 | 结果 |
|---|--------|------|------|
| 单测 | machine-watermark 31 + fleet-sensors 26 + server-loss 23 | `vitest run`(独立重跑) | **80/80 PASS** |
| ① | trigger free-low 支路(2-tick) | harness + 真 Discord E2E | PASS(admission 真拒 reason=pressure_hold, "memory 5.0% free") |
| ①′ | trigger swapout 支路(baseline+2 delta) | harness + E2E | PASS(healthy free% 下靠 swapout-delta 触发) |
| ② | pressure→recovery **立即 clear**(Tadashi 硬保证) | harness + E2E | PASS(第一个 healthy 样本当场 clear+resolve+admission 恢复) |
| ②′ | AND-release:free% 回但仍 thrash → **不** clear | harness + E2E | PASS(delta>MIN 挡住解除) |
| ③ | restart stranded hold:第 2 样本才 lift | harness + E2E + ★本机真读数 | PASS(第 1 样本 delta unknown 不 lift) |
| ③′ | 疤单独(高静止 swap 水位+健康 free%)永不 re-arm | harness + E2E + ★本机 | PASS(零新工单/零降载广播) |
| ③″ | manual hold 永不被传感器 lift | harness + E2E | PASS |
| ③‴ | 探测失败(null 读数)永不 lift | harness | PASS |
| 根因 | 运行时无 sysctl 依赖 | 单测 PATH-stub(空 env 只跑 vm_stat,sysctl 零调用) | PASS |
| 根因 | 生产源码无旧 Swap* 符号回流 | grep sentinel 单测 | PASS(零残留) |
| shell | `restart-services.sh --bridge-only` 顶层执行顺序 | `test-restart-services.sh` | **68/68 PASS** |
| shell | `--bridge-only --dry-run` 零副作用 | 真实调用 | PASS(exit 0,真 Bridge :9876 未动) |
| shell | restart-guard allowlist 含 `--bridge-only` | `test-flywheel-restart-guard.py` | **136/136 PASS** |
| 真机 | 真 Discord 告警落隔离 529 频道 | `qa-fly-1082-fleet-alerts-e2e.mjs` | **38/38 PASS**(6 条真消息,marker [QA1082-466563]) |
| lint | biome | 4 个改动文件 | 干净 |
| CI | Build & Test on HEAD 0236307e | GitHub Actions | SUCCESS |
| review | Codex xhigh(implement 阶段) | 2 轮 | APPROVED |

## 独立 QA 产物(提交到本分支)

- `qa-fly-1142-real-pressure-e2e.mjs`:独立行为 harness,驱动**真编译 dist** 全链路
  (真 `readMemoryPressure` + 注入 seam + 真 `StateStore` + 真 `RunnerAdmissionController`)
  走完 32 条断言,含**本机活疤**段(非 macOS 优雅跳过)。可作回归复跑用。
- 真 Discord E2E(`scripts/qa-fly-1082-fleet-alerts-e2e.mjs`)由 QA 独立重跑,run marker
  `[QA1082-466563]`,与 implement 阶段的 `[QA1082-115057]` 是**两次独立跑**。

## 与 implement 阶段的区别(不是橡皮图章)

implement 的证据在同 session 产出;本 QA 是**独立 session**在确切 ship HEAD 上:
① 独立重跑全部单测;② 独立写 harness 驱动真 dist(implement 的 harness 我没复用);
③ 独立跑真 Discord E2E(自己的 run marker);④ 抓到**本机此刻真实处于事故疤形态**这一
最强现场证据(旧信号 93.8% used 会锁死、新信号 27.1% free 正常、fix 第 2 样本清疤)。

## Ship 阶段待办(不在本 PR,plan §4.5)

- 撤 `~/.flywheel/.env` 三行 stopgap(`FLYWHEEL_SWAP_PRESSURE_HIGH_PCT=99` /
  `FLYWHEEL_SWAP_PRESSURE_LOW_PCT=99`)。旧键已不再被读(grep sentinel 证);新键
  `FLYWHEEL_MEM_FREE_LOW_PCT` / `FLYWHEEL_MEM_FREE_HIGH_PCT` / `FLYWHEEL_MEM_SWAPOUT_MIN_PAGES`。
- fix 上线后用 `restart-services.sh --bridge-only` 做纯 env-reload 重启使阈值撤销生效。

## 备注

- 全量 teamlead vitest 套件:与本 diff 相关文件(machine-watermark / fleet-sensors /
  server-loss)全绿;若高负载下出现 real-tmux / 长 bash-suite 的超时型 flake,以 CI
  干净机器(HEAD 0236307e SUCCESS)为仲裁。
