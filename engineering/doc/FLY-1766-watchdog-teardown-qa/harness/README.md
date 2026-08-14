# FLY-1766 QA harness — 复跑说明

这些是 FLY-1766 独立 QA 用的仪器,**不进被测 PR**。

| 文件 | 用途 |
|---|---|
| `probe-ab-frozen-vs-prepr.sh` | 修前(merge-base `97dec19bd`)/ 修后(PR head `a30e4c70f`)探针 A/B,各用各自那一代的 env 旋钮名,驱动到真实 page 阈值 |
| `probe-live-readonly.sh` | 把两代探针以只读姿态对准活体生产 Bridge(独立 state 文件 + `_probe_post` 改写 + 不带 bot token,绝不会真发 Discord)。**每代必须独立 state 文件**,共用会互相污染计数 |
| `body-v2-real.json` | 由 PR head 的真 `buildLivenessManifest` 产出的 v2 manifest(`liveness` 键) |
| `body-v1-realproducer.json` | 由 merge-base 的真 `buildWatchdogManifest` 产出的 v1 manifest(`watchdogs` 键,含 `w4_lead_blocked`) |
| `qa1766-rider-replay.test.ts` | 独立 50-tick rider 锚点重放(记录精确触发 tick 号);放进 `packages/teamlead/src/bridge/__tests__/` 后用 vitest 跑 |

前置:两个 `probe-*.sh` 需要同目录下有 `probe-BEFORE.sh` / `probe-AFTER.sh`,取法:

```bash
git show 97dec19bd:scripts/bridge-liveness-probe.sh > probe-BEFORE.sh
git show a30e4c70f:scripts/bridge-liveness-probe.sh > probe-AFTER.sh
```
