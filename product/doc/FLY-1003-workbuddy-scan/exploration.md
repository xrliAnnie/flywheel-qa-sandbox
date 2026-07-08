# FLY-1003 WorkBuddy 竞品分析 — 探索

Issue: FLY-1003 (https://linear.app/geoforge3d/issue/FLY-1003/workbuddy-竞品分析-腾讯-workbuddy-vs-flywheel-competitor-scan)
日期: 2026-07-08
基于: 无(本 issue 第一份文档);上游参照 = `product/doc/FLY-909-competitor-scan/competitor-scan.md` + `matrix-deepdive.md` + `product/doc/FLY-911-product-positioning/positioning.md`

---

## 这是什么活

Annie(2026-07-08)让研究腾讯 **WorkBuddy** —— 又一个竞品,跟 Raft(FLY-1001)/ Matrix 同一套竞品分析打法。**产出折进 FLY-909 competitor-scan**(进对比表 + 差异化每轴标 vs WorkBuddy)+ 对 **FLY-911 定位**的影响评估。**诚实结论,不美化,UNKNOWN 标清。** PM 验收 = 未来 FLY-830,现在不做。

这是**竞品情报/文档活**,不碰技术实现。对比基线 = Flywheel 现有形态 + FLY-911 已收敛定位。

## WorkBuddy 已知(quick scan + 已初步 WebSearch 核实)

- **WorkBuddy = 腾讯云 AI Agent 办公工作台**(`copilot.tencent.com/work` / `codebuddy.cn/work`)。与腾讯此前的 AI 编程工具 **CodeBuddy 同一套 agent 架构** —— 腾讯从「服务开发者」向「服务全职场人」的战略延伸。
- **多 agent**:把高层请求拆成子任务并行跑;**Expert Teams** = 一个 lead agent 协调多个 sub-agent(一个调研 / 一个写代码 / 一个写文档)。**100+ 内置专家角色**(市场 / 工程 / 游戏 / 财务…,当同事叫)。
- **20+ skill 包 + MCP**:连 GitHub/GitLab/Jira/Confluence/Google Drive/Gmail/Notion/Slack。多模型切换(混元 / DeepSeek / GLM / Kimi / MiniMax)。
- **跑法**:桌面 agent(直接读本地文件、sandbox 隔离执行)+ 通过 WhatsApp / 微信 / Discord / Slack / Telegram 当 bot 用。
- **时间线**:2026-01 内测 → 2026-03-09 国内全量上线 → 2026-05-29 面向全球用户上线(TechNode)。有 **Enterprise Edition + Agent Suite**(企业 AI team)。被称「China's #1 PC-based productivity AI agent」。
- TechNode 定性:**"OpenClaw-like workplace AI agent"**。**大厂(腾讯)竞品、Flywheel 形态高度相邻。**

## 为什么这家值得挖(初判)

1. **组织形态撞车**:「lead agent 协调 sub-agent 团队」+「100+ 专家当同事」几乎就是 Flywheel 的 CoS→Lead→Runner 分层,跟 Matrix 一样是「你指挥一支 AI 队」。
2. **两条我们的「候选差异」它正面覆盖**:
   - **供应商中立 / 多模型**:WorkBuddy 原生切混元/DeepSeek/GLM/Kimi/MiniMax —— 这条我们本来当「第一方厂商结构上不做」的差异候选,腾讯(非模型第一方、云厂商中立立场)恰恰做了。**必须诚实重估这条还成不成立。**
   - **手机 IM 驱动**:它也能通过微信/WhatsApp/Discord 当 bot 用 —— 我们的「手机原生 IM」界面赌注也不再独有。
3. **大厂体量**:腾讯的分发/资源/生态(微信)是 Matrix/Paperclip/OpenClaw 那种早期团队没有的,威胁量级不同 —— 但要看它 target 是不是我们那群(非技术 OPC operator)。

## 要回答的问题(对齐 issue 的研究重点)

1. **WorkBuddy 具体是什么** —— 产品形态、目标客户、核心机制、腾讯的定位。
2. **它 vs Flywheel** —— 功能 / 定位 / 目标客户撞在哪、哪里正面竞争;它是「大厂做办公 agent」、我们是「非技术 OPC operator 的自治软件公司」,差异在哪(诚实收窄)。
3. **对 FLY-911 定位有没有影响、要不要调** —— 尤其「供应商中立」「手机 IM」两条候选差异被腾讯覆盖后怎么重估。

## 口径(继承 FLY-909 / FLY-911,不破)

- **定位大结论归 FLY-911 跟 Annie 拍,本文不硬下** —— 差异写成「候选 / 待 911」。本文是喂料。
- **诚实、别护短、别 overclaim**:UNKNOWN 标清(官网常挡爬,标 ⚠️ 建议 Deep Research 复核);别把腾讯官方宣称当既成事实。
- **验证 Annie 假设别替她下结论**:她的假设(大厂做办公 agent、跟我们相邻)哪里对哪里不对,分开说。

## 产出(交付形态,同 matrix/paperclip 打法)

1. `product/doc/FLY-909-competitor-scan/workbuddy-deepdive.md` —— 逐家深挖(同 matrix-deepdive.md 模板:一句话定位 / 目标用户 / 产品形态 / 背景 / 亮点 / 软肋 / 跟 Flywheel 像谁不一样对比表 / 值得借鉴 / 一句话差异化候选)。放 FLY-909 文件夹,跟其他 deepdive 并列。
2. 编辑 `product/doc/FLY-909-competitor-scan/competitor-scan.md` —— 横切表 A 加 WorkBuddy 一行 + 差异化每轴(领域 / 常驻组织 / 手机 IM / 供应商中立 / done-for-you)标 vs WorkBuddy。
3. **FLY-911 影响评估**(本 issue 的 research.md / plan.md 里给出结论,并视结论轻改 positioning.md 的竞品表 + 诚实边界)—— 尤其供应商中立 & 手机 IM 两条候选被腾讯覆盖后的重估。

## 方法

- WebSearch 刷新(已起步)+ WebFetch 官网/评测 + 视需要 ChatGPT Deep Research(Annie 已通用授权)复核官网挡爬的点。
- competitive-analysis skill(April Dunford:先定义替代品)。
- 中文。no-three-stage 单会话。
