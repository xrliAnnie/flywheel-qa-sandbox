# FLY-910 block 2 · 「一条 command」形态研究(OpenClaw + Hermes Agent 借鉴)

Issue: FLY-910 (https://linear.app/geoforge3d/issue/FLY-910/非工程快速-onboarding-体验设计一条-command-上手后体验)
日期: 2026-07-06
基于: 2026 web 研究(OpenClaw docs · Hermes Agent docs/Nous Research)

> Honey Lemon 派的 block 2 研究:学 OpenClaw + Hermes Agent 的一条-command onboarding,产出借鉴要点 + 给我们的 command 形态建议。**锚**:客户=甲(终端一条 command 可接受)· 部署=B 自托管 · 交互=引导式对话不表单。

## 两家怎么做(事实)

**OpenClaw**(自托管 AI agent gateway,Flywheel Bridge 血统):
- 一条 `curl … | sh` 干 6 件:验 Node → 查/装 Git → 拉核心 → 装依赖 → 生成带**安全默认值**的 .env 模板 → 起 onboarding wizard(**浏览器**里)。
- wizard 开场给二选一:**QuickStart(默认值)vs Advanced(全控)**;可 `--flow quickstart` 跳过问。
- 步骤:Model/Auth(API key / **OAuth** / 手动)→ Workspace(默认目录)→ Gateway(端口/绑定/auth/Tailscale)→ Channels(Discord/Slack/Telegram… 作 plugin)。
- **最快路径**:跳过 channel,直接 `openclaw dashboard` 在浏览器聊。TTF-message 几分钟。

**Hermes Agent**(Nous Research,2026-02,开源,"grows with you"):
- 一条 `curl … install.sh | bash` 装,一条命令起。
- `hermes setup` = 全 wizard;或 `hermes model` / `hermes tools` 分步。
- **三档 flavor**:**Quick Setup(Nous Portal)= 免费 OAuth 登录、零 API key**,配好 model + Tool Gateway(**推荐快路**)· Full(自带 key、全走一遍)· Blank Slate(全关、只留裸最小)。
- `hermes model` 引导连接方式:OAuth / API key / 自定义 endpoint;**支持安全重跑(幂等)**。

## 借鉴要点(给我们)

| # | 学到的 | 对 Flywheel 的含义 |
|---|--------|-------------------|
| 1 | **一条 curl 干全套 + 起 wizard**(装依赖→拉核心→安全默认→起向导) | 正是我 S0 设计,验证了。照做。 |
| 2 | **分档:QuickStart(默认)vs Advanced(全控)** | 甲 要快 → **默认 QuickStart**(用我锁的默认:C1 bot / 砍 GitHub / Linear 隐藏 / 只读 scope);`--advanced` 给要控制的。别让人从零配。 |
| 3 | **OAuth 优先、最小化粘 key**(Hermes「免费 OAuth 零 key」是金标准) | Linear/模型/业务工具能 OAuth 就 OAuth;**只有 Discord bot token 不可避免手动**(我们诚实的硬坎)。 |
| 4 | **生成安全默认值**(.env 模板/默认目录) | 用户不配置,系统给安全默认;敏感项才问。 |
| 5 | **安全重跑/幂等** | 我 S0–S8 的 state.json 续传已对齐。 |
| 6 | **「最快摸到聊天」逃生路**(OpenClaw 跳 channel 直接 dashboard 聊) | 借鉴:尽早给一个「先跟你的 Captain 说上话」时刻,别让全套 provisioning 挡在第一句对话前。 |
| 7 | wizard 位置:OpenClaw 走**浏览器**,Hermes 走**终端** | 甲 终端 OK + Annie 要「对话不表单」→ **默认终端引导式对话**;OAuth 那几步天然弹浏览器。两者混用最顺。 |

## 给我们的 command 形态建议(recommendation)

**一条终端 command → 引导式对话向导(默认 QuickStart)**:
1. `curl -fsSL https://get.flywheel… | sh`(形态与 OpenClaw/Hermes 一致,甲 熟悉)。
2. curl 干:验/装依赖 → 拉核心 → 生成安全默认 config → 起**终端内引导式对话** agent(不是浏览器表单;OAuth 步骤才弹浏览器)。
3. **默认 QuickStart**:用锁定默认一路带过(C1 bot 引导 / 砍 GitHub / Linear 隐藏 / 只读工具),甲 最快到 Aha;`--advanced` 留给要全控的。
4. **OAuth 优先**:模型/Linear/业务工具能 OAuth 就 OAuth、不粘 key;**只有 Discord bot token 手动**(honest,S5 手把手兜)。
5. **「先跟 Captain 说上话」的早时刻**:借 OpenClaw 逃生路思路——一旦 Discord + 模型就绪,先让客户跟 Captain 打个招呼(哪怕工具还没全接),把「有反应的对话」提前;完整跨系统 Aha 随后(工具接好)。
6. 幂等续传(已在 S0–S8)。

> **和已有 detailed spec 的关系**:以上全**印证并细化**了 onboarding-flow-detailed.md 的 S0–S8,不冲突。要落的两处小增强:① S0/S1 显式支持 `--flow quickstart|advanced`(默认 quickstart);② 在 Discord+模型就绪后、工具全接之前,插一个「跟 Captain 打招呼」的早对话时刻(缩短 time-to-first-message)。Annie 认这个形态我就把这两处织进 detailed spec。

## 给 Annie 的确认点(block 2)
1. 认不认「**一条终端 curl command → 终端引导式对话、默认 QuickStart(`--advanced` 可选)**」这个形态?
2. 要不要那个「工具还没全接就先跟 Captain 打个招呼」的早时刻(更快有反应,但第一句可能还做不了真活)?
