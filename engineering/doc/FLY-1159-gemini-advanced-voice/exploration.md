# FLY-1159 /gemini-advanced 语音接线（route A）— 探索

Issue: FLY-1159 (https://linear.app/geoforge3d/issue/FLY-1159/voiceb-gemini-advanced-语音接线route-a-delegate-挂-gemini-引擎)
日期: 2026-07-11
基于: 无（上游输入 = issue 正文 + PR #548 交接包 engineering/doc/FLY-1159-gemini-advanced-voice/handoff.md）

## 1. 问题是什么

Annie 直令：/gemini-advanced 的**语音版**「一直推着去做」。FLY-1018（文字地基,
PR #518,已 merge）交付了 packages/gemini-agent 的深层 6 工具循环;FLY-1159 是
它的语音接线 —— 在 VC 里对 /gemini-advanced 语音命令说一句话就能派深活,口头收到「已受理」,
完成后口播 + 频道文字落地。

**本票的特殊形态**:实现已经存在。PR #548（OPEN,base = flywheel-FLY-1018,head =
feat/fly1018-voice-delegate）包含 3 个 commit:

| commit | 内容 |
|--------|------|
| 0b6862df | 实现主体 — advanced.ts(新)+ config.ts / wiring.ts / cli.ts / package.json 增量 + 14 新测 |
| 285f2ac8 | Codex R1 修复 — 轮换空窗 sendText 静默 no-op 会丢完成通知 → deps.sendMessage 文字保底无条件化 |
| 48d83fa1 | FLY-1159 交接包 handoff.md（「不要重做实现」红线 + QA/ship 生命周期任务清单）|

Codex code review 两轮 APPROVED（R2 零 findings）,voice-bridge 193/193（当时基线）。

所以 FLY-1159 的真实工作 = **把这份已批准的实现安全落到 main + 独立真机语音 QA +
founder-gated ship**。设计阶段的任务 = 给 implement/QA 阶段一份精确、机器验证过的
落地计划,并确认交接包里已过时的假设。

## 2. 行为合同（v2 — founder 2026-07-11 更正,QA 对着验）

> **v2 更正**:handoff 原合同把 delegate 挂在同一个 /gemini 命令上（配置开关）。
> Annie 明确推翻:「/gemini → just Gemini Live;/gemini-advanced → Gemini Live +
> Gemini Agent,两个都要是语音版」—— delegate 必须是**独立命令**,/gemini 永不
> 携带它。旧的单命令拍板（brainstorm gate,Tadashi）由 Tadashi 背书改判。

- 命令形态:**两个语音命令并存**,共享同一 SessionSlot(同一 VC 同时只有一个
  助理会话):
  - /gemini = 纯现状(Gemini Live + 2 个只读小工具),**无论 advanced 配没配都
    字节不变**(字节冻结,Annie 不再测);
  - /gemini-advanced(仅当 advanced 配置存在时注册;命令名默认 gemini-advanced,
    advanced.commandName 可配,与 /gemini 撞名 = 启动即拒)= 同一 Live 引擎 +
    delegate_task。
- 配置:huddle.assistant.advanced = { leadId, commandName?, deptLabel?,
  identityPath? } —— 不配 = 只有 /gemini,字节不变;半配置(缺 agent env)=
  daemon 启动即拒(fail-fast 带修复指引,语义不变)。
- 链路(在 /gemini-advanced 上):说一句 → Live 口头「已受理,任务 <id>」(即时
  ACK)→ 深层 6 工具文字循环异步跑(#518 的封闭注册表 + scoped token)→ 完成
  **口播**(尽力而为 —— 轮换空窗/会议已散时 rotator 的 sendText 会静默丢)+
  **语音频道文字落地**(无条件送达,createDiscordCompletionSink —— 这才是完成
  通知的保证面,Codex #548 R1 修复的合同)。
- 权威面:零新增 —— ship 意愿仍止于 request_ship_approval;绝无 merge/deploy 能力。

架构优点（Tadashi 拍板 route A 的理由）:语音层用 Gemini Live（原生、快）,
Claude/工具只在委派深活时异步调用 → 避开 /glaw 每轮 claude -p 冷启动的卡死/延迟病。

## 3. 代码库审计 — 交接包写完之后世界变了什么

handoff.md 写于 2026-07-10 20:53(commit 48d83fa1);此后 main 上发生了两件事,
其中一件推翻了交接包的一条关键假设:

### 3.1 #518 已 merge（前提成立）

d1e5117d feat(FLY-1018) 已在 main。交接包待办第 3 条「#518 合并后 rebase/retarget」
的前提已成立。但注意 #518 是 squash-merge —— #548 的 head 分支带着 #518 的**原始
commit**,与 main 上的 squash 版本历史分叉。直接 merge/retarget 会把 #518 的旧
commit 当增量重放,产生假冲突。

### 3.2 FLY-1160（#550）合入,交接包「冲突面理论为零」已过时

交接包断言:「rebase 本分支到 main、PR retarget main(冲突面理论为零 —— 全部改动
在 voice-bridge,#518 不碰它)」。这在写下时成立,但 **3.5 小时后** FLY-1160
(resident Claude voice-brain, #550, 2026-07-11 00:21) 合入 main,重改了 voice-bridge
的 wiring.ts(+58)和 cli.ts(+122),并且 FLY-1065 captions 也改过 assistant/config.ts。

**实测冲突面（本设计阶段在 scratchpad 演练 cherry-pick 得到,非理论推断）**:

| 文件 | 冲突 hunk | 性质 | 解法 |
|------|-----------|------|------|
| assistant/config.ts | 2 | FLY-1065 captions 字段与 advanced 字段撞同一插入点 | 两边都保（纯加性） |
| cli.ts | 1 | FLY-1160 ResidentBrainManager import 与 loadAdvancedAgentConfig import 撞行 | 两边都保（纯加性） |
| wiring.ts | 0 | 自动合并 | — |

第 2、3 个 commit（285f2ac8 / 48d83fa1）零冲突。

### 3.3 语义正交性验证（不是只看文本冲突）

- FLY-1160 的 scope 被 founder 明确收窄:「/glaw + /eleven only —— /gemini(-advanced)
  have no Claude conversational brain」(#550 commit message 原话)。resident brain
  与本票的 Gemini Live 会话是两条互不相交的链路。
- FLY-1160 对 wiring.ts 的改动全是 shutdown 语义（isShuttingDown 命令下架 /
  close(AbortSignal) / Linear client 的 signal 透传）;**#548 挂载的 seam ——
  makeRealConversationFactory → TalkSessionRotator 的 extraTools 注入点 —— 未被触碰**,
  auto-merge 干净。
- FLY-1160 对 cli.ts 的改动（brainManager 单例 / BrainPort / 两阶段 shutdown）与
  #548 的启动 fail-fast 检查（loadAdvancedAgentConfig）位于不同代码段,无执行顺序耦合。

### 3.4 机器验证（演练证据）

scratchpad 演练:origin/main (6f151690) 上 cherry-pick 3 commits → 解 3 hunk →
pnpm build (voice-core + gemini-agent + voice-bridge, tsc 全过) →
**voice-bridge 测试套 336/336 全绿**（= FLY-1160 新增测试 + FLY-1159 的 14 新测
+ 全部既有测试共存,零回归）。解决 patch 与 diffstat 已存档,implement 阶段照抄即可。

## 4. 落地路径选型（本票唯一真正的设计决策）

### 选项 A（推荐）:cherry-pick 到三段式共享分支 flywheel-FLY-1159,开新 PR,close #548

- 三段式管线（Design → Implement → QA）在 flywheel-FLY-1159 一条分支上工作;
  设计文档已在此分支。implement 阶段 cherry-pick 0b6862df + 285f2ac8 + 48d83fa1,
  按 §3.2 表解 3 hunk（演练 patch 可照抄）,全套测试 + lint,开新 PR(base=main)。
- squash-merge 分叉问题天然消失（只重放 3 个真增量 commit,不带 #518 旧历史）。
- #548 close 时留 comment 双向链接,Codex R1/R2 审计线索不丢。
- 新 PR head ≠ #548 已批 head → 按纪律重跑 Codex code review（增量,diff 几乎
  字节一致,预期快）。

### 选项 B:retarget #548 到 main + rebase --onto 原分支

- 保住 #548 的 PR 评论区（Codex 记录原位）。
- 缺点:head 分支 feat/fly1018-voice-delegate 挂在旧 FLY-1018 worktree 的模型上,
  与三段式共享分支管线错位（progress ledger、QA respawn、gate binding 都绑本分支）;
  rebase --onto main c2370b81 后 force-push 老 PR,冲突解法与选项 A 完全相同,
  却要多维护一个游离分支。Codex review 因 head 变更同样要重跑 —— 选项 B 并不省。

结论:选 A。选 B 唯一的增益（评论区原位）用链接即可保全。

## 5. 范围边界

- **不重做实现**（handoff 红线）。行为合同 §2 冻结,QA 对着验。
- **不碰 /glaw、/eleven、resident brain**（FLY-1160 领地,正交已验证）。
- 生产专属 Discord bot = Tadashi 上线手续,不在本票（handoff §4）。
- ship model = merge-to-main-only,不重启生产 Bridge（Annie 2026-07-11 00:34 拍的
  voice wave ship 模式;voice-bridge 是按需起的 daemon,merge 即生效于下次启动）。

## 6. 遗留问题（进 research/plan 细化）

1. QA 方案细节:967 staged 形态 + ~/.flywheel/gemini-agent-test 隔离半区复用路径、
   QA R3 四条锚点的语音链复现步骤、TEST_BOT_TOKEN_1、GEMINI_API_KEY 取值纪律。
2. Codex 增量 review 的提法(带上 #548 两轮记录做上下文,声明 diff 与已批内容的关系)。
3. implement 阶段的验证清单(全仓 lint、voice-bridge 336 基线、pnpm-lock 一致性)。
