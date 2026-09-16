# FLY-2591 Codex 自动切号 + 重置卡兑换 — 调研

Issue: FLY-2591 (https://linear.app/geoforge3d/issue/FLY-2591/产品prd-codex-自动切号-重置卡兑换的产品定义fly-2571-的-prdfounder-2026-09-15-直令派-runner)
日期: 2026-09-15
基于: exploration.md

---

## 0. 可信度分级（本文件统一用这三档）

| 档 | 含义 |
|---|---|
| **【实测】** | 我今天在这台机器上、或在本仓代码里亲自读到的。可复核。 |
| **【二手】** | 公开网页转述的 OpenAI 规则。官方 help.openai.com 对我们 **403**，无法取原文。 |
| **【推断】** | 我从上面两类推出来的，没有直接证据。 |

⚠️ **【v2 更新，2026-09-15 22:5xZ】官方原文已取到。**
curl 对 help.openai.com 是 403（bot 拦截），但**真浏览器能过** —— founder 点名 Lead 用 claude-in-chrome
取回了两处官方页面：

| 代号 | 页面 |
|---|---|
| **A** | `help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan`（页面自报 Updated: 4 hours ago） |
| **B** | `developers.openai.com/codex/pricing` → 实跳 `learn.chatgpt.com/docs/pricing` |

⇒ §3.1 / §3.2 已提级为 **【实测·官方原文】**。
🔴 **§3.3 那条「支柱」已被 founder 的直接使用经验裁定为假（2026-09-16）** —— 见 §3.3。

---

## 1. 5 小时窗口的当前状态（Context B ① 的复核）

| 时间 | 事件 | 档 |
|---|---|---|
| 2026-07-12 前后 | OpenAI 临时取消 5 小时窗口（Plus / Pro / Business 全部），周额度不变 | 【二手】 |
| 2026-08-25 | **只对 Plus 恢复** 5 小时窗口 | 【二手】多来源一致（9to5Mac / TechRepublic / Notebookcheck / explainx） |
| 2026-08 公告 | **Pro（$100 / $200）明确保持关闭**，「未来几个月」 | 【二手】 |
| 2026-09 | 仍然如此 | 【二手】 |

**我们在 Pro ⇒ 现在只有周额度，没有 5h 窗口。founder 的纠正是对的。**

但代码侧要注意：`parseCodexRateLimits` 本来就解析 `primary` / `secondary` **两个**窗口，
`limited()` 判的是「任一窗口 100%」，`reset()` 取的是所有窗口里**最早**的那个。
⇒ **5h 窗口回来时，现有选号逻辑不需要改结构**，它天然多一个触发源、多一个 reset 候选值。
需要改的只有两处语义：(a) 兑卡阶梯里「自然重置时间」指的是**周窗**，不能被 5h 窗口的近期 reset 污染；
(b) 通知里要说清是哪个窗口打满的。这是【推断】，但结构证据在 `candidate-selector.ts` 里可直接复核。

来源：
* https://9to5mac.com/2026/08/24/openai-restores-5-hour-codex-and-work-limits-for-chatgpt-plus-users/
* https://www.techrepublic.com/article/news-openai-five-hour-codex-limit-chatgpt-plus/
* https://www.explainx.ai/blog/codex-plus-5-hour-limit-returns-chatgpt-work-august-2026

---

## 2. 重置有三种，我们说的「重置卡」是第二种

| 种类 | 是什么 | 档 |
|---|---|---|
| **自动重置** | 到点自己刷新（周窗；Plus 还有 5h 窗） | 【二手】+【实测】`resetsAt` 字段存在 |
| **banked reset**（＝founder 说的「重置卡」） | 存在账号里、手动兑换的一次性刷新 | 【二手】 |
| **付费即时重置** | 花钱买一次立刻刷新 | 【二手】，本 PRD 不涉及 |

来源：https://laplusda.com/en/posts/codex-usage-limit-reset-date/

---

## 3. banked reset 的四条关键规则

### 3.1 兑一张 = 刷新 5h + 周两个窗口，并且**改掉周重置日期** 【实测·官方原文 A】

> "Using a full banked reset refreshes your 5-hour and weekly Codex usage windows and
> **changes your weekly reset date**. Check Settings → Usage for your updated reset time."
> —— 来源 A，2026-09-15 实读

⇒ **直接证实 founder 的 Context A ③**：额度立刻变满，且重置时间从当下重新开始算。
这是整个兑卡选号策略的地基 —— 因为「兑卡会覆盖掉这个号原本的自然重置」，
所以该烧在**自然重置最不值钱（＝最晚）**的号上。founder 的直觉是对的，这条能给它一个机制上的理由。

### 3.2 自发放起 **30 天**过期 【实测·官方原文 B】

> "Banked rate-limit resets are usable for 30 days after they're granted."
> —— 来源 B，2026-09-15 实读

（另有 Codex app 自己的 banner 佐证：「You were granted a rate limit reset that will expire in 30 days」。）

### 3.3 ✅ 「没东西可刷就不扣卡」= **假。已结案** 【founder 直接使用经验，2026-09-16】

第三方转述的说法是：

> "The reset is consumed only when it successfully refreshes at least one eligible usage window.
> If there is nothing to reset, it remains available."

**这句话是假的。** 三级证据，一级比一级硬：

1. 【二手】多个第三方把它**归给 OpenAI Help Center**。
2. 【实测·官方原文】2026-09-15 把官方 A / B 两个页面取回来逐句读，**两处都没有这句话**。
3. 🔴 **【founder 直接使用经验，2026-09-16 裁定】** —— 决定性的一条：
   > 「它当然会变啦，我都已经用过很多次了，这个我很确定。逻辑就是：假设你有 3 张卡，
   >  你现在 reset，它就会用一张卡。就这么简单，没有什么好去验证的。」
   > 「**就算我现在的账号是满的，我用了那个 reset 卡，它也会把这个东西浪费掉。**」

⇒ **兑一张卡就扣一张，跟有没有东西可刷无关。** 这**不是待验证项，是已知答案**。
原来那条「拿一张真卡在还有额度的号上兑一次去验」的动作**已删除** ——
不让 founder 花一张真卡去验一件她已经确定的事。

**设计含义**：机器**绝不能**在「可能还有额度」的号上建议兑卡，因为那一定是净损失。
好消息是 §5.3.2 的阶梯按构造就做不到这件事（前置是三个号全部 limited，
且被选中的号重置时刻已知、至少在 1 小时之外）。

### 3.4 界面只显示**剩几张**，不显示**每张的到期日** 【二手】

> 一个用户「could see three resets but had no idea when each one expired」；
> 另一个只看到 "four banked resets" 的计数。文章原话：界面
> "has not surfaced the full expiry timeline"。

⇒ **「先用快过期的卡」这条判据，机器基本无法自行判定。** 这是 exploration §4.2 的证据基础。

### 3.5 【v2 新增·官方原文】打满时**当前这一回合不会被腰斩**

> "If you reach your usage limits during an active turn, the agent will be able to continue
> working on that turn, subject to fair use limits." —— 来源 B

⇒ 与 FLY-2572 记录的现象一致。**「撞墙 ≠ 立刻死」有官方依据了**，
这也解释了为什么 `goal_ended` 的 `usageLimited` 是回合结束时才出现的信号。

### 3.6 【v2 新增·官方原文】OpenAI Support **不给**重置

> "Can Support reset my usage limits? **No.**" —— 来源 A

⇒ **「打满了去找客服」这条退路不存在。** PRD 不要留这个选项。

### 3.7 【v2 新增·官方原文】一次性重置是**公告式促销，且不承诺未来还有**

> "An automatic reset is applied directly to the usage limits covered by the announcement."
> "**Future resets are not guaranteed.**" —— 来源 A

⇒ 官方口径就是不承诺、不可预期。**这从官方侧支持了 founder 自己的判断**
（「这种就比较难以预测了……我觉得我们会用到的可能性比较小」），也支持 §9.1 不接入任何预测平台的决定。

来源：
* 官方 A：https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
* 官方 B：https://developers.openai.com/codex/pricing （实跳 learn.chatgpt.com/docs/pricing）
* https://tokenkarma.app/blog/codex-banked-rate-limit-reset-expiry-2026/
* https://startupfortune.com/codex-users-are-losing-banked-rate-limit-resets-to-a-quiet-30-day-clock/
* https://codex-reset.com/banked-reset

---

## 4. 兑换必须由人手动完成，没有官方自动通道 【二手】

* 兑换入口：Codex 的 Settings → Usage（TUI 里是 `/usage → Redeem`），
  「a banked reset must be applied by you from Settings → Usage and confirmed」。
* **openai/codex#32218** 是一个尚未实现的功能请求：
  "Allow users to queue one banked usage reset for automatic redemption when a usage limit is exhausted"。
  ⇒ 说明**今天没有排队自动兑换**这个东西。

⇒ FLY-2571 的边界「兑卡这一步永远是 founder 本人」不是我们的保守选择，**是外部事实约束**。
「自动」的上限就是：自动判断该兑哪张 + 准确叫人 + 兑完自动切过去并把停住的活重新派出去。

来源：https://github.com/openai/codex/issues/32218

---

## 5. ⚠️ 新发现：存在一个能自主烧卡的 `Consume usage reset` 工具 【二手】

**openai/codex#41801**：用户报告 Codex 在对话中自主调用了名为 `Consume usage reset` 的工具，
没有确认对话框：

> "At no point did I explicitly authorize Codex to consume one of my banked reset credits
> after it proposed doing so. There was no confirmation dialog or separate approval step
> before the reset was consumed."

issue 标签 `app / bug / rate-limits / tool-calls`，无 maintainer 回复。
另有 **#41593** 报告同类「未经授权就用掉 banked reset」。

**两个含义**：
1. 兑卡入口不只有 UI —— 存在一条 tool-call 通道。
2. **我们自己的 Codex runner 有可能在 founder 不知情的情况下烧掉一张卡。**

【未核实】我**没有**确认这个工具是否出现在我们用的通道（`codex app-server` / `codex resume --remote` TUI）上。
这是一条必须在实现前做掉的验证任务，不是断言。若存在，我们必须显式关掉它
（例如把它加进不可批准的工具名单），否则「兑卡必须经 founder 同意」这条闸是漏的。

来源：
* https://github.com/openai/codex/issues/41801
* https://github.com/openai/codex/issues/41593

---

## 6. 我们自己这边的代码事实（全部【实测】，2026-09-15）

### 6.1 切号链已经存在（FLY-2465，Done 2026-09-10）

`packages/teamlead/src/codex-quota/`，2977 行，12 个模块：

| 文件 | 干什么 | 与本 PRD 的关系 |
|---|---|---|
| `candidate-selector.ts` (161) | 选下一个号：按 reset **升序**（最早优先），平手比剩余额度，再比 profile 名 | **Context A ② 已实现** |
| `quota-reader.ts` (155) | 起隔离 `codex app-server`，`initialize → account/read（校身份）→ account/rateLimits/read`，20s 超时 | **额度探针已存在，且很便宜** |
| `probe.ts` (361) | 隔离 codex 进程执行器 | |
| `coordinator.ts` (273) | incident 状态机；`CODEX_QUOTA_MAX_PAUSE_MS = 10 分钟`＝最长静默暂停 | 兑卡闸要挂在它的 `pool_exhausted` 分支上 |
| `host-readiness.ts` (337) | 校验 approved homes 清单（`managed` / `independent`）、活体、lease | **今天恒失败**，见 6.4 |
| `run-recovery.ts` (523) | 被 usageLimited 收的体 terminate → 重起 | 兑卡成功后复用同一条路 |
| `outbox.ts` (196) | 发通知 | **Context A ⑥ 的切号一半已实现**，见 6.3 |
| `admission-replay.ts` / `launch-binding.ts` / `readiness.ts` / `runtime.ts` / `audit.ts` | 准入、绑定、审计 | |

### 6.2 触发信号是结构化的，不是解析 stderr

`packages/core/src/codex-quota.ts`：

```ts
export const codexQuotaSignalV1Schema = z.strictObject({
  version: z.literal(1), vendor: z.literal("codex"),
  source: z.enum(["goal_ended", "review_exec"]),
  sourceEventId: identity, bindingId: identity,
  evidence: z.enum(["usageLimited", "usageLimitExceeded"]),
  observedAt: ...,
});
```

发出方：`packages/claude-runner/src/codex-daemon-adapter-helpers.ts:233-250`
（goal-ended status === `"usageLimited"` → `failureKind: "goal_usage_limited"` + 这个 signal）。

⇒ **修正 FLY-2571**：触发不是「撞墙字符串」，是 codex app-server 的 goal-ended 协议状态；
额度数值也有独立的结构化读法。PRD 按这个更强的基座写。

### 6.3 现有切号通知的内容

`outbox.ts:151`：

```
Trigger=usageLimited from=<源号> reset=<源号ISO> to=<目标号> affected_runs=N restarted_runs=M
```

对照 Context A ⑥（「几点、从哪个号到哪个号、**两个号各自额度状态**」）：
**缺目标号的额度与重置时刻**。这是一个小但确定的增量。

全池打满时今天发的是（`eventType: quota_no_target`，severe，@founder）：

```
Codex fleet remains paused (<reason>). No blind replacement is allowed.
Check account resets or add credits. Trigger=... to=none ...
```

⇒ 这是**一条告警，不是一道闸**：它没有说该兑哪个号、没有结论、没有她可以按的东西。
Context B ② 反对的正是这种「给一堆信息让我自己判断」的形态。

### 6.4 全仓零 banked reset 代码

```
grep -rniE "banked|redeem|reset_card|resetCard|creditGrant" packages/*/src scripts   → 0 命中
```

⇒ Context A 的 ③ / ④ / ⑤（兑卡那半）**全新**。

### 6.5 flag 语义已查清（FLY-2571 问的「别假设它就是开关」）

`packages/config/src/feature-flags/registry.ts:353`：

```
name: codex_quota_auto_switch
category: kill_switch      scope: bridge_global    polarity: default_on
envVar: FLYWHEEL_CODEX_QUOTA_AUTO_SWITCH
description: Automatically rotate a quota-limited Codex account and recover affected runners
             after a successful probe
```

消费方 `plugin.ts` 七处（7822 / 7873 / 7919 / 7926 …）都是这套切号机制。
⇒ **它就是 FLY-2465 那套机制的总开关**，语义无歧义。

生产当前值（`sqlite3 -readonly ~/.flywheel/teamlead.db`）：

```
codex_quota_auto_switch | * | has_override=1 | raw_value=false | rev=3
                        | updated_at 2026-09-14T07:36:01Z | by bridge-local-operator
```

**默认 on，但被显式关到 false，且 9-14 还被动过一次。**

### 6.6 宿主部署状态：仍然装不上（FLY-2521/2523 未解）

```
~/.flywheel/codex-quota/
  switch-audit.jsonl        0 字节
  readiness-receipt.json    不存在   → host-readiness 恒 authority_unavailable → incident 恒 readiness_failed

~/.flywheel/codex-homes/agents/flywheel/eng_design/auth.json
  symlink → ~/.codex/auth.json                         ✔ managed 合规
~/.flywheel/codex-homes/agents/flywheel/implement/auth.json
  普通文件 3982 bytes（mtime 2026-09-15 11:11）         ✘ 违约，切号对它无效
```

⇒ **2026-09-11 的病根（FLY-2521）原样还在，2523 的收尾一步没做。**

### 6.7 切号为什么必须等 home drained

`host-readiness.ts:91-106`：`managed` ⇔ `credentialShared === true`
⇔ home 的 auth.json 是指向 canonical `~/.codex/auth.json` 的 symlink。

⇒ 换掉 canonical 的瞬间，**所有共享它的在跑体身份立刻跟着变**。
所以安全前提是 managed homes `activity === "drained"`（无活体）。
这既是 Q2「切的瞬间在跑的体会怎样」的答案，也解释了为什么 implement home 必须变回 symlink（2523 第 1 步）。

---

## 7. 停摆代价（【实测】，FLY-2571 2026-09-15 记录）

三号同时打满 ⇒ `code` / `simple_code` 的实现节点**全部起不来**：
QA 必须与实现不同 vendor，而 QA 菜单只有 Claude；实现改走 Claude 会被 `SAME_VENDOR_REVIEW_COMBINATION` 拒派。
设计段也因为奇偶分臂把奇数号钉在 Astra 上而开不了。
⇒ **Codex 断 ＝ 新代码单一律停。** 这就是「烧一张卡值多少钱」的分母。

---

## 8. 还没核实的（明确列出来，别混进事实）

1. `account/rateLimits/read` 的返回里**有没有** banked reset 张数字段 —— 如果有，卡账本可以全自动，
   founder 一个字都不用录。**这是本 PRD 里最有价值的一条待查项。**
2. `Consume usage reset` 工具在 `codex app-server` / TUI 通道上**是否存在**（research §5）。
3. §3.3「没东西可刷就不扣卡」只有二手证据，需要用一张真卡实测一次。
4. 兑卡之后，`account/rateLimits/read` 多快能读到新的 `resetsAt`（决定「兑完探多久才算失败」）。
