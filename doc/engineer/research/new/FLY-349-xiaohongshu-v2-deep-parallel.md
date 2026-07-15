# Research: 小红书学习系统 v2 — 全内容下载 + Gemini 多模态深读 + 并行 — FLY-349

**Issue**: FLY-349（xiaohongshu 学习系统 v2 设计 — 深度 + 并行）
**Date**: 2026-06-19
**Source**: FLY-332 pilot 首扫观察、`doc/engineer/{exploration,research,plan}/*/FLY-286-*`、现有 `xiaohongshu-learning` SKILL.md、已 merge 的 FLY-286 基建（`xiaohongshu-state.ts` / `xiaohongshu-analysis-store.ts` / `bridge/xhs-review-*`）
**前置审计**: 现有 skill 全文、state/analysis-store、scheduler、TmuxAdapter（Runner spawn）、本机 8 核
**Status**: Complete（brainstorm gate 已过；据此进 plan）

> 🔴 **这是设计/research，不是实现。** 不动 live、不改 FLY-286 现有代码。本轮产出 = research + plan 给 Annie review。

---

## 0. 一句话

FLY-286 把小红书学习 loop 在生产跑起来了，但 FLY-332 首扫**只过了文字层**（标题/正文/评论），没真正下载图/视频、没走 Gemini 多模态。v2 要补的就是这层**深度**（全内容下载 → Gemini 读图/读视频 → 精提取），并让大收藏夹（125+ 条）能**又快又细又对**地处理——而"快"的正解不是并行抓取，而是把昂贵的分析层藏在串行抓取的时间下。

---

## 1. 现状 gap（实证，非假设）

### 1.1 FLY-332 pilot 首扫实际做了什么

| 维度 | pilot 首扫（FLY-332） | v2 目标 |
|------|----------------------|---------|
| 分析广度 | 最新 **30/125** 条（`first_run_analyze_limit≈30`） | 全 125（分阶段，见 plan） |
| 内容深度 | **只文字层**：`title` + `desc` + 顶部评论 | 图文 + **视频** 全下载 |
| 图片 | **未下载、未 vision** | 下载 → `Read`（vision）/ Gemini 读图 |
| 视频 | **降级**（`video_opt_in=false` → 只 caption+评论） | `yt-dlp` 下载 → Gemini pro 读 |
| Gemini | **没走** | 多模态深读（图+视频）+ 精提取 |
| 并行 | 串行逐条 | 分析层 bounded 并行 |

### 1.2 为什么首扫这么浅（根因，决定 v2 改哪）

1. **pilot 配置 `video_opt_in=false`**（gated pilot 刻意保守，隐私+负载）→ skill 的视频分支按设计**降级**到只读 caption+评论。collection `claude` 多为 AI 视频内容 → 多数 note 命中降级。
2. **`first_run_analyze_limit≈30`** → 125 条只析最新 30，留 95 未碰。
3. **图片 vision 是 skill 既有能力但实战未充分跑**：SKILL.md §5 写明 normal note 要 `download imageList[].urlDefault → sips webp→png → Read`，但首扫的产出是"文字层快速过一遍"——说明图片深读这条在 pilot 里没真正发挥（时间/降级/保守取的近路）。

> **结论**：v2 不是"修 bug"，是**把已设计但首扫没走深的深度层做实、做强**（视频开 opt-in + Gemini、图片 vision 做扎实、精提取），并解决"大收藏夹要快"的并行编排。FLY-286 的控制模型（事后 review、自动建、幂等、web-local 回写）**不动**——v2 是在它的"逐条读 note"这一步往深里挖 + 加并行。

---

## 2. 硬约束审计（这些事实决定 v2 架构，不是偏好）

### 2.1 🔴 串行 MCP 抓取是真正的瓶颈

