# FLY-922 决策 memory — 探索

Issue: FLY-922 (https://linear.app/geoforge3d/issue/FLY-922/lead-决策-memory-学习-annie-决策模式逐步减-human-in-the-loop产品方案)
日期: 2026-07-06
基于: 无(本任务第一份文档;上游 = product-experience-spec §3.2 + FLY-65/69/GEO-149)

---

## 1. 问题定性(不是笔记 memory)

Annie 要的**不是**一套「帮 Lead 记事」的普通笔记 memory,而是一套 **「学 Annie 决策模式」的系统**:

- 记的是 **Annie 的决策 + 背后的思路 + 触发**(她怎么想到该开某个新 issue、为什么这么拍板)。
- 目的是把这些沉淀成 Lead 未来能**复用来「代她做同类决策」**的依据。
- 北极星 = **逐步减少 human-in-the-loop**:Lead 慢慢学会 Annie 会怎么拍板,很多事按她的风格**自治处理**,不用她一步步教「这要怎么做、那要怎么做」。

Annie 原话锚点:「她的决策力未必比 Lead 强,有了这套很多东西能自动帮她处理。」

判定标准:如果一个功能只是「让 Lead 记得住上下文」,那它**不是**本 issue;本 issue 的成败在于「Lead 能不能在**该 Annie 拍板的岔口上,按她的模式先替她拍**(该自治的自治、该问的仍问)」。

## 2. 溯源:Annie 最早那条构想

按 issue 要求「先翻最早那条相关 issue,接上她当初构想」,审计 Linear + 代码后溯源清晰:

| 层 | 出处 | 内容 |
|----|------|------|
| **最早骨架** | `doc/architecture/product-experience-spec.md` §3.2 | 学习来源 / 学习应用(高信心自动应用+告知、低信心先问)/ 纠正机制(存 决定+纠正+原因)/ 偏离检测(新标准还是特例)/ 决策权渐进扩展(按场景解锁) |
| 当前边界 | spec §3.1 | 静态自主性边界表(哪些 Lead 自己决定、哪些必问 Annie) |
| 已完成 | GEO-149 (Done) | CIPHER: Decision-making memory — 从 approve/reject 历史学 pattern |
| Backlog | FLY-65 | Lead Learning Loop + CIPHER Integration(§3.2 的完整实现) |
| Backlog | FLY-69 | Decision Right Expansion — Lead 权限解锁机制 |
| 相关 | FLY-489 / GEO-282 / FLY-105 | self-improving loop / reflective learning / digest layer |

**本方案在这条脉络上收敛,不另起炉灶。** FLY-922 = 把 §3.2 这套几个月前写下的骨架,build 在「已经在 dogfood 且 work 的那部分」上,补齐从「记录」到「自治决策」缺的环。

## 3. 已 work 的地基(dogfood 事实)

Honey Lemon 现在用的 file-based agent-memory(`~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/`):

- **~186 个文件**,四型:`user`(1)/ `feedback`(120)/ `project`(27)/ `reference`(34)。
- `MEMORY.md` = 索引(每条一行指针),session 启动时进 context;个别相关条目以 `<system-reminder>` 形式召回。
- **feedback 型(120)就是决策语料主体**。每条已含:
  - **决策**(发生了什么 / Annie 拍了什么)
  - **Why**(她为什么这么拍 — 思路)
  - **How to apply**(蒸馏出的、未来可复用的规则)
  - **判据**(区分性条件,如「如果成败取决于 Annie 觉得自不自然 → brainstorm-first」)
  - **来源**(originSessionId + 日期)+ `[[链接]]`(关联其它决策)
- 已经出现**分级自治规则**的雏形:如 `feedback_synthetic_founder_go_dogfooding` 编码了「仅当四条全满足才可接受 + worker 绝不自行跨 founder gate → 升级」。

结论:**「记什么、怎么记才能真复用来决策」这个最难的问题,dogfood 已经用实践回答了一大半。** 这是本方案最强的一手材料,也是它区别于纯理论方案的底气。

## 4. 缺口(从「记录」到「自治决策」缺的环)

现有 memory 是**被动召回**(passive recall,作为背景 context 注入),它**没有**:

1. **接进真正的决策岔口** — 现有 Decision Layer(Hard Rules → Haiku Triage → Verify → Route: `auto_approve` / `needs_review` / `pr_handoff`)是 human-in-the-loop 的强制点,但 memory 里的「Annie 决策模式」没喂进这个 route 选择。§3.2 的「高信心→自动应用+告知」闭环没闭。
2. **信心累积 / 毕业跟踪** — 没有「某类决策被一致观察到 N 次 → 该场景可自治」的机制。
3. **偏离检测** — Annie 这次行为跟以往 pattern 不一致时,没有机制让 Lead 主动问「新标准还是特例?」。
4. **按场景解锁** — §3.1 那张表是 hard-coded 的静态表,没有「Annie 显式解锁某类决策权」的机制,也没有「随信心自动放权」的通道。
5. **跨 Lead 通用** — 每个 Lead 各自一个 memory 目录;没有共享的「Annie 决策 pattern」层(Tadashi 学到的 Annie 偏好,Honey Lemon 用不上)。
6. **capture 系统性** — 现在靠 session「顺手记」;不是每次 Annie 拍板/纠正都被系统性捕获。

## 5. Topic 树(逐块收敛,Mode A)

已与 Lead 对齐(brainstorm gate)。当前钻取顺序:**先 D+E(心脏),再回填 A/B/C,最后 F/G**。

- A. 记什么 — 决策/理由/偏好风格/开 issue 的触发;在现有 feedback 型上补什么字段
- B. 怎么记 — 从「session 顺手记」→「每次 Annie 拍板/纠正系统性 capture」
- C. 怎么被调用 — 从背景 recall → 接入 Lead 决策岔口(自治 vs 必问)
- **D. 记录→自治的演进阶梯 ⬅ 首块(Lead 授权我发挥,出候选 ladder 带 Annie 挑)**
- **E. human-in-the-loop 分级递减 ⬅ 首块(同上)**
- F. 跨 Lead 通用机制 — 每 Lead 独立 memory + 共享决策 pattern 层
- G. 安全 — secret/PII 过滤(§3.3)

## 6. 焊死的硬地板(Lead 红线,不可动)

**founder-gated 动作永远 always-ask,不随信心解锁**:merge / ship / runner 生命周期 / 花钱 / 任何不可逆动作。自治只在**可逆 / 低风险**决策上扩张。这是 founder-only-authority 红线(FLY-175/245),ladder 再激进也不碰。设计时当作不可移动的 floor。

## 7. 假设(需 Annie/Lead 确认,不静默填)

- **A1**:方案以现有 file-based typed memory 为地基演进,**不**推倒换向量库 / 重型 RL(除非 research 表明必要)。
- **A2**:「自治」的第一批目标是**可逆、低风险、高频**的决策(如 issue 优先级排序、triage 归类、措辞润色),不是不可逆动作。注:Runner 重试**不在**首批 —— 代码里 retry 是 reserved(强关旧 runner、可能毁证据),见 plan §5.8。
- **A3**:演进节奏由 Annie 主观感觉 + 准确率共同 gate,**不是**纯自动毕业(§3.2 原文)。
- **A4**:跨 Lead 共享是「Annie 决策偏好」这类通用 pattern;各 Lead 的部门专属上下文仍独立。
- **A5**:实现交 Tadashi;本 issue 只出产品方案 + 可交互雏形,不写实现代码。
