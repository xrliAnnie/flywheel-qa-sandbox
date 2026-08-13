# FLY-806 gemini-video 免费网页路径 — 调研

Issue: FLY-806 (https://linear.app/geoforge3d/issue/FLY-806/toolingbug-gemini-video-skill-免费网页路径挂了-web-streamgenerate-稳定-400-只能退付费)
日期: 2026-07-02
基于: exploration.md

> Gate 已拍板(flywheel-eng-lead / Annie):落地迁 flyview-skills;主路径=B(claude-in-chrome 驱动 Gemini 网页 UI),A 不做;免费-only、删付费 Veo fallback;skill 改名 **Gemini Free Video Creation**;plan-first + Codex design review、不自 ship。本调研为 plan 做技术支撑。

## 1. claude-in-chrome 驱动机制(参照 deep-research skill 实证)

flyview-skills 已有 `skills/generic/deep-research/` 作为「skill 驱动真实网页 UI」的成熟范式,直接复用它的结构与踩坑:

- **驱动方式**:skill = 一份 **SKILL.md 指令**,让 **agent** 用 `mcp__claude-in-chrome__*` 工具集(`navigate` / `computer`(点击/输入)/ `read_page` / `get_page_text` / `javascript_tool`)开真 Chrome、走真登录态。**不是** headless 脚本、**不是** raw CDP、**不是** 直调内部 RPC。
- **连接模型**:claude-in-chrome 经 "Claude for Chrome" 扩展 + Chrome Native Messaging 配对到 Claude 账号。
- **两道硬门(deep-research 4 轮 QA 血泪,直接继承)**:
  1. **必须 headed + 已配对 Chrome**。headless(`--headless=new`)下合成输入进不了跨域 OOPIF;且配对是**交互式一次性 Connect**(有人点 Connect / `claude --chrome`)→ **不是全无人值守 background job**,**每浏览器串行**。
  2. **`computer` 点击坐标 = 截图像素、非 CSS 像素**。从 DOM `getBoundingClientRect`(CSS px)算出的坐标必须换算 `clickX = cssX × screenshotW / innerWidth` 再点;直接读截图上的控件位置则无需换算。
- **fail-loud 铁律**:任何一步拿不到预期(没登录 / 没视频入口 / 下载没落地)→ **明确报错**,绝不产出半成品、绝不静默。
- **不输凭据**:登录是 founder 手动步骤,skill 永不代填账号密码。

## 2. Gemini 网页视频的真实现状(WebSearch,2026-07)

**关键事实(重要,修正「免费」的含义):**

- **免费 tier 不含视频生成**。免费 Gemini(无订阅)= Gemini 2.5 Flash + 100 credits/月 + **无 Veo/视频**。
- 视频生成(Veo 3.1 / **Gemini Omni**,官方说 Gemini Omni 正在 Gemini app 里**取代 Veo**)属 **Google AI Plus / Pro / Ultra 付费订阅**:
  - Pro(~$19.99/月):Veo 3.1(含 Lite trial)+ 1000 credits/月(有月度额度上限)。
  - Ultra(~$249.99/月):最高视频访问 + 25000 credits/月。
- 所以本 skill 语境下的 **「免费」= 「吃 Annie 已经在按月付的 Gemini 订阅额度」**,而非「$0 免费账号」。它对比的是 **付费 Veo API 的每条 $1.2–3.2 计量计费**——订阅内视频是**已付月费包含**(受 credit 额度限),不再逐条烧钱。这正是老 skill「FREE (uses subscription)」的原意,也是 Asha 说「以前能用、现在挂了」的前提(→ 账号本来就有订阅、视频本来能出,挂的是 StreamGenerate 的 model-id 轮换,不是订阅没了)。

**推论:** 主路径 B 的可行性**强依赖**「登录的 Gemini 账号有 Plus/Pro/Ultra 订阅且视频 credit 未耗尽」。这是本 issue 的 **#1 风险/验证点**(见 §5)。若账号是免费 tier / 额度耗尽,则**根本不存在免费视频路径**——skill 必须**识别到并明确报错**,不产出、不烧钱、不误导。

## 3. 网页 UI 视频流程(设计要点,不硬编码按钮文案)

Gemini app UI 会变(Veo→Gemini Omni 改名),故 flow 指令要像 deep-research 一样**按截图定位控件**、robust 到文案变化:

1. 确认 headed + 已登录(headless guard:`/headless/i.test(navigator.userAgent)`)。看到登录墙 → STOP 报「需 founder 登录」。
2. 定位「创建视频 / Video / Gemini Omni」入口(Tools/工具 菜单或 composer 里的 video 选项)。**找不到视频入口** = 账号无视频权限 → STOP 报「此账号/地区无免费视频(需 Plus/Pro/Ultra 订阅)」。
3. 输入 prompt → 提交。
4. **异步等待完成(视觉轮询、非 page text)**:视频生成 ~1–2min+,按截图轮询直到视频卡片渲染 / 出现下载控件。设上限超时。
5. **取回视频**:优先用 UI 自带的下载(download 按钮)落到 `~/Downloads`,用 before/after `find` 差集绑定**本次**新文件(参照 deep-research 的 `.docx` 绑定法,防旧文件冒充)。
6. 额度/限制态识别:若 UI 显示「upgrade to generate video」/「out of credits」/ 配额提示 → STOP 明确报「免费额度用尽/不可用」,不静默、不退付费。

## 4. Skill 结构决策

- **落点**:`flyview-skills/skills/generic/gemini-free-video-creation/`(generic 层,与 deep-research/video-watch 同级)。
- **名字**:目录名 + frontmatter `name` = `gemini-free-video-creation`(kebab,= 目录名;CI 门①要求二者相等)。显示/标题 = 「Gemini Free Video Creation」。**已核 blocklist.txt 无此名**(门④过)。description ≤350 字符、无过宽触发词(门②)。
- **形态**:主体 = SKILL.md(agent 驱动 claude-in-chrome flow),内联 bash 片段做下载校验(参照 deep-research)。**尽量不放独立 `scripts/*.sh`**(避免触发 CI 门③ shellcheck;若要放则本地先 shellcheck 跑绿)。
- **`allowed-tools`**:`Bash` + `mcp__claude-in-chrome__{list_connected_browsers,tabs_context_mcp,navigate,computer,read_page,get_page_text,javascript_tool}`(对齐 deep-research)。
- **免费-only**:**完全删除** Veo API / `predictLongRunning` / `GEMINI_API_KEY` fallback。free 失败 = 报错退出,永不花钱。
- **CI**:本地跑 `scripts/skill-guard.sh` 必须 `ALL GATES GREEN` 才提 PR。

## 5. 旧 skill 退役(迁移卫生)

- 老 `gemini-video`(`~/.claude/skills/gemini-video/`)是**手放的本机 user-level skill**,不由 skills-sync 管理(flyview-skills 里没有它),故 skills-sync 的 prune **不会**自动删它。
- 新旧同时存在会**双匹配**「生成视频」触发 → 歧义,且老的仍会静默烧 Veo 钱。故需**显式退役老 skill**:删 `~/.claude/skills/gemini-video/` + 改 `~/.claude/rules/video-generation.md` 指向新 skill。
- 本机可在实现时做;**fleet-wide 老 skill 清理无自动通道**(它从没进 flyview-skills)→ 作为 plan 里的迁移说明 / follow-up 标注(skills-sync 不管未由它安装的 skill)。

## 6. 关键假设与风险

- **A1(核心假设)**:登录的 Gemini 账号有 Plus/Pro/Ultra 订阅、视频 credit 未耗尽(证据:老免费路径以前能出视频)。skill 吃此订阅 = 「免费」。
- **R1(make-or-break)**:若账号免费 tier/额度耗尽 → 无免费视频路径。skill 必须**识别 UI 的「需升级/额度用尽/无视频入口」态并 fail-loud**(§3.2、§3.6)。这也是 QA 的头号验证项。
- **R2**:claude-in-chrome 需 **headed + 已配对**、串行、交互配对 → **非全无人值守**。Runner/cron 场景需 founder 的已配对 headed Chrome(与 deep-research 同约束)。SKILL.md 的 Prerequisites 必须写清。
- **R3**:UI 文案/布局随 Gemini Omni rollout 变动 → 按截图定位、别硬编码文案;变动时 fail-loud 而非猜。
- **R4**:视频异步、下载可能慢/失败 → before/after find 差集 + 超时 + 明确报错。

## 7. 交付边界(两 repo)

- **flyview-skills repo**:新 skill `skills/generic/gemini-free-video-creation/`(代码 PR 开这里)。
- **Flywheel repo(本分支)**:仅过程文档 `engineering/doc/FLY-806-.../`(exploration/research/plan);本分支的 PR + landing signal + approve gate 走这里。
- 老 skill 退役 + rule 更新:本机执行 + plan 标注(见 §5)。