RedNote MCP（`127.0.0.1:18060`, `xiaohongshu-mcp`）驱动**一个真实 Chromium**：
- `get_collection_content`：一次拿全收藏夹**元数据**（noteId/title/type/xsecToken/cover），≤200，无 cursor。便宜，一次。
- `get_feed_detail`：**每条**一次，拿 `desc`/评论/`imageList` URL。**~60s+/条、flaky**（SKILL.md 明确"retry-after-idle，最多 ~3 次 backoff"），且必须**串行**（单浏览器，并行会撞）。

→ 125 条 × ~60s（+retry）≈ **2 小时**纯抓取，**远超**分析时间。这是 wall-clock 的支配项。
→ **任何"并行抓取"方案都是错的**：会让单 Chromium 互撞、超时、雪崩。

### 2.2 🔴 `xsec_token` ~15min 短命 → 下载必须紧跟抓取

`get_feed_detail` 返回的 `xsec_token`（下载图/视频要用）~15 分钟过期。
→ **不能**"先串行抓全 125 条 detail，再统一下载"——最早抓的 token 早过期。
→ 下载（图片 + 视频 yt-dlp）**必须耦合在抓取阶段**：抓到一条 detail 立刻下该条媒体（token 新鲜），落到 per-note 本地目录。

### 2.3 Gemini 多模态：能力在、但重

SKILL.md §6 已验证的配方（QA 过）：
- 视频：`yt-dlp`+cookie 下载（`--max-filesize 200M`、`-S "res:720"` 降码率）→ `GEMINI_CLI_TRUST_WORKSPACE=true gemini -m gemini-2.5-pro -S "res:720" -p "@file.mp4 <directive>"`，隔离 temp 子目录。**必须 pro**（`flash`/`-lite` 会 exit 0 但**编造**内容不读视频）。720p/15s clip ~**45-60s**。
- 图片：下载 → `sips webp→png` → `Read`（vision，本会话内）/ 或同样可走 gemini 读图。
- 凭据卫生：`umask 077`、cookie `chmod 600`、`trap` EXIT 清理、不打印 token/signed URL、即用即删。

→ 分析单条 ~1-2min（视频更重）。125 条若并发 5 ≈ 125/5 × ~1.5min ≈ **~40min**——**藏得进** 2h 的串行抓取时间里（§2.1）。这就是"并行的收益在哪"的量化答案。

### 2.4 🔴 机器负载是硬上限（Annie 的 crash 史）

项目记忆铁律：**load 飙高 → WindowServer panic 整机崩**（多 agent 并发把 load 干到 170-450 的事故）。Gemini 视频分析 CPU/IO 重。
→ v2 **必须**有：硬并发上限（本机 8 核 → 见 §2.5）、负载感知节流（load > 阈值就降并发/暂停）、**宁慢勿崩**。这条单独、醒目写进 plan。

### 2.5 Workflow 工具（Claude dynamic workflow）的并发模型 + 可用性

- **并发 cap** = `min(16, cores−2)`。本机 8 核 → **6**。正好落在 FLY-286 早定的"4-6"区间。
- **subagent context 隔离**：每条 note 一个 subagent，在**自己的 context** 里下载+读图+读视频+提取，只把 schema 结构化结果返回 orchestrator。→ **全媒体/长文本不进主 context**——直接命中 Annie"别把全内容 load 进 context"。
- **MCP 可达但仍受单浏览器限**：subagent 能经 ToolSearch 调 session MCP，但 RedNote MCP 是单 Chromium → **不能**让 subagent 并行抓取。Gemini 是 CLI（bash），subagent 可跑。
- 🔴 **工具名 + 可用性待验证**：`packages/claude-runner/src/config.ts` 列的工具是 `Read`/`Bash`/`Task`/`Batch`/`Skill` 等——**没有**字面叫 `Workflow` 的。即生产 Runner 的"dynamic workflow"很可能是 `Task`/`Batch`（subagent fan-out），非 orchestrator 手上的 `Workflow` 工具。现 `xiaohongshu-learning` skill frontmatter `allowed-tools: Bash Read`（刻意 no-code）；生产 Runner 经 `TmuxAdapter` 起 `claude`，`--allowed-tools` 仅显式设时加（`TmuxAdapter.ts:610`）。→ B 路径需 spike 定准工具名 + 证生产 Runner 能从此 skill 调 + 放开工具面。**这是 skill-vs-workflow 取舍的关键不对称**（§4）。

