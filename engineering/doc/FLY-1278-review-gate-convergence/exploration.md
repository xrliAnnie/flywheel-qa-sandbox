# FLY-1278 跨家族审查门收敛修复 — 探索

Issue: FLY-1278 (https://linear.app/geoforge3d/issue/FLY-1278/fix-跨家族审查门在-lead-已裁决的非阻塞项上死循环-审稿人反复重提被-overrule-的优化建议强制门永不收敛fly-1251)
日期: 2026-07-15
基于: 无

## 1. 问题陈述

FLY-1188 跨家族审查 lane（codex 作者 → Claude 审稿人）+ FLY-827 fail-closed 硬门组合出一个死锁形态：审稿人对一条 **Lead 已明确裁决拒绝的非阻塞优化建议**（MEDIUM）反复投 CHANGES_REQUESTED，门永不放行。FLY-1251 现场（2026-07-14/15）R6-R9 连续四轮，全部只有同一条 MEDIUM finding，代码本身正确（263 测 + typecheck + build 绿），runner 正确拒绝弱化授权、Lead 坚持不 codex_skip（铁律）→ 无解死锁。

## 2. 现场证据（生产 teamlead.db + comm.db，2026-07-15 直查）

`codex_review_job` 表（execution `bb9cb377`，FLY-1251，code review）：

| 轮 | verdict | frozen head | findings |
|---|---|---|---|
| R1 | failed（gate 问题）| dbfd18f8 | — |
| R2-R3 | CHANGES_REQUESTED | dbfd18f8 / c6815e8f | 真缺陷（round-3 HIGH 引出 metadata sub-lease）|
| R4-R5 | **APPROVED** | 9013d0b3 / 12ebbac8 | head 随后移动，批准作废 |
| R6-R9 | CHANGES_REQUESTED | fa98f1ef ×2 / 160d73c2 / 51ec80c6 | **每轮恰好一条、同一条 MEDIUM**（30s docs-only metadata lease 优化）|

三个决定性细节：

1. **审稿人自己在 R6-R9 的 finding 里写明**「the TOCTOU guard … is the genuine correctness fix and should stay」「Recommend applying …」——它知道这是优化建议，仍投 CHANGES_REQUESTED，因为契约从没告诉它 MEDIUM 不该 block。
2. **runner 确实把 Lead 裁决注册进了审查请求**——R7/R8/R9 的 gate 消息原文（comm.db）：「Lead ruling on prior MEDIUM: authorization correctness > rate optimization … reject the 30s docs-only lease … Follow-up FLY-1274 owns …」「do not relitigate the settled authorization policy」。
3. **但审稿人从未见过这些话**：`ReviewRequestCoordinator.buildPrompt()`（review-request-coordinator.ts:754-790）只用 issue_id / head / round / 上轮 findings 拼 prompt，**从不读 gate 问题的 content**。裁决文本写进了一个结构上到不了审稿人的通道。

## 3. 根因分析（四条，全部是机制缺陷，不是模型失灵）

- **RC1 · 裁决通道断裂（主因）**：Lead ruling 唯一的登记位置是 gate 消息文本，而 prompt 构造器不读它。审稿人在信息上是无辜的——它每轮都在「诚实地」重申一条它不知道已被裁决的建议。
- **RC2 · 阻塞语义真空**：审稿人契约（buildPrompt 的 contract 段）只要求输出 `verdict + findings[severity]`，从未定义**什么 severity 才配 CHANGES_REQUESTED**；coordinator 侧也没有任何 severity 政策——reviewer 的二元 verdict 被原样当成门的开关（runJob → completeCodexReviewJob → commitAuthorityIfApproved）。一条 MEDIUM = 门关死。
- **RC3 · 复审 prompt 主动推动重提**：reround prompt 唯一的指令是「Your previous findings were: … Focus on whether they were correctly fixed」——对一条被裁决「不修」的建议，这句话就是在指示审稿人再提一遍。
- **RC4 · 无监督覆盖路径**：唯一的旁路是 `codex_skip`（session 级、execution 启动时冻结、跳过整个 review）——粒度错误（per-review 不是 per-finding）、代价过大（放弃全部审查）、且被治理铁律禁用。没有「Lead 裁决单条 finding 已定案」的机制。

## 4. 设计目标（对应 issue 要做 1-4）

1. Lead 裁决能**真实到达**审稿人，且审稿人被要求尊重它（信息层）。
2. 阻塞语义机械化：**只有 HIGH（correctness/security/授权/数据）阻塞**；MEDIUM/LOW = 非阻塞建议，随 verdict 附带传递但不关门（强制层——不依赖模型听话）。
3. 收敛保证：同一条已裁决 finding 不再跨轮触发 fail-closed。
4. 受监督的 per-finding Lead 覆盖路径（非 codex_skip），带完整审计 + Discord 可见性。
5. 真 HIGH 缺陷照旧 fail-closed；不弱化 FLY-827/FLY-1188 的任何既有防线（head 冻结、家族反转、gate 绑定、fail-close 解析）。

## 5. 方案

### 5.1 组件设计（推荐：A+B+C+D 组合，缺一不可）

**A · 门侧 severity 政策（机械强制，治本）** — coordinator 在拿到 verdict 后计算 `effectiveVerdict`：
- 阻塞 finding := severity 不在 {MEDIUM, LOW} 白名单（缺失/未知值一律算阻塞，fail-closed），**且**未被 Lead 裁决定案。
- reviewer 说 APPROVED → 照旧 APPROVED（政策只单向放宽 CHANGES，绝不收紧 APPROVED）。
- reviewer 说 CHANGES_REQUESTED：有阻塞 finding → 维持关门；**全部 findings 非阻塞 → effectiveVerdict=APPROVED（advisory 放行）**——写权威 record、开门，非阻塞建议作为 advisories 附在 verdict payload 里交给 runner + Lead alert 知会（绝不静默丢弃；期望去向 = follow-up issue）。
- findings 为空的 CHANGES_REQUESTED → 维持关门（审稿人拒绝给结构化理由 = fail-closed）。
- 这一条**单独就终结 FLY-1251 的实际死锁**（R6 即放行）。

**B · 审稿人契约补 severity 语义（提示层，与 A 双向对齐）** — R1 contract 明确定义：HIGH = correctness/security/数据丢失/授权破坏（ship-unsafe，必须 block）；MEDIUM = 应修但不阻 ship 的改进（性能/成本/速率/重构）；LOW = nit。并告知「CHANGES_REQUESTED 仅当存在 ≥1 条 HIGH；全 MEDIUM/LOW 请投 APPROVED 并列出——门会机械执行此政策」。

**C · Lead 裁决通道（per-finding、Lead 权威、服务端持久）** — 新 StateStore 表（issue 域）记录 per-finding ruling：finding 标识 + disposition（overruled / follow-up + issue 号）+ rationale + ruled_by + 审计时间。写入路径 = 新 `flywheel-comm review-ruling` → Bridge 端点校验（execution/issue 存在、该 finding 确实出现在**已投递过的** verdict 里——不能预先豁免还没被提出的 finding）→ 落库 + Discord issue thread 可见性通知（=「受监督」）。**裁决过的 finding 从阻塞集合里排除（含 HIGH）**——这是 issue 要求 4 的「门接受该 head」。finding 标识 = 审稿人输出 schema 新增稳定 `id` 字段（resume 同 session，可要求跨轮复用同 id）+ 兜底指纹。
- **权威边界（关键决定）**：裁决**只能来自 Lead**，绝不接受 runner 在 request/gate 文本里自带「Lead 说了算」——否则 codex 作者可以伪造裁决自我豁免真 HIGH，等于打穿 reviewer-inversion。这正是为什么「把 gate 消息文本透传进 prompt」这个最省事的修法被**否决**（见 5.2）。

**D · 裁决感知的复审 prompt（信息层）** — buildPrompt 注入 GOVERNANCE 段：列出已裁决 findings（id/标题/disposition/理由/follow-up issue），指令「已定案，勿重提、勿以此投 CHANGES_REQUESTED；若有**新证据**证明某条实为 HIGH 真缺陷，以 `disputesRuling: <id>` 标注重提——它不会机械关门，但会 alert Lead 复议」。同时修 RC3：reround 指令改为「聚焦你**未定案**的既往 findings 是否被正确修复 + 修复引入的新问题」。

### 5.2 被否决的替代方案

| 方案 | 否决理由 |
|---|---|
| 把 runner 的 gate 消息文本直接透传进审稿人 prompt | 作者控制的自由文本 = 对审稿人的 prompt-injection 面；作者可伪造「Lead 已裁决」豁免真缺陷，打穿家族反转不变量。coordinator 的设计哲学（payload 是待校验输入、绝非权威）明确反对 |
| 只改 prompt（B+D），不做机械政策（A） | 本事故证明纯提示不可靠的反面也成立——模型行为无强制保证；FLY-1204 教训：标签/嘱咐不能冒充事实，收敛必须机械成立 |
| verdict 完全由 findings 计算，取消 reviewer 的二元 verdict | 改动大且丢失审稿人整体判断的逃生口（它仍可用一条 HIGH 表达整体否定）；保留 verdict 字段 + effective 计算 = 双保险且 parser 向后兼容 |
| codex_skip 放宽 / Lead 直接 skip | 治理铁律明确禁止；粒度错误（整审跳过 vs 单条定案），审计意义完全不同 |
| N 轮后自动放行 / 轮次上限 | 数轮数 = 允许真 HIGH 被磨过门,直接违反「真 HIGH 仍 fail-closed」验收 |

### 5.3 范围边界

- **In**：跨家族 lane（ReviewRequestCoordinator / claude-review-runner / StateStore / flywheel-comm 新子命令 / codex-runner-contract.md 文案）。design + code 两类 review 统一适用 effective-verdict 政策。
- **Out**：legacy claude-author→codex-reviewer lane（byte-compat 不动——其循环由 runner 会话式自解，如需同政策另开 issue）；verify-approval / isCodexGateSatisfied 消费端（record 只在 effective APPROVED 时写入,消费端无需改）；FLY-1274 本体（优化归它）；Lead CLI 硬身份认证（现状全机同 posture,对齐 FLY-246 follow-up）。

## 6. 开放问题（brainstorm gate 向 Lead 确认）——已裁决（2026-07-15，Tadashi via brainstorm gate）

Lead 批复：理解正确，A+B+C+D 全批；否决「gate 文本透传」确认正确。三个确认点全按推荐执行：

1. **A 的默认值**：**default ON** + `FLYWHEEL_REVIEW_SEVERITY_POLICY=0` 逃生口——「这是 bug fix 不是新功能（我们自己的规矩就是 MEDIUM/优化不该 block ship），default-off 灰度 = 做了跟没做一样」；advisory findings 附 verdict payload + alert 知会 Lead、绝不静默丢，保留。
2. **裁决豁免 HIGH**：**生效**，配 dispute-alert + Discord issue thread 审计——「否则『门接受该 head』在 HIGH 上是空话」；终极兜底不变：verify-approval / founder ship gate 零改动，Annie 仍批每一次 merge。
3. **裁决作用域**：**issue 级跨 execution 存活**——「execution 级会让裁决死于每次 retry」。

追加设计输入（Lead 直令）：**验收必须包含用 FLY-1251 真实 R6-R9 序列做的回归 fixture**——machine-replay 那四轮，断言政策开启后 R6 即 effectiveVerdict=APPROVED + advisory 传递。已折进 plan.md 测试节。
