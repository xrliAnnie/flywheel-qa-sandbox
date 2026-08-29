# FLY-882 Discord bot token 池 — 探索/Exploration

Issue: FLY-882 (https://linear.app/geoforge3d/issue/FLY-882/opsinfra-discord-bot-token-池-一次建好-n-个空白-bothoney-lemon-anna-备用以后加)
日期: 2026-07-05
基于: 无

## 背景 / 来源

Annie 2026-07-05 05:55 提出：「一次多建几个空白 bot 把 token 池建好（产品 Lead + Anna + 备用），以后谁需要 bot 自己去拿。」她当时在线，希望今天就把池建起来。

当前每次要给一个新 Lead（如 Peter、Oliver）配 Discord bot，都是走 `/setup-discord-lead` 这个纯手动 runbook：现开 Discord Developer Portal → New Application → 记 token → 开 intents → 生成邀请链接 → Annie 点一次邀请 → 建 `DISCORD_STATE_DIR` + `access.json` → 改 `projects.json`。每一步都要 Annie 在场经手 Discord 后台的敏感操作（建 App、Reset Token）。这套流程本身没问题，但意味着"要不要给这个 agent 一个身份"和"现在有没有空闲的 Discord bot 身份"这两件事被耦合在一起——每次都得临时起一轮 Portal 操作。

FLY-882 把"预先攒一批空白身份"和"临时用哪个身份"解耦：一次性（今天，Annie 在线时）批量创建 6 个空白 application + bot，存进本地 token 池；以后任何一个新 Lead/agent 要用 Discord 身份，直接从池里认领一个，跳过"现建 App"这一步，只需要走认领流程（改名、邀请进 server、跑 `/setup-discord-lead` 剩余步骤）。

## 现状代码审计

审计确认这是一个**从零开始的新能力**——代码库里目前没有任何"池"的概念：

- **`/setup-discord-lead`**（`.claude/commands/setup-discord-lead.md`）是一份纯 prose 手动 runbook，不是脚本。Step 1 写"Guide the user or use Chrome automation"去 Developer Portal 建 App，但仓库里**不存在**任何实际驱动 Portal 的 Chrome/Playwright 自动化脚本——每次都是当次 session 里临时用 Claude-in-Chrome 手动操作。
- **token 存放现状**：真实 token 值只存在 `~/.flywheel/.env`，格式 `{DISNEY_NAME}_BOT_TOKEN=...`（现有：`PETER_`、`OLIVER_`、`SIMBA_`、`ASHA_`、`BELLE_`、`MUFASA_`、`RAFIKI_`、`REFLECTION_`、`TADASHI_`、`CASS_`、`HIRO_`、`ARIEL_`、`TRITON_` 等 20 个 key）。`~/.flywheel/.env` 当前权限是 `644`（不是文档里写的该有的 `600`——是历史遗留的不一致，不在本 issue 修复范围内，但设计新池子时不能重蹈覆辙）。
- **`ProjectConfig`**（`packages/teamlead/src/ProjectConfig.ts`）：每个 `LeadConfig` 有 `botTokenEnv?: string`（env 变量名）+ 运行时解析出的 `botToken?: string`。`parseAndValidateProjects()` 在读 JSON 时**主动剥离**任何裸写的 `botToken` 字段（"secrets must come via env"），只认 `botTokenEnv` 这层间接引用。这是一个值得抄的模式：配置文件（会进 git 或至少结构化管理）只存"去哪儿找密钥"的指针，密钥本体单独存一处、单独管权限。
- **`access.json`**（`$HOME/.claude/channels/discord-<lead-id>/access.json`）：Discord plugin fork（`xrliAnnie/claude-plugins-official`，不在本仓库）读取的频道 allowlist，schema 是 `{dmPolicy, allowFrom, groups: {channelId: {requireMention, allowFrom}}, pending, allowBots}`。这一层完全在 `/setup-discord-lead` 的 Step 3 范围内，FLY-882 不碰。
- **FLY-519（fleet provisioning，已完成 PR #250/#259）** 的 exploration 明确把"自动创建 Discord bots"列为**非目标**："自动创建 Discord bots / Linear teams（账号操作 Annie 经手；runbook 列步骤）"——即 FLY-519 特意把这块留白，FLY-882 现在来填这个洞，但填的方式不是"全自动建 App"（Discord 没有无头 API 能建全新 Application+Bot，必须走已登录的 Developer Portal 网页），而是"批量攒库存，认领时零现建"。
- **命名惯例**：`agentId` 是 kebab-case（`product-lead`、`ops-lead`……），bot 走 Disney 角色命名（部门首字母对应角色：P=Peter, O=Oliver, 预留 F=Flynn/M=Moana/D=Dumbo/E=Elsa/S=Simba/H=Hercules）。这次要认领的 "Honey Lemon"（FLY-880 内部 PM agent）、"Anna"（FLY-879 对外访谈员）不严格落在这张表里——它们是 Flywheel 自托管（self-hosting，FLY-270）下的新角色命名，不是 GeoForge3D 那条线，池子设计不需要预先假设名字，空槽保持占位名（`flywheel-pool-01`…`06`），认领时才改名。

## 关联 issue（划清边界，避免范围蔓延）

- **FLY-880**（内部 PM agent "Honey Lemon"，In Progress，PR #450/#15 已在跑）——这是"建 Honey Lemon 这个 agent 本身"，跟 Discord 身份是两件事。task list 里已经有一个独立跟踪项 `#103: Honey Lemon (Flywheel Product Lead) cutover — token from Annie → deploy → full-capability QA`，说明"把 Discord 身份接上、邀进 server、跑满全流程"本来就是**另一件排定的后续工作**，不是 FLY-882 的交付物。
- **FLY-879**（对外 PM 访谈员 bot "Anna"，Backlog，未开始设计）——issue 原文明确："等 879 设计过了再邀"，即 Anna 的 Discord 身份现在只能"预留"，不能真邀进 server（879 还没定权限隔离设计，879 自己的红线是"只往 doc/interviews/ 开 PR、绝不碰内部 codebase"这类强隔离要求，跟这个身份用什么 bot token 没关系，但"现在邀进 server"等于让一个还没设计权限边界的 agent 先拿到 Discord 出入口，属于抢跑）。

结论：FLY-882 的"认领"到"预留身份 + 改名 + 登记 claimed"为止，不含"邀进 server + 起 Lead 进程"的完整 cutover。这个边界判断已经写进 brainstorm gate 问题去跟 Tadashi 确认。

## 核心张力：三段式流水线 vs. "今天就做"

Annie 明确说"今天就做，她在线参与"——但当前 repo 是三段式流水线（Design → Implement → QA，各自独立 agent session）。真正"用 Claude-in-Chrome 操作 Developer Portal 建 6 个空白 bot"这个动作，必须有 Annie 在场（她的账号、可能的 MFA），这本质上是 Implement 阶段的活，不是 Design 阶段该做的。已经在 brainstorm gate 消息里向 Tadashi 提醒这个时间窗口敏感点，建议 design review 一过就立刻接 Implement，不要拖到第二天错过 Annie 在线的窗口。
