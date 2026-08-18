# FLY-1863 定时炸弹机制与证据档案 — 调研

Issue: FLY-1863 (https://linear.app/geoforge3d/issue/FLY-1863/p0main-红-869-引入的两条-post-ship-finalization-测试在-main-上就失败-ci-ok)
日期: 2026-08-17
基于: exploration.md

所有实验在本 worktree(HEAD = `2b7a09d87` = origin/main,`git status` 干净,`pnpm install --frozen-lockfile` + `pnpm -r build` 全绿)执行;执行时刻均在引信时刻(2026-08-18T01:00:01Z)之后。CI 取证经 `gh` CLI,均为只读。

## 1. 机制(代码链,精确到行)

1. 测试种子 `seedLandOperationClaim`(`packages/teamlead/src/__tests__/post-ship-finalization.test.ts:89-109`,#869 新增):
   ```ts
   ensureLandOperation({ ..., now: "2026-08-17T00:00:00.000Z" })
   claimLandOperation({ ..., now: "2026-08-17T00:00:01.000Z",
                        leaseExpiresAt: "2026-08-18T01:00:01.000Z" })   // ← 引信
   ```
2. 被测实现 `runResumablePostShipFinalization` 在 land 上下文里落 `terminal_notified` 步骤时传**真实墙钟**(`packages/teamlead/src/bridge/post-ship-finalization.ts:1057`):
   ```ts
   store.recordLandOperationStep({ ..., step: "terminal_notified", now: new Date().toISOString() })
   ```
3. `StateStore.recordLandOperationStep`(`packages/teamlead/src/StateStore.ts:45737-45745`)对 lease 做守卫:
   ```ts
   if (!operation || ... || !operation.lease_expires_at
       || String(operation.lease_expires_at) <= input.now) return;   // → {ok:false, reason:"stale_land_generation"}
   ```
4. 真实时间 ≥ 2026-08-18T01:00:01.000Z 后,守卫必拒 → `terminalNotified=false` → 返回 `{complete:false, outcome:"partial", reason:"land_terminal_notification_incomplete"}`,而两条失败用例断言 `{complete:true, outcome:"completed"}`。

**为什么恰好只挂这两条**:同文件 40 条里,只有这两条同时满足 (a) 传入 `landOperation` 上下文、(b) 期待 `complete:true`(即需要 lease 门放行)。其它带 landOperation 的用例期待的 partial 在 lease 门之前就产生、或与 lease 无关的路径给出同样的 partial reason,时间无关(例:`:958` 用例靠 fetch 403 制造同一个 `land_terminal_notification_incomplete`,lease 过期与否结果相同)。第二条失败用例(archive waiver)也在 `terminal_notified` 这道**更早**的闸倒下,没走到 `archive_waiver_notified`(:1191)—— 探针实测两条 reason 相同,见 §3。

其余生产代码调用 `claimLandOperation`(StateStore.ts:45604)只比较**注入**的 now/lease,种子改为相对时钟后自洽,无第二个坑。

## 2. 实验①:干净 main 单跑 ×10(Lead 指定)

命令:`npx vitest run src/__tests__/post-ship-finalization.test.ts --reporter=basic`,packages/teamlead 下连续 10 次,02:50:30Z–02:51:43Z。

**结果:10/10 失败,每次都恰好 `2 failed | 38 passed (40)`,失败的恰是同两条,零方差。** 失败率 100%,不是间歇 —— 在引信之后是确定性失败。原始日志:scratchpad `x10.log`(关键行已摘录进本档案,报告不依赖 scratchpad 存活)。

## 3. 实验②:探针取实际 reason

把两条断言临时替换为 `console.log(JSON.stringify(result))`(拷贝为独立临时文件跑,跑完即删,零残留):

```json
{"complete":false,"outcome":"partial","reason":"land_terminal_notification_incomplete",
 "details":{"tmuxClosed":true,"commDbFinalized":true,"closeoutBlocked":false,"worktreeRemoved":true,"threadArchived":false}}
```

两条 reason **相同**,均为 `land_terminal_notification_incomplete` —— 与 §1 机制预测一致(lease 门在 terminal_notified 一步拦截,mock fetch 本身全部 200)。

## 4. 实验③:单变量突变(因果证明,本地)

在本 worktree 把测试文件里 `leaseExpiresAt` 的 `2026` 改为 `2099`(唯一变量),同机同窗单跑:**40/40 全绿**。随后 `git checkout --` 还原,`git status` 干净。

## 5. CI 时间线全样本表(核心证据)

判据:**该 teamlead 分片 job 内测试实际执行时刻** vs 引信 2026-08-18T01:00:01Z。注意 `gh run list` 的 `createdAt` 是排队时刻不是执行时刻(#871 靠这个差点成为反例,见 §6)。

| 样本 | 执行时刻 (UTC) | 引信前/后 | lease 字面量 | 结果 |
| --- | --- | --- | --- | --- |
| main push run(#869 合入触发,00:14)— run 整体 CANCELLED,但 teamlead 2/3 shard 已跑完 | 00:14–00:2x | 前 | 2026 | ✅ 绿(238 文件全过;Cass 订正:聚合状态 CANCELLED 不能反推成分状态) |
| main push run 32084709862, Unit (teamlead 2/3), head 2b7a09d8(00:29 下一次合入触发) | 00:29:45–00:35:19 | 前 | 2026 | ✅ 绿(40/40,尸检榜实录) |
| #868 run(head 4f773ae5,旧 merge ref) | 00:38 | 前 | 2026 | ✅ 绿 |
| #871 run 32085755239, Unit (teamlead 2/3) | job 01:49:55 起,FAIL 行 01:55:56 | 后 | 2026 | ❌ 恰两条红 |
| #874 / #876 / #877 各自最新 run | 01:34+ / 01:44+ | 后 | 2026(docs 分支不碰该文件) | ❌ 红 |
| FLY-1852 runner 本地干净 worktree 单跑 | 01:4x | 后 | 2026 | ❌ 2 failed / 38 passed |
| 本单实验① ×10 | 02:50–02:51 | 后 | 2026 | ❌ 10/10 红 |
| **#875 run 32090025726, teamlead 全分片** | **01:56–02:24** | **后** | **2099(分支内已改)** | **✅ 全绿** |
| 本单实验③ 突变 | 02:5x | 后 | 2099 | ✅ 40/40 绿 |

**零反例存活。** 引信前全绿(main 侧绿样本 n=2,Cass 订正 —— 含 00:14 那轮被取消 run 里已完赛的 shard)、引信后 lease=2026 全红、引信后 lease=2099 全绿 —— 三格齐,时间与 lease 字面量完全解释全部样本,分支/分片/环境不进入解释。

## 6. 两个曾经的"反例"如何溶解

- **#875 引信后还绿**(尸检榜"间歇"的主要依据之一):`git show refs/pull/875/head:...test.ts:101` 实证其分支已把 lease 改为 `"2099-08-18T01:00:01.000Z"`(FLY-1833 动 land 机制时顺手改的)。它 01:23 那轮红挂在 teamlead 3/3 的 `commdb-session-prune`(顺序依赖,他们当场以 61c4ba0a3 自修),与本单两条无关。⇒ #875 实为 CI merge 态里的**天然单变量对照组**。
- **#871 run createdAt 00:46:04Z(引信前)却红**:job 实际 01:49:55Z 才开跑(GitHub runner 排队 ~64 分钟),失败行时间戳 01:55:56Z,引信后。⇒ `createdAt` 不是执行时刻。

## 7. 同形状潜在引信 bounded 排查(只列不修)

全仓 `*.test.ts` 扫描 expiry 类字段 × 任意未来年份,并逐项追到消费时钟。早期只凭字面量把 `merge-ship-gate` 列为候选的结论已被下表的调用链核验取代:

| 候选 | 消费时钟 / 路径 | 最终结论 |
| --- | --- | --- |
| `packages/teamlead/src/__tests__/workflow-engine-dispatcher.test.ts:3940` producer credential(`2027-07-22`) | admission 使用注入的 2026 `now`;后续 `submitWorkflowNodeOutput` 未传 `now`,回到真实墙钟 | **确认的独立引信候选**;已上报 `flywheel-eng-lead`,本 PR 不扩修 |
| `workflow-source-projector.test.ts` 的 2027 fixtures | 消费继续使用固定注入时钟,或 claim 已转 permanent | 已排除:被审路径无真实墙钟引信 |
| `bridge/__tests__/merge-ship-gate.integration.test.ts` 的 2027 claim | claim/消费沿固定注入时钟比较 | 已排除:被审路径无真实墙钟引信(推翻早期初筛) |
| `external-merge-reconcile.test.ts:136` 的 2027 expiry | 该值被存储,但被测路径不消费它 | 已排除:被审路径无真实墙钟引信 |
| `ship-eligibility.test.ts` 的 2999 默认值 | evaluator 使用真实墙钟 | 明确的远未来 sentinel 边界,非近期开火候选;不在本单处理 |

核验包含阳性突变:把 workflow dispatcher credential 改成"晚于 admission 注入时钟、早于当前真实时钟"后,admission 通过但 output submission 失败;还原 2027 后定向用例恢复全绿。其它过去日期命中属于冻结时钟或"过期即预期"形态,不因字面量本身判为引信。

## 8. 病灶 B 现状(main 红无人接;founder 已裁出本单)

> **2026-08-17 founder 范围裁决:**这是独立问题,不在 FLY-1863 实现。以下证据保留供后续立单,本 PR 不改 workflow、不新增 webhook。

- `.github/workflows/ci.yml` `on: push: branches: [main]` + `pull_request` —— main push **有** CI;`ci-ok` job 仅聚合 `needs` 判绿,无任何通知步骤。
- 全部 workflows 零 Discord/webhook 出站;现有 secrets 仅 `CLOUDFLARE_API_TOKEN` / `FW_BETA_PUBLISH_TOKEN` / `GITHUB_TOKEN` / `NPM_PUBLISH_TOKEN` ⇒ 需新增一个 Discord webhook secret(一次性 setup,#flywheel-alerts 频道)。
- GitHub-hosted runner 摸不到本机 Bridge ⇒ 告警必须走 GitHub 侧出站(webhook),不能复用 Bridge 告警管线;#flywheel-alerts 已有工单 owner 闭环(claude-infra-bot),消息落进去即接上现有处置回路。

## 9. 结论移交 plan

本单修复面 = 测试种子相对时钟化 + 时间免疫回归测试 + 引信排查清单。`main-red-alert` / webhook 方案经 founder 裁决整体移交独立问题。生产代码(StateStore / post-ship-finalization)**零字节改动**。

### 保质期表(会过期的结论)

| 结论 | as-of | 重核命令 |
| --- | --- | --- |
| origin/main = 2b7a09d87,种子 lease=2026-08-18T01:00:01Z | 2026-08-18T02:5xZ | `git rev-parse origin/main && git show origin/main:packages/teamlead/src/__tests__/post-ship-finalization.test.ts \| sed -n '89,109p'` |
| #875 未合入;其分支带 lease→2099 | 同上 | `gh pr view 875 --json state,mergedAt` — **若已合入,main 上两条测试将转绿,plan §与-875-协调 生效,修复动机(A半)转为结构加固而非解堵** |
| 全仓 PR 被 `CI OK` 连坐挡住 | 同上 | 任取新 PR 看 teamlead 分片;若 #875 或本修复已合入则此态解除 |
| workflows 无 Discord webhook secret | 同上 | `grep -rn "secrets\." .github/workflows/` |
| 行号(45742 等) | 同上 | `git log -S "stale_land_generation" -1` + grep 重定位 |