### 2.6 已 merge 的 FLY-286 基建（v2 站在它肩上，全复用）

| 组件 | 位置 | v2 用法 |
|------|------|---------|
| state helper（lease/CAS/owner-fence、processed 差集、operation 幂等、next-due、bootstrap、`analyze_baseline`） | `flywheel-comm/src/xiaohongshu-state.ts` + `xhs-state` CLI | 原样复用 |
| AnalysisStore（per-run JSON、atomic、0600、无 raw bytes） | `flywheel-comm/src/xiaohongshu-analysis-store.ts` | **扩 post 记录的多模态字段**（§3.2） |
| FeedbackStore + 异步 feedback 消费 | `xhs-analysis` CLI + state | 原样复用 |
| web-local review 路由（loopback+same-origin+review-token+scoped CSP） | `teamlead/src/bridge/xhs-review-*` | 原样复用（review 页多展示多模态产出） |
| scheduler + tick.sh + plist | `teamlead/src/xiaohongshu-scheduler.ts` + `scripts/` | first-run vs recurring 模式参数（§3.3） |
| 抓取/视频/图片/凭据卫生配方 | SKILL.md §3/§5/§6 | 深读层的**底座** |

→ v2 的新增面**很窄**：把"逐条读 note"做深（多模态精提取）+ 加并行编排 + 两模式 + 负载节流。控制/存储/回写/幂等**全不重做**。

---

## 3. 设计空间分析

### 3.1 并行能放哪、不能放哪（核心）

```
收藏夹 = [note1, note2, ... note125]

┌─ 串行（单 Runner，MCP 单浏览器，token-fresh）────────────┐
│ 对每条:  get_feed_detail (MCP, ~60s, retry)              │   ← 瓶颈，不可并行
│          ↓ 立刻下载该条媒体 (yt-dlp/curl, token<15min)   │   ← 耦合在此，token 新鲜
│          → per-note 本地目录 {detail.json, imgs/, vid}   │
└──────────────────────────────────────────────────────────┘
                  │  (producer 喂)
                  ▼
┌─ 并行（bounded 4-6，无 MCP、无 token）─────────────────────┐
│ 对每条已落盘的 note（worker 只产结果 JSON，不建单/不写 state）:│
│   Gemini 读视频 / 读图 / 文本蒸馏 → 精提取                  │   ← 昂贵但独立，可并行
│   ⚠️ 图片：CLI-only 路径走 `gemini` 读图（bash 调不了 Claude │
│      `Read` vision）；要用 `Read` 并行只能走 subagent（见 §4）│
│   → {summary, keyPoints, judged_useful, draft?}           │
│   → 清该 note temp（封顶磁盘）                              │
└──────────────────────────────────────────────────────────┘
                  │  (单一 aggregator 串行收口副作用)
                  ▼
   judge → 自动建 issue（串行 Linear MCP, 幂等, 复用 FLY-286）→ review 页
```

- **不可并行**：MCP detail-fetch（单浏览器）、媒体下载紧跟抓取（token）。
- **可并行**：分析（Gemini/vision/提取），每条独立、无共享状态、无 MCP/token 依赖。
- **关键收益**：分析并行后**藏在**串行抓取的 ~2h 下（producer-consumer 重叠），wall-clock ≈ max(抓取, 分析) ≈ 抓取时间——分析"免费"。**而不是**并行抓取（错，撞浏览器）。

### 3.2 深度层：每条 note 的多模态深读 + 精提取

