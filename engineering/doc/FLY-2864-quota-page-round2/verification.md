# FLY-2864 额度页第二轮四条 — 实施验证记录
Issue: FLY-2864 (https://linear.app/geoforge3d/issue/FLY-2864/额度页第二轮-founder-看了上线页后的四条删-token-状态列claude-充值卡读出真数据business-档位读成)
日期: 2026-09-24
基于: plan.md（v3）, research.md

## 1. 实施对照（plan §4 T1–T7）

| 步 | 内容 | 提交 |
|---|---|---|
| T1 | 本机 CLI 版本读取；明细 store 加 `tier` / `resetGrants`；探针改读 `usage?cedar_ember=1&skip_spend=1` 并带 CLI UA；外部时间归一化 | `e3674af47` |
| T2 | 从 WHAM reader 抽出 `readVerifiedCodexAuth`（行为不变） | `8b6c2b248` |
| T3 | Codex 订阅 reader（`node:https`）+ 独立 store | `026b32d54` |
| T4 | 快照：实时档位优先、卡透传、Codex 订阅按同身份投影 | `3e4334636` |
| T5 | 视图/页面：删 token 列、卡格新规则、`下次扣费日` 列 | `7d9ead8a9` |
| T6 | `createAccountQuotaRefresh` 组合逻辑 + plugin 注入 | `9b6ba7578` |
| R1 修复 | 沿用的过期取消记录显示「读数已过期」；明细响应 256 KiB 上限 | `3a135c950` |
| R2 修复 | 取消行结束日已过即「读数已过期」，不再依赖 note（整轮失败保留的旧 store 也覆盖） | `df0d54f4e` |

## 2. 真实数据核验（分支 dist，只读，临时目录）

脚本：`evidence/real-data-harness.mjs`。2026-09-25 00:38Z 在本机对生产账号池跑两个只读探针，
store 写到临时目录，其余输入只读生产文件，然后渲染页面。没写生产文件，没刷新 token，也没发 POST。

Claude 明细（脱敏）：

| 号 | usageStatus | tier | 重置卡 |
|---|---|---|---|
| business | ok | max / `default_claude_max_20x` | 1 张，`endsAt 2026-10-22T16:00:00Z` |
| personal | ok | max / `default_claude_max_20x` | 1 张，同上（founder 已重登，token 恢复） |
| school | ok | max / `default_claude_max_20x` | 1 张，同上 |
| shopping | ok | max / `default_claude_max_20x` | 1 张，同上 |
| personal1 | `forbidden:oauth_not_allowed_for_organization` | free / `default_claude_ai` | `known:false, reason:forbidden`（已取消行，页面整行「已取消」） |

Codex 订阅（脱敏，全部 `status: active`、`note: null`）：

| 号 | renewsAt (UTC) | 页面显示（PT） |
|---|---|---|
| business | 2026-10-23T03:59:39Z | 10/22 周四 |
| personal | 2026-10-24T17:00:24Z | 10/24 周六 |
| personal1 | 2026-10-19T04:02:27Z | 10/18 周日 |
| personal2 | 2026-10-20T21:23:08Z | 10/20 周二 |
| school | 2026-10-03T23:37:58Z | 10/03 周六 |
| shopping | 2026-10-18T22:04:02Z | 10/18 周日 |

渲染出的页面（截图 `evidence/accounts-page-branch.png`）：
- Claude 表头：账号｜周重置日｜5h reset｜周用量｜Fable 周用量｜充值卡｜下次扣费日。
- Codex 表头：账号｜周重置日｜5h reset｜周用量｜兑换卡｜下次扣费日。
- business 档位两处都是 `Max 20x`。
- 全页不含「token 状态」「明细未提供」「待你确认」「订阅到期」。唯一的 `@` 是 CSS `@media`。页面和 store 里没有 `Bearer`、`eyJ`、`sk-`。

## 3. 本地定向验证（不跑全包）

| 命令 | 结果 |
|---|---|
| `pnpm lint` | exit 0（只有既有 warning） |
| `pnpm --filter "flywheel-teamlead..." build` | exit 0 |
| `pnpm --filter "...flywheel-teamlead" typecheck` | teamlead、voice-codex 均 Done（先补建 `flywheel-voice-bridge...`，否则其缺 dist 连锁报 TS2307） |
| 定向 17 文件（见下） | 270/270 |
| hook-payload.test + patrol-tick-loop.integration.test | 15/15 |
| R1 修复后 account-quota-view + account-detail | 51/51 |
| **最终 head `df0d54f4e`**：`pnpm lint` | exit 0（27 个既有 warning，0 error） |
| **最终 head**：`pnpm --filter "flywheel-teamlead..." build` | exit 0 |
| **最终 head**：定向 17 文件 + hook-payload + patrol-tick-loop.integration | 19 文件 288/288 |

定向 17 文件：`claude-quota/__tests__/account-detail`、`__tests__/claude-cli-version`、`__tests__/quota-external-instant`、`bridge/__tests__/account-quota-refresh`、`codex-quota/__tests__/codex-subscription-reader`、`codex-subscription-store`、`readonly-usage-reader`、`codex-accounts-observer`、`bridge/__tests__/capacity-snapshot`、`account-quota-view`、`account-quota-page`、`__tests__/capacity-route`、`quota-monitor-credentials`、`patrol-tick-render`、`patrol-tick`、`bridge-child-process-census`、`required-wall-clock-thresholds`。

巡检 tick 回归：用 main 分支构建的 dist，对同一份快照先抓下改动前的 `formatAccountQuotaTickLines` 输出，
写成字面量断言（`account-quota-view.test.ts` 的「patrol tick is untouched」）。改动后逐字一致。

### 消费者发现与排除

对每个改动文件分别用完整路径、文件名、父目录做 `git grep -lF`。保留下来且已执行的测试见上表。排除项和原因：

- `vitest related`：`plugin.ts` 和 `hook-payload.ts` 是中心依赖，相关集合会扩成接近全包测试，与本节点「本地不跑全包」冲突，所以中途终止（FLY-2828 同样处理过），不当作全量绿。
- 其余约 70 个 `plugin.ts` 测试导入者：它们测的是无关路由。本 diff 对 plugin.ts 只改了 `/api/accounts-page.html` 处理器和刷新组合，这两处由 `capacity-route.test.ts` 与 `account-quota-refresh.test.ts` 覆盖。
- 其余 `hook-payload` 测试导入者（EventFilter、commdb-*、epic-intake*、各 *-render）：用的是无关的格式化函数。hook-payload 对本改动的唯一依赖是巡检 tick，已由上面几个测试覆盖。
- `epic-page/freshness.ts` 和 `bridge/patrol-tick.ts` 只把 `CapacitySnapshot` 当类型引用，运行时不受影响。
- `packages/claude-runner/test/kill-path-inventory*`、`child-process-census.json`：只因父目录名 `codex-quota/` 命中。本改动没有新增 spawn 或 kill（census 测试已执行并通过）。
- 历史 exploration、plan、research 文档和 FLY-2688、FLY-2803 的 evidence 脚本：不是运行时消费者。

有一条负载敏感失败：`opus-model-sync.test.ts` 在和其他文件并行跑时失败 1 条。这个文件本单没改，只是被新的版本 helper 引用；单独跑两次都是 63/63。

### 消费者清扫（plan T7，2026-09-25T00:35Z）

- 新模块只被快照、视图、页面、刷新组合和 plugin 引用，切号、候选、告警模块都没有引用。
- `subscriptionTier`、`resetGrants`、`nextCharge` 只出现在 capacity-snapshot、account-quota-view、account-quota-page，以及明细探针和 store 里。
- 非测试代码新增的写操作只有 `codex-subscription-store.ts` 对自身文件的原子写。没有对凭据文件的写，也没有任何非 GET 请求。

## 4. 代码评审

- R1（Codex，`codex:rescue`）：CHANGES_REQUESTED，两条。
  - MAJOR：沿用的 Codex 取消记录在到期日过去后，仍把过去的日期显示成下次扣费日。
  - MINOR：Claude 明细响应体没有字节上限。
  - 两条都先补失败测试再修复（`3a135c950`）。
- R2：CHANGES_REQUESTED，一条 MAJOR。
  - 体积上限修复确认有效。
  - 过期取消的修复只看 `note`，漏掉了一种情况：整轮读取失败时刷新会保留旧 store，而旧 store 里的行 `note` 仍是 null。
  - 改为不看 note：只要取消行的结束日（PT）早于今天，就显示「读不到（读数已过期）」，与 active 分支的规则对称。依据是真正已经结束的订阅会读成 `none`。
  - 新增一条 store → 快照 → 视图 的测试，覆盖「保留下来的旧 store」这条路径（`df0d54f4e`）。修复前两条新测试都是 RED。
- R3：**APPROVE**。没有任何级别的问题。全量 diff 重扫后，身份继承、排序与决策隔离、密钥泄露、请求 host 和体积上限都没有新问题。
