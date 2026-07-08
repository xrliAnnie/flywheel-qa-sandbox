# FLY-909 竞品候选 List — 给 Annie 过目 + 补充

Issue: FLY-909 (https://linear.app/geoforge3d/issue/FLY-909/竞品分析市面上别人怎么做-喂产品定位形态)
日期: 2026-07-06
基于: research.md;新增 Annie 提供的重点对标 Matrix(flowith)

> **流程(Annie 定)**:先给候选 list → 你(Annie)补充你想到的 → 再一个个深挖。
> 这一页是**待补充的候选名单**,不是最终分析。请圈掉不想看的、补上想看的。
> 🌟 = Annie 已点名 / 我判断的**重点对标**(最贴我们要做的)。

---

## 🌟 重点对标(最贴 Flywheel 愿景 —— 建议第一批深挖)

| # | 玩家 | 一句话 | 为什么是重点 |
|---|---|---|---|
| 0 | **🌟 Matrix(flowith 出品)** | 「Launch a 0-Person Company that actually earns」—— 设目标 → CEO 级 Agent 自建部门、自主分工 → build/ship/distribute/earn 全闭环 | **Annie 点名,跟我们非常像**:一整个你指挥的自主 AI 公司 + 分层部门 + 跑 Claude/Codex 订阅(同我们)。是目前正面对标度最高的一家 |

**Matrix 初步画像(深挖前的速写)**:
- **定位**:0 人公司运行框架;你只定方向 + 给资源,Matrix 经营并赚钱。比我们更激进(目标 = 自动赚钱的**整个生意**,不止造软件)。
- **产品形态**:**macOS 桌面 app**(matrix.build,Apple Silicon)+ **游戏式「小人」可视化** agent 干活;canvas 出身(flowith)。
- **驱动**:**支持 Codex / Claude Code 订阅 + BYOK** —— 跟 Flywheel 一样不锁按 token 计费(⚠️ 所以「无 token 计费」不是我们的独有差异)。
- **战绩**:GDPVal-Bench 95.45% SOTA(超 Codex 84.9% / Opus 15%);公测已建数万家「0 人公司」;3 家官方示例(Video Commerce Studio / SEO Growth Lab / Lead Gen Agency);现免费开放。
- **背景**:flowith(2023,Derek Nee + Yichen Wu,YC China),旗舰是 canvas 式 agentic workspace + Agent Neo(10M context)。
- **已知痛点**(评论区):稳定性/API error、连自己 Claude 报 no credit、Intel Mac 不支持、小人可视化被部分用户嫌分心、有人质疑「verification cost(验证成本)是 AGI 经济瓶颈」。
- **跟我们哪像/哪不一样(待深挖确认)**:
  - **像**:你指挥的一整个 AI 组织 + 分层部门 + 订阅驱动。
  - **不一样(初判)**:① 我们是**软件工程团队**(真 PR/CI/review/长期维护一个真 codebase),它是**赚钱生意闭环**(偏运营+变现);② 我们**聊天(Discord)为界面**,它**桌面 app + 游戏可视化**;③ 我们打**非技术小企业的真实产品需求**(如 Hooves & Paws),它打**「0 人创业/自动赚钱」的消费级 autonomy 叙事**;④ 我们有 **founder 验收 gate + QA 纪律**,正对它「verification cost」这个公开软肋。

> ⚠️ **诚实修正**:Matrix 的存在推翻了我第一版「一整个 AI 公司这个空位没人正面占」的判断。这个位**有人占了**。我们的差异化要从「唯一做 AI 公司」收窄到「**软件工程纪律 + 聊天界面 + 非技术小企业真实产品**」。深挖后会改写 competitor-scan.md 的差异化章节。

---

## 档一:no/low-code AI builder(非技术自己 prompt 出 app —— 最贴目标客户)

已刷新画像(见 research.md),建议全深挖:

| # | 玩家 | 一句话 | 深挖优先级 |
|---|---|---|---|
| 1 | **Lovable** | 不写代码发布 production app;vibe coding 门面 | 高 |
| 2 | **Base44**(Wix) | 一句话 → 带 DB+认证+托管的全栈 app;$100M ARR | 高 |
| 3 | **Replit Agent (Agent 3)** | 大白话变 app,不用碰文件 | 高 |
| 4 | **Bolt.new**(StackBlitz) | 浏览器里整套开发环境 | 中 |
| 5 | **v0**(Vercel) | 高质量 UI 组件工厂(偏前端) | 中 |
| — | 候补:Create.xyz / Softr / Bubble+AI / Google Opal / a0.dev | 更长尾的非技术 builder | 低(按需) |

## 档二:自主编码 agent / AI 开发(只看形态 + 定位打法)

| # | 玩家 | 一句话 | 深挖优先级 |
|---|---|---|---|
| 6 | **Devin**(Cognition) | AI software engineer;卖「工程产能单位」 | 高(定位打法值得学) |
| 7 | **Factory(Droids)** | agent-native 覆盖整个 SDLC;Slack 触发 + Linear 连接 | 高(teammate 面最像我们) |
| 8 | **OpenAI Codex** | async 云端 agent,派任务 → 出 PR | 中 |
| 9 | **GitHub Copilot(agent mode)** | 实时 IDE + agent | 中 |
| 10 | **Claude Code** | terminal-first agentic(**我们的 Runner 就是它**) | 低(自己人) |
| — | 候补:Cursor / Google Jules / Zencoder / Cosine Genie | 更多编码 agent | 低(按需) |

## 档三:teammate / AI 组织形态(照出「像谁/不像谁」)

| # | 玩家 | 一句话 | 深挖优先级 |
|---|---|---|---|
| — | **🌟 Matrix / flowith** | (见上「重点对标」) | 最高 |
| 11 | **Lindy** | 最好上手的 AI 员工(运营:邮件/CRM),接 1000+ 工具 | 中(叙事 + 集成教训) |
| 12 | **Artisan** | 自主 BDR(外呼销售) | 低 |
| — | 候补:Manus / Genspark / Vellum / OpenClaw / Zapier Central | 通用 agent / AI 员工 | 低(按需) |

---

## Annie 补充的竞品(已认出真身,加进 list)

> Annie 口头补了两个,像认 XHS→Matrix 那样查了真身。**都偏开源/自托管/面向工程师**,不是非技术 SMB —— 但作为「自主软件 agent」形态对标有价值,归档二。

| # | Annie 说的 | 认出的真身 | 是什么 | 深挖优先级 |
|---|---|---|---|---|
| 13 | **hermas agent** | **Hermes Agent**(Nous Research,2026-02)✅ 高置信 | 开源、**自托管在你自己服务器的常驻 daemon**:跨会话攒记忆、**自己写可复用 skill**、跑 cron、接 16+ 消息平台、自我改进。跑在 $5 VPS 就行。面向**技术自托管者** | 中(它的 memory + 自写 skill + 消息平台形态跟我们有并行,值得看) |
| 14 | **open people** | **OpenHands**(原 OpenDevin,All Hands AI)⚠️ 中高置信,待 Annie 确认 | 开源自主软件工程师、**Devin 的开源对标**($18.8M A 轮、70K+ star)。给它一个 GitHub issue → 自主 plan/写/出 PR;有 CLI/SDK/桌面/云(接 Slack/Jira/Linear)。面向**开发者** | 中 |

**⚠️「open people」待确认**:我判断 = OpenHands(「people」↔「hands」音近,且它是最出名的「Open___」自主软件 agent)。如果 Annie 指的是别的(比如 OpenClaw / 某中文圈产品 / 一个真叫 OpenPeople 的东西),说一声我重认。

**这两家对我们定位的初步意义**:它们证明「自主软件 agent」这条线**开源侧也很热**(Hermes 自托管 daemon、OpenHands 开源 Devin),但**都要求用户是技术人 / 会自托管** —— 正好反衬我们的位置:**非技术创始人不碰服务器、不写 issue、只在 Discord 说话**。Hermes 的「常驻 + 记忆 + 自写 skill + 接消息平台」跟 Flywheel 架构有并行,深挖时重点对比。

---

## 我给 Annie 的三个问题(帮你补 list)

1. 除了 Matrix,你脑子里还有哪些「感觉像我们」的?(尤其中文圈 / 你刷到的)→ 直接补进档三。
2. 深挖批次:我建议**第一批 = Matrix + Lovable + Base44 + Devin + Factory**(5 家,最喂定位)。这个批次你 OK 吗,还是想先只挖 Matrix?
3. 要不要我对 Matrix 直接调 **ChatGPT Deep Research**(你已通用授权)做一次深挖?它是最贴的对标,值得一份带引用的深度对比。

---

## 下一步(等 Annie)

Annie 圈定 list + 补充 → 我按批次一个个深挖(重点对标 Matrix 优先,必要时 Deep Research)→ 回填 research.md + 改写 competitor-scan.md 差异化章节 → 再给你 review。
