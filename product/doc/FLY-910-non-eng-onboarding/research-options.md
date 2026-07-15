# FLY-910 非工程 onboarding — research / options(6 块腿活,交 Honey Lemon 逐块带 Annie)

Issue: FLY-910 (https://linear.app/geoforge3d/issue/FLY-910/非工程快速-onboarding-体验设计一条-command-上手后体验)
日期: 2026-07-06
基于: exploration.md(现状痛点审计,底料)· brainstorm-prep.md · FLY-912 Hooves&Paws synthesis · 2026 web 研究

> **不是 PRD、不是深设计。** 是 6 块有证据的 research/options,每块给我的**推荐 + 留给 Annie 的决策点**。Honey Lemon 逐块带 Annie 对。研究口径:block 4 用 web 研究打底(非完整 ChatGPT Deep Research),任一块 Annie 想更深我再上 deep-research。

---

## Block 1 · 首次产出具体长啥样(依据 Hooves & Paws)

**依据**:FLY-912 synthesis(Anna Session-1)。三条对首次产出最关键:
- 楔子 = **可信跨系统可见性 / 根因诊断**,不是「替你建个 app」;Flywheel 给的是**能力/系统让客户自己立起来**。
- 价值的底层货币 = **钱 / 风险可见性**(干净 P&L、不静默漏单),不是「dashboard 数量」。
- 客户的三个痛(同一母 job 三面):T1 未知风险可见(静默失败,客户排第一)· T2 跨系统根因诊断(最高频)· T3 成本/利润可见(价值锚)。

**我推断的首次产出 Aha(能力级 + 具体样例):**
- **通用表述**:「你用大白话描述想要啥 → 你**新建的那个 department**在 Discord 里,真的做了一件你日常要跨好几个系统才能搞定的事 → 把**结果**直接甩回给你。」Aha 不是「装好了」,是「**它替我干成了一件我本来要当侦探才能弄的事**」。
- **Hooves&Paws 具体落点(只当样例,不承诺给他们定制)**:一个「订单诊断/可见性」department,在 Discord 回答「**这单为什么卡**」——它去串平时要翻 4 个系统(Veeqo/Ordoro/KV log/发票)的信号,给出一个「为什么」的答案;或一次「把 dropship 成本接回订单」的干净 P&L 拉取。产出形态 = **Discord 里一条可信的答案/结果**,不是一个静态 app。

**⭐ 我必须上报的张力(请 Annie 拍)**:第一个真实客户**比「非工程」假设更技术**——他们自建过工具,缺的是时间/注意力 + 「造对那一半」。synthesis 的建议画像是「**没空当技术侦探的经营者**」,不是「完全不会技术的小白」。
→ **决策点**:onboarding 的目标用户,是显式选「**有技术直觉、缺时间的经营者**」,还是坚持「完全非技术」?这直接决定 onboarding 要多少手把手、终端一条 command 是否可接受(对前者完全 OK,对后者可能仍嫌硬)。**我倾向前者**,因为第一个真实证据、且与 FLY-909 竞品开放问题合流。

---

## Block 2 · Lead/Runner 换更好懂的词(候选 + 利弊)

> **✅ 已定(Annie,2026-07-06):Captain(=内部 Lead)+ Crew(=内部 Runner)** —— 好玩派/航海主题(Annie taste 拍;超出我原候选 A–D,她自创)。下方候选分析留作决策记录。过度信任提醒(说成「AI 员工」少抓 18% 错)仍适用:文案保留「你审批」暗示。

**为什么该换**:①对非技术用户,"Lead/Runner" 是内部黑话;②行业已成熟用「**团队/雇佣/员工**」隐喻(把 agent 当 teammate/employee/你"雇"的人),非技术人一听就懂;③**且与 Annie 锁的定位「帮他们搭一个 AI 公司 / 建 department」高度自洽** —— 公司/部门/经理/员工是同一套隐喻。
**⚠️ 一个反面证据(影响用词分寸)**:研究显示把产出说成 "AI employee" 时,人会**少抓 18% 的错**(过度信任)。→ 用词要保留「**你来拍板/审批**」的暗示,别把 agent 说得像全权同事;这也正好呼应 Flywheel 的 founder-gated。

| 候选(Lead → / Runner →) | 优 | 劣 |
|---|---|---|
| **A. 经理 Manager / 员工 Employee** | 最直觉、最贴「搭 AI 公司」;人人懂 | "employee" 过度拟人 → 过度信任风险(见上);需靠 UI 保留审批感 |
| **B. 经理 Manager / 专员 Specialist(IC)** | 保留「经理带做事的人」结构;"专员" 比 "员工" 少一点拟人、多一点"工具人"感 | "专员" 稍正式;非技术人可能没 "IC" 概念(但"专员"能懂) |
| **C. 主管 / 做事的人(doer)** | 极白话 | 不够产品化、不够体面 |
| **D. 保留组织隐喻整套:部门 Department · 经理 Manager · 组员 Worker** | 和「建 department」定位逐词咬合;可扩展(一个部门多 worker) | 词多,onboarding 要一次讲清层级 |

**我的推荐**:**B(经理 Manager / 专员 Specialist)**,并在 department 语境下用 D 的「部门」当容器 —— 即「你建一个**部门**,里面有一个**经理**帮你把关、几个**专员**干活」。技术映射:Manager≈现在的 Lead、Specialist≈Runner。保留「重要动作你审批」的措辞压过度信任。**留给 Annie**:她要不要「员工」这种更亲的词 vs 「专员」这种更"工具"的词?这是 taste,她定。

---

## Block 3 · 10 步 founder cutover 逐条判(能自动化 / 必须留 founder 闸)

来源 = `setup-new-project.sh` §8。原则:token 签发/授权、merge、ship、runner-lifecycle **永远 founder-gated**(FLY-175);但「founder-gated」应收敛成**一次 OAuth 授权点一下**,而不是「手动编辑配置」。

| # | 步骤 | 判定 | 怎么做无痛 |
|---|------|------|-----------|
| 1 | commit+push 脚手架 | ✅ 全自动 | 系统代跑 |
| 2 | gh 建仓 + push | 🟡 半自动 | 一次 GitHub OAuth 授权 → 系统用 API 建仓(cloud 模式下平台代持) |
| 3 | Linear 建 team/labels | ✅ 可自动 | Linear API 用 token 直接 provision |
| 4 | **建 Discord bot + 频道 + token 塞 .env** ← 最痛 | 🟡 半自动(关键) | **不让客户碰 Developer Portal / 不粘 token**:用**预建 bot 池(FLY-882 已有)** 或多租户 bot;客户只做**一次「授权 bot 进我的 server」**;token 全程 server 侧,绝不经客户手 |
| 5 | 手改 live projects.json | ✅ 全自动 | 系统写,客户永不看 JSON |
| 6 | 跑 claude-lead.sh 生成 manifest | ✅ 全自动 | 系统代跑 + 校验 |
| 7 | 装/reload launchd plist | ✅ 自动(自托管)/ N/A(云托管平台代跑) | 视部署模型(Block 5) |
| 8 | 重启 Bridge | ✅ 全自动 | 系统代做 |
| 9 | 验证上线 + 真 founder 聊一次 | ✅ 自动健康检查 + 🎁 做成 Aha | 自动 health-check;把「跟你的经理打个招呼」做成引导式首次体验 |
| 10 | 接 deploy digest hook | ✅ 自动/可选 | 默认接上或跳过 |

**必须留 founder 的(但都收敛成"点一下授权/审批",非手动配置)**:第 2/4(+ Linear)的**第三方授权** = 客户一次 OAuth/authorize 点击(不是粘 token);以及**运行期**的 merge / ship / runner-lifecycle 审批(FLY-175 现成)。
**结论**:那张「手动搞一天」的 10 步,**几乎全可自动化**;真正留给人的 = **几次 OAuth 授权点击 + 运行期的批准**。「搞一天」→「点几下授权」。

---

## Block 4 · OpenClaw + 「一条 command onboarding」怎么把 provisioning 做无痛

**OpenClaw(Annie 说的 OpenCloud;且 Flywheel 的 Bridge 本就是 OpenClaw 血统)**:一行安装脚本 → `openclaw onboard --install-daemon` 一个引导式 wizard,自动化 auth / gateway 配置 / channel 注册 / workspace 默认值,连 Discord/Telegram/WhatsApp 等,几分钟能聊上。**这就是 Annie 要的「一条 command 装完即用」的活参照。**
**同类无痛 provisioning 的通用套路(Supabase CLI / Vercel / Railway / Tailscale 都这样)**:
- CLI 触发**浏览器 OAuth 握手**拿第三方授权 —— **绝不让用户手动粘 token**;
- 合理默认值 + 引导式一问一答(不是表单);
- provisioning 全走 provider API;
- 结尾**健康检查**给确定性("一切就绪");装 daemon 常驻。

**套到 Flywheel(把 Block 3 那 10 步包成一条 `flywheel onboard` wizard)**:
`一条 command` → 检测/装依赖 → **开浏览器让客户授权 Discord / GitHub / Linear(点一下,不粘 token)** → 用 API(或 bot 池)provision team/labels/bot/config → 起服务 → 健康检查 → **「去 Discord 跟你的经理打个招呼」**。全程客户只:跑一条命令 + 点几下授权 + 描述想要啥。

**决策点(留 Annie)**:入口她说终端一条 command 可接受 —— 那第一版就照 OpenClaw wizard 形态做;要不要**同时**留一个「Discord 邀请进来后纯对话引导、连命令都不用敲」的更软入口(见 Block 6)?

---

## Block 5 · 部署模型三选 tradeoff(云托管 / 自托管 / 混合)

> **已定(Annie,2026-07-06):部署模型 = B 纯自托管起步;云托管 A/C 推到未来。** 下表保留作决策记录;无痛自托管的深挖见同文件夹 `self-hosted-onboarding.md`。

| 维度 | 云托管(我们跑) | 自托管(客户跑) | 混合(控制面我们跑·数据/工具在客户侧) |
|---|---|---|---|
| onboarding 体验 | 🟢 最顺(平台代跑 launchd/Bridge/服务) | 🔴 最硬(客户要有台**常开机器**跑 tmux/launchd) | 🟡 中(控制面免装,连接需授权) |
| time-to-value | 🟢 最快(研究:云比自托管快~70%) | 🔴 慢 | 🟡 中 |
| 成本 | 🟡 我们扛托管成本、随规模涨 | 🟢 客户侧硬件、但 TCO 更高/更不可预测 | 🟡 折中 |
| 数据所有权/local-ownership | 🔴 数据在我们托管 | 🟢 完全客户掌控(合规/主权友好) | 🟢 关键数据留客户侧 |
| 维护负担 | 🟢 我们担 | 🔴 客户担 | 🟡 分担 |
| 适配"非技术/缺时间"客户 | 🟢 强 | 🔴 弱(现实上不可行) | 🟡 中 |

**关键现实**:Flywheel 现在**深度本地**(跑在 founder 的 Mac 上、cmux/tmux/launchd)。让一个非技术 SMB **自托管** = 他得有台机器 7×24 常开 —— 对目标客户基本不现实。研究也指:<50 人、无 IT 的团队,**云托管几乎总是对的**,除非合规逼自托管;混合是 2026 主流(~70%)。
**⭐ 战略岔口(必须 Annie 拍,别我替她定)**:云托管/混合对 onboarding 友好得多,但**和「你自己拥有/本地运行」的定位相冲**,且是一大块基建投入(把本地架构搬上云)。Annie 之前重视 local/ownership —— 这条和「非技术能上手」在部署层**直接打架**。**我的判断**:对非技术目标客户,**云托管或混合**才可能有真·无痛 onboarding;自托管留给"技术+要主权"的客户当高级选项。但这是定位取舍,交她。

---

## Block 6 · 获客渠道 options(网站 vs Discord 邀请)

**研究**:社群驱动增长强(有社群的公司营收快 2.1×、CLTV 高 46%);但 Discord「对技术产品好、但**搭建/管理成本高**」;2026 主流是 **Product-Led Sales + 混合**(自助获取 + 销售扩张);**技术买家**泡在 Discord,但**非技术 SMB 老板不泡开发者 Discord**。

| option | 优 | 劣 | 适配度 |
|---|---|---|---|
| A 网站优先(营销站 → 引导注册 → 引进 Discord) | 触达非技术 SMB 摩擦最低;可讲结果价值主张 | 要做站 + 内容 | 🟢 高(非技术受众不在 dev Discord) |
| B Discord 邀请优先(Anna 触达 / 邀请链接) | 贴现有 Anna 采访 concierge 打法;零建站 | 非技术老板不主动来 Discord;规模化难 | 🟡 早期 concierge OK |
| C 混合 + concierge(早期 Anna 人肉带 · 网站做规模) | 早期高价值样本用人肉、规模用站 | 两条腿都要投 | 🟢 阶段化最稳 |

**我的推荐**:阶段化 **C** —— 早期(现在)= **Anna concierge 触达 + 人肉带 onboard**(和 minimalist-entrepreneur 的 manual-first 一致,先跑通再自动化);中期 = **网站当正门**(结果型价值主张 → 引导 → 进 Discord 用产品)。**Discord 是产品发生地,不是获客发生地**。留 Annie:早期要不要就锁定 Anna concierge、暂不建站?

---

## 汇总:给 Annie 的关键决策点(逐块已标,集中列)
1. **目标客户画像**:显式选「有技术直觉、缺时间的经营者」还是「完全非技术」?(Block 1)—— 卡住 onboarding 手把手程度。
2. **部署模型**:云托管/混合/自托管?(Block 5)—— 和 local/ownership 定位直接打架,战略级。
3. **角色用词**:经理/专员 vs 经理/员工?(Block 2)—— taste。
4. **入口软硬**:只终端一条 command,还是加 Discord 纯对话软入口?(Block 4)
5. **获客**:早期锁 Anna concierge 还是同时起网站?(Block 6)

> 我不写 PRD。等 Honey Lemon 把这几块带 Annie 拍完,我按结论逐块深钻到「能交 Tadashi」的颗粒度。
