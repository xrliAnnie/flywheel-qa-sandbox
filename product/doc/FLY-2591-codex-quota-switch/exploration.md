# FLY-2591 Codex 自动切号 + 重置卡兑换 — 探索

Issue: FLY-2591 (https://linear.app/geoforge3d/issue/FLY-2591/产品prd-codex-自动切号-重置卡兑换的产品定义fly-2571-的-prdfounder-2026-09-15-直令派-runner)
日期: 2026-09-15
基于: 无

---

## 1. 这张单在问什么

FLY-2571 是工程需求单，本单是它的 PRD。founder 要的东西一句话：
**Codex 额度不再需要她人肉盯着。** 三个号之间该用哪个、什么时候烧重置卡、烧哪个号的卡，
由机制按明确规则自动算出来并执行；她只在「必须她本人按」的那一步（兑卡）出现，
而且要被提前、明确地叫到，卡面上只有**一句结论**，不是一堆数字让她挑。

## 2. 我读到的真问题（不是表面需求）

表面需求是「做一个自动切号 + 兑卡机制」。但把 FLY-2571 和 Context A/B 放在一起读，
真问题有三层，而且**第一层今天已经解决了，第三层才是真正卡住的**：

| 层 | 问题 | 今天的状态 |
|---|---|---|
| L1 切号 | 一个号打满了自动换下一个号 | **代码已存在**（FLY-2465，`packages/teamlead/src/codex-quota/`），但 flag 关着、宿主没装完 |
| L2 兑卡 | 三个号都空了，该烧谁的卡 | **完全不存在**，全仓零代码，且卡账本这本账根本没有 |
| L3 落地 | 上面两层跑不跑得起来 | **FLY-2521/2523 未解**，readiness receipt 不存在、implement home 仍是凭据拷贝 |

⇒ 本 PRD 的重心不是「设计一个切号算法」（算法已经写好且符合 founder 的规则 2），
而是 **(a) 补 L2 的兑卡闸与账本降级路径，(b) 把 L3 写成明确的前置条件**。
只写 L2 的逻辑而不处理 L3，就是又造一份「逻辑很好但没有落地面」的东西 —— 2026-09-11 已经发生过一次
（flag 默认 on、宿主没装完 → 额度打满一次反把整支 Codex 舰队卡死 8 分钟不恢复，Lead 只能拉 kill switch）。

## 3. founder 的规则，逐条对照代码

| Context A | 内容 | 代码事实 |
|---|---|---|
| ① 触发条件与 Claude 不同：Codex 只有周额度用完才切 | 不做 90% 预切 | **已满足**。`candidate-selector.ts:limited()` = `reached === true \|\| usedPercent === 100`，没有 90% 阈值 |
| ② 在还有额度的号里选重置时间最早的 | 先把早重置的号用掉 | **已实现**。`candidate-selector.ts` 排序首键 `reset(a) - reset(b)`（升序＝最早优先） |
| ③ 用掉一张卡 → 额度变满 + 重置时间从当下重算 | | **外部行为，已二手核实**（见 research.md）。代码侧零实现 |
| ④ 全打满要用卡时两条判据打架 | 最晚重置 vs 卡快过期 | **零实现**。今天全打满只会走 `pool_exhausted` → 等最早恢复时刻，或发一条 severe founder 告警 |
| ⑤ 权限分两档：切号不用问、兑卡必须经她同意 | | 切号那半**已实现**（自动）；兑卡这半零实现（今天只有一条「Check account resets or add credits」的告警，不是闸） |
| ⑥ 每次动作都要有通知 | | 切号通知**已实现**（`outbox.ts` `switch_notification`），但内容缺「两个号各自额度状态」；兑卡通知零实现 |

## 4. 我发现的、founder 和 Lead 都没点出的东西

### 4.1 她的样例算出来是 school，我的规则算出来是 business

founder 在 FLY-2571 的原话样例里选了 School，理由是「它的下一次 reset 时间比较晚（9 月 21 号），
而且它有两张卡，其中一张 10 月 3 号就到期，比 Business 更早到期」。

但同一段里她给的数据是 Business 也是 9 月 21 号。她是在**天**的粒度上看成平手，
再用「卡的到期日」破平。而我们的机器读到的是**分钟**粒度：

```
2026-09-15 03:5xZ 实测（FLY-2571 记录）
personal  9-19 10:17
school    9-21 00:28
business  9-21 15:31   ← 分钟粒度下，「最晚」是 business，不是 school
```

⇒ 同一条规则、同一组数据，天粒度选 school、分钟粒度选 business。**这是个必须问她的分歧**，
而且她的破平键（卡的到期日）恰恰是机器读不到的那一项。

### 4.2 「卡快过期优先」这条判据，机器在绝大多数情况下无法评估

多个来源反映 Codex 界面只显示**还剩几张**，不显示**每张的到期日**（research.md §3）。
Lead 的草案把「卡即将过期 → 选那个号」放在阶梯第 ②位，但它的输入 99% 时间是 unknown。
一条常年 unknown 的判据放在阶梯高位，等于阶梯的第一步就悬空 —— 而 Context B② 明确说
「读不到的输入不构成把选择权推回给她的理由」。⇒ 我要把它从阶梯里摘出来（见 plan/PRD 的替代方案）。

### 4.3 「等一会儿」比「烧一张卡」便宜，但今天没有人在做这个权衡

卡是有限的、会过期的；等待是免费的。如果三个号都空了、但最早的自然重置就在 40 分钟后，
烧一张卡买到的只是 40 分钟 —— 纯浪费。今天的代码其实已经算出了这个数（`pool_exhausted` 的
`nextAttemptAt`），但没有人拿它去决定「值不值得叫醒 founder」。
⇒ 兑卡闸前面应该有一道**等待闸**：最早自然重置在 T_wait 以内就不叫她，只发一条「N 分钟后自动恢复」。
T_wait 该设多少是**她的价值判断**（她的卡 vs 她的舰队停摆），不是我能替她拍的 —— 这是我唯一要问她的第二个问题。

### 4.4 Codex 侧存在一个能自己烧卡的工具，这是个风险不是特性

openai/codex#41801：用户报告 Codex 在对话中**自主调用了 `Consume usage reset` 工具**，
没有确认对话框就烧掉了一张 banked reset。#32218 是「让用户把一张卡排队自动兑换」的功能请求（尚未实现）。

⇒ 两个含义：
1. **今天没有任何官方自动兑卡通道** —— 「兑卡是 founder 本人操作」不是我们的保守选择，是事实约束。
2. **我们自己的 Codex runner 可能有能力烧卡**。如果那个工具在 app-server / TUI 面上也存在，
   一个跑得正嗨的 runner 有可能在 founder 完全不知情的情况下消费掉一张卡。
   我**没有核实**它是否出现在我们用的通道上 —— 这要成为一条工程验证任务，不是断言。

### 4.5 FLY-2571 说「唯一可靠的额度来源是撞墙字符串」，这一条已经过时

FLY-2571 写：目前唯一可靠来源是 `codex exec` 撞墙返回的 `You've hit your usage limit ... try again at <时间>`。
但 FLY-2465 落地的东西比这个强得多（代码实读）：

* **触发**是结构化的 goal-ended 状态 `usageLimited`（`packages/core/src/codex-quota.ts` 的
  `codexQuotaSignalV1Schema`，`source: "goal_ended" | "review_exec"`），不是解析 stderr 文本。
* **额度读数**走 `codex app-server` 的 `account/rateLimits/read`
  （`quota-reader.ts`），直接拿到 `usedPercent` + `resetsAt`，还带身份校验（`account/read` 比对
  accountKey/profile）和刷新令牌失效检测。这是一个**便宜的、可以对未在用的号做的探针**。

⇒ PRD 应该在这个更强的基座上写，而不是沿用「只能撞墙才知道」的前提。

### 4.6 切号会不会把在跑的体切坏，取决于 home 是不是 symlink

`host-readiness.ts` 把每个 codex home 分成 `managed`（`credentialShared = true`，auth.json 是指向
`~/.codex/auth.json` 的 symlink）和 `independent`（自带凭据）。managed home 意味着
**换掉 `~/.codex/auth.json` 的瞬间，所有共享它的在跑体身份立刻跟着变**。
所以切号的安全前提是 managed homes 处于 `drained`（无活体）。这正是 host-readiness 检查 `activity` 的意义，
也正是今天卡住的地方：`implement` home 现在是**普通文件拷贝**而不是 symlink（2026-09-15 11:11 实测），
既不满足 managed 的合同，也让切号对它无效。

## 5. 今天（2026-09-15）我自己核过的宿主状态

```
~/.flywheel/codex-quota/            只有 switch-audit.jsonl，且是 0 字节
                                    没有 readiness-receipt.json → host-readiness 恒 authority_unavailable
codex-homes/agents/flywheel/eng_design/auth.json   symlink → ~/.codex/auth.json   ✔ 合规
codex-homes/agents/flywheel/implement/auth.json    普通文件 3982 bytes            ✘ 违约
flag_values codex_quota_auto_switch  scope=*  override=yes  raw_value=false  rev=3
                                     updated_at 2026-09-14T07:36:01Z by bridge-local-operator
```

⇒ **FLY-2521/2523 至今未动**，且 kill switch 在 9-14 还被再动过一次。
本 PRD 的一切逻辑，在 2523 收尾之前都没有落地面。

## 6. 我要问 founder 的（只有两个，都带推荐）

1. **分歧 4.1**：她的样例选 school，分钟粒度的「最晚重置」选 business。哪个是她要的行为？
   （我的推荐：分钟粒度 → business。理由和她自己的逻辑一致，且她的破平键机器读不到。）
2. **未定的阈值 4.3**：舰队全停多久才值得烧一张卡？（我的推荐：2 小时。）

其余全部由我按已知信息拍板，假设写在卡面上，她判错再推翻 —— 这是 Context B② 的合同。

## 7. 不在本 PRD 范围内

* 不拆工程单（Tadashi 的事），末尾只给拆单建议。
* 不设指标 / 考核 / hard limit。
* 不改代码、不动 flag、不碰 `~/.codex`。
* 不绕开 QA 跨 vendor 不变量或任何 merge / authority 闸。
