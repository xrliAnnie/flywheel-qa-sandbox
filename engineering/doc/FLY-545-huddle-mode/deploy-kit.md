# FLY-545 Huddle 部署 kit(post-merge 执行手册)
Issue: FLY-545 (URL 不可得,只写 issue 号)
日期: 2026-07-10
基于: bot-provisioning.md + packages/voice-bridge/src/config.ts schema

> **状态**:未提交工作稿(head 已绑 ship/codex 两门,QA runner 不移 head)。合并后由
> Tadashi/ops 执行 production 应用。**部署本身 merge-gated**:/glaw 从合并的正式代码跑,
> 常驻程序不带这个命令就无法启动 —— 所以 **approve→merge 是整条部署的唯一 unblock**。

## 硬约束(为什么不能"现在就跑")
1. **必须先合并**:/glaw 命令 + huddle 常驻 runtime 是本 PR 的代码;主机上现在没有 voice-bridge
   daemon 在跑,命令未注册。不合并 = 没有可启动的东西。
2. **两步物理上是 founder 的**(bot 无 admin/MANAGE_CHANNELS,runner 不冒用 founder 会话):
   - 把 Huddle 编排 bot 邀请进服务器(点一条链接);
   - 建/指定一个常驻 **#huddle 语音频道**(或拍板直接用现有 General VC)。
3. **production config 改动**(~/.flywheel/.env + projects.json)= Lead/ops 领域,QA worktree
   runner 不擅自改生产(projects.json 被生产 Bridge 读,加未知块有运行时风险)。

## Runner 已备好(零生产改动,合并后照抄即可)

### A. ~/.flywheel/.env 追加三行(token 来源已核)
```
HUDDLE_ORCH_BOT_TOKEN=<~/.flywheel/discord-bot-pool/flywheel-pool-06/token>
HUDDLE_EARS_BOT_TOKEN=<~/.flywheel/discord-bot-pool/flywheel-pool-04/token>
GEMINI_API_KEY=<现在只在 ~/.zshrc,拷进 .env——launchd wrapper source 不到 zshrc>
```
(FLYWHEEL_API_TOKEN / DISCORD_OWNER_USER_ID 已在 .env,无需加。)

### B. projects.json 给 flywheel 项目加 huddle 块(schema 见 config.ts)
```jsonc
"huddle": {
  "guildId": "1485787271192907816",
  "voiceChannelId": "<新建的 #huddle VC id,或现有 General VC 1485787273193853170>",
  "orchestratorBotTokenEnv": "HUDDLE_ORCH_BOT_TOKEN",
  "earsBotTokenEnv": "HUDDLE_EARS_BOT_TOKEN",
  "commandName": "glaw",           // 默认就是 glaw,可省
  "moveMembers": true,
  "leads": [
    // ⚠️ 开放项:每个参会 Lead 需要一个在 guild 里能 Connect/Speak 的 bot token env。
    // 需 Tadashi 定:哪几个 Lead 进 huddle + 各自 botTokenEnv(如 Tadashi 自己的 bot)。
    { "agentId": "<lead agentId>", "botTokenEnv": "<该 Lead 的 BOT_TOKEN env>",
      "geminiVoice": "Kore", "aliases": ["Tadashi"] }
  ]
}
```

### C. Founder 点几下(合并后我给现成链接/频道建议)
1. 邀请编排 bot(权限已算好 = View/Send/Connect/Speak/MOVE_MEMBERS):
   `https://discord.com/oauth2/authorize?client_id=1523232391349403850&scope=bot&permissions=19926016&guild_id=1485787271192907816&disable_guild_select=true`
   (耳朵 bot pool-04 = Note-taker 已在 guild,无需邀请。)
2. 建一个语音频道命名 #huddle(或拍板用 General VC),把它的 id 填进 B 的 voiceChannelId。
3. 起 voice-bridge 常驻程序(Tadashi/ops 那步)。
4. 然后在 #huddle 发 **/glaw @点名一个 Lead** → 全程跑。

## 开放项(需 Tadashi 拍)
- 参会 Lead 名单 + 各自 bot token env(huddle 至少要 1 个 Lead bot 能说话)。
- #huddle 用新建 VC 还是现有 General VC。
- production apply 的执行人 + 时机(建议:合并后 Tadashi 主导,或指派我执行 A/B、founder 做 C)。
