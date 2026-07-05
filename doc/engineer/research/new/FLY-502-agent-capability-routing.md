# Research: Claude / Codex / Gemini(agy) / Kimi 多 agent 能力对比 + agy quota + coding-agent 扫描 → agent-routing 决策 — FLY-502

**Issue**: FLY-502
**Date**: 2026-06-22
**Source**: brainstorm gate (Tadashi approved, exec d3532a6c) + Annie 补充 (Deep Think/3D, FLY-451) + **v2 扩展 (Tadashi 指令 678f4bb7: 加 Kimi + 市面 coding agent 扫描 + Deep Think API 计价)**
**Status**: Complete (v2)

> 数据为 WebSearch/WebFetch 实时拉取(知识截止 2026-01,quota/价格/最新能力已查证)。来源见文末。
> 交付物 = 同目录 `FLY-502-agent-routing.html`(founder-facing 互动 HTML)。本文 = source-of-truth 分析。

---

## 1. 背景与目标

Annie 要的 system = 把不同 agent **有机结合、每个 task 派给最适合的 agent**。Flywheel 已支持
Claude / Codex / **agy(Antigravity)** 作 Runner backend(FLY-493 agy 上线),**Kimi Code 在接(FLY-494)**。
本研究给「哪类活路由到哪个 backend」提供决策依据,并回答 Annie 个人问题:**主要用 agy 做生图 +
视频分析,免费档够不够、不够升哪档**;**agy 能不能用 Gemini 3 Deep Think 做 3D 建模**(FLY-451);
**v2 新增**:Kimi 进对比、市面其它 coding agent 谁能当 backend、Deep Think 走 API 多少钱。

四个 backend 的「头牌模型」(对比基准):

| Backend | CLI | 默认/头牌模型 | 备选模型(同 CLI 内) | Flywheel 状态 |
|---|---|---|---|---|
| **Claude** | Claude Code | Claude **Opus 4.8**(1M ctx 变体) | Sonnet 4.x / Haiku 4.5 | 生产默认 |
| **Codex** | OpenAI Codex | **GPT-5.5** / GPT-5.3-Codex | GPT-5.4 | 已支持 |
| **agy** | Antigravity CLI(Go binary) | **Gemini 3.1 Pro** | Gemini 3.5 Flash / Claude Sonnet·Opus 4.6 / GPT-OSS 120B | FLY-493 上线 |
| **Kimi** | Kimi Code CLI(TS,MIT 开源) | **Kimi K2.7-Code** | (开源 open-weight,可自托管) | FLY-494 在接 |

---

## 2. 能力对比(各维度谁强谁弱)

> 评级口径:🟢 该维度最强 / 🟡 强但非第一 / ⚪ 可用但明显弱 / ❓ 缺独立验证。比较的是各家头牌模型。

| 维度 | Claude · Opus 4.8 | Codex · GPT-5.x | agy · Gemini 3.1 Pro | Kimi · K2.7-Code | 谁强 |
|---|---|---|---|---|---|
| **编码 · SWE-bench Verified** | 🟢 88.6% | 🟡 80.0% | 🟡 80.6% | ❓ 无独立数 | **Claude** |
| **编码 · SWE-bench Pro(最难)** | 🟢 69.2% | 🟡 56.8% | ⚪ 46–54% | ❓ vendor 58.6*(无第三方) | **Claude** |
| **agentic / 工具编排** | 🟢 最成熟(parallel-subagent) | 🟡 native computer-use | 🟡 Claude-Code-class | 🟡 coder/explore/plan + ACP | Claude |
| **视觉 / 图像理解** | 🟡 强 | 🟡 强 + computer-use | 🟢 vision frontier | 🟡 多模态(MoonViT-3D) | **agy** |
| **视频分析 ⭐** | ⚪ 仅抽帧 | ⚪ 弱 | 🟢 Video-MMMU 榜首 | 🟢 **video-in-context**(MoonViT-3D,coding 循环内) | **agy / Kimi** |
| **生图** | ⚪ 无原生 | 🟡 GPT Image 2 ~3s | 🟢 Nano Banana Pro 4K | ⚪ 无原生(coding 模型) | agy / Codex |
| **大上下文** | 🟡 200K / 1M 变体 | 🟡 数十万 | 🟢 1M 多模态 | 🟡 256K | agy |
| **推理** | 🟢 GPQA 93.6 / 对齐最佳 | 🟡 强 agentic | 🟡 强 + Deep Think 档 | 🟡 coding 优化(省 30% think token) | Claude |
| **工具 / 生态** | 🟢 MCP/subagent/hooks/skills/Agent Team | 🟡 ChatGPT 生态 | 🟡 mirror Claude Code | 🟡 **OpenAI+Anthropic 双兼容 API** + MCP + ACP | Claude |
| **成本** | API $5/$25;Pro $20/Max $100–200 | API $1.75–5/$14–30;Plus $20/Pro $100 | API $2/$12;Free/$20/$100/$200 | 🟢 **API $0.95/$4(cache $0.19);open-weight 可自托管** | **Kimi(最便宜)** |
| **速度** | fast 2.5× | 少 token→更快 | Flash 极快 / Pro 中 | 快(省 think token) | 看任务 |

