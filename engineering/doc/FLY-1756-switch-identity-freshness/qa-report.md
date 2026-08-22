# FLY-1756 Lead 代 founder 切号自愈 — QA 验收报告(PR-2)

Issue: FLY-1756 (https://linear.app/geoforge3d/issue/FLY-1756/bug-切号器切不到任何号-凭证池快照全柜过期refresh-token-一次性存着必死-切号只认台账不验活身份)
日期: 2026-08-21
基于: plan.md(R8)· exploration.md · research.md

## 0. 判定

**PASS** — 冻结 head `c50253a166514dab70a6f5bd7df62002a476d510`(PR #916,OPEN / 非 draft / MERGEABLE,
远端 `origin/flywheel-FLY-1756-pr2` 与本 worktree 同 SHA;PR-1 = 已合入的 #913)。

issue 的两条正对照与一条负对照全部真机跑过并通过;两条安全红线(绝不轮换活跃号、
绝不用旧副本覆盖更新的活凭据)有独立反面对照证明成立。存在 4 条不阻塞的残留缺口,见 §5。

## 1. Discord-capable 判定 —— 无 N-to-N 面(显式声明,非静默跳过)

diff 只触及 `packages/teamlead/src/account-heal/{quota-monitor,quota-monitor-runtime,
quota-monitor-credentials,claude-profile-cli}.ts`。**零** Discord send / relay(Runner↔Lead↔founder)/
render(thread title · badge · pinned header · status line)/ founder interaction / roundtable /
跨-Lead 协调面:未新增或修改任何 alert kind、body、routing。

唯一与 Discord 相邻的效应是**节奏**:`attemptIdentityDeliveries`(对已存在的
`account_identity_mismatch` 投递做重试,每 tick 上限 2 条)原先只在 accelerated tier 的 sweep
里可达,现在在 base tier 也可达。该重试本身受 `deliveryDue(..., episodeRealertMinutes)`(默认 30 分钟)
与 `signature` 去重双重约束,消息形态 / kind / routing / body 一字未改 ⇒ 无刷屏面。

⇒ **本单无 N-to-N 面 —— 已改用真机隔离 E2E 验证**(§3),529 房 N-to-N 不适用。

## 2. 自动化门(独立复跑,非引用 PR body)

| 门 | 结果 |
|---|---|
| 本次改动的 4 个测试文件 | 122/122 通过 |
| 相邻防线 14 个文件(告警合同 / 字节兼容哨兵 / 红线 / 真锁真脚本切号集成 / store / guard / machine-account) | 200/200 通过 |
| `tsc --noEmit`(teamlead) | 干净 |
| biome check(改动的 4 个文件) | 1 条 warning,位于 diff 之外、改动前即存在 |

合计 18 文件 322 项。未在本机跑全仓 vitest(会压死生产 Bridge,已知纪律)。

## 3. 真机隔离 E2E(自建,非引用实现者证据)

沙箱跑**真的**编译产物 `makeQuotaMonitorRuntime`、**真的** bash `flywheel-claude-profile reconcile`
子进程、**真的** `verifyPoolCredential` 刷新 + 池写回、**真的**文件锁与 `security(1)` 读写接口。
只顶替两个连不上的 Anthropic 端点(OAuth refresh / `oauth/profile`)与 usage API。
生产 Keychain / `~/.flywheel/claude-profiles` / `~/.claude.json` / 账本全程零触碰。

初始态刻意复刻 issue 现场:`.active` = `beta`,活 Keychain 里是 `alpha`(= founder 刚手工登录)。

| # | 场景 | 结果 |
|---|---|---|
| S1 | 一次 tick 自愈漂移 | reconcile 恰调用 1 次;`.active` beta→**alpha**;alpha 池副本 digest 变为**与活 Keychain 逐字节相同**(`92d6bb4f…`);Keychain 字节**未变** |
| S1b | 非活跃槽保鲜 | beta 轮换并原子写回(`AT-beta-0001`→`AT-beta-r1`);gamma 被 HTTP 400 拒 ⇒ 池文件**逐字节未变**(`07c05602…`),无半写 |
| S1c | 活跃号红线 | OAuth 服务端收到的 refresh token 只有 `RT-beta-0001` / `RT-gamma-0001` —— **alpha 的 refresh token 零次**外发 |
| S1d | 无永久对账循环 | 第二 tick(+61min)reconcile **未再调用**(digest 已对齐) |
| S2 | 反面对照:对账失败、标签继续指错人 | 保鲜 **零次刷新**(refreshLog 为空),5 个文件全部零改动。非空过绿:`lastCandidateSweepAt` 已被打戳 ⇒ sweep 确实执行并在活身份门前中止,不是被计时器跳过 |
| S3 | monitorOnly(`order: []`) | 保鲜零刷新、池零改动(reconcile 仍会跑,见 §5-C) |
| S4 | founder 验收 ②:`use alpha`(alpha == 活身份) | exit 0,`.active` 不变,Keychain 文件 **mtime 前后逐位相同**(`1787358581651.7888`)⇒ 真 no-op |
| S5 | founder 验收 ①:切走再切回,零人工 | `use beta` → 0(Keychain 变 `AT-beta-u1`);`use alpha` → 0(变 `AT-alpha-u2`)。`use beta` 用的正是保鲜轮换后的 `RT-beta-r1` ⇒ **同时证明写回没坏** |
| S6 | 负对照:真死的号 | `use gamma` → exit 30 fail-closed,Keychain 与 `.active` 均未变 |

### harness 自身的两次假结果(已定位并修复后重跑)
1. 手写账本缺 `quotaExhaustedUntil` / `weeklyResetAt` ⇒ `readStoreStrict` 判 null ⇒ 对账 47
   `invalid_store`。误读会变成「产品对账坏了」。
2. 进程内 HTTP server + `execFileSync` ⇒ 事件循环被阻塞 ⇒ 子进程 `AbortError` 超时 ⇒
   `use beta` 假 30。误读会变成「切号仍失败」。改为独立进程 server 后为真 exit 0。

本报告所有数字来自两处修好之后的那一轮。

## 4. 生产现状只读核对

- 5 个池槽的 `identity-anchor.json` 全部 mode 600 且恰为 `resolvePoolProfileIdentity` 要求的 5 键 ⇒
  该解析器在生产不会因 schema/权限不符而恒返 null(否则 Fix C 会静默永不生效)。
- `~/.flywheel/quota-monitor.json`:`order = [personal, school, business, personal1]`(非空 ⇒ 非 monitorOnly),
  `candidateSweepMinutes = 60` ⇒ 保鲜每小时一轮、约 4 次 refresh。
- 5 个池槽的 refreshToken / accessToken 两两互不相同(本地 hash 比对,未打印明文)⇒ §5-B 的风险当前未发生。
- 守护进程是 `while (!stopping) { await runtime.tick() }` 长驻循环 ⇒ `lastReconcileAttempt`
  的 20 分钟节流在同一进程生命周期内确实生效(仅重启后重新武装)。

## 5. 残留缺口(全部不阻塞,按影响排序)

**A. 老化点名缺失(对照 plan §4 的 founder 终裁句)** — plan §4 明写「30 拒绝则不写回、保留 auth
fail-closed **并发老化点名**」。实现里 stale 候选走 `continue`,无告警、无 state、无 `pool_credential_aging`
kind。⇒ 某个号真烂到需要重新登录时,系统每小时安静重试,founder 只能在下次切号失败时才发现。
plan §3.2/§3.4 的 `keychain_pool_divergence` kind、`displaySynced` 清除谓词、低频 identity audit
(`identityAuditMinutes`)、新 config/state 键、§9 的 QA 脚本与 state strip 脚本同样未交付 ——
本版实现范围窄于已批准的 plan,属**少做**而非做错。

**B. 保鲜只按槽位名,不核「这个槽里的钥匙是否真属于这个号」** — 若某槽错放了当前活跃号的凭据
(同一 OAuth family),每小时的保鲜会把 founder 正在用的登录轮换掉。`verifyPoolCredential` 只按
name 比对 `activeName`。当前生产池 5 个 family 互不相同 ⇒ 未发生。近乎零成本的补法:保鲜前把候选槽的
`rawDigest`(已在 snapshot 里)与活 Keychain 的 `rawDigest` 比一下,相同即跳过。

**C. monitorOnly 下仍会跑 reconcile** — 实测 S3:`order: []`(= 配置缺失/写坏的兜底态)时保鲜确实零刷新,
但 tick 仍会 spawn reconcile 并改写 `.active` / 池槽 / 账本(不碰 Keychain)。PR body 的
「monitor-only 无池 mutation」只对保鲜那一轮成立。

**D. `lastCandidateSweepAt` 在活身份证明**之前**打戳** — 一次瞬时 probe 失败会白白吃掉一整个
`candidateSweepMinutes`(生产 60 分钟)窗口。保守但延迟自愈。

另:`isAuthUnusable` / `isQuotaUsable` 两道候选过滤被移除 ⇒ 永久死号每轮都会被 POST 一次刷新,
无退避、无告警。对 Fix C 的目标(检测复活)是必要的,与 A 合起来看是「重试了但不报」。

## 6. 建议

A + B 合成一张 follow-up 单在下个窗口做;C / D 记为 advisory。不建议为它们卡住本单 ——
founder 的两条验收与两条安全红线均已成立。
