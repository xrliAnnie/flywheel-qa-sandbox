# FLY-910 无痛自托管 onboarding 深挖(Annie 定 B 纯自托管起步)

Issue: FLY-910 (https://linear.app/geoforge3d/issue/FLY-910/非工程快速-onboarding-体验设计一条-command-上手后体验)
日期: 2026-07-06
基于: research-options.md · exploration.md(10 步审计底料)· 2026 web 研究(OpenClaw / Discord 官方)

> Annie 定:**部署模型 = B 纯自托管起步**(客户自己机器上跑),云托管 A/C 推到未来验证需求 + 有余力再做。故本文只挖「无痛自托管 onboarding」。**诚实优先**:明确标出哪些坎**无法消除**、最差要 founder(我们/Anna)上门陪建。

> ⚠️ **自托管的一个 reframe(影响每一步)**:自托管下客户用的是**他们自己的** Discord / Linear / 模型账号。所以之前我提的「用我们预建的 Discord bot 池(FLY-882)」**在纯自托管下不适用** —— 那是我们的 infra,客户在自己机器上跑、连自己的 Discord,必须**自己建 bot**。这把「几乎全自动」的乐观判断往回收了:有几步**本质要用户亲手点**,删不掉,只能带得无痛。

---

## Block ① · 10 步 cutover 三分表(自托管口径:能自动 / 必须用户手动 / 客户自己 gate)

原则:token 签发、merge、ship、runner-lifecycle 永远 gate;但自托管下「founder」= **客户本人**(他是自己那个 AI 公司的老板),所以 founder-gated = 客户自己拍板。

| # | 步骤 | 判定 | 能做到多无痛 |
|---|------|------|-------------|
| 1 | commit+push 脚手架 | ✅ 自动(自托管可**仓留本地**、跳过 push) | 隐形 |
| 2 | gh 建仓 | 🟡 **建议非-eng 自托管路径直接砍掉 GitHub**,仓留本地;若保留则需用户有 GitHub 账号 | 可移除的坎(见决策点2) |
| 3 | Linear team/labels | 🟠 **账号=用户手动一次**(需 Linear 账号 + API key 或 OAuth);拿到 key 后 team/labels **全自动 provision** | 账号那下删不掉;provision 自动;Linear 可全隐藏在 agent 后(客户从不开它) |
| 4 | **建 Discord bot + 频道 + token** | 🔴 **不可消除的硬坎**:用户必须去 Developer Portal 建 app+bot+copy token+开 intents(Discord **无 API 可代建**);频道可自动建;token 经 CLI 安全录、**绝不粘聊天** | 步骤删不掉,但引导可做到很顺(见 Block ③) |
| 5 | 手改 projects.json | ✅ 全自动 | 隐形(客户永不看 JSON) |
| 6 | claude-lead 生成 manifest | ✅ 全自动 | 隐形 |
| 7 | 装/reload launchd | ✅ 自动(装在用户机器上) | 自动,但**引入「机器要常开」现实**(见决策点1) |
| 8 | 重启 Bridge | ✅ 全自动 | 隐形 |
| 9 | 验证 + 首次聊 | ✅ 自动健康检查 + 🎁 做成首个 Aha | 亮点:「去 Discord 跟你 Captain 打招呼」 |
| 10 | 接 deploy hook | ✅ 自动/可选 | 隐形 |
| + | 模型 auth(Claude 订阅/key) | 🟠 用户手动一次 | 引导录入 + 校验 |
| + | 运行期 merge/ship/runner-lifecycle | 🔵 **客户自己 gate**(FLY-175,自托管下 founder=客户) | 做成 Discord 里一键批准 |

**收敛**:自托管下「手动搞一天」压缩成 →「跑一条 command + **3 件必须亲手的事**(建 Discord bot / 授权 Linear / 录模型 key)+ 运行期自己批准」。其余全自动、隐形。

---

## Block ② · OpenClaw 及同类怎么处理不可避免的账号/token(deep-research)

**OpenClaw(= Annie 说的 OpenCloud,Flywheel Bridge 的血统)自托管 onboarding wizard 就是活参照**——它对 Discord 那步是**交互式手把手带过**,不是自动化掉(自动化不了):
1. 引导「去建 Discord application → 命名(如 OpenClaw)→ Bot 区 Add Bot」;
2. 「Reset Token → 复制」;**token 经 env(DISCORD_BOT_TOKEN)/CLI 录,绝不粘聊天**(长期凭证安全铁律);
3. 引导开 **Privileged Gateway Intents**(Message Content 读消息 / Server Members 做 allowlist);
4. channel 作 plugin,wizard 帮装;DM 安全用 pairing code(首条 DM 发码、approve)。

**同类无痛套路(可借)**:
- **OAuth device grant**(Discord 官方支持,专为 CLI/非-web 客户):用于**授权/邀请类**步骤,免 redirect、CLI 友好 —— 但注意**建 bot application 本身仍必须手动**,device flow 只帮「授权」不帮「建 app」。
- 合理默认 + QuickStart 模式覆盖常见场景;
- **检测已装/已配就跳过**(幂等、断点续传);
- 结尾**健康检查**给确定性("一切就绪")。

**诚实结论**:业界最好的自托管 onboarding(含 OpenClaw)也**没能把 Discord 建 bot 这步自动化掉** —— 它们赢在「把不可避免的手动步骤**带得极顺** + 其余全自动」。我们照这个标准做就是同级最优,别假装能一键消掉它。

---

## Block ③ · 引导式 agent 怎么把留下的手动步骤带得最无痛(对话式,不要表单)

**形态**:一个**引导式 onboarding agent**(Anna,或专门做一个 onboarding concierge agent)在终端/对话里带全程:
- **一步一问、对话式**,绝不甩一张表单;能自动的**后台悄悄做**(provision / 写 config / 起服务),用户只感知「描述想要啥 + 授权那几下」。
- 对每个**不可自动**步给到「**点这里 → 点这个 → 把这一串复制回来**」级别的手把手,配**短视频/截图**;一次只推一步,不信息过载。
- 用户说「我建好了」→ agent 让其**经 CLI 安全录 token**(不粘公开频道)→ **立即校验**(连一下 Discord 确认 token 有效)→ 才进下一步;失败给**具体报错**(如「intents 没开」),不是「出错了」。
- **断点续传**:装一半中断,重来能接着走,不重复已完成步。
- **收尾 Aha** = 「去 Discord 跟你的 Captain 打个招呼」——首次对话直接让新建的 department 干一件真事(呼应 Block-1 首次产出)。
- **worst-case 升级**:用户卡在 Discord Portal → **一键喊 Anna/我们真人来陪**(screen-share 陪建)= 诚实兜底,不假装全自助。

---

## 诚实:哪些坎无法消除 / 最差要 founder 上门

1. **建 Discord bot(Developer Portal)** —— 无法 API 自动化,只能引导。最差:用户搞不定 → Anna/我们 screen-share 陪建。
2. **拥有/注册账号**:Discord、Linear、模型(Claude)。没有就得注册(手动),onboarding 只能给链接 + 「弄好告诉我」。
3. **一台常开的机器(自托管的深层坎,onboarding 解不了)**:自托管 = 客户得有台机器 **7×24 开着**,agent 才一直在干活;关机=公司停摆。这不是 onboarding 流程能消的,是**自托管模型本身的成本**,得让目标客户知道。
4. **模型成本/额度**:Claude 订阅或 API key,用户自担。

> 我们能做到的最好 = 把 1/2/4 带得极顺(Block ③)+ 其余全自动;**3 是模型级现实,必须诚实告知 Annie**,别让 onboarding 体验掩盖它。

---

## 给 Annie 的决策点(逐块已标,集中列)
1. **「机器常开」现实**:自托管要客户有台 7×24 常开机器 —— 要不要显式设成门槛/告知(目标客户=有台常开机器的人)?这是自托管最硬的隐性坎。
2. **砍不砍 GitHub**:非-eng 自托管路径仓留本地、不接 GitHub(少一个账号/一步)?我倾向砍。
3. **Linear 全隐藏**:客户从不打开 Linear、只在 Discord 聊,Linear 纯做后台任务存储 —— 可接受吗?(仍需他有个 Linear 账号,那步删不掉。)
4. **Discord 建 bot 手动不可消除**:接受「引导式手把手 + worst-case Anna 陪建」作为第一版答案吗?

> 我不写 PRD。等你带 Annie 把这几点拍完,我把「一条 command + 引导式 agent 带过 3 件手动事」的 onboarding 流程深钻到能交 Tadashi 的颗粒度(逐屏对话 + 每步触发什么 + 校验/失败路径 + 首次产出样例)。