**一句话总结**:
- **Claude = 编码 + agentic 最强**(尤其最难档)+ 对齐最稳;Flywheel 生产默认。
- **Codex = 编码极接近、最便宜顶级编码器(5.3)、computer-use、生图快**。
- **agy(Gemini) = 多模态之王**:视频/视觉/生图/最大多模态上下文;编码够用但最难档落后。
- **Kimi(K2.7-Code) = 最便宜 + 开源(可自托管)+ video-in-context + OpenAI/Anthropic 双兼容(最易接 backend)**;但**编码 benchmark 只有 vendor 自报、无独立第三方验证**——能力待真实验证。

> `*` Kimi vendor 自报 SWE-bench Pro 58.6(声称高于 Opus 4.6 / GPT-5.4),但截至 2026-06-12 **无独立第三方公开榜验证**——决策时把它当「待验证」,不当已证实。

---

## 2.5 市面其它 coding agent 扫描(能不能当 Flywheel runner backend)

> **Flywheel backend 过滤器** = ① headless/CLI agentic(非纯 IDE)② tmux 可驱动 ③ 可插模型 / 程序化驱动面。
> 行业现状:65% 工程师**每天用 2 个** coding agent(不是 1 个)——多 backend 本就是常态。

| Agent | 形态 | 关键差异 | 能当 Flywheel backend? |
|---|---|---|---|
| **OpenCode** | 终端原生(似 Claude Code,MIT) | 75+ provider、LSP、隐私优先、免费(只付模型 token);可选 hosted gateway($20/$100/$200) | ✅ **强候选**——Claude-Code-shaped、model-agnostic |
| **Cline** | VS Code/JetBrains 扩展 **+ CLI** | 开源 Apache-2.0、Plan/Act 审批、任意 OpenAI 兼容 + 本地(Ollama) | ✅ 可(有 CLI、model-agnostic) |
| **Gemini CLI** | 终端 | Google 官方,已并入 Antigravity | ✅ ≈agy 路径(已覆盖) |
| **Goose** | 终端 agent(开源,Block) | 可插模型、扩展 | ✅ 可(CLI) |
| **Aider** | git-native CLI | 每次编辑=commit、开源免费、pioneer | △ 可,但 **2026-05 后停更**、未跟进前沿模型 |
| **Amp**(Sourcegraph) | agentic + 代码搜索 | 语义代码图跨仓、token 不限量 | △ 有 CLI/可探,偏自家平台 |
| **Devin**(Cognition) | **托管云自治平台** | 隔离云 VM、并行 Managed Devins、自动开 PR、67% PR merge 率、写 89% 自己 commit | ✗ 托管云(非本地 CLI;支持 ACP 可远程驱动) |
| **Cursor** | AI-native IDE | UX 标杆、Composer 多文件、$20 Pro | ✗ IDE,非 headless |
| **Windsurf** | VS Code fork | Cascade 多文件、并行 agent、$15 Pro | ✗ IDE |
| **Cody / Continue** | IDE 助手 / 扩展 | inline 补全 / autopilot;Cody 焦点被 Amp 取代 | ✗ IDE 内 |

