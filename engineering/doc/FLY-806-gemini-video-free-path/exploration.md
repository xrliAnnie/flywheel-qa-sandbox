# FLY-806 gemini-video 免费网页路径挂了 — 探索

Issue: FLY-806 (https://linear.app/geoforge3d/issue/FLY-806/toolingbug-gemini-video-skill-免费网页路径挂了-web-streamgenerate-稳定-400-只能退付费)
日期: 2026-07-02
基于: 无

## 1. 问题复述

`~/.claude/skills/gemini-video/generate.sh` 的 **free 路径**(Gemini web StreamGenerate)挂了。
现象:免费网页出视频用不了 → 每次都退到付费 Veo(`veo-3.1-generate-preview`,~$1.2–3.2/条),**每次烧钱**。
gemini-video 是 **global skill**,跨项目影响(不止 Sub)。

Asha 已排查:**不是 cookie 问题**(`oracle-refresh-cookies` OK、14 cookies 已存,重试仍失败),结论=免费网页端点本身变了。

## 2. 根因调查(本次实测,非推测)

我用当前 skill 的 free 路径逻辑单独复现了一次请求(fresh cookies,`~/.oracle/cookies.json` 2026-07-02 21:11 刚刷过),关键发现:

| 步骤 | 结果 |
|------|------|
| 加载 Google cookies | ✅ 14 个都在 |
| 拉 access token(`SNlM0e`/`thykhd`)| ✅ 成功(`thykhd`) |
| StreamGenerate POST（当前 skill 原样,无 query param) | **HTTP 200**,不是 400 |
| StreamGenerate POST（补 `bl`+`rt`+`_reqid` query param) | **HTTP 200** |

但 200 的响应体是一条**纯文本拒绝**:

> "Are you signed in? I can search for images, but **can't seem to create any for you right now**. It's also possible that image creation isn't available in your location yet."

**结论(推翻 issue 表述):这不是"稳定 400 / payload 坏了"这么简单。**

- 请求本身在 fresh token 下是通的(200)。Asha 看到的**间歇 400** = `at` token 与 cookie 会话不同步的次生症状(旧 token 配新 cookie → 400);但**就算修好 400,拿到的也只是一条拒绝文本,不是视频**。
- 真根因:skill 里硬编码的 model header
  `x-goog-ext-525001261-jspb: [1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4]]`
  里的 model id `9d8ca3786ebdfbea` **不再路由到能生成媒体的后端**。Gemini web 现在直接回"我搜得到图但创建不了"。这是 Google 侧的**能力网关变更**(model id 轮换 / 生成能力按账号·地区门控),不是我们 payload 写错。

### 2.1 旁证:gemini-image 早就弃用了同一条路

`~/.claude/skills/gemini-image/generate.sh` 现在的实现里**根本没有 StreamGenerate 网页路径**了——它 method 1 = Gemini CLI + nanobanana 扩展,method 2 = 直调付费 API。(SKILL 文档里"tries Oracle Gemini web (FREE) first"是**过时描述**,代码已不符。)
→ 说明"直调 Gemini web 内部 RPC 拿免费生成"这条路 **在 image 侧已经被放弃过一次**;gemini-video 是全家桶里**最后一个**还挂在这条 reverse-engineered 内部 RPC 上的 skill。

## 3. 现有代码的第二个问题:静默烧钱

`generate.sh` main 逻辑:free 路径任何失败 → **直接、静默** fallback 到付费 Veo(第 446-454 行)。
- free 路径现在**每次都失败**,所以**每次调用都在烧 Veo 钱**,且调用方(和 Annie)不一定意识到。
- 这正是 issue 里"只能退付费(烧钱)"痛点的**直接机制**。
- 另外 free 路径的拒绝检测只认 `["a lot of requests","try again","can't do that"]`,新的拒绝话术("can't create any for you at the moment")**不在里面**,所以它连"被拒绝"都没识别对,直接当"没视频"处理。

## 4. 方向选项(取舍留给 brainstorm gate 拍)

### 方向 A — 重新逆向 StreamGenerate 视频路径
找到当前正确的 video model header + payload。
- ❌ 高投入 + **本质不稳定**:model id 是 Google 内部轮换值,这次就是这么挂的,修好也只是等下次再挂。是"踩不完的跑步机"。不推荐作为主路径。

### 方向 B — claude-in-chrome 驱动真实 Gemini 网页 UI(Annie 提的备选)
不再直调内部 RPC,而是**驱动官方网页 UI**(像 deep-research skill 那样用 claude-in-chrome + Native Messaging 开真 Chrome、走真登录态)。
- ✅ **结构性稳**:用 Google 官方维护的 UI 流程,扛得住内部协议 churn;吃订阅=免费。
- ⚠️ 代价(据 deep-research skill 实证):**必须 headed Chrome + 已登录 Gemini + 交互式一次性 Connect 配对**;**每台机器串行**;视频异步(~1–2min+)要轮询 UI 取下载。→ **不是全 headless**,对 Runner/cron 无人值守场景是真约束。
- 📌 Annie 原话点名"Flavio 侧可能重做" → 这条可能是**独立 skill 工程**,不一定塞进本 bug 修复。

### 方向 C — 成本安全兜底(无论 A/B 都该做)
- 修拒绝检测 → 干净识别"free 网页路径不可用"并**明确上报**。
- 给付费 Veo fallback 加**显式 opt-in 闸**(如 `--allow-paid`,默认关):**绝不静默烧钱**。默认只报"免费路径已挂",要花钱必须调用方明确同意。
- ✅ 低风险、便宜、直接止血 issue 里的"烧钱"痛点。

## 5. 我的推荐(带 push back)

1. **立即做 C(止血)**:静默付费 fallback 是"烧钱"的直接机制,先堵住。这是本 issue 内我能低风险独立交付的最高价值部分。
2. **主路径选 B(claude-in-chrome 驱动 UI)** 作为"durable 免费路径"——因为 A 是跑步机、这次就是被它甩下来的;B 是 Annie 已经点过的方向,结构上正确。
3. **不推荐 A** 作为主路径(可留作"要是 B 太重、先临时续命"的备选,但要写明它会再挂)。

## 6. 需要 gate 拍板的开放问题(scope/架构级)

1. **代码落哪里 + PR 开在哪**:gemini-video **既不在 Flywheel repo、也不在 flyview-skills repo**,只作为本机 global skill 存在于 `~/.claude/skills/gemini-video/`。
   - (a) 只补本机 `~/.claude/skills/` 拷贝(快,但不进版本分发)?
   - (b) 借本 issue 把 gemini-video **迁进 flyview-skills**(`xrliAnnie/flywheel-skills`),走 skills-sync 正式分发(对齐 FLY-216/443/510 模式)?
   - 若走 (a)/(b),那我在 **Flywheel repo 的这条分支/PR** 就只承载**过程文档**(exploration/research/plan),代码改动的 PR 另开在对应 repo。需要确认这个拆分可接受。
2. **B 的归属**:claude-in-chrome UI 驱动是本 issue 内做,还是拆给"Flavio"独立 skill issue?本 issue 内先只交付 C(止血)+ 写清 B 的 plan?
3. **止血默认行为**:free 挂了之后,默认应该是"**直接失败并提示**"(最省钱)还是"**保留付费但要 `--allow-paid`**"?我倾向前者更安全,但想确认 Annie 对"完全不自动花钱"的接受度。
