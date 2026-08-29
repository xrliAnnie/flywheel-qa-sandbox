# FLY-910 Discord 权限模型 research — bot 能自动到哪、用户最少手动做啥

Issue: FLY-910 (https://linear.app/geoforge3d/issue/FLY-910/非工程快速-onboarding-体验设计一条-command-上手后体验)
日期: 2026-07-08
基于: Annie 要「简化建 Discord + research 权限模型」· Discord 官方 API 文档 + 社区(2026-07 WebSearch)

> **Annie 的想法**:能不能一开始就拿一个**高权限 bot**,让 **bot 自动把该建的(频道/角色/webhook)都建了**,而不是让用户手动一样样建。
> **我 research 后的诚实结论**:**能自动一大半,但有 3 件用户必须亲手、删不掉**(Discord 平台限制,不是我们没做)。下面给「最大自动化 / 最少手动」的确切边界。

---

## 1. bot 能做什么 / 不能做什么(核实过的事实)

| 能力 | 能不能程序化(bot 自动) | 依据 |
|---|---|---|
| **建 server(guild)本身** | 🔴 **实际上不行** —— `POST /guilds` 只对「在 **少于 10 个 guild** 的 bot」开放,**且建出来的 server 归 bot 所有**(不是用户的),要转给用户还得用户先进群 + 所有权转移(脆、要 2FA)。**结论:让用户自建 server 最干净(10 秒)。** | Discord API `Create Guild`「can be used only by bots in less than 10 guilds」;社区多年讨论此限制 |
| **建 bot 应用 + 拿 token** | 🔴 **不行** —— 没有公开 API 能创建一个 Discord application/bot,**必须去 Developer Portal 手动建**。这是唯一真正删不掉的一步。 | 无 `Create Application` 公开 API;只能 Portal |
| **开 Privileged Intents**(Message Content / Server Members) | 🔴 **不行** —— 这两个开关在 Developer Portal,只能手动开。 | Portal-only toggle |
| **邀请 bot 进 server** | 🟡 **半自动** —— 我们生成 OAuth2 邀请链接(带高权限 + 预选 server),**用户点一下**授权。「bot 只能经 OAuth2 加群,不能收普通邀请」。 | OAuth2 `scope=bot&permissions=<int>&guild_id=<id>` |
| **建频道 / 分类** | 🟢 **能自动** —— bot 有 Manage Channels 权限就能程序化建/改/删频道。 | Guild/Channel API + Manage Channels 权限位 |
| **建角色 / 配权限** | 🟢 **能自动** —— Manage Roles 权限就能建角色、配权限(不超过 bot 自己最高角色)。 | Manage Roles |
| **建 webhook** | 🟢 **能自动** —— Manage Webhooks 权限就能建/改/删 webhook。 | Manage Webhooks |
| **发消息 / 建 thread / 组织结构** | 🟢 **能自动** | 常规 bot 能力 |

**一句话**:**server、bot 本体、两个 intent = 平台锁死要用户手动;进群一次点授权;此后频道/角色/webhook/整个内部结构 = bot 全自动建。**

## 2. 高权限怎么给(Annie 说的「一开始拿高权限 bot」)

- 高权限**不是**一个「API key」,是**邀请链接里的 permissions 整数**:`https://discord.com/oauth2/authorize?client_id=<bot>&scope=bot&permissions=<整数>&guild_id=<用户server>`。
- Discord 把每个权限打进一个 64-bit 位掩码;我们把 Manage Channels + Manage Roles + Manage Webhooks + 发消息等**需要的位**算进这个整数(或直接给 Administrator 图省事,但**最小权限更稳/更可信**,建议只给需要的)。
- bot 一进群,Discord **自动给它建一个带这些权限的托管角色** → 此后 bot 就能自动把频道/角色/webhook 全建好。
- **可预选 server**:链接带 `guild_id=<用户刚建的server>` → 授权弹窗直接预选那个 server,用户少选一步。

## 3. 「最大自动化 / 最少手动」= 简化后的建 Discord(替换原 7 微步)

**用户只做这 4 件(平台锁死、删不掉)**:
1. **建一个自己的 server**(左边「+」→ 创建 → 起名,10 秒)—— 因为 bot 不能干净地建归用户所有的 server。
2. **在 Developer Portal 建 bot 应用 + Copy token**(贴进 Buddy 的安全输入)—— 无 API 可代建。
3. **开两个开关**(Message Content / Server Members intent)—— Portal-only。
4. **点一下我们生成的高权限邀请链接**(预选好他的 server)。

**其余 bot / Buddy 全自动**:
- 生成带最小必需权限 + 预选 server 的邀请链接;
- bot 一进群 → **自动建好所有频道 / 分类 / 角色 / webhook / 内部结构**(用户不用手动建任何频道);
- 每步即时校验(连 Gateway / 确认 intent / 确认已入群 / 确认频道建好)。

→ **对比原设计**:原设计里「建频道」本来就是 [AUTO],这次 research **确认了可以把结构全部交给高权限 bot 自动建**(不止频道,连角色/webhook),用户手动面进一步压到**只剩那 4 件平台锁死的**。**这就是能简化到的极限;再往下(免手动建 bot/server)Discord 平台不给,只能靠「现成共享 bot 池」那条捷径 —— 而那条 Annie 已定标『理想/大概率做不成』。**

## 4. 诚实边界(必须让 Annie 知道)
- **建 bot 应用 + token + 开 intents + 建 server + 点邀请** = **平台锁死的最小手动集**,任何人(含 OpenClaw)都没绕过去。我们能做的是把这 4 步带到「点错都难」+ 其余全自动。
- 想连这 4 步都免 = 只能用**我们预建的共享 bot**(用户只点邀请)→ 但那 bot 不是用户完全自有、且共享 bot 进太多 server 有风险 → **块3 已定:当理想/探索项,不当第一版承诺**。

## 出处(2026-07 WebSearch)
- bot 建 guild 限制:Discord API `Create Guild` 文档 + discord/discord-api-docs Issue #1300 / Discussion #5957(「less than 10 guilds」限制多年讨论)。
- OAuth2 bot scope + 权限整数 + guild_id 预选:Discord OAuth2 文档;Discord 权限计算器(discordapi.com/permissions.html 等)。
- 频道/角色/webhook 程序化:Guild/Channel/Webhook API + Manage Channels/Roles/Webhooks 权限位。