补 pilot 缺的层。每条产出一个**多模态分析记录**（扩 AnalysisStore 的 post schema）：

```jsonc
{
  "noteId": "...", "title": "...", "url": "...",
  "type": "video|normal",
  "mediaKinds": ["text","image","video"],
  "rawCounts": { "images": 4, "videoSeconds": 15 },   // 下了多少（非 bytes）
  "modalRead": {
    "text": "正文/评论蒸馏",
    "images": "vision 读图：图里讲了什么（步骤截图/prompt/工具界面…）",
    "video": "Gemini pro 读视频：帧+音轨+屏幕文字，video-grounded（非泛知识）"
  },
  "keyPoints": ["精提取 1（actionable）", "精提取 2", "..."],  // ← Annie 要的"重点"
  "judgment": { "useful": true, "reason": "..." },
  "createdIssue": { "issueId": "...", "opId": "...", "state": "triage" },
  "status": "created|candidate|no_action"
}
```

- **精提取**是 v2 的产品价值：不是把全文塞进 issue，是 Gemini/vision 读完后**抽出对 Flywheel 有用的可执行点**（工具/做法/prompt/思路）。每条 subagent 在自己 context 里读全内容，只回这个精炼结果。
- **诚实标注**：Gemini 视频读是"内容 + 模型常识"的综合，非逐字转录（SKILL.md 已定基调）；review 页是人类 backstop。

### 3.3 两个运行模式（Annie 明确要求）

| 模式 | 触发 | 量 | 并行 | 编排 |
|------|------|----|----|------|
| **first-run（大批量）** | `bootstrapped=false` → `analyze_baseline` | 125（历史存量） | **重并行**（4-6） | dynamic workflow / bounded pool 价值最大 |
| **recurring（每周轻量）** | `bootstrapped=true` 增量 | 每周 **5-10** 条新帖 | 轻/串行即可 | 简单，**不需重并行**（甚至原 skill 串行就够） |

→ 架构必须**同一引擎吃两种模式**：靠 state 的 `bootstrapped` + diff 出的 `new` 数量自动选并发档（量小走轻量路径，量大才点燃并行池）。recurring 不该背 first-run 的复杂度。

### 3.4 🔴 Annie 的 first-10 探路（v2 的第一阶段，不是纯理论 doc）

Annie 明确：**别一上来 process 全 125**。先拿**前 ~10 条**实测最优深加工方案：
- 每条全内容下载（图文+视频）+ Gemini 多模态深读 + 精提取，**量真实的** MCP 时延 / Gemini 时延 / 失败率 / 小红书 MCP 限制（125 不一定简单）。
- 据实测**定方法**（提取 prompt 怎么写最准、视频该不该全下还是抽帧、并发几档不崩、token 窗口够不够）。
- **再 back-apply** 到全 125。

→ plan 把这条作为**Phase 1（empirical-first-10）**：先验证再 scale，避免在 125 条上烧时间/撞限制才发现方法不对。

---

## 4. skill vs dynamic-workflow（取舍 — 关键不对称）

两条路都能做"分析层并行"。差异：

| 维度 | 方案 A：bounded shell pool（留在 skill） | 方案 B：subagent/Task fan-out（"dynamic workflow"） |
|------|------------------------------------------|--------------------------------------------------|
| 工具面 | **不变**（skill 现 `Bash` 就够：`xargs -P` / 后台 job 池；🔴 图片走 `gemini` CLI 读图——bash 调不了 Claude `Read` vision） | **要加并行工具**进 skill 面 + 验证生产 Runner 暴露它（🔴 工具名是 `Task`/`Batch`？非字面 `Workflow`，§2.5 待验证） |
| context 管理 | 分析在子进程 bash 里，结果写文件；主 agent 不读全媒体（已是 SKILL.md 现状） | **更强**：每条 subagent 独立 context，schema 结构化返回，全媒体天然不进 orchestrator context；且 subagent 可调 `Read` vision |
| 结构化输出 | 自己定 JSON + 解析（易错） | **schema 强制 + 自动重试**（tool-call 层校验） |
| 并发控制 | 自己写池 + 负载节流 | 自动 cap `min(16,cores−2)`=6；但**负载节流要自己加**（Workflow cap 不看 load） |
| 错误处理 | 自己 trap/重试/降级 | 单 subagent 死 → 返回 null，`.filter(Boolean)` |
| 成熟度 | **今天就能跑**（现 skill 就是 bash 编排） | 依赖 Workflow 工具在生产 Runner 可用（未证） |
| MCP 抓取 | 不涉及（抓取在串行段） | **同样不能**用 subagent 并行 MCP（单浏览器） |

