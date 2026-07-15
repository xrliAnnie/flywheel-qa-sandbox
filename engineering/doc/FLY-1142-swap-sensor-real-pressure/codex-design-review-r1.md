# Design Review — plan.md (Round 1)
Date: 2026-07-10
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确且适配现有架构：保留 durable hold / ARC 标识，只替换探针与迟滞信号，是最小且可行的根治路径；纯页数比也确实不受 16384 vs 4096 page-size 差异影响。但计划目前把“swapout delta 未知”当成“已证明为 0”，`--bridge-only` 控制流也没有真正隔离普通 deploy 路径，另有若干运行时文案与 E2E seam 漏项，因此尚不宜进入实现。

## What's Good (Keep)

- 根因链路核对准确：`fleet_pressure_hold` 是 id=1 的 durable 单行（`StateStore.ts:1418-1430, 4660-4699`），`tryAdmit()` 在其他资源检查前读取它并以 `pressure_hold` 拒绝全部新准入，同时 probe 异常 fail-open（`runner-admission.ts:224-262`）。
- 保留 `set_by="swap-sensor"`、`swap_pressure_high`、correlation key、ARC repair wiring 与 kill switch 是正确的兼容边界；这能让旧 hold attribution、现有工单去重和 AutoRepairBot 接线继续工作。
- `freePct=(free+inactive)/(free+active+inactive+speculative+throttled+wired+compressor)` 是同单位页数之比，page size 在分子分母中完全消掉；当前 `vm_stat` 的这些 resident bucket 之和也与物理页总量同量级。把 speculative 留在分母但不放进分子是偏保守的选择。
- OR 触发 / AND 解除、null probe 不清状态、两帧确认、env tunable 与独立 kill switch 均延续 FLY-1082/FLY-1048 的既有模式；不引入新 timer 也符合当前 `onPollComplete` piggyback 架构（`plugin.ts:6517-6539`）。
- TDD 顺序基本合理：先钉 parser/monitor，再改 fleet 生命周期，最后清旧符号；ship 后才撤生产 `.env` stopgap，避免修复未上线时提前失去保护。

## Issues & Recommendations

1. **首次采样的 swapout delta 是 unknown，不是 0；当前计划会在无法证明恢复时 fail-open。** 计划在 `plan.md:50-53, 106-109` 一方面定义 AND 解除，另一方面又允许首 tick 仅凭 `freePct >= FREE_HIGH` 清 stranded hold，并保留 `recoveryProbe = !memMonitor.inPressure`。Bridge 重启时 monitor 必然从 normal 开始；若此刻 free% 尚高但机器正在 swapout，首样本没有前值，计划仍会清 durable hold，`tryAdmit()` 随即放开全部 runner。更明显的是首样本 free% 已低时，monitor 只处于 pending、`inPressure` 仍为 false；同 tick 随后的 Hub reconcile（`plugin.ts:6530-6539`）会把仍不健康的 active ticket 当作 recovered。null 读数也会在 fresh monitor 上得到同样的错误 true，这与“probe failure ≠ recovery”矛盾。建议把 delta/health 做成三态并由 monitor 单点拥有：首次样本或计数器回退产生 `delta: unknown`；它可以依据低 free% 累积 danger，但不得 clear/lift/resolve。只有第二个有效样本证明 `freePct >= HIGH && delta <= MIN` 后才清 stranded hold（最多多等当前一个 30s tick）。`recoveryProbe` 应返回 `null`（无有效恢复证据）、`false`（pending/in pressure/明确不健康）或 `true`（已证明 healthy），而不是 `!inPressure`。补测：首个健康样本不 lift、第二个静止样本才 lift；第二样本 delta>0 不 lift；首样本低 free% 不 resolve；null 不 lift/resolve；counter reset 后也重新等一个 baseline。

2. **计划给出的 monitor API 无法实现它自己要求的共享 `isHealthy()` 和告警细节。** `plan.md:80-90` 把 `lastSwapoutsTotal` 私有化且 `tick()` 只返回 `"none" | "trigger" | "clear"`，但 `fleet-sensors.ts` 侧又要在 `plan.md:104-108` 使用本次 `swapoutDelta` 做 restart lift、告警文案和 repair watermark。`MemoryPressure` 只有累计总数，fleet 层无法在不复制第二套 baseline 的前提下得到 delta；复制会让 monitor、lift 与 recovery 的判断漂移。建议让 `tick()` 返回结构化 evaluation（至少 `{ event, freePct, swapoutDelta: number | null, danger, healthy: boolean | null }`），或让 monitor 暴露本 tick 的只读 evaluation；fleet 的 alert、lift、repair 和 recovery 全部消费同一结果。成功 parse 的业务必需字段也应收紧为 non-null：七个 bucket、`Swapouts` 必须 finite、非负、分母 > 0，否则整个 reading 为 null；只有诊断用 `pageSize` 可选。这样不会留下“freePct 缺失但 delta 正常”或相反时 OR/AND 如何计算的未定义行为。

