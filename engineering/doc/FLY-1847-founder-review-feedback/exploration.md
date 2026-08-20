# FLY-1847 founder review 意见回传与 verdict 误判 — 探索

Issue: FLY-1847 (https://linear.app/geoforge3d/issue/FLY-1847/founder-ux-互动-review-页的意见回传是手动复制粘贴-已实际发生她写了一整轮我们没收到而她不知道)
日期: 2026-08-18
基于: 无

> 2026-08-19 状态：本文保留问题空间与历史方案。founder 已选择“卡锚定固定协议”，否决自然语言词库/分类器、页面 marker 自动打回与 ❌ reaction；最终实施边界见 `plan.md`。

## 1. 问题:七个实例、三种形态、一个根

Issue 累计记录了 7 个实例(2026-08-17 至 2026-08-18),归成三种形态:

| 形态 | 实例 | 具体 |
|------|------|------|
| ① 她的意见没被收到 | 1-3 (FLY-1827) | 页面留言写在 localStorage 里,没点「一键汇总复制」贴回 thread;系统只收到一个**无 feedback 的 `passed=false`**,她不知道内容没送出来 |
| ② 她的同意被记成否决 | 5 (FLY-1826) | 「ok what's next」→ `passed=false`,runner 的 `complete --route needs_review` 被硬门拒绝,单子无法终结 |
| ③ 她的提问被记成否决 | 4 (FLY-1833 ship 卡)、7 (FLY-1846) | 「还有什么需要我做决定的?」→ `passed=false` / 返工 kickback |

再加一条**最锋利的**:founder_review 卡的自动正文自相矛盾(`founder-thread-notifier.ts:154-155`)——第一段教她「点一键汇总复制贴回 thread」,第二段说「直接回复这条卡片 = 打回」。**她照卡面做,必然被判成打回。**

**一个根**:founder_review 通道把 founder 的自然语言强行二分成 通过/打回,**没有「既非通过也非打回」这个态**;而且**写入即关门**(`insertResponseIfGateOpen` 原子地写 response + `markQuestionTerminalDisposed`),每一次误判都必然消耗 founder 的一次额外操作才能恢复。

## 2. 现状机制审计(不是 greenfield —— 关键事实)

### 2.1 founder_review 通道(病灶)

- **分类器**:`packages/teamlead/src/bridge/founder-review-response.ts:26` `classifyFounderReviewReply` —— NFKC + trim + lowercase + 去尾部标点后,**整串精确等于** `都可以了/可以了/通过/lgtm/approved` 之一 → `passed:true`;**否则一律 `passed:false`**,原文塞进 `feedback`(空文本连 feedback 都没有 —— 实例 1-3 的 113 字节回执)。
- **入口**:`founder-reply-deliverer.ts:585-613` `processFounderMessage` —— founder 在 thread 里发的**任何消息**,只要(a)是对 review 卡的 Discord reply,或(b)当前恰有一个开着的 founder_review round,就被送进上述二元分类并**立即写入 verdict**。
- **写入即关门**:`flywheel-comm/src/db.ts:1749` `insertResponseIfGateOpen` 在同一事务里写 response + `markQuestionTerminalDisposed` —— 已答的 round 关死,再点 ✅ 或再回话都写不进,唯一出路是 runner 开新 round。
- **✅ 通道**:`gate-poller.ts:3088` 轮询 review 卡上的 ✅ reaction → `tryFounderReviewReactionResponse` → `passed:true`。`checkReactionConfirmation` 本身支持任意 emoji(`emoji` 参数,默认 ✅)—— **加 ❌ 通道是现成机制的对称复用**。
- **verdict 消费**:`flywheel-comm/src/founder-review.ts:376` `resolveFounderReviewVerdict` + `commands/complete.ts:139` `founderReviewCompletionBlockReason` —— `needs_review`/`no_code` 完成必须最新 round `passed:true`,否则 `process.exit(1)` 拒绝(当前 head 是 exit 1;实例 5 报的 exit 0 在本 head 不复现,单独归因,不进本设计)。
- **无任何回执**:verdict 写入后没有任何 in-thread 确认。她不知道自己那句话被记成了什么。

### 2.2 已存在、可直接复用的结构

- **第三态的落点早就有**:`founder-reply-deliverer.ts:705-716` —— 没有命中任何 gate 的 founder 消息走 `deliverAmbiguousToLead`,注释明言「Bridge is a transport only… Lead's later guarded response is the sole action allowed to write a runner response」。**三态化 = 让不确定的消息落回这条既有通道,而不是被 review gate 吞掉。**
- **round 换代机制**:开新 round 会 supersede 旧 round(`supersededAt`,`resolveFounderReviewVerdict` 只看未 superseded 的最新一轮)。第三态不写 verdict → round 保持开放 → 她随时还能 ✅,runner 也可在收到 Lead 转达的意见后直接返工、开新 round 换代旧 round —— **两条恢复路都不花她第二次操作**。
- **ship 卡侧早有三态先例**:`approval-signal/founder-ship-approval-classifier.ts` —— LLM strict 分类器 `approve/reject/unclear`,unclear **fail-closed 不动状态**;`approval-intent.ts` 也有 `approve/reject/neutral`。说明「fail-closed 三态」在本 codebase 是既定安全范式,founder_review 是唯一还在用「else = 打回」的通道。
- **in-thread 通知先例**:ship 路径的「已存着」notice(`deferred-approval.ts`)—— 给 founder 发一行状态回执有既定形态。
- **页面契约的源头**:`packages/edge-worker/src/Blueprint.ts:869-909`(INTERACTIVE COMMENT LAYER + HONEST COMMENT RETURN)—— 所有互动 review 页的「一键汇总复制」格式由这段注入契约决定。**改这里 = 改所有未来页面的汇总输出格式。**

### 2.3 硬约束

- **托管是纯静态 + 严格 CSP**:报告页发布在 Vercel 静态托管(`reports-route.ts` → `deployFilesToVercel`),CSP `default-src 'none'; script-src 'nonce-…'`(`report-registry.ts:66`)—— 页面**发不出任何 fetch/XHR**;Bridge 在住宅 Mac 上,公网不可达。「页面自动回传」需要新的可达 endpoint + 存储 + 轮询 + 鉴权,是一整块新 infra。
- **trusted attribution**:`insertFounderReviewResponseIfGateOpen` 要求 founder 归属(`isTrustedApprovalAttribution`),Lead 不能替 founder 写 verdict(`gate-response-router.ts:260` 明确 403 Lead 的 approve)。任何设计不得开 Lead 代写 verdict 的口子。
- **边界(issue 明文)**:空白打回是合法动作 —— 不得强制她写意见;localStorage 持久化保留。

## 3. 解法空间

Issue 给了两个方向(二选一或都做):**(1) 让意见真的能回传**;**(2) 让漏掉变得不可能/可检测**。

### 方向 A:三态分类 + 显式打回 + 回执(选定,零新 infra)

核心倒置:**今天的默认是打回,改成默认是第三态;打回变成显式动作。**

- **PASS**(不变,保守精确):白名单逐字匹配 或 卡上 ✅。**不放宽** —— 放宽 pass 会把带意见的回复误判成通过,方向更危险(memory: `reference_founder_review_pass_is_exact_match_vs_copy_button`)。
- **KICKBACK**(收窄为显式三种):
  1. 卡上 **❌ reaction** —— 一下 = 无意见打回(空白打回合法且便宜);
  2. 逐字「**打回**」(与 pass 白名单同款保守匹配);
  3. **带机器 marker 的页面汇总粘贴** —— 把 Blueprint 契约里「一键汇总复制」的输出格式标准化:首行固定 literal marker(如 `【页面意见汇总】FLY-XXXX`),分类器识别 marker → `passed=false` + 全文进 feedback。**教她走的那条路(写→复制→贴回)从此正确落账为「带内容的打回」。**
- **第三态**(其余一切:提问、闲聊、「ok what's next」、手写长段、attachment-only):**不写 verdict,round 保持开放**,走既有 `deliverAmbiguousToLead` 转 Lead;并在 thread 里回一行解释(每 round 至多一次,防刷屏):「这条没有记为通过或打回,已转给 Lead。要通过点 ✅;要打回点 ❌ 或回『打回』。」
- **回执(治「她不知道」)**:
  - pass(文字路)→ bot 在她的消息上点 ✅(镜像 ship 卡的既有承诺形态);
  - kickback 带意见 → 一行回执「已记为打回,页面意见已交给 runner(N 字)」;
  - kickback 无意见(❌/「打回」)→ 一行回执「已记为打回(未附意见)。**如果你在页面写过留言,它们还没送出来** —— 打开页面点『一键汇总复制』贴回来,我会补交给 runner」 —— 这就是实例 1-3 那条丢失路径的**当场检测与告知**,发生在系统唯一能观测到的时刻(verdict 时刻)。
- **卡片文案重写**(founder-thread-notifier):按用途三分「要提意见 / 要通过 / 还没想好」,消除自相矛盾;「页面留言目前不会自动同步」改成肯定句「写完点复制贴回来,我才收得到」。

### 方向 B:页面自动回传(rejected for now)

Vercel serverless function 收留言 + 存储(KV)+ Bridge 轮询 + 鉴权,或 Bridge 公网隧道。**否**:
- 新 infra 面(function、存储、轮询、token 管理、CSP connect-src 放宽)对住一个「回执 + marker + 文案」就能当场可见的丢失模式,不成比例;
- Annie 简单性铁律「修结构别加报警器·删的比加的多」—— 方向 A 是把错误的默认改对(结构修复),方向 B 是加一条并行管道;
- 若 A 落地后丢失仍复发,B 作为 follow-up 单独立项,届时页面契约(marker、localStorage key)已就绪,不冲突。

### 方向 C:LLM 分类器接管 founder_review(rejected for now)

复用 ship 卡的 subscription classifier 三态判 founder review 回复。**否(现在)**:确定性规则已把「会写 verdict 的路径」收窄到五个显式信号(白名单、✅、❌、「打回」、marker),残余全部第三态转 Lead —— 错判率结构性归零,不需要模型;LLM 引入延迟/成本/不确定性,且「手写长段意见被三态转 Lead」的代价只是 Lead 转达一次(该通道今天本来就在用)。若第三态量大到 Lead 不堪,再考虑用 LLM 只对「长文本残余」做 feedback/chat 二分(unclear 仍第三态)。

### ship 卡侧(实例 4)—— 同原则、独立 chunk

实例 4/部分实例 5 在 approve_to_ship / FLY-1772 kickback 腿上:founder 在 ship 卡 thread 的提问被当 feedback 触发 `founder_feedback_kickback` 返工。同一个根,同一剂药:**kickback 铸造前加第三态守卫** —— 文本既非 approve(LLM 分类器已 strict)也非显式打回信号(❌/「打回」/marker/分类器 reject)→ 不铸 kickback,转 Lead。实现上只动「文本→kickback 决定」那一个边界,不碰 FLY-1772 的返工机器本身。因涉及另一套机制(workflow source projector),在 plan 中列为独立 chunk,可后置。

## 4. 选定方向

**方向 A(三态 + 显式打回 + 回执 + 文案/契约修复)为主体,ship 卡守卫为第二 chunk,方向 B/C 明确 rejected-for-now。**

对七个实例的覆盖:

| 实例 | 修后行为 |
|------|---------|
| 1-3 (写了没贴,空打回) | 空打回只能来自显式 ❌/「打回」,回执当场提醒「页面留言还没送出来」→ 她或 Lead 立即看见 |
| 4 (ship 卡提问→返工) | kickback 铸造前第三态守卫 → 提问转 Lead,不动状态 |
| 5 (「ok what's next」→passed=false) | 不匹配任何显式信号 → 第三态,round 开着,她随手 ✅ 即通过 |
| 7 (「还有什么要我决定?」→passed=false) | 同上,第三态转 Lead,bot 一行解释教她两个显式动作 |
| 卡文案自相矛盾 | 三分用途重写;marker 让「贴回汇总」正确落账 |

## 5. 不做什么(诚实边界)

- **不做**页面留言自动到达 runner —— 本设计让「没到达」当场可见、让教的路正确落账,不消灭手动步骤本身。
- **不做**强制填写意见 —— ❌ 一下就是合法空白打回。
- **不放宽** pass 白名单,**不开** Lead 代写 verdict。
- **不碰**写入即关门语义(防双写的既有设计)、round supersede 机制、FLY-1772 返工机器本体。
- **不处理**已被误记的历史 round(恢复 = 既有的开新 round 路径)与实例 5 的 exit-0 观察归因。
