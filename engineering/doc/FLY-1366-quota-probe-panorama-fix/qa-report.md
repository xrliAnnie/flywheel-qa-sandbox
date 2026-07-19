# FLY-1366 账号自愈探针失效 — QA 验证报告

Issue: FLY-1366
日期: 2026-07-19
基于: plan.md（验收标准 L1/L2/L3）

## 结论

**PASS（代码层）** — 被验对象 PR #651 @ `4c90e85f8`。

代码修复正确、测试非空过、CI 全绿。**但 L3 实弹验收尚未发生且当前不可能发生**（见 §4），
按 plan.md §1 的自身约定，**issue 不能凭本报告关单**——本报告只支持 merge，不支持关单。

## 1. 验证范围与真实边界（先说做不到的）

| 层级 | 状态 | 说明 |
|---|---|---|
| L1 单测 + typecheck + lint | ✅ PASS | 独立复跑 + 突变验证 |
| L2-① 独立复跑单测 | ✅ PASS | 190/190（6 个受影响文件） |
| L2-② 真机只读探针对照 | ⚠️ 替代证据 | **未能按原方法复现**，改用生产实证（§2.2） |
| L2-③ 告警实发实收（已部署 main dist） | ❌ 未做 | 需 merge 后部署;已做**编译产物行为级**验证（§3） |
| L3 实弹（真实 quota-100% 窗口自动切号） | ❌ 不可能 | 生产 daemon 卡死 24h+（§4） |

**L2-② 为何改用替代证据**：池内 5 个 profile 的 access token **全部过期**
（school/business/personal1 于 `2026-07-19T10:29Z` 过期，探针时 `22:01Z`），因为 daemon
从 07-18 起就没成功轮询过。按原方法探针需先跑 OAuth probe-refresh，而 **refresh 会轮转
refresh token family**——这正是 exploration R2 判定 `personal` 号死亡的机制。为一次只读取证
去承担弄死另一个备胎的风险，不划算。**故未执行**，改用下述生产实证。

## 2. 根因前提的独立复核

### 2.1 旧校验器确实拒 null（代码级，确定）

`quota-usage-api.ts` 旧 `isQuotaWindow` 要求 `typeof value.resets_at === "string"`，
`null` 必然落空 → `validatePayload` 返回 null → `error:"malformed"`。此为读码可判定的事实。

### 2.2 API 确实会吐 `resets_at: null`（生产实证，本次独立取得）

读生产 statusline cache `~/.claude/usage-api-cache.json`（2026-07-19 14:56 写入，活跃号真实
payload），逐个窗口形字段取值：

```
five_hour:    utilization=47.0  resets_at="2026-07-19T22:29:59.660191+00:00"
seven_day:    utilization=70.0  resets_at="2026-07-22T06:59:59.660212+00:00"
extra_usage:  utilization=null  resets_at=null        ← 窗口形对象携带 null reset
```

另有 5 个 `seven_day_*` 键整体为 `null`。**即 `resets_at: null` 是该 API 的真实合法形态，
不是 exploration 编造的**。这与 exploration 记录的 07-18 实测（闲置号 five_hour
`{"utilization":0,"resets_at":null}`）形态一致。

**诚实边界**：本次拿到的是 `extra_usage` 的 null，**不是**「闲置 five_hour + utilization 0」
那一个精确样本；后者的原始抓取仅存在于 exploration.md 的 07-18 记录中，本次未能独立复现。
两者共同支持同一结论，但证据强度不同，不混为一谈。

已核 `validatePayload` 只校验 `five_hour` / `seven_day` 两个窗口，`extra_usage` 及
`seven_day_*` 的 null 不参与判定，不会误伤。

## 3. 突变验证（证明测试不是空过的绿）

对每个断言方向做反向突变，确认测试真的会红：

| 突变 | 预期 | 实测 |
|---|---|---|
| 删掉 `if (value.resets_at === null) return true;`（撤销核心修复） | 红 | ✅ 红 1 例（`quota-usage-api.test.ts:112`） |
| `isQuotaWindow` 对 `resets_at` 一律放行（过度宽松） | 红 | ✅ 红 5 例（数字/乱串/布尔/对象/invalid instant） |
| 候选排序把 null 改回 `Date.parse(null)` → NaN | 红 | ✅ 红 1 例（既有测试「ranks a candidate whose weekly window has not opened…」） |

**结论：正向与负向断言均真实生效，非 `not.toContain` 类空过。**

### 3.1 F3（告警 mention fallback）行为级验证

不满足于注入 mock，直接调**编译产物** `dist/account-heal/quota-monitor-alert.js`，
用真 stub 二进制捕获 argv：