**结论**:Flywheel 现有四后端(Claude/Codex/agy/Kimi)已覆盖前沿;**真正值得追加评估的 backend = OpenCode**
(MIT、Claude-Code-shaped、任意模型——最契合 agent-agnostic 策略),其次 Cline / Goose。
**IDE(Cursor/Windsurf)与托管平台(Devin)不契合 headless-runner 模型**,不作为 backend 候选(可作 Annie 个人开发工具)。
参考基准:Terminal-Bench agent 榜 Codex CLI(GPT-5.5)83.4% 第一、Claude Code(Opus 4.8)78.9% 第二。

---

## 3. agy / Gemini quota & tiers

> Antigravity 自上线后多次砍免费额度、又在付费用户抗议后把付费档涨了 9×。以下为 2026-06 现状。

| Tier | 价格/月 | 可用模型 | 额度 | 备注 |
|---|---|---|---|---|
| **Free** | $0 | **仅 Flash**(Gemini Pro 自 **2026-03-25** 起付费独占) | **~20 req/天**(Dec'25 由 250 砍下)+ 5h 刷新 + 周上限 | 多人报 lockout |
| **AI Pro** | $20 | 全模型(含 **Gemini 3.1 Pro + Nano Banana Pro**) | 比 Free 高(credit 量未公开) | 重度用户报 7–10 天 lockout |
| **AI Ultra** | $100(2026-06 新档,原 $249.99) | 全模型 + **Deep Think** + 25,000 credits/月 | ~**5× Pro** 额度 | I/O 2026 降价后入门档 |
| **AI Ultra Max** | $200(原 $250) | 全模型 + **Deep Think** + 最高额度 | ~**20× Pro** 额度 | 最高档 |

> Credit→token 换算率、各模型 credit 单价 **官方均未公开**,精确用量无法预测。

**API 价(参考,/1M token):** Claude Opus 4.8 $5/$25;GPT-5.3-Codex $1.75/$14;Gemini 3.1 Pro $2/$12(≤200K)、$4/$18(>200K);**Kimi K2.7-Code $0.95/$4(cache hit $0.19)**。

### ⭐ Annie 的问题:agy 做生图 + 视频分析,够不够?

- **免费档 NOT 够**:她要的 Gemini 3.1 Pro 自 2026-03-25 起免费档拿不到(只剩 Flash + ~20 req/天 + lockout)。
- **最低 = AI Pro $20/mo**(解锁 Gemini 3.1 Pro + Nano Banana Pro);重度日常 → AI Ultra $100(5×)/ Ultra Max $200(20×)。
- **省钱替代**:`codex-image`(gpt-image,ChatGPT Plus 免费额度、~3s)兜大量生图;`gemini-image`/`gemini-video` 直打 Gemini。**agy 不可替代价值 = 视频分析 + 集成 IDE**。

---

## 4. Gemini 3 Deep Think + agy + 3D 建模(FLY-451)+ Deep Think API 计价(v2)

**Deep Think 是什么**:最大并行推理("System 2",同时探索多假设),建在 Gemini 3.1 Pro 之上。
HLE 41.0%、ARC-AGI-2 45.1%、IMO/ICPC/物理化学奥赛金牌级。每次查询要**几分钟**。

**3D 建模 / 3D 打印(FLY-451)**:2026-02 升级后能**读手绘工程草图 → 验证结构完整性 → 实时导出可制造 3D 模型**;
算载荷路径、建议材料厚度、为 SLA/SLS 优化拓扑——直接对口 GeoForge3D。

**agy 能用 Deep Think 吗?→ 当前 NO**:`agy models` = Flash / 3.1 Pro / Claude 4.6 / GPT-OSS,**无 Deep Think slug**。
agy 天花板 = gemini-3.1-pro 标准模式。Deep Think 锁在 Gemini app(Ultra)+ 限量 API。

### Deep Think 走 API 多少钱?(Annie v2 问)

- **没有独立的 per-token「Deep Think」公开 SKU**。它按 **Gemini 3.1 Pro token 计价**:$2/M input(≤200K)、$12/M output;>200K 翻倍 $4/$18。
- **但 Deep Think 把内部 thinking token 当 output 计费**,且做海量并行推理 → **单次查询的(计费)output token 数远高于普通 3.1 Pro**,实际单次成本被放大数倍,且每次要几分钟。
- **接入路径**:① 消费端 = AI Ultra 订阅($99.99 入门 / $200 顶配,含 Deep Think + 25,000 credits/月)——**最稳、Annie 该走这条**;② 开发端 = Gemini API via Google Cloud,**早期访问**(限研究/企业),按上面 token 价计但 thinking-token 放大成本。
- **结论给 Annie**:要「Gemini 做 3D 打印模型」,走 **Gemini app + AI Ultra($99.99 起)** 最直接;纯 API 既要早期访问资格、单次又因 thinking-token 计费而贵,**不建议为 3D 自己接 API**。

---

## 5. Routing 推荐(task type → backend)

| Task 类型 | 推荐 backend | 理由 |
|---|---|---|
| 复杂 / 多仓 / 最难编码 | **Claude** | SWE-bench Pro 69.2% 领先;parallel-subagent |
| 一般 / 省成本编码 | **Codex**(5.3-Codex) | 80% Verified、$1.75/$14、computer-use |
| **最省钱 / 开源可自托管编码** | **Kimi** 或 **OpenCode** | Kimi $0.95/$4 + open-weight;OpenCode MIT 任意模型 |
| **视频分析 / video-in-context** | **agy(Gemini)** 或 **Kimi** | agy 视频理解最强;Kimi 把原片入 coding 循环 |
| 生图 · 品牌一致/4K | **agy(Nano Banana Pro)** | 原生 16:9 至 4K、14 参考图一致性 |
| 生图 · UI mockup/快 | **Codex(gpt-image-2)** | ~3s、密集排版、ChatGPT Plus 免费额度 |
| 屏幕/文档/空间视觉 | **agy(Gemini)** | vision frontier |
| 超长多模态上下文 | **agy(Gemini)** | 1M 多模态 |
| 最难推理 / 对齐敏感 | **Claude** | GPQA 93.6、对齐最佳 |
| 草图→3D 打印模型 | **Gemini app Deep Think(Ultra $99.99起)** | 非 agy CLI;非自接 API(thinking-token 贵) |
| Flywheel 生产 Runner 默认 | **Claude** | 最成熟 agentic + Agent Team transport |

---

## Sources
- Antigravity pricing/quota: vibecoding.app, antigravity.google/blog/changes-to-antigravity-plans, androidheadlines(9×), antigravity.im/limits
- Gemini 3 Pro + Deep Think: blog.google(vision/video + deep-think), deepmind.google/models/gemini/deep-think, ai.google.dev/gemini-api/docs(pricing/thinking), eesel.ai(gemini-3 pricing), finout.io
- Deep Think 3D: business-standard.com(草图→3D), digitaltrends.com + creati.ai(SLA/SLS·载荷·材料), chromeunboxed.com
- Claude Opus 4.8: llm-stats.com, finout.io, vellum.ai, truefoundry
- Codex/GPT-5.x: developers.openai.com/codex/pricing, morphllm.com, openai.com/index/introducing-gpt-5-5
- Kimi K2.7-Code: openrouter.ai/moonshotai/kimi-k2.7-code, vm0.ai, kimi.com/resources, vals.ai, cometapi.com + FLY-492 研究(video-in-context / ACP / OpenAI·Anthropic 兼容)
- Coding-agent 扫描: morphllm.com/ai-coding-agent + best-ai-coding-agents-2026, artificialanalysis.ai/agents/coding, dev.to(every-ai-coding-cli-2026), augmentcode.com(devin-alternatives), github/bradAGI/awesome-cli-coding-agents, env.dev/ai/opencode
- 生图对比: 2slides.com, xda-developers, getimg.ai
- 编码 benchmark: morphllm.com/swe-bench-pro, vals.ai/benchmarks/swebench
