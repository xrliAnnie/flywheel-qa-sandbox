# FLY-2779 模型选型：能力 × 价格 × 节点组合 × A/B 方案 — 调研

Issue: FLY-2779 (https://linear.app/geoforge3d/issue/FLY-2779/产品研究模型选型-fable-51-opus-55-gpt-6-astra-gpt-6-sol能力-价格综合评估-每个节点与-lead)
日期: 2026-09-22
基于: 无（本单是 Lead 已交付的模型对比页 https://fw-reports-356a6d.vercel.app/r/e221f94a434a167fb99b7e53ccf4faa6/ 的增量补充：价格 / 多候选 / A/B）

---

## 0. 一句话结论

三条事实改变了原来的判断：

1. **Astra 没有降价。** 今天（2026-09-22）变的是 OpenAI 发布了 **GPT-6 Sol / GPT-6 Luna**，
   在同一张（7 小时前更新的）价目表上，GPT-6 Sol 的额度费率是 Astra 的 **1/5**。
   founder 记忆里「Codex 出了新价目表、Astra 便宜了」方向对，但便宜下来的是**新出的 Sol**，不是 Astra 本身。
2. **Fable 5.1 在第三方独立实测里被 Opus 5.5 双向支配**：指数更低（53 vs 58），
   跑完同一套评测的**总花费还贵 51%**（\$13,129 vs \$8,708）。我们现在把 Fable 摆在设计节点默认位和
   flywheel-eng-lead 上，这两处都值得重排。
3. **「谁更贵」不能只看每百万 token 单价。** Astra 单价是 Opus 5.5 的 2.5 倍，但跑完同一套评测
   Astra **反而便宜 39%** —— 因为它输出 token 量只有 Opus 的 1/4。这正好解释了 founder 的历史教训
   为什么当时反过来：贵的是**啰嗦**，不是**单价**。

**本文已转为定稿记录。** founder 2026-09-22 拍板（8:00 PM PDT，QA 一行 8:27 PM PDT 在卡上追改）：
设计段 Astra / Opus 5.5 / Fable 5.1 各 1/3、实现段直接用 Opus 5.5、
**QA 段 GPT-6 Sol 75% / Opus 5.5 25%（为了攒数据）**、Raya 维持 Astra、
Tadashi 她先手动试 Opus 5.5 再定。
见 §5；两段分流怎么量见 §6；交 Tadashi 的配置清单见 §6.3。

---

## 1. 现状快照（本机实测，不是记忆）

### 1.1 每个节点现在跑什么

来源：`.flywheel/agents/registry.yaml`（graphs.*.policies）+ `~/.flywheel/models.json`（运行期权威）

| 工作流 | 节点 | 默认模型 | 实际解析到 | 允许的候选 | effort |
|---|---|---|---|---|---|
| code 工程开发 | `eng_design` 设计 | `fable` → **被运行期分流覆盖** | 见下 | fable / codex / astra | high（astra 同 high） |
| code | `implement` 实现 | `codex` | **gpt-5.6-sol** | fable / codex / astra | xhigh |
| code | `qa` | `opus` | **claude-opus-5**，但被 `phases.qa` 钉成 **claude-opus-4-6[1m]** | opus | high |
| simple_code 轻量开发 | `implement` | `codex` | gpt-5.6-sol | opus / fable / codex / astra | xhigh |
| simple_code | `qa` | `opus` | 同上（phases.qa 覆盖） | codex / opus | high |
| prd 产品需求 | `pm` | `opus` | claude-opus-5 | **只有 opus** | high |
| product_design_flow | `product_design` | `opus` | claude-opus-5 | 只有 opus | high |
| prototype | `proto` | `opus` | claude-opus-5 | 只有 opus | high |
| generic | `general` | `opus` | claude-opus-5 | 只有 opus | high |

别名解析（`packages/config/src/model-builtins.ts:36-37`）：
`codex` = `gpt-5.6-sol`；`astra` = `gpt-6-astra`；`fable` = `claude-fable-5-1`；
`opus` = `claude-opus-5`（`~/.flywheel/models.json` 的 `bindings.opus`）。

### 1.2 设计节点的分流现在是什么状态 —— 与本单描述不符

单子里写「当前 `codexPercent = 0`（即全走 Fable）」。本机 `~/.flywheel/models.json` 实测：

```json
"modelSplit": { "enabled": true, "rule": "issue_number_percentage",
  "codexPercent": 100, "codex": {"arm":"A","model":"astra"}, "fable": {"arm":"B","model":"fable"} }
```

> **截至 2026-09-22 4:56 PM PDT 起 `codexPercent=100`（此前为 0）；谁改的、是否有意，待确认。**

时间戳依据：`~/.flywheel/models.json` 的文件 mtime 为 `2026-09-22 04:56:46 PM PDT`，与 Lead 独立给出的时点一致。
⛔ 本文不对原因作任何推测。`codexPercent=100` 意味着设计节点当前每一单都落 A 臂（Astra），
FLY-2570 那个 A/B **没有在采对照数据**——这是配置的直接后果，不是对动机的判断。

### 1.2.1 ⚠️ 同一个设计节点上有**两套**分流配置，必须搞清楚哪一套在管派单

| 层 | 位置 | 规则 | 版本 | 落地时间 |
|---|---|---|---|---|
| 仓内 registry | `.flywheel/agents/registry.yaml` → `graphs.code.policies.eng_design.modelSplit` | `issue_number_parity`（奇 Astra / 偶 Fable） | `fly2403-v1` | 2026-09-08，PR #1116（`git log -S'fly2403-v1'` 实测；不是 9/15） |
| 运行期 | `~/.flywheel/models.json` → `modelSplit` | `issue_number_percentage` | 由 semantics 的 sha256 派生 | 当前值 2026-09-22 16:56 PDT |

**结论：运行期那一套（models.json 的百分比）在管派单；registry 里的奇偶表不参与选臂。**

证据在 `packages/teamlead/src/workflow-menu.ts:766-777`：

```ts
const scopedSplit = menu.shape === "code" && node.id === "eng_design" && node.modelSplit;
if (scopedSplit && modelConfig.runtimeModelSplitStatus === "invalid") throw ... // MODEL_SPLIT_CONFIG_INVALID
const modelSplit = scopedSplit ? (modelConfig.modelSplit ?? node.modelSplit) : node.modelSplit;
```

优先级链（`packages/teamlead/src/__tests__/workflow-model-split.test.ts` 逐条有断言）：

| models.json 的 modelSplit | 实际生效的 | 测试 |
|---|---|---|
| 存在且合法 | **运行期那一套**（registry 的奇偶表被完全旁路） | 「reads the current models.json split policy for every dispatch decision」——同一单 FLY-2403 随运行期配置改变臂 |
| 缺失 | registry 的 `fly2403-v1` 奇偶表 | 「uses the registry default when modelSplit is absent」 |
| 存在但格式错 | **抛 `MODEL_SPLIT_CONFIG_INVALID`，拒绝派工**（不会静默回落奇偶） | 同一条测试的后半段 |

⇒ **Lead 观察到的那个反例正是代码预测的结果**：FLY-2654 是偶数单（奇偶表会判 Fable），实跑是 Astra；
而百分比策略在 `codexPercent=100` 下，桶位恒 `< 100`（桶值域是 `[0,100)`）⇒ **每一单都是 A 臂 Astra**。
不是巧合，是唯一可能的结果。

🪤 **一个会咬人的坑（做推广时必须知道）**：`scopedSplit` 的第三个条件是 `&& node.modelSplit` ——
也就是说 **registry 里那段看似已经失效的奇偶配置，是让运行期百分比策略能够生效的「闸门」**。
如果有人因为「它反正不生效」而把 `fly2403-v1` 那段从 registry.yaml 删掉，
`scopedSplit` 变成假 ⇒ `modelSplit = node.modelSplit = undefined` ⇒ **models.json 里的百分比策略会被静默忽略，
分流整个消失**，而且不报错。**内容是死的，存在是活的。**

📌 另一个易错点：百分比形式**不接受 `enabled: false`**（`model-split.ts` 明确抛错，提示用
`set --codex-percent 0`）；而奇偶形式接受 `enabled: false`（此时不产生任何 assignment，回落到节点
`defaultModel`，即 Fable）。两种形式的「关掉」方式不一样。

### 1.3 每个 Lead 现在跑什么

来源：`~/.flywheel/projects.json`

| 项目 | Lead | 模型 |
|---|---|---|
| geoforge3d | product-lead / ops-lead / cos-lead | opus[1m] |
| joycon-typeless | joycon-lead | opus[1m] |
| personal-assistant | belle-lead | sonnet |
| growth | mufasa-lead | （未设，走默认） |
| growth | rafiki-lead / reflection-lead | sonnet |
| flywheel | flywheel-cos-lead | opus[1m] |
| flywheel | **flywheel-eng-lead** | **fable** |
| flywheel | flywheel-product-lead | opus[1m] |
| flywheel | claude-infra-bot-lead | sonnet |
| tidal-echo | tidal-echo-cos-lead | sonnet |
| tidal-echo | tidal-echo-content-lead / sub-lead | opus[1m] |
| raya | **raya** | **gpt-6-astra**（modelContextWindow 1,050,000） |

---

## 2. 价格：订阅场景下「贵」到底指什么

我们付的是**月度订阅**，不是 API 按量。所以 API 的 \$/MTok **不是我们的账单**，它只是一把
「相对贵贱的尺子」。真正稀缺的是**额度窗口**。两家的计价语言完全不同，必须分开说。

### 2.1 三种口径

| 口径 | 适用 | 我们实际付的是它吗 |
|---|---|---|
| A. API \$/MTok | 跨模型比相对贵贱、算单任务成本 | ❌ 不是账单，是尺子 |
| B. Codex 订阅额度（5 小时窗 / 周窗 + credits） | 所有 Codex vendor 节点（implement、eng_design 的 A 臂、raya） | ✅ 是 |
| C. Claude 订阅额度（5 小时窗，多账号轮换） | 所有 claude vendor 节点与 Lead | ✅ 是 |

### 2.2 口径 A —— API 单价（一手）

OpenAI（https://developers.openai.com/api/docs/models/gpt-6-astra、`.../gpt-6-sol`，2026-09-22 读取）

| 模型 | 输入 | 缓存输入 | 缓存写 | 输出 |
|---|---|---|---|---|
| GPT-6 Astra | \$10 | \$1 | \$12.5 | \$50 |
| GPT-6 Sol | \$2 | \$0.2 | \$2.5 | \$10 |

Anthropic（https://platform.claude.com/docs/en/about-claude/pricing，2026-09-22 读取）

| 模型 | 输入 | 5m 缓存写 | 1h 缓存写 | 缓存命中 | 输出 |
|---|---|---|---|---|---|
| Claude Fable 5.1 | \$10 | \$12.50 | \$20 | **\$0.25**（0.025x） | \$50 |
| Claude Opus 5.5 | \$4 | \$5 | \$8 | **\$0.20**（0.05x） | \$20 |
| Claude Opus 5（我们现在的 `opus`） | \$5 | \$6.25 | \$10 | \$0.50 | \$25 |

⚠️ **三个容易算错的地方，都已核过两边：**

1. **272K 台阶（OpenAI 侧）**：Astra 和 GPT-6 Sol 的价目页**都写了**
   「Prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request.」
   ⇒ 大上下文请求两边**绝对成本同时翻倍**，但**比值不变**（仍是 5x）。
   只抓贵的那一边会算出假的倍数暴涨 —— 这是 FLY-2343 踩过的坑，这次两边都抓了原文。
2. **长上下文溢价（Anthropic 侧）**：**没有**。文档原文：「Claude 4.6 and later models … include the full
   1M token context window at standard pricing.（A 900k-token request is billed at the same per-token rate as a 9k-token request.）」
   ⇒ 我们这种长会话、大仓库上下文的场景，Claude 侧在大上下文上**结构性便宜**，OpenAI 侧有台阶。
3. **缓存命中价差**：长 agent 循环里输入绝大部分是缓存命中。
   Fable 5.1 命中 \$0.25/MTok，Astra 命中 \$1/MTok —— **Fable 的缓存命中反而比 Astra 便宜 4 倍**。
   所以「Fable 贵」只在输出侧成立；输入重、输出轻的活（长上下文只读分析）Fable 不吃亏。

### 2.3 口径 B —— Codex 订阅额度（founder 说的「新价目表」就是这张）

**一手来源**：ChatGPT Rate Card（https://help.openai.com/en/articles/20001106-codex-rate-card），
页面自己标注 **「Updated: 7 hours ago」**（= 2026-09-22 当天）。这就是 founder 印象里今天更新的那份。

Work & Codex 按 token 计 credits（credits per 1M tokens）：

| 模型 | 输入 | 缓存输入 | 输出 | 相对 Astra |
|---|---|---|---|---|
| **GPT-6 Astra** | 250 | 25 | 1,250 | 1.0x |
| **GPT-6 Sol** ← 今天新增 | **50** | **5** | **250** | **0.2x（便宜 5 倍）** |
| GPT-6 Luna | 2.5 | 0.25 | 12.5 | 0.01x |
| **GPT-5.6 Sol**（我们 implement 现在用的） | 100 | 10 | 500 | 0.4x |
| GPT-5.6 Terra | 50 | 5 | 300 | — |
| GPT-5.6 Luna | 5 | 0.5 | 30 | — |

换算：credits 和美元是固定比例（Astra \$10/MTok ↔ 250 credits ⇒ **25 credits = \$1**），
GPT-6 Sol \$2/MTok ↔ 50 credits，同一比例。**所以这张表没有给 Astra 打折，它只是把新模型加了进来。**

⇒ 对 founder 那句话的诚实回答：
- ✅ 今天确实有新价目表（7 小时前更新）。
- ❌ 没有证据显示 **Astra 降价**：API 页仍是 \$10/\$50，rate card 仍是 250/1250，与我 2026-09-04 在 FLY-2343 读到的一致。
- ✅ 真正发生的是：**GPT-6 Sol 以 Astra 1/5 的费率出现**，且比我们现在用的 GPT-5.6 Sol 还便宜一半。
  TechCrunch 转述 OpenAI 的说法是「6 系列以 5.6 系列一半的成本提供」，与 rate card 数字吻合。

**但这张 rate card 是 Business / Enterprise 的 credit 口径。我们是 Plus 账号（3 个 Plus + 2 个 Free，`codex-profile`）。**
Plus 的真实约束是**包含额度的 5 小时窗 / 周窗**，credits 只是超出后的加购通道。

Plus 的窗口口径（https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex，
页面标注 Updated: 6 days ago，**该表还没有收录 GPT-6 Sol**）：

| 模型 | Plus 每 5 小时的「本地消息」估算 |
|---|---|
| GPT-6 Astra | **5–45** |
| GPT-5.6 Sol | **10–100** |
| GPT-5.6 Terra | 25–200 |
| GPT-5.6 Luna | 250–2,000 |

⇒ 在 Plus 上，**Astra 每个 5 小时窗能干的活大约只有 GPT-5.6 Sol 的一半**。
这就是 founder 说的「实现节点用 Astra 太贵只好换回 Sol」在机器上的样子 —— 不是账单变多，是**窗口更快撞墙**。

⚠️ **推算（不是官方数字，必须标明）**：GPT-6 Sol 的窗口行还没发布。若窗口消耗与 credit 费率同比例，
GPT-6 Sol（50 credits）相对 GPT-5.6 Sol（100 credits）应是**约 2 倍的消息数**，即约 20–200 条/5h，
约为 Astra 的 **4 倍**。**这是我的推算，不能当成 OpenAI 的承诺** —— 上线后必须实测（见 §6 指标）。

### 2.4 口径 C —— Claude 订阅额度：**官方不公布每模型权重**

查了 Anthropic 的两篇一手文档（
https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan 、
https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code，后者标注今天更新）：
**没有任何 per-model 的数字权重**。原文只有定性表述：
「Opus … **uses meaningfully more of your quota**」「Opus costs several times more per turn than Sonnet」。

⇒ **Claude 侧的「价格」我们只能自测。** 这不是查资料能补上的缺口，它直接决定了 A/B 方案里必须先加计量（§6）。

本机现有的唯一计量是 `~/.flywheel/quota-monitor.json` / `quota-monitor-state.json`：
5 小时窗触发阈值 90%、70% 加速轮询、账号轮换顺序 personal → school → business → personal1。
它记的是**账号级窗口位移**，**没有按模型/按节点拆**。

⚠️ **一个会误导跨厂商 token 比较的坑**：Anthropic 文档写明
「Claude 4.7 and later models … use a newer tokenizer … produces **approximately 30% more tokens** for the same text」。
⇒ 拿 token 数直接跨厂商比「谁啰嗦」会高估 Claude 侧约 30%。下面 §4 用的是**美元总额**而不是 token 数，正是为了绕开这一点。

---

## 3. 可用性核查（推荐一个用不上的模型等于没推荐）

| 模型 | 在我们的运行时里能用吗 | 证据 |
|---|---|---|
| Claude Fable 5.1 | ✅ 能，已注册 | `models.json` 有条目；`model-builtins.ts` MODEL_IDS.FABLE |
| Claude Opus 5（现 `opus`） | ✅ 能 | `bindings.opus = claude-opus-5` |
| **Claude Opus 5.5** | ⚠️ **模型可用，但 Flywheel 还没注册** | Claude Code 2.1.280 二进制里**有** `claude-opus-5-5`；但 `model-builtins.ts` 的 `OPUS_IDENTITIES` 最高只到 `claude-opus-5`，`~/.flywheel/models.json` 也没有它 ⇒ **现在 dispatch 会被 fail-loud 拒掉**。开通成本：在 `models.json` 的 `models` 数组加一条（Fable 就是这么加进去的），大概率**不需要改代码**；上线前要跑一次冒烟。 |
| GPT-6 Astra | ✅ 能 | 本机 codex 0.154.0 内嵌 catalog 有 `gpt-6-astra`（context_window 272000 / max 872000） |
| GPT-5.6 Sol（现 `codex`） | ✅ 能 | 同上，catalog 有 `gpt-5.6-sol` |
| **GPT-6 Sol** | ⚠️ **今天刚进 Codex，本机版本还没有** | 本机 codex **0.154.0** 的内嵌 catalog **没有** `gpt-6-sol`（只有 gpt-5.6-sol / gpt-6-astra）。openai/codex 的 **rust-v0.156.1（发布于 2026-09-23T02:41:36Z，即当地 09-22 19:41 PDT）** release note 原文：「Choose GPT-6 Sol or GPT-6 Luna from the model picker.」「[hotfix 0.156.0] Add GPT-6 Sol and Luna to the model catalog (#47332)」。npm 上 `@openai/codex` 最新还是 **0.156.0**（不含 Sol）。⇒ **要用 GPT-6 Sol，必须先把 Codex CLI 升到 ≥0.156.1。** |

📌 单子里写的「0.153.2 里还没有 gpt-6-sol」仍然成立，而且 0.154.0 也没有；**变化发生在今晚**。

---

## 4. 能力 + 单任务成本（第三方，同一版本内比较）

来源：Artificial Analysis，**Intelligence Index v4.3.2**（两次对比页给出的版本号一致，可同版本内比）。
AA 同时公布「跑完整套指数的总花费」和「总输出 token」—— 这是目前能拿到的、最接近 founder 要的
**单任务成本**的公开口径（它按各模型自己的 API 价折算，所以自带「啰嗦惩罚」）。

| 模型 | 智能指数 v4.3.2 | Terminal-Bench 4.0 | SciCode | 跑完指数总输出 token | **跑完指数总花费** | 相对 Astra | 输出速度 |
|---|---|---|---|---|---|---|---|
| Claude Opus 5.5 | **58** | 60% | 67% | 260M | **\$8,708** | 1.64x | 54 t/s |
| Claude Fable 5.1 | 53 | 52% | 63% | 188M | **\$13,129** | **2.47x** | 65 t/s |
| GPT-6 Astra | 53 | 59% | 56% | **60M** | **\$5,324** | 1.0x | — |
| GPT-6 Sol | 48 | 44% | 58% | 77M | **\$1,550** | **0.29x** | 115 t/s |

派生指标（我算的，不是 AA 公布的）：**每一点指数分的花费** = 总花费 / 指数分

| 模型 | 每分花费 | 排名 |
|---|---|---|
| GPT-6 Sol | \$32 | 最便宜 |
| GPT-6 Astra | \$100 | |
| Claude Opus 5.5 | \$150 | |
| Claude Fable 5.1 | **\$248** | 最贵 |

**四条读数：**

1. **Fable 5.1 被 Opus 5.5 双向支配**：分更低（53 < 58）、花费更高（\$13,129 > \$8,708）。
   在「只看能力」和「只看成本」两个方向上 Fable 都输，没有一个维度需要权衡。
2. **Astra 便宜是因为不啰嗦，不是因为单价**：单价是 Opus 5.5 的 2.5 倍，输出 token 只有 1/4，净结果便宜 39%。
   ⇒ **founder 的历史教训要修正一半**：Astra 在 AA 这套任务上并不是「贵」的那个。
   它在**我们的 Plus 订阅**里贵，是因为**窗口配额**卡得紧（5–45 条/5h），而不是因为烧钱多。
   这两件事在订阅场景下会给出相反的结论，必须分开讲。
3. **GPT-6 Sol 是性价比的新地板**：\$1,550 跑完指数，比 Astra 便宜 3.4 倍，速度快一倍以上。
   代价是能力掉一档（48 vs 53），且 **Terminal-Bench 只有 44%**（Astra 59%、Opus 60%）——
   **在 agentic coding 上掉得比综合指数更明显**。所以它适合体量大、难度中等的节点，不适合硬骨头。
4. **Opus 5.5 是综合最强**：指数第一（58）、Terminal-Bench 第一（60%）、SciCode 第一（67%）。

⚠️ **这张表的边界（不要越界解读）：**
- AA 的任务组合**不是我们的任务组合**。我们的活是超长 agent 会话、巨量缓存命中、工具调用密集，
  AA 指数里没有等价项。所以它排的是**相对贵贱的序**，不是我们的**绝对成本**。
- 「Opus 5.5 成本只有 Astra 的 20%–40%」是 **Anthropic 自己的宣传**，**不能写成第三方结论** ——
  AA 的独立实测方向恰好相反（Opus 5.5 贵 64%）。
- GPT-6 Sol 与 Opus 5.5 都是 2026-09-22 当天发布，第三方样本很薄；AA 已出指数，但
  METR 任务时长、独立 agentic 长程评测**都还没有**。缺就是缺。

---

## 5. 定稿：每个节点 / 每个 Lead 用什么

**founder 2026-09-22 8:00 PM PDT 拍板**（原话要点：「设计段 Astra、Opus 5.5，还有 Fable 5.1 三个都上，
各占三分之一的流量看效果。实现段我看了你的新结果之后，比较倾向直接用 Opus 5.5，QA 段用 Sol 6，
然后 Raya 用 Astra 是可以的。我现在唯一不太确定的是 Tadashi……我最近先 manually 用 Opus 5.5 试一下，
看它的效果怎么样。两个先决条件 Tadashi 都在做，应该今天晚上就会修好。」）

| 在哪 | 现状 | 定稿 | 来源 |
|---|---|---|---|
| `eng_design` 设计 | 运行期 100% Astra | **Astra / Opus 5.5 / Fable 5.1 各 1/3** | founder 拍板 —— 三组对比 |
| `implement` 实现 | gpt-5.6-sol @ xhigh | **Opus 5.5** | founder 拍板（不再做实现段对照） |
| `qa` | claude-opus-4-6[1m]（`phases.qa` 钉住） | **GPT-6 Sol 75% / Opus 5.5 25%** | founder 拍板（2026-09-22 8:27 PM PDT 在卡上改的，原话「we could do opus 5.5 25%, sol 75%, mostly just to give us some data」）—— 主要为了攒数据 |
| Lead：raya | gpt-6-astra | **Astra（不动）** | founder 拍板 |
| Lead：flywheel-eng-lead（Tadashi） | fable | **founder 先手动试 Opus 5.5（2026-09-22 起已在跑），看效果再定** | founder 拍板，待回填 |
| `pm` / `product_design` / `proto` / `general` | claude-opus-5 | Opus 5.5 | 沿用推荐，founder 未表态 |
| Lead：其余 opus[1m]（product / ops / cos / joycon / flywheel-cos / flywheel-product / tidal-echo-content / sub） | opus[1m] | Opus 5.5[1m]，统一升 | 沿用推荐，founder 未表态 |
| Lead：sonnet 那几个（belle / rafiki / reflection / claude-infra-bot / tidal-echo-cos） | sonnet | — | **现状，本单不评**（founder 有禁用 Sonnet 的直令，质量原因；本单不得写成「推荐维持 Sonnet」） |

⛔ 本单不执行这张表。定稿后由 Lead 交 Tadashi 改配置（§6.3）。

### 5.1 一条提醒（不改决定，只把代价讲清楚）

**设计段分三组要跑多久**
- **你定的**：三个模型各 1/3。
- **我们提醒**：看成本约 **3 周**（每臂约 25 单）；要「统计上显著」要 **3.6–8 个月**（算法见 §6.2）。
- **因为**：分三组把每臂样本砍到三分之一，且三组要两两比较（Bonferroni 把每臂从 150 抬到 200 单）。
- **建议按 3 周的成本口径收**，能力只当护栏（§6.1）。

📌 原来关于 QA 的那条提醒（GPT-6 Sol 的 Terminal-Bench 44% 最低、漏判无下游防线）**已被 founder 回应**：
她把 QA 改成 **GPT-6 Sol 75% / Opus 5.5 25%**，用 25% 的对照臂来攒数据。提醒因此撤下，
它的证据仍在 §4 的表里。

### 5.2 沿用推荐那几行的依据（供回看）

- 产品单节点走 Opus 系列：产出是中文长文与判断，AA 指数 Opus 5.5 第一（58）；
  且 runner 面 Codex vendor 只允许 `xhigh` effort（`model-builtins.ts` `effortsBySurface.runner`），没有降档空间。
- 其余 Opus Lead 统一升 5.5：避免 Lead 之间口径不一导致行为漂移；Opus 5.5 比 Opus 5 单价更低（\$4/\$20 对 \$5/\$25）。
- ⛔ Sonnet 那几行**不在本单的评估范围内**，本单不对它们作任何推荐。
  founder 有禁用 Sonnet 的直令（质量原因），所以「维持 Sonnet」不能作为结论写出来；
  表里那一行只是**记录当前状态**。要不要换、换成什么，是另一件事。

## 6. 两段分流（设计段三组 + QA 段 75/25）

founder 拍板后保留两段分流：**设计段三组各 1/3**，**QA 段 GPT-6 Sol 75% / Opus 5.5 25%**
（2026-09-22 8:27 PM PDT 追加，目的是攒数据）。
**实现段直接切 Opus 5.5、不做对照**；我原先提的 GPT-6 Sol 对 GPT-5.6 Sol 实验**已作废**。

### 6.1 记哪些数，什么情况下停（两段同一套）

设计段与 QA 段用**同一套指标、同一条摘臂规则**。

**每一臂记四个数：**

| 指标 | 怎么取 | 方向 |
|---|---|---|
| QA 一次通过率（没走过 `qa_retry` 边） | 工作流边计数 | 越高越好 |
| founder 打回次数 / 单 | `founder_rework` 边计数 | 越低越好 |
| 每单额度消耗 | Codex 侧看 `/usage` 面板日快照；Claude 侧用 `quota-monitor` 的 5 小时窗位移（账号级代理，官方无 per-model 权重，§2.4） | 越低越好 |
| 每单 wall-clock | `sessions.started_at/ended_at` | 越低越好 |

**合成判据：每「一次过 QA 的单」的额度成本 = 总额度消耗 ÷ 一次过的单数。**
它同时惩罚「便宜但老返工」和「一次过但烧光窗口」。

**停止条件（两段同一条规则）：**
- **正常收**：每臂约 **25 单**到点收，按合成判据决定。设计段约 3 周（§6.2）；
  QA 段的 25% 臂约 2–3.5 周（§6.2.1）。
- **提前摘臂**：某一臂的 QA 一次通过率比最好那臂低 **超过 15 个百分点**，或 founder 打回率翻倍
  ⇒ **立刻摘掉该臂，不等 3 周、不看成本。**
- **不追统计显著**（要 3.6–8 个月，见 §6.2）。这是「带护栏的成本决策」，不是显著性实验 —— 这一点要对 founder 讲明。

⚠️ **前提**：`sessions` 表现在**没有 model 列**（`packages/flywheel-comm/src/db.ts` 全文 grep 不到），
这四个数一个也记不下来。补列是跑这个 A/B 的硬前置（§6.3）。

⚠️ 跑 A/B 期间**固定 Claude 账号轮换顺序**（`~/.flywheel/quota-monitor.json` 的 `order`），
否则两臂的窗口位移不可比。

### 6.2 时长的算法依据

**单量实测**（Flywheel 仓库合入 main 的提交里出现的**不同 FLY/GEO 单号**，按自然周去重）：

| 周 | W30 | W31 | W32 | W33 | W34 | W35 | W36 | W37 | W38 |
|---|---|---|---|---|---|---|---|---|---|
| 不同单号 | 29 | 38 | 23 | 69 | 49 | 53 | 80 | 57 | 75 |

近 8 个完整周（W31–W38）**中位数约 55 单/周**，区间 23–80。W39 只有周一到周二，未计入。
命令：`git log origin/main --since=... --format='%ad|%s'` 抽单号去重。

⚠️ **已知的未知数**：只有 `code` 形状有 `eng_design`；`simple_code` 没有设计段，
`prd` / `product_design_flow` / `prototype` / `generic` 三段都没有。
**这个比例现在没有任何地方记录** —— 所以 §6.3 的记账列里要加 `workflow_shape`。
设 `g` = 走 `code` 的比例，每臂每周单量 = `55 × g ÷ 3`：

| g | 每臂每周 | 成本读数（25 单/臂） | 显著性读数（200 单/臂） |
|---|---|---|---|
| 0.3 | 5.5 | 约 4.5 周 | 约 36 周（8 个月） |
| 0.5 | 9.2 | **约 3 周** | **约 22 周（5 个月）** |
| 0.7 | 12.8 | 约 2 周 | 约 16 周（3.6 个月） |

显著性样本量：`n ≈ (z_{α/2}+z_β)² · [p₁(1-p₁)+p₂(1-p₂)] / (p₁-p₂)²`。
检出「QA 一次通过率 60% → 75%」（α=0.05、power=0.8）两组需每臂 **149**；
三组要两两比较，Bonferroni 把 α 收到 0.0167（z 由 1.96 升到 2.394），需每臂 **199**。

⇒ **分三组把每臂样本砍到三分之一，正是把设计段拉到 3.6–8 个月这个量级的原因。**

### 6.2.1 QA 段 25% 那一臂攒到 25 单要多久

QA 节点在 `code` 与 `simple_code` 两个形状里都有，所以基数比设计段大。
设 `h` = 走 `code` 或 `simple_code` 的比例，25% 臂每周单量 = `55 × h × 0.25`：

| h | 每周落到 25% 臂 | 攒够 25 单 |
|---|---|---|
| 0.5 | 6.9 | 约 3.6 周 |
| 0.7 | 9.6 | **约 2.6 周** |
| 0.9 | 12.4 | 约 2.0 周 |

⇒ **中位数单量下约 2–3.5 周。**
把周与周的波动也算进去（实测 23–80 单/周，h=0.7）：最快 **约 1.8 周**，
连着几个慢周可能到 **约 6 周**。

⚠️ 区间宽的主因仍是 `h` 量不到 —— 这正是 §6.3 要加 `workflow_shape` 列的原因。

### 6.3 下一步 · 交 Tadashi 的配置改动清单

**founder 已知、Tadashi 在做（她 8:00 PM 说「应该今天晚上就会修好」）：**

1. 升 Codex 客户端到 **≥0.156.1**，拿到 `gpt-6-sol`
   （本机 0.154.0 的内嵌 catalog 没有；`rust-v0.156.1` 发布于 2026-09-23T02:41:36Z UTC = 09-22 19:41 PDT）。
2. 把 **Opus 5.5** 登记进 Flywheel（`~/.flywheel/models.json` 的 `models` 数组加一条 + 冒烟；
   `claude-opus-5-5` 在 Claude Code 2.1.280 二进制里存在，是我们这边没注册）。
   同理 GPT-6 Sol 也要加一条（`provider: "openai"` / `runtimeVendor: "codex"` 是被接受的，
   runner 面 effort 会自动收成 `xhigh`）。

**这一轮新查出来的，一并交给他：**

3. **节点白名单缺模型**（`.flywheel/agents/registry.yaml`，fail-loud 抛 `MODEL_NOT_ALLOWED_FOR_NODE`）：

   | 节点（`code` 形状） | 白名单现在有 | 定稿要用 | 缺 |
   |---|---|---|---|
   | `eng_design` | fable / codex / astra | Astra / Opus 5.5 / Fable | **opus** |
   | `implement` | fable / codex / astra | Opus 5.5 | **opus** |
   | `qa` | **只有 opus** | GPT-6 Sol 75% / Opus 5.5 25% | **gpt-6-sol**（opus 已在名单里） |

   （`simple_code` 的 `qa` 白名单里有 codex、`code` 没有，两者不一致，一并处理。）

4. **分流臂数写死为 2，且两臂的模型写死** —— `packages/config/src/model-split.ts` 的类型与解析器
   只有 `codex` / `fable` 两个字段，且逐字校验 `["codex","A","astra"]` / `["fable","B","fable"]`。
   - **QA 段是两组**（GPT-6 Sol / Opus 5.5），**臂数上够用**，但两臂的模型仍被写死成 astra/fable，
     所以「任意两个模型对打」这一项必须先放开。比例 75/25 现有的 `codexPercent` 结构能表达。
   - **设计段是三组，现在根本做不了**，要先放开到 N 臂（百分比之和校验 100，允许 34/33/33 这种不整除）。

5. **分桶键要带 `nodeId`**（现在是 `sha256("fly2570-v1:<issueNumber>")`）。
   不带的话同一张单在不同节点上被同一枚硬币决定，多节点实验相关，结果读不出来。

6. **`sessions` 表加归因列**：`model_alias` / `arm` / `node_id` / `workflow_shape`（dispatch 时写入，
   值取自已有的 `WorkflowModelAssignmentReceipt`），完成时落 `qa_first_pass` / `founder_kickback_count` / `wall_clock_ms`。
   没有这一步，§6.1 的四个数一个也记不下来。

7. **QA 节点两处配置打架**：`registry.yaml` 写 `opus`、`~/.flywheel/models.json` 的 `phases.qa` 钉
   `claude-opus-4-6[1m]`。定稿要把 QA 做成 GPT-6 Sol 75% / Opus 5.5 25%，
   **`phases.qa` 那处不解掉，两个臂都会被直接盖掉，整段分流不生效**。

8. 🪤 **别删 `registry.yaml` 里 `fly2403-v1` 那段奇偶配置**。它内容已死（不参与选臂），
   但 `scopedSplit` 的第三个条件是 `&& node.modelSplit` ⇒ 删掉会让运行期策略被**静默忽略、分流整个消失且不报错**（§1.2.1）。
   推广时要把这个隐式耦合显式拆掉。

9. 设计节点当前是 `codexPercent=100`（自 2026-09-22 4:56 PM PDT 起，此前为 0，§1.2）。
   换成三臂配置时这条自然被替换，但要确认替换后**不再有遗留的全量切换**。

## 7. 来源清单（全部 2026-09-22 读取）

| # | 来源 | 类型 | 用于 |
|---|---|---|---|
| 1 | https://developers.openai.com/api/docs/models/gpt-6-astra | 厂商一手 | Astra API 单价、272K 台阶、上下文 |
| 2 | https://developers.openai.com/api/docs/models/gpt-6-sol | 厂商一手 | GPT-6 Sol API 单价、同款 272K 台阶 |
| 3 | https://help.openai.com/en/articles/20001106-codex-rate-card（页面标注 Updated: 7 hours ago） | 厂商一手 | **今天更新的那张价目表**；credits 费率 |
| 4 | https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex（Updated: 6 days ago） | 厂商一手 | Plus 每 5 小时消息估算表 |
| 5 | https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan | 厂商一手 | Plus 额度与 credits 关系 |
| 6 | https://platform.claude.com/docs/en/about-claude/pricing | 厂商一手 | Opus 5.5 / Fable 5.1 单价、缓存倍率、**1M 无溢价**、tokenizer +30% |
| 7 | https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code | 厂商一手 | **证明 Anthropic 不公布 per-model 额度权重** |
| 8 | https://artificialanalysis.ai/models/comparisons/claude-opus-5-5-vs-gpt-6-astra | 第三方实测 | 指数 v4.3.2、总花费、token 量 |
| 9 | https://artificialanalysis.ai/models/comparisons/claude-fable-5-1-vs-gpt-6-sol | 第三方实测 | 同上（同 v4.3.2，可同版本比） |
| 10 | `gh api repos/openai/codex/releases`（rust-v0.156.1，2026-09-23T02:41:36Z UTC） | 厂商一手 | GPT-6 Sol 进入 Codex catalog 的确切版本与时间 |
| 11 | 本机 codex 0.154.0 二进制内嵌 model catalog | 本机实测 | 证明当前版本**没有** gpt-6-sol |
| 12 | 本机 Claude Code 2.1.280 二进制 | 本机实测 | 证明 `claude-opus-5-5` 可用 |
| 13 | `~/.flywheel/models.json`、`~/.flywheel/projects.json`、`.flywheel/agents/registry.yaml` | 本机实测 | 现状快照 |
| 14 | `packages/config/src/model-split.ts`、`packages/teamlead/src/workflow-menu.ts`、`packages/flywheel-comm/src/db.ts` | 本仓代码 | A/B 现有能力与计量缺口 |
| 15 | https://techcrunch.com/2026/09/22/openai-launches-gpt-6-sol-and-luna/ | 二手（转述厂商） | 发布时间、「6 系列为 5.6 系列一半成本」的厂商说法 |

**厂商宣传与第三方结论的分界**（本单不许混用）：
- 「Opus 5.5 成本只有 Astra 的 20%–40%」= **Anthropic 自述**，AA 实测方向相反，本文不采信为结论。
- 「GPT-6 Sol 错误率约为前代一半」「6 系列半价」= **OpenAI 自述**（半价那条与 rate card 数字吻合，可交叉验证；错误率那条无第三方复现）。
- 指数 / Terminal-Bench / SciCode / 跑指数总花费 = **Artificial Analysis 独立实测**，且限定在 **v4.3.2** 同版本内比较。