| 场景 | `--mention-user` 实测 |
|---|---|
| 两个 env 均未设 | （不带） |
| 仅 `FLYWHEEL_FOUNDER_USER_ID` | `FOUNDER123` ✅ **事故场景，fallback 生效** |
| 显式 `..._MENTION_USER` 同时存在 | `EXPLICIT9` ✅ 显式优先 |
| `..._MENTION_USER=空白串` | `FOUNDER123` ✅ 未被空串压住（避开 `??` 陷阱） |

并核实 `~/.flywheel/.env:98` 确有 `FLYWHEEL_FOUNDER_USER_ID`（19 位 snowflake，非空），
wrapper 会 source 它 → **部署后 fallback 具备真实生效条件**。

> 取证自纠：首次用 `^ *export *FLYWHEEL_FOUNDER_USER_ID=` 提取得到 EMPTY，是**我的正则要求
> `export ` 前缀而该行没有**，属工具口径错误导致的假阴性，已改用 source 后读变量纠正。

## 3.2 端到端探针（Lead 点 1 + 点 4）——「no_target 消失」的直接证据

上述突变只证明各段单独成立。为证明**两半真的接得上**，本 QA 新增
`packages/teamlead/src/__tests__/quota-monitor-idle-e2e.test.ts`：把**真** `fetchAccountUsage`
（真 validator）经可注入的 `fetchFn` 接进 `pollOnce`，喂 07-18 记录的原始 JSON 形态，
在**隔离环境**跑完整一轮探针（未触碰任何生产账号池状态）。

场景 = 事故当时的真实构型：active `shopping` 5h 100%，两个备胎 school / business 均闲置
（`five_hour: {utilization: 0, resets_at: null}`）。

| 代码状态 | `pollOnce` outcome | panorama |
|---|---|---|
| **修复前**（突变掉 null 接受） | **`no_target`** ← 事故日志里一模一样的症状 | 备胎全 `usage_malformed` |
| **修复后**（PR 现状） | **`switched`** | `school:qualified` / `business:qualified` |

即 **≥1 个可切换目标出现、no_target 消失**，且这条链路是端到端的（原始 payload → 校验 →
panorama → 切换决策），不是把已解析结果喂进去的桩。

同文件第 2 例守反路：`resets_at: 12345`（非 null 非法值）与 `utilization: -1` 仍判
`usage_malformed` → `no_target` 且零 switch I/O。**该例在核心修复被突变掉时仍绿**，
证明它测的是「没被改宽松」而不是跟着修复一起动的。

> 该文件同时补掉了本报告 §5.1 原先记的观察项：核心解析修复此前只有单点守护。

## 3.3 freshness_stale 是同源还是独立（Lead 点 3）

**独立问题，本 PR 没修它，只让它可诊断。** 逐条：

- 两者走**不同代码路径**：`usage_malformed` 出自 `fetchUsage` 的 payload 校验;
  `freshness_stale` 出自 `verifyCandidate` 的 OAuth probe-refresh。
- diff 逐行核对：`verdict.fresh === "stale"` 这个**判定条件本身一字未动**，
  改的只有返回的 reason 字符串（裸词 → `` `freshness_stale: ${verdict.reason}` ``）
  及随之而来的类型/前缀匹配。
- 因此 `personal` 号**仍然会被拒**（class 仍是 `unverifiable`），运维只是终于能从
  panorama 看见「为什么」（如 `refresh refused (HTTP 403)`）。
- 真根因（exploration R2）是 personal 的 refresh token family 已死，属**运维复登**动作，
  plan.md 已列为非目标 + follow-up。**没修 ≠ 悄悄放过**，此处点名。

## 4. 🔴 阻塞项：生产自愈至今仍是死的（与本 PR 无关，但必须让 Lead 知道）

`/tmp/flywheel-quota-monitor.log` 最近 12 轮（07-19 18:09 → 21:49 UTC）**全部**：

```
outcome=identity_conflict  panorama=[]  delivery=[{"kind":"machine_account_conflict","primary":"sent"}]
```

自 07-18 18:09 Annie 手动切到 personal1 起，**已连续卡死 24 小时以上**，panorama 根本不运行。

含义（三点，别混）：
1. 本 PR 修的是 panorama **跑起来之后**的解析问题；identity_conflict 让 panorama **压根没跑**。
   两者是串联的两道门，**修好这道不等于自愈恢复**。
2. plan.md §3 规定的 pre-QA 运维事务（采认 Keychain 现实、解 identity_conflict）**尚未执行**。
   不解除，L3 实弹永远等不到。
3. 因此 L3 无法由本次 QA 完成，且**部署后也不会自动发生**——必须先做 §3。

## 5. 观察项（非阻塞，供 review 参考）