3. **`--bridge-only` 方案没有真正绕开 deploy 账本，分支位置也过晚。** 当前脚本在 SHA gate 之前已经执行可能有副作用的 plugin fork/update 与 project `.lead/` 扫描（`restart-services.sh:438-459`）；正常 main 又必然进入 `deploy_and_verify()`（`restart-services.sh:1334-1337`），其中会 build（`1224-1230`）、发送 deploy 通知并最终写 `deployed-sha`（`1285-1292`）。因此仅按 `plan.md:114-118` 设置三个 flag、包住 SHA/diff 区块，并不会“直接落到 stop/start”，在 `CURRENT_HEAD != DEPLOYED_SHA` 时甚至可能顺带部署尚未部署的代码。建议在参数解析/锁之后就用 `BRIDGE_ONLY` guard 跳过 plugin update、project SHA scan、SHA/diff classification，并在所有函数定义完成后的 Main 增加独立第三分支：可选 idle wait → `stop_bridge` → `start_bridge` → 现有同等强度 health check；不 build、不 rollback git、不调用 `do_restart_all_leads`、不发“代码已更新”通知、不清 plugin marker、不写任一 deployed-sha。`--dry-run` 必须在这些副作用前退出。仓库明确已有 `scripts/test-restart-services.sh`（当前 62 项通过），不是“有测试则加”：应在该文件加 hermetic 断言，覆盖 SHA match/mismatch、plugin/project pending、dry-run、Lead 调用次数、build 调用次数和两个 SHA 文件均不变；另在 restart guard allowlist 测试加 `--bridge-only` 合法命令形态。

4. **重命名与 seam 语义变更的影响面不完整，会产生错误运维信息并使现有真 E2E 失效。** `plan.md:170-179` 漏了多处真实消费者：admission detail 仍写“swap … watermark falls”（`plugin.ts:3012-3016`）；server-loss 会拼成“当前 swap 水位 41.0% free”（`server-loss.ts:250-267`）；`swapPressureRepair()` 的幂等回报、Lead 降载通知和结果仍全部说“swap 水位回落”（`fleet-sensors.ts:186-218`）。更关键的是 `scripts/qa-fly-1082-fleet-alerts-e2e.mjs:152-155, 288-340` 通过同一个 `FLYWHEEL_SWAP_SENSOR_CMD` seam 注入旧 `vm.swapusage` 格式，改 parser 后会直接失效；`server-loss.test.ts` 也固定了旧 watermark 语义。建议扩充影响文件清单，更新 `plugin.ts`、`server-loss.ts`/其测试、FLY-1082 E2E harness，以及仍作为当前行为合同的 PRD/代码注释；保留机器标识符 `swap_pressure_high`、`leadId="swap"`、`set_by="swap-sensor"`，但所有人类可读文本统一为“memory pressure / free% / active swapout”。E2E 的 scar 场景应给两个样本相同且很大的累计 `Swapouts`，证明累计疤不触发；另 seed 一条旧 durable hold，按第 1 项要求在第二个静止样本后才解除。

5. **8/15 是合理起点，但目前的依据不足以证明“正常高负载不误拦且 OOM 前足够早”。** 计划只列一个 48GiB 主机的健康/高负载点与“真 OOM 到个位数”的结论（`plan.md:23-32`），没有 incident time series；`SWAPOUT_MIN=0` 还是每 tick 的绝对页数，而实际 tick 是 30s（`plugin.ts:6471, 6524`），延迟或长 poll 会改变其含义。当前现场样本约 21% free 且累计 Swapouts 在观察快照间未增长，只能支持“此刻安静”，不能证明峰值并发下连续两个窗口不会出现少量后台 swapout，也不能证明 free<8 经两 tick（约 60s）确认仍来得及。建议保留 8/15 作为 provisional default，但在 ship gate 加数据化校准：记录/回放正常峰值与事故附近的 `{timestamp, freePct, swapoutDelta}`；证明正常高负载在至少一个代表性窗口不连续触发，且压力回放在 OOM 前留出有效降载时间。若拿不到事故序列，至少做受控高并发 soak + 注入的快速下降边界测试，并明确 `MIN_PAGES` 是按 30s cadence 解释，或改成按 elapsed time 归一化的 pages/sec。阈值测试还应钉住 7.999/8/14.999/15 的边界与非法 0、负数、NaN、>100 配置。

6. **验收应证明完整运行时链与 scar 的“无依赖”性质，而不只是 monitor 单测。** `plan.md:143-150` 的场景 ① 同时给低 free 和持续 swapout，真机层没有分别证明 OR 的两条支路；场景 ③ 的新 seam 本身不含 swap usedPct，文字上的“swap 水位高”没有可观测断言。建议保留 unit 层的两条 OR 单独覆盖，并把 E2E ③ 定义为：执行路径不调用 `sysctl vm.swapusage`；输入为 healthy free% + 高但静止的累计 Swapouts；两 tick 无新 hold，若预置旧 `swap-sensor` hold 则按已证明 healthy 的时点解除；manual hold 永不解除。这样才能直接证明根因已从运行时依赖图中移除，而不是仅凭测试叙述宣称通过。

## Verdict

CHANGES REQUESTED — address items above
