# FLY-910 竞品 onboarding 研究 — 别人「从零到第一次用起来」那段怎么做

Issue: FLY-910 (https://linear.app/geoforge3d/issue/FLY-910/非工程快速-onboarding-体验设计一条-command-上手后体验)
日期: 2026-07-08
基于: FLY-909 competitor-scan(Paperclip / Matrix / Cowork / OpenClaw / Lovable / Base44 已覆盖,直接用)+ command-form-research.md(OpenClaw / Hermes)+ 本轮补 raft.build 的 onboarding

> Honey Lemon / Annie 派:研究相似产品的 onboarding —— 专看「粘一条命令 / 注册 → 上手 → 第一次拿到有用的东西」那一段(引导长什么样、让用户做什么、怎么少让人卡壳),给下面 `tactical-options.md` 的 option 表当依据。**诚实、有出处;查不实的直说。**

---

## 一张表:每家「怎么起步 → 怎么带 → 第一次产出」

| 产品 | 一句话 | 起步入口 | 怎么带用户上手 | 第一次拿到啥 | 谁托管 |
|---|---|---|---|---|---|
| **Paperclip** | 把你的一堆 AI agent 组织成一个公司 | 自己机器上跑(官方 5 分钟起一个容器,或 Docker/VPS) | **Company Wizard**:回答几个问题 → 自动装配好一个公司(含 CEO / 经理 / 干活的)+ 一堆「导入即跑」的公司模板 | 一个配好的 AI 公司在你自己面板里开始接活 | 你自己自托管(它没有托管云) |
| **Matrix**(flowith) | 开一家「0 人公司」 | 下一个 macOS 桌面 app;公测靠邀请码 + 送免费额度 | **设一个目标就开跑** —— 一个 CEO 级 agent 自动建部门、自主分工;屏幕上有游戏小人可视化 | 一家在跑的「0 人公司」(它官方样例都是营销/内容/获客生意) | 桌面 app 跑在你自己 Mac 上 |
| **Raft**(raft.build) | 人和 AI agent 在同一个聊天频道里当队友一起干 | 网页注册(app.raft.build,有免费档) | 注册 → **连上你自己的 AI 订阅**(Claude/Codex 等,自带)→ **装一个很轻的本地小程序**(在你自己机器上跑 agent)→ 建或导入 agent → 进频道 | 一个聊天式工作区,agent 自己认领任务、并行干、互相交接,你在 thread 里看得见、可回退,「最终拍板永远是你」 | 网页 + 你机器上一个本地小 daemon(混合) |
| **Claude Cowork**(Anthropic) | 非技术知识工作者的 AI 助手 | 就在 Claude 桌面 app 里(不用装别的、不碰命令行) | **用大白话描述「做完长什么样」→ 它自己做完 → 交到你电脑一个文件夹** | 一份做好的知识工作成品(研究/合同/报告),你 review | 桌面 app,锁 Claude |
| **OpenClaw**（我们 Bridge 的血统) | 跑你自己设备、在你已用的 IM 里回你的个人 AI 助理 | **一条 `curl … | sh`** → 验环境/装依赖/拉核心 → 起一个引导 wizard(浏览器里) | wizard 开场给二选一:**QuickStart(用好默认值,最快)** vs Advanced(全控);一步步问 Model/授权 → 工作目录 → 网关 → 连哪些聊天渠道 | 「跳过接渠道直接 dashboard 聊」是最快摸到对话的逃生路,几分钟能聊上 | 你自己自托管 |
| **Hermes**（Nous Research) | 「跟你一起成长」的开源个人 agent | **一条 `curl … | bash`** 装,一条命令起 | `hermes setup` 全程 wizard;**三档**:QuickStart(免费 OAuth 登录、零 API key,最快) / Full(自带 key) / Blank(全关);支持**安全重跑**(装一半断了重来不重复) | 配好一个 agent + 工具网关就能用 | 你自己自托管 |
| **Lovable / Base44** | 聊天几句就出一个能跑的 app | 网页,聊天框 | 用大白话描述你要的 app → 几分钟生成一个真能跑的(Base44 连数据库/登录/托管都接好) | 一个当场能打开的 app / 内部工具 | 平台托管(Base44 数据锁平台、搬不走是它的软肋) |

**关于 Draft**:Annie 把它跟 Paperclip / Matrix 并列点名,但我这轮**没查到一个明确对应的「你指挥一整个 AI 公司」类产品叫 Draft**(搜索只返回泛泛的「solo founder AI agent」文章)。**不瞎编** —— 请 Annie 给个链接或截图确认是哪个 Draft(像之前 competitor-scan 里 Aimless Agent 真名待确认那样),我再补它的 onboarding。下面的 option 不依赖 Draft 这一家。

---

## 从这些 onboarding 里学到的几条(直接喂 option）

1. **一条命令 → 引导式对话(不是一屏表单)** 是自托管这类的通用起步姿态(OpenClaw / Hermes 都这样)。我们的「终端一条 command」不孤单,有活参照。
2. **默认给「快路」(QuickStart),把「全控」藏在 --advanced 后面** —— 别让人从零配(OpenClaw / Hermes 都这么分档)。时间紧的老板要快。
3. **越早让人「先聊上一句」越好** —— OpenClaw 专门留了「跳过接渠道、直接进 dashboard 聊」的逃生路。呼应我们「工具还没全接、先跟 Captain 打个招呼」的想法。
4. **能授权就授权、少让人手动粘密钥**(Hermes 的「免费 OAuth 零 key」是金标准)。我们只有 Discord 建 bot 这一步天生手动、删不掉,别装能一键消掉它。
5. **自带订阅 / BYO 模型是标配**(Matrix / Raft / Paperclip 都让你连自己的 Claude/Codex)。我们一样。
6. **Raft 跟我们最像**:聊天频道 + AI agent 当队友 + 自带订阅 + 本地小 daemon + 「最终拍板是你」。差别:它是**网页 app + 轻本地 daemon 的混合**,我们现在是**纯自托管**(客户自己机器 + Discord)。这印证了「managed / 更软的入口」是真存在的产品方向(我们放到 V2)。
7. **没人真做到「完全非技术自己跑起来」**:连 70K star 的 Paperclip 都还是「原型穿产品外衣」、要自托管。这条赛道谁先把「替你做完、真能自己用」跑通谁赢 —— 我们 MVP 先服务懂点电脑的老板、managed 版(V2)再接非技术那群。

## 出处

- Paperclip / Matrix / Cowork / OpenClaw / Lovable / Base44:`product/doc/FLY-909-competitor-scan/`(paperclip-deepdive.md · matrix-deepdive.md · competitor-scan.md · competitor-deepdives.md,2026-07 WebSearch/WebFetch,含各自官网 + 第三方评测)。
- OpenClaw / Hermes 一条-command wizard 细节:`command-form-research.md`(OpenClaw docs · Hermes/Nous Research docs)。
- Raft:raft.build / app.raft.build 官网(2026-07 WebFetch)。
- Draft:未找到明确对应产品,待 Annie 确认(2026-07 WebSearch 两轮无实据)。