1. ~~核心解析修复只有 1 个测试守着~~ → **本 QA 已补齐**（§3.2）。原状况属实：
   `quota-monitor.test.ts` 的 65 个用例注入已解析结果、绕过真实 validator，
   撤销核心修复时它们**全绿**；唯一守门的是 `quota-usage-api.test.ts` 的孤立单测。
   新增的 e2e 文件把两半接起来，突变核心修复即复现 `no_target`。
2. **候选排序的 `-Infinity` 平手依赖「NaN 是 falsy」**。两个闲置候选同为 `-Infinity` 时
   `a.resetMs - b.resetMs` 得 NaN，靠 `||` 短路落到 `orderIndex`。正确，但隐晦。
   已实测该行为成立;未新增测试——本 QA 尝试写过一个，经突变验证发现**在现有 2 候选
   夹具下无区分力（删掉平手裁决它照样绿）**，属空过绿测，遂**删除而非提交**。
   真正守住 null 排序语义的是既有那条 NaN 突变会打红的测试。
3. `pnpm lint`（裸 `biome check`）全仓报 639 errors，但**改动的 12 个文件 0 error**
   （repo biome 2.1.4 定向复核），且 CI Quick Gate lint 绿 → 属既有全仓噪声，非本 PR 引入。

## 6. 本地测试失败的定性（不是回归）

`pnpm --filter flywheel-teamlead test` 本地 69 failed / 8625 passed。**判定为高负载 flake**：

- 失败文件全在 `actions.*` / `event-route.*` / `post-ship-finalization` / `complete-marker-reconciler`
  / `claude-profile-cli` / `createLeadRuntime-preflight` / `fly247-bash-suites` —— **无一个是本 PR 触碰的文件**
  （本 PR 只动 `quota-*` + `account-store` 及其测试）;
- 取 `post-ship-finalization.test.ts` 单文件单线程隔离重跑 → **21/21 全绿**（阳性反证）;
- 机器 load average **27.19 / 37.48 / 37.50**;
- 同一 head `4c90e85f8` 的 CI **9/9 全绿**，含 teamlead 三个分片。

已按纪律 `env -u FLYWHEEL_RUNNER_BACKEND` 排除已知 env 污染。

## 7. 验收对照（plan.md §1）

| 标准 | 判定 |
|---|---|
| 真抓 fixture 从红变绿 | ✅ 突变验证确认 |
| 负向（resets_at 为数字/乱串）仍 malformed | ✅ 5 例突变红 |
| 闲置候选进 tier0 并完成切换的 pollOnce e2e | ✅ 存在且通过 |
| sevenD null 排最前 | ✅ 存在，且 NaN 突变会打红 |
| active-trigger null 守卫 e2e（含精确 signature） | ✅ 2 例（含 cooldown 绕行路径） |
| mention fallback 单测 | ✅ 单测 + 编译产物行为级双证 |
| typecheck（teamlead 单包） | ✅ exit 0 |
| CI 全绿 | ✅ 9/9 @ `4c90e85f8` |
| L3 实弹 | ❌ **未达成**（§4） |

### 7.1 Lead 五点要求逐条对照

| # | 要求 | 判定 | 证据 |
|---|---|---|---|
| 1 | 正路：resets_at=null + 0% 判合格切换目标 | ✅ | §3.2 e2e：`outcome=switched`、`school/business:qualified` |
| 2 | 反路：真畸形负载仍被拒（别修成什么都收） | ✅ | §3 过度宽松突变红 5 例 + §3.2 e2e 第 2 例（数字 reset / 负 utilization → `no_target`） |
| 3 | freshness_stale 是同源还是独立 | ✅ 已定性 | §3.3：**独立**，本 PR 只加可诊断性、判定条件一字未动，personal 仍被拒 |
| 4 | 端到端跑一轮，产出 ≥1 可切目标、no_target 消失 | ✅ | §3.2 前后对照表（隔离环境，未动生产池） |
| 5 | 回归：既有切号单测/集成测全绿 | ✅ | 受影响 7 文件 192/192；CI 9/9 @ `4c90e85f8`；本地 69 failed 已定性为高负载 flake（§6） |

## 8. 给 Lead 的建议

1. **本 PR 可以 merge** —— 代码正确、证据充分、无回归。
2. **但 FLY-1366 不能就此关单**。plan.md §1 白纸黑字「实弹过了才关单（已向 founder 承诺）」，
   而 L3 未发生。
3. **merge 后的真实下一步是运维，不是等**：先做 plan.md §3 解 identity_conflict，
   再做 §4 的 bootout/bootstrap 部署（daemon 现在跑的是 FLY-1182 worktree 的 dist，
   plist 把四个路径 env 钉死，**改 .env + kickstart 不会生效**），然后才谈 L2-③ 与 L3。
4. 建议把「§3 运维事务」显式建成可追踪动作交给 Lead，别让它悬在 plan 文档里 —— 它已经
   悬了 24 小时，期间自愈完全失效。
