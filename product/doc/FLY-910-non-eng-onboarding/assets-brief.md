# FLY-910 / FLY-1023 M8 — Discord 4 步素材制作 brief

Issue: FLY-1023 (BI-8;上游 FLY-910 spec §2 + 附录)
日期: 2026-07-09
基于: onboarding-buddy-spec.md §2(4 步话术)+ scripts/buddy/copy/step2a-discord.md(实装话术)

> 给内容侧的制作 brief:4 张截图 + 1 条 15s 短视频。**字幕逐字用下表「字幕(=话术)」列**——它与 Buddy 实装话术(copy/step2a-discord.md)一字对应;素材做好后按「落位路径」放进本文件夹,Buddy 话术模板里的 [截图 N] 锚点即指向它们。

## 一、4 张截图

| # | 画面 | 字幕(=话术,逐字) | 标注 | 落位路径(占位) |
|---|---|---|---|---|
| 1 | Discord 客户端左侧栏,「+」按钮与「亲自创建」弹窗 | 建一个你自己的服务器:打开 Discord,左边点大「+」→「亲自创建」→ 起个名。 | 红圈:+ 按钮、亲自创建 | `assets/discord-step1-server.png` |
| 2 | discord.com/developers/applications,New Application 弹窗 + Bot 页 Reset Token 按钮 | 给团队成员做工牌:「New Application」→ 起名 →「Create」;「Bot」页 → 点「Reset Token」→ 复制那串密钥。 | 红圈:New Application、Reset Token;密钥打码 | `assets/discord-step2-bot.png` |
| 3 | Bot 页下方两个 intent 开关 | 同一页往下,把「MESSAGE CONTENT INTENT」和「SERVER MEMBERS INTENT」两个开关打开。 | 红圈:两个开关(拨到开) | `assets/discord-step3-intents.png` |
| 4 | 邀请链接打开后的授权页(服务器下拉已选中) | 点开邀请链接、选你刚建的服务器、点授权,把成员请进去。 | 红圈:服务器下拉、授权按钮 | `assets/discord-step4-invite.png` |

## 二、15s 短视频分镜

| 秒 | 画面 | 字幕(与截图字幕同源,压缩版) |
|---|---|---|
| 0–3 | 截图 1 动化:点「+」→ 亲自创建 → 起名 | 建个你自己的服务器 |
| 3–8 | 截图 2 动化:New Application → Bot → Reset Token → 复制(打码) | 做张工牌,把密钥复制下来 |
| 8–11 | 截图 3 动化:两个开关拨开 | 打开这两个开关 |
| 11–15 | 截图 4 动化:点邀请 → 选服务器 → 授权 → 成员出现在列表 | 点邀请,团队进场 ✓ |

落位:`assets/discord-4steps-15s.mp4`(竖屏 9:16 优先,终端里以链接形式给出)。

## 三、制作要求

- 密钥/邮箱等一律打码;界面语言以英文原版 UI 为准(按钮名不翻译,字幕里保留原文按钮名)。
- 字幕字体/排版随品牌规范(产品层定);每步一句、不叠加。
- 截图是短视频的 fallback:两者字幕必须一致。

## 四、挂接点(工程侧已就位)

- Buddy 实装话术:`scripts/buddy/copy/step2a-discord.md` — 4 步各带 `[截图 N]` 锚点;素材落位后,产品层可把锚点替换为链接/路径,替换不影响话术层解析({{VAR}} 模板机制与锚点无关)。
- 真实截图/视频制作 = 内容侧执行(Tadashi 拆单时可派内容 runner);本 brief 即其输入。
