# FLY-2777 「账号额度一览」重做 — 调研（B1–B5 根因取证）

Issue: FLY-2777 (https://linear.app/geoforge3d/issue/FLY-2777/产品设计额度页-账号额度一览重做按有额度在上打满在下分组排序-修五处数据读错-删掉所有她不看的东西fly-2688-后续founder)
日期: 2026-09-22
基于: exploration.md

---

## 0. 证据分级（下文每条结论都带级）

| 级 | 含义 |
|---|---|
| 【代码】 | 读了生产源码，逻辑可逐行复核 |
| 【真机】 | 读了本机真实状态文件 / 真实页面输出，可复现 |
| 【静态符号】 | `strings` 只读查二进制，证明「符号存在」，**不证明调得通** |
| 【未验证】 | 尚无证据，明确标为待实调 |

⛔ 本次调研**没有**执行任何 Codex/Claude 的带凭据 RPC，**没有**动共享 auth。
凡需要真调才能落定的，一律留在【未验证】，不编。

**页面数据链路（【代码】）**

```
claude-accounts.json ─┐
claude-profiles/*/.credentials.json ─┤→ capacity-snapshot.ts →
codex-quota/codex-accounts.json ─────┘   account-quota-view.ts → HTML
```

---

## B1 — personal 周用量 96% 却显示「打满」

### 根因（【代码】+【真机】，已定位）

`packages/teamlead/src/bridge/account-quota-view.ts:425-443`：

```ts
const cappedWindows = [
  account.fiveHPct === 100 ? account.fiveHResetAt : undefined,
  account.sevenDPct === 100 ? account.weeklyResetAt : undefined,
  (account.fableSevenDPct ?? null) === 100 ? account.fableWeeklyResetAt : undefined,
].filter(...)
const exhausted = cappedWindows.length > 0 || (exhaustedUntil 在未来)
```

**三个维度（5h / 周 / Fable）任一到 100%，整行就被判定 `exhausted`，渲染成一个「打满」标签 + 整行红底。**

真机核对（`~/.flywheel/claude-accounts.json`，2026-09-23T01:20Z 读）：

| 账号 | 5h | 周 | Fable | 页面结论 |
|---|---|---|---|---|
| personal | 51% | **98%**（页面那一版 96%） | **100%** | 打满 ❌ |

⇒ 判定逻辑**没有算错任何一个数**。错的是**把三维压成一维**：
`exhausted` 是一个 OR，渲染时却丢掉了「是哪一维满的」。

### founder 是对的，而且被丢掉的那一半也是对的

- 「96% 不算打满」——**对**。周额度还剩 4%，这个号现在**能用**。
- 「Fable 满了」——**也是真的，而且更要紧**：2026-09-22 工程 Lead 停摆半天，
  正是因为他只跑 Fable，而活跃号的 Fable 是 100%。

⇒ 两件事都必须出现在页面上，**不能合成一个词**。

### 修法方向

**去掉「打满」这个单一标签，改为按维度呈现。** 分组归属（有额度 / 打满）
只看**周额度**这一维；Fable 打满是**行内的一个独立状态**，不改分组，但必须显眼。

具体呈现有两种合理形态，**这是本单唯一要交 founder 选的开放题**（见 plan.md §3）。

---

## B2 — Claude business 显示「Max 5x」，实际是 Max 20x

### 根因（【真机】，已定位到源头，且**不是页面的错**）

页面的档位来自 `readPoolSubscriptionTier()`
（`packages/teamlead/src/account-heal/quota-monitor-credentials.ts:144-185`），
它读的是**本机存的那份 OAuth 凭据文件**：

```
~/.flywheel/claude-profiles/<账号>/.credentials.json → claudeAiOauth.rateLimitTier
```

真机实读（只取非机密字段）：

| 账号 | subscriptionType | rateLimitTier | 页面显示 |
|---|---|---|---|
| **business** | max | **`default_claude_max_5x`** | Max 5x |
| personal | max | `default_claude_max_20x` | Max 20x |
| school | max | `default_claude_max_20x` | Max 20x |
| shopping | max | `default_claude_max_20x` | Max 20x |
| personal1 | max | `default_claude_max_20x` | Max 20x |

⇒ **页面读得一字不差。源头那份凭据里就写着 5x。**
issue 里对 `/api/capacity` 的观察（business 是 `default_claude_max_5x`）也是同一个源头。

### 一条要紧的补充（【真机】，推翻了「文件太旧」这个顺手的解释）

`business/.credentials.json` 的 mtime 是 **2026-09-22 18:20**（今天，刚写过），
但里面仍然是 `max_5x`。⇒ **不能说成「文件旧了」。**

### 两个事实并列，本单不替任何一方下结论

| | 内容 | 级别 |
|---|---|---|
| 机器侧 | `~/.flywheel/claude-profiles/business/.credentials.json` 里 `rateLimitTier = default_claude_max_5x`，且该文件今天刚被写过 | 【真机】 |
| founder 侧 | 「business 是 **Max 20x**」 | founder 2026-09-22 口述 |

这两条现在**互相矛盾，而我没有第三方证据去裁**。可能是：

1. 凭据刷新只换 token、没有重取档位（写回时沿用了旧 tier）；
2. 升级后 OAuth 侧要重新登录才会重新颁发 tier；
3. 记混了（business 确实还是 5x）。

⇒ **这一格归 founder 判断。** 设计稿里这一格照实写成
**「机器读数 5x / 你说 20x，待你确认」**，不画成 20x，也不画成"机器是对的"。

⚠️ 这条**不能在设计稿里把 business 直接画成 Max 20x**：那会让一个未定性的
矛盾看起来已经有答案了。

---

## B3 — personal1 已 cancel，页面没反映

### 根因（【代码】+【真机】+【静态符号】）

**(a) 「已 cancel」在机器侧没有可读来源。**

页面的「订阅到期」只有两个来源：

1. `account.retiresAt` —— 【真机】`~/.flywheel/claude-accounts.json` 里
   **只有 business 有**（`2026-10-14`）。全仓 grep：**没有任何代码写入 `retiresAt`，只有读**
   （`account-candidate-selector.ts` / `account-store.ts` / `switch-executor.ts` 全是读）。
   ⇒ 它是一个**纯人工维护的字段**。
   ⚠️ **但它不证明「已 cancel」**：`account-store.ts:61-63` 只把它定义为
   operator-specified retirement instant，**没有** `cancelled` / `confirmedBy` /
   证据来源 / 确认时间任何一个字段。有人填了一个日期 ≠ 有人确认过这个订阅要取消。
2. `MANUAL_CLAUDE` 常量 —— `account-quota-view.ts:17-22` 里硬编码的
   founder 2026-09-17 手填值（personal 10/4、school 9/17、shopping 9/20）。
   ⇒ 这就是 personal/school/shopping 那三个「订阅到期」的来源：**五天前的手抄**。

**personal1 两个来源都没有 ⇒ 显示「无数据」。**

**(b) 【静态符号】Claude 的 OAuth 面上没有订阅取消字段。**
扫 Claude Code 二进制（`~/.local/share/claude/versions/2.1.280`）里所有
`"*subscription*"` / `"*cancel*"` / `"*renew*"` 形状的 JSON 键名：
有 `stripe_subscription`、`apple_subscription`、`pro_trial_expired` 这类，
**没有**任何「订阅已取消 / 当前计费周期结束于」形状的字段。
`/api/oauth/profile` 与 `/api/oauth/usage` 也没有。

⇒ **结论：来源未找到。** 不是「读错了」，是**根本没有这个读数**。

**(c) personal1 的数据停在 9/8，是另一件事。**
【真机】`personal1.lastObservedAt = 2026-09-08T21:33Z`，且它**没有** `observedFableSevenDPct`、
没有 `fiveHResetAt`——形状停在 Fable 维度上线之前。账本
（`~/.flywheel/account-ledger.json`）里它的 auth 状态是
`lastFreshness: "stale", lastVerifiedAt: 2026-09-07, reason: "runner login_expired"`。
⇒ 这个号的用量探测**已经两周没成功过**。页面把两周前的 70% 摆在「现在」的位置上，
只靠一个没人解释的灰色区分——这正是 exploration §3.3 说的那个坑。

### 修法方向

严格照 founder 的第 8 条：**只有确定已 cancel、确定会在那天到期的才显示到期日。**

她要的输入是三件套：**已取消 + 到期日 + 确认来源**。
系统里**有日期**（business 的 `retiresAt=10/14`、以及 `MANUAL_*` 的手抄值），
但**没有任何一个账号凑齐这三件**——缺的是「取消」这个事实和「谁确认的」这个来源。

- **删掉 `MANUAL_CLAUDE` / `MANUAL_CODEX` 的到期日兜底**——那是 9/17 的手抄，不是确认。
  （`MANUAL_CODEX` 的 `8/3` 甚至已经过去七周了，还挂在页面上。）
- **`retiresAt` 也不够格**：它只是一个 operator 填的退役日期，不带取消证据。
  ⇒ 连 business 的 `10/14` 也**不能**当成「已确认到期」画进产品画布。
- ⇒ **按 founder 第 8 条严格执行的结果是：现在一个到期日都显示不出来。**
  这不是设计偷懒，这是她那条规则的正确结果——**机器侧根本没有「已 cancel」这个读数。**
- personal1 的「已 cancel」要上页面，需要工程侧先有一个带确认来源的权威输入。
  ⇒ 要还给 founder 的实话：**这一格只能她说了算，而且得有地方记下「是她说的」。**

---

## B4 — Claude 充值卡：页面没这个信息

### 根因（【代码】：页面根本没接；【静态符号】：接口存在）

**页面侧**：`account-quota-view.ts:495` —— Claude 行的 `credits` 直接写死
`missingCell("—")`，而且 Claude 表的第五列渲染的是 Fable 用量、**根本不渲染 credits**。
⇒ 不是读失败，是**从来没接过**。

**数据源侧**（【静态符号】，扫 Claude Code 2.1.280 二进制）：
Claude 的「充值卡」= **prepaid credits（预付额度）**，Claude Code 自己就在调：

| 用途 | 端点 | 返回形状（从二进制里的处理代码还原） |
|---|---|---|
| **查余额** | `GET /api/oauth/organizations/:orgUUID/prepaid/credits` | `{ amount, currency, auto_reload_settings: { enabled }, expiry_policy_months }` |
| 可买的包 | `GET .../prepaid/bundles` | `{ bundles[], bundle_paid_this_month_minor_units, bundle_monthly_cap_minor_units, purchases_reset_at, currency, expiry_policy_months }` |
| 购买 | `POST .../contracts/prepaid/credits` | — |
| 购买状态 | `GET .../prepaid/commits/{id}` | — |

鉴权是 `auth: "teleport-org"`（**org 级**），与现在额度探测用的账号级
`/api/oauth/usage` 不是同一条路。TUI 入口是 `/usage-credits`
（二进制里还留着 `"/extra-usage is now /usage-credits"` 这条改名提示）。

### ⚠️ 一条必须说的实话：**这个已找到的接口**给不出「几张卡」

founder 要的是「**有几张、各自什么时候过期**」。这个形状在 Codex 那边成立
（每张卡有独立 `id` / `expiresAt`，见 B5）。在 Claude 这边：

**我找到的这个 prepaid 余额接口给不出逐卡列表** —— 它返回的是**一个余额**
（`amount`，最小货币单位）+ 一条**过期策略**（`expiry_policy_months`，
即「买了之后 N 个月过期」），没有逐张卡，也没有逐张过期时间。

⚠️ 但这只证明「**这个端点**没有」，**不证明 Claude 平台一定没有别的来源**。
我没有扫遍所有可能的面。⇒ 如实写作：**逐卡来源未找到**。

⇒ 这个端点能给她的最接近的答案是：
**余额（折算成美元）· 自动续充开关 · 过期策略（N 个月）· 本月已购 / 月度上限**。

🔴 **这是一次产品语义替换，不是等价交付**：她要「几张卡 / 各自到期」，
我能给的是「一个余额 / 一条过期策略」。**这必须由她点头，不能我替她换。**
（列为 plan.md §5.4 的 founder sign-off 项。）

### 修法方向（工程侧，**全部【未验证】，必须先实调**）

1. **B0 实调**：拿一个账号打一次 `GET /api/oauth/organizations/:orgUUID/prepaid/credits`，
   确认 ① 我们的订阅（个人 Max，非 org）**调不调得通**、② `amount` 的单位与币种。
   ⚠️ 这是 org 级端点，个人订阅很可能直接 404/403 —— **那样的话就要如实回
   「当前账号类型无可用来源」并把这一列整个删掉**，不能把「未接通」
   设计成一个长期存在的空格子。
2. 调得通 ⇒ 接进 `capacity-snapshot`，Claude 表加一列「充值余额」。
3. 设计稿里**照「未接通」画**（见 plan.md），并写清 1 的两种结局各自长什么样。

---

## B5 — Codex 兑换卡：页面写「重置兑换未暴露」

### 根因（一个已证实的缺陷 + 一个未证实的现状，别混成一句）

**【已证实】解析器接不住 schema 规定的对象** —— 只要上游真的返回了它，就必被丢掉。
**【未证实】9/22 那次到底有没有返回它** —— 字段是可选的，「缺席」和「返回了对象」
在现有解析器下**落到同一个 `known:false`**，没有 raw result 就分不开。

⇒ 所以**不能**把当前六个号的空值唯一归因于解析器；
能确定的是：**这个缺陷存在，且必须修，否则修好上游也读不到。**

**上游形状**（FLY-2591 PRD §4.3 P1b，源自 openai/codex PR #28143
"feat(app-server): expose rate-limit reset credits"，merged 2026-06-15）：

```ts
RateLimitResetCreditsSummary = { availableCount: bigint,
                                 credits: RateLimitResetCredit[] | null }
RateLimitResetCredit = { id, resetType, status, grantedAt,
                         expiresAt: number | null, title, description }
```

⇒ **它是一个对象**（张数 + 每张卡的 id/过期时间）。

**FLY-2688 的解析器**（`packages/teamlead/src/codex-quota/rate-limit-detail.ts:122-137`）：

```ts
function parseResetCredits(container) {
  if (!("rateLimitResetCredits" in container)) return { known: false, value: null };
  const value = container.rateLimitResetCredits;
  if (value === null)                      return { known: true,  value: null };
  if (typeof value === "number" && ...)    return { known: true,  value: String(value) };
  if (typeof value === "string" && ...)    return { known: true,  value };
  return { known: false, value: null };          // ← 对象走到这里
}
```

**它只接受 number / 数字字符串 / null。一个对象会落到最后一行 → `known:false`。**
而 `known:false` 在页面上就渲染成 **「重置兑换未暴露」**
（`account-quota-view.ts:574-578`）。

### 取值位置：已证实是对的（这一条在 Round 1 评审中被纠正）

【实测】对本机正在用的 `codex-cli 0.153.2` 跑
`codex app-server generate-json-schema`，读 `v2/GetAccountRateLimitsResponse.json`：

```
TOP properties: accountId, rateLimitResetCredits, rateLimitUpsell,
                rateLimits, rateLimitsByLimitId
required: [rateLimits]
rateLimitResetCredits: RateLimitResetCreditsSummary | null   ← 顶层、可选
RateLimitResetCreditsSummary: { availableCount (必需, int64),
                                credits: RateLimitResetCredit[] | null }
```

⇒ `parseResetCredits(value)` 读**最外层**是**对的**，不用去桶里找。
**唯一的缺陷是类型**：schema 说是对象，解析器只接受标量。

> 我在初稿里写的「取值层级未验证、最外层与桶里都找一次」是**错的**，
> 会把工程修法带偏。已改正。

### 还不能声称的那一半（证据边界）

真机 `~/.flywheel/codex-quota/codex-accounts.json`（2026-09-22T23:26Z）里
**六个号全是** `resetCredits: { known: false, value: null }`。

但 `rateLimitResetCredits` 在 schema 里是**可选**的，而现有解析器对
**「字段缺席」和「字段存在但是对象」会落到同一个 `known:false`**。
⇒ **不能**据此断言「9/22 那次 RPC 确实返回了对象、只是被解析器丢了」。
（同一次读数里 `credits` 解析成功，只说明桶里那个字段在——它是另一个字段。）

⇒ 分成两件事：
- **【已证实·必修】类型不匹配** —— 按顶层 `{availableCount, credits[]}` 重写解析器。
- **【未证实·待实调】本次到底返回了什么** —— B0 要在授权窗口抓一次 raw result，
  区分 absent / null / object。**没有它，就不能把当前的空值唯一归因于解析器。**

### 一个陷阱（FLY-2591 PRD 明写，别踩）

`credits.length` **可以小于** `availableCount`（后端会截断列表）。
⇒ 「有几张」只能取 `availableCount`，**不能用 `credits.length` 代替**。
⇒ 「各自什么时候过期」只有 `credits[]` 里那几张能给；截断时要如实说
「还有 N 张，明细未给全」，不能假装列全了。

### 为什么本单不去实调（边界，如实写）

真调 `account/rateLimits/read` 要碰共享的 Codex auth 与账号池。
FLY-2591 PRD 已把这类实调定为「必须挑没有在飞作业的窗口、由有权限的人做」（FLY-2521 教训）。
本单是设计单，**不具备这个授权**。
⇒ **取值位置已经不是问题了**：本机 schema 已证实它在**顶层**（见上一节），
工程不必再去桶里找。

留在【未验证】的只剩一条，交给工程实现单的 B0 第一步：
**9/22 那次 raw result 里的 `rateLimitResetCredits` 究竟是 absent、null，还是 object。**
同时建议那一步**把一次真实 raw result 落盘留证**，省掉下一个人再猜一次。

### 修法方向

Codex 表的第五列：**删掉 credits（余额）那一半**（founder：「我们反正也没买 Credits」——
真机实读也确实是 `balance: "0"` / `hasCredits: false`，她说得对），
**只留兑换卡**，列名改成「兑换卡」，内容 = **张数 + 最早过期时间**。

---

## 附：A9「当前在用的账号没有绿色高亮」也有根因（【代码】+【真机】）

founder 说「现在没有显示」。查下来**标记其实打上了，只是被压住了**：

- 【真机】页面 HTML 里确实有 `<tr class="exhausted-account active-account">`（Claude personal）
  和 `<tr class="active-account account-missing">`（Codex personal2）。
- 【代码】CSS 里：
  ```css
  .active-account td            { background: var(--active-row) }      /* 浅绿 */
  .exhausted-account.active-account td { background: var(--exhausted-row) }  /* 红，后定义，赢 */
  .active-account td:first-child{ box-shadow: inset 4px 0 0 ... }      /* 4px 细左边条 */
  ```

⇒ **当前在用的号恰好是打满的号时，绿底被红底完全覆盖**，只剩第一列一条 4px 细线。
这不是「没做」，是「做了但在最常见的那种情况下看不见」——而「在用的号被打满」
恰恰是她最需要一眼看到的时刻。

**修法方向**：把「在用」从**背景色**改成**一个不会被任何行状态覆盖的独立标记**
（账号名旁的绿色实心标记 + 「在用」字样）。背景色留给「有额度 / 打满」分组，
两套编码各管一件事，不再抢同一个通道。