**两个都不能把"整条搬进 workflow"**：MCP 抓取（§2.1）+ token-fresh 下载（§2.2）必须串行、在单 Runner/单浏览器里。并行机制只能接管**分析层 fan-out**。这是 hybrid 的根因（§5 plan 详述），不是偏好。

→ **倾向推荐 hybrid**（抓取+即下留 skill 串行；分析层并行），并行实现**优先 A1（shell pool · CLI-only：gemini 读图/读视频/蒸馏全并行）作 v1**（零新工具面、今天可跑、绕开"bash 调不了 `Read` vision"的坑、契合现 skill 的 no-code 形态），**B（subagent/Task fan-out）作探索/升级项**（context 隔离 + schema 更优，但先 spike 验证生产工具名 + 可用性）。plan §5 给完整 A1/A2/B 拆分 + 理由 + 给 Annie 讲清"为什么抓取不能并行搬 workflow"。

---

## 5. 风险 / 待验证（写进 plan 当设计约束）

1. 🔴 **机器负载**（§2.4）：硬并发上限 + load 节流，宁慢勿崩。
2. 🔴 **Workflow 工具生产可用性**（§2.5）：先在隔离环境验证 Runner 能否调 Workflow + skill 工具面如何放开；未证前不在生产 first-run 用 B。
3. 🔴 **小红书 MCP 限制**（Annie 点名"125 不一定简单"）：first-10 实测真实失败率/限流/CAPTCHA；`get_collection_content` ≤200 无 cursor → >200 收藏夹取最新 200 + 告警（已有机制）。
4. **xsec_token 窗口 vs 长串行**（§2.2）：125 条串行抓取 ~2h，但下载即用即下（token 新鲜），不囤 token；first-10 验证窗口够。
5. **磁盘/temp 封顶**：125 视频不能全囤（25GB+）；producer-consumer 限 in-flight + 用完即删（SKILL.md 已有"下→读→删"，并行池要保这个不变量）。
6. **Gemini 配额/时延**：125 视频 × pro 调用；first-10 量时延、看是否撞配额；多账号 fallback（`codex-multi-account` 同理，gemini 侧待确认）。
7. **video opt-in / 隐私**：v2 开视频深读 = 把视频体送 Google/Gemini；Annie 已在 FLY-286 知会同意，v2 沿用 `video_opt_in`。

---

## 6. 待 plan / codex-design-review 定的开放项

1. 分析并行 v1 = shell pool（A）还是直接上 Workflow（B）——倾向 A 先行、B 探索（§4），plan 给推荐 + Annie 拍。
2. 视频处理粒度：全下 720p vs 抽关键帧（省 Gemini/带宽）——first-10 实测定。
3. 精提取 prompt 模板：怎么写让 Gemini/vision 输出"对 Flywheel 有用的可执行点"——first-10 调。
4. first-run 125 是否仍分批（`first_run_cap` 建单上限 + 是否分多 tick）——复用 FLY-286 §7，量大时 review 页消化。
5. AnalysisStore post schema 扩多模态字段（§3.2）的具体形 + 兼容（additive，不破 FLY-286 既有）。
6. 负载节流的具体信号（`uptime` load avg 阈值 / 并发降档曲线）。
