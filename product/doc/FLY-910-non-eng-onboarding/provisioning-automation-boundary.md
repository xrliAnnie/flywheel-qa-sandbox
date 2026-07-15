# FLY-910 → FLY-648 · Provisioning 自动化边界表(交 Tadashi 建底座)

Issue: FLY-910 (https://linear.app/geoforge3d/issue/FLY-910/非工程快速-onboarding-体验设计一条-command-上手后体验)
日期: 2026-07-06
基于: self-hosted-onboarding.md · exploration.md(setup-new-project.sh §8 审计)· FLY-648 EPIC(核心/项目分离 + 可移植 provisioning)

> **用途**:把「非工程自托管 onboarding 的一条 command」拆成**每步的自动化边界**,直接喂 Tadashi 的 FLY-648 底座(sub#2 可移植 provisioning + 核心/项目分离)。**部署 = B 纯自托管起步**(Annie 定)。
> **产品/UX 决策仍归 Annie**(beachhead 未定,见文末);本表是**工程边界规格**,不是已批的产品形态。

## 分类图例
- **[AUTO]** 系统全自动、用户无感(底座该做的)
- **[OAUTH]** 用户点一次授权(浏览器/device flow),**不粘 token**
- **[MANUAL]** 本质要用户亲手、无法 API 自动化 → 引导式手把手兜(见 self-hosted-onboarding.md Block③)
- **[GATE]** 运行期 founder 闸;自托管下 **founder = 客户本人**(FLY-175)

## A. 前置:账号(用户必须有/注册,一次性,external)
| 账号 | 类 | 说明 |
|---|---|---|
| Discord | [MANUAL] | 没有要注册;引导给链接 |
| Linear | [MANUAL] | Annie 要保留 Linear;客户从不打开它、纯做后台任务存储(仍需他有账号) |
| 模型(Claude 订阅/key) | [MANUAL] | 成本用户自担;引导录入 + 校验 |
| GitHub | **建议砍** | 非-eng 自托管路径**仓留本地、不接 GitHub**(少一个账号一步)→ 见决策点。保留则 [OAUTH]+[AUTO] |

## B. 一条 command 触发的 provisioning 步骤
| # | 步骤(来自 setup-new-project.sh §8) | 类 | 底座要做什么 / 留给用户什么 |
|---|---|---|---|
| 1 | 脚手架 repo/.flywheel/.lead/doc-flow | [AUTO] | 本地生成;**自托管不 push GitHub**(仓留本地) |
| 2 | GitHub 建仓 | **砍**(或 [OAUTH]+[AUTO]) | 见 A;默认跳过 |
| 3 | Linear team/labels | [OAUTH]+[AUTO] | 用户一次授权 Linear(OAuth,不粘 API key)→ 系统 API 建 team/labels;Linear 隐藏在 agent 后 |
| 4 | **Discord bot + 频道 + token** | **两条路,见 §C** | 底座把 bot-provisioning 做成**可插拔 seam**;频道 [AUTO] 建;token [AUTO/secure] 经 env/CLI,**绝不粘聊天** |
| 5 | 写 live projects.json | [AUTO] | 系统写;用户永不看 JSON |
| 6 | claude-lead.sh 生成+校验 manifest | [AUTO] | 系统代跑 |
| 7 | 装/reload 服务(launchd) | [AUTO] | **FLY-648 关键**:launchd→OS-portable service 抽象(macOS launchd / Linux systemd / WSL2);引入「机器常开」现实(见决策点) |
| 8 | 起/重启 Bridge | [AUTO] | 系统代做 |
| 9 | 健康检查 + 首次聊 | [AUTO]+🎁 | 自动 health-check;「去 Discord 跟你 Captain 打招呼」= 首个 Aha |
| 10 | 接 deploy digest hook | [AUTO]/可选 | 默认接或跳 |

## C. Discord bot 两条路(底座做成可插拔,Annie 选哪条都能撑)
| 路 | 类 | 用户体验 | tradeoff |
|---|---|---|---|
| **C1 自建 bot(max ownership)** | [MANUAL] 引导 | 用户去 Developer Portal:建 app→加 bot→Reset Token 复制→开 Message Content + Server Members intents;经 CLI 录 token→即时校验 | 步骤删不掉(Discord 无 API 代建);但最「纯自托管/客户完全拥有」;worst-case 用户卡住→Anna screen-share 陪建 |
| **C2 bot 池辅助(min friction,FLY-882「那招」)** | [OAUTH/invite] | 用户**只点一次「邀请这个 bot 进我的 server」**(invite-url),跳过整个 Developer Portal | 免手动建 bot、最顺;但 **bot 身份/token 是 Flywheel 托管的**(FLY-882 池)→ 依赖我们、不是「完全自托管/自有」。纯自托管下这其实是个**半托管让步** |

> **给 Tadashi 的底座要求**:bot-provisioning 是一个 **strategy seam**(C1 own-portal / C2 pool-invite 可切),不要写死。这样 Annie 拍 beachhead 后(完全非技术 → 可能偏 C2 省事;技术+要主权 → 偏 C1)底座都不用改。**产品默认走哪条 = Annie 定,不是工程定。**

## D. 运行期(不在一条 command 里,但底座要留)
| 动作 | 类 | 说明 |
|---|---|---|
| merge / ship / runner-lifecycle | [GATE] | 永远 founder 闸(FLY-175);自托管下 founder=客户,做成 Discord 里一键批准 |

## E. 收敛结论(一句话给 Tadashi)
自托管「一条 command」= **底座自动跑完 B 表所有 [AUTO]** + **引导用户过 3 件亲手事**(① Discord bot:C1 建 或 C2 邀请 ② 授权 Linear[OAUTH] ③ 录模型 key[MANUAL])+ **运行期客户自己 [GATE]**。GitHub 建议砍。token 全程不进聊天。bot 路做成可插拔 seam。

## F. 无法消除 / 需诚实告知(非工程边界,产品侧)
1. **建 Discord bot(走 C1 时)无法自动化**——只能引导 / worst-case 真人陪建。
2. **账号注册**(Discord/Linear/模型)——onboarding 只能给链接 + 等用户弄好。
3. **⭐ 机器 7×24 常开**——自托管模型本身的成本,provisioning 底座解不了;目标客户得有台常开机器。
4. **模型额度/成本**——用户自担。

## 锚已锁(2026-07-06,Annie)
- **beachhead = 甲**:时间紧、**有技术直觉**的经营者(非「完全非技术小白」)。→ onboarding 可假设客户有点技术底:**终端一条 command 能接受、不必极致傻瓜**,手把手按甲的水平。
- **部署 = B 纯自托管**。
- **→ Discord bot 默认走 C1(自建 / max ownership)**:甲 有技术直觉 + 选了自托管(要掌控),能在引导下自己建 bot;**C2(bot 池)留作可选省事捷径**,但默认不牺牲 ownership。底座仍做成可插拔 seam(C1/C2 可切)。

## 仍待 Annie 拍(战术,不 gate 底座)
- GitHub 砍不砍(我倾向砍)/ Linear 全隐藏可否 / 「机器常开」设不设门槛。
- 用词**已定**(Annie 2026-07-06):**Captain(=Lead)+ Crew(=Runner)**(好玩派/航海主题)。

> 本表是**工程边界规格**,让 Tadashi 现在就能把 FLY-648 底座建成「两条 bot 路(默认 C1)+ OS-portable service + token 不进聊天 + 可续传」的形状。锚已锁,底座可动工;上列战术项不 gate 底座、Annie 逐块拍完再锁产品默认文案。
