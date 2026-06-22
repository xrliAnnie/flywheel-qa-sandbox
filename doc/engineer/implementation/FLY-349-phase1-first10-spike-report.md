# Phase 1 Spike Report: 小红书学习 v2 — empirical first-10 deep 实跑 — FLY-349

**Issue**: FLY-349（Phase 1 empirical-first-10，Annie 授权、用 quota 窗口）
**Date**: 2026-06-19
**性质**: 经验性 spike（非生产交付，无 TDD/PR 全套）。目标 (a) 用 quota 在最值钱的 Gemini 深度分析上 (b) 验证 #4 设计 + 量级/质量。
**Scope**: claude 收藏夹前 10 条（5 图文 + 5 视频），温和串行爬（load 高）+ 离线 Gemini 多模态分析。

---

## 0. Bottom line

✅ **#4 深度多模态方法验证成功**：10/10 条产出真实结果。5 条视频全部走通"yt-dlp 下载 → Gemini 多模态读视频 → 精提取"，质量**远超** FLY-332 pilot 的文字层——video-grounded、抓到真实工具/模型名、给出对 Flywheel 可执行的点。**这正是 Annie 要的深度。**

🔴 **但发现一个会卡死生产的硬问题**：**gemini CLI 的 OAuth 路彻底挂了**（`IneligibleTierError`，Google 弃用个人免费 Code Assist client）。现有 SKILL + 我 v2 设计假设的 `gemini -p "@video.mp4"` CLI 路**当前不可用**。已找到并验证可行替代（直接打 Gemini File API + API key）。**生产 v2 必须改用 API 路，不能依赖 CLI。**

---

## 1. 🔴 三个关键发现（直接改 v2 设计）

### F1. Gemini CLI OAuth 死了 → 必须走 API key（已验证）
- CLI 报 `IneligibleTierError: Gemini Code Assist 个人免费 client 不再支持，迁 Antigravity`。重 auth / 给 `GEMINI_API_KEY` 都没用（settings.json 钉死 `oauth-personal`）。
- ✅ **替代（已验证可行）**：绕开 CLI，直接打 **Gemini File API**（resumable upload → poll ACTIVE → generateContent）+ `~/.zshrc` 里的 API key（= gemini-image/video skill 用的同一 paid-fallback key）。视频/图片都走通。
- **成本**：可忽略。gemini-2.5-pro 视频 token 便宜，~$0.05/视频量级；全 10 条 spike 总计 <$1。
- ⚠️ **给 Annie 的 flag**：你说的"quota 2h 后过期"如果指 gemini 订阅/CLI —— **那条已死**。能用的是 API key（paid，但极便宜）。生产 v2 用 API key 路。

### F2. 视频下载 flaky（~50% 首试失败）→ 必须 retry-after-idle
- yt-dlp 有原生 `XiaoHongShu` extractor，720p、25-43MB、下载 ~11-20s。**但首次常报 `No video formats found`**（note3/4/9 都需重试）；**等 ~20-25s 重试即成功**。5/5 视频最终全下成。
- 含义：生产 producer 下载视频**必须**带 retry-after-idle（复用 SKILL 既有纪律），不能首失即弃。

### F3. `get_feed_detail` 在高负载下 flaky/超时 → 影响图文笔记的多 slide
- get_feed_detail（拿正文+评论+完整 imageList）：note3/4 成功（含丰富评论），**note1 连续 2 次超时**。MCP 单浏览器在 load 100+ 时不稳。
- 后果：5 条图文笔记**只取到封面/首屏**（collection content 自带），多 slide 内容（教程正文在 slide 2-N）本次**未取到** → 图文分析是 slide-1 级（仍有效但不完整）。
- 含义：生产 v2 对 get_feed_detail 也要 retry-after-idle + 错开高负载窗口；或图文笔记接受"首屏+逐 slide 重试"。

---

## 2. Empirical 验收表（plan §7 要的数据，本次实测）

| 指标 | 实测 | 用途/结论 |
|------|------|-----------|
| MCP 登录 | ✅ 已登录、**无 CAPTCHA** | 安全窗口 OK |
| get_collection_content | ✅ 一次拿 10 条**元数据**（无正文/媒体，证实源码发现） | 全文须逐条 detail |
| get_feed_detail | ⚠️ **flaky**：2 成功(含丰富评论) / note1 2 次超时 | 生产要 retry + 错峰；多 slide 受影响(F3) |
| 视频下载(yt-dlp) | ⚠️ **flaky ~50% 首试**；retry-after-idle 后 **5/5 成功**；720p 25-43MB；~11-20s | 必须 retry(F2) |
| Gemini 视频读 | ✅ **5/5 成功**，~64-68s/条，质量高、video-grounded | 核心能力验证；藏得进抓取时间 |
| Gemini 图片读 | ✅ **5/5 成功**(封面)，质量好 | 图路验证(API 路) |
| Gemini auth | 🔴 **CLI OAuth 死**；API key 路 ✅ | 改设计(F1) |
| 成本 | ~$0.05/视频，全 spike <$1 | 可忽略 |
| 峰值 load | 跑中 109-125（**多来自其它进程**，我串行很轻）；后段回落 55-74 | 生产并发要保守 + 错峰(F3) |
| 磁盘高水位 | **71MB**（视频用完即删） | 即删纪律有效，磁盘非瓶颈 |
| 限流/封号 | 本次**未撞**限流/封号（10 条、温和串行、登录浏览器） | 守天花板的温和路安全 |

---

## 3. 10 条结果（每条 Gemini 提炼的最有价值点；全文在 spike 工作目录 analysis.txt）

**视频（5，full 多模态深读）：**
| # | 标题 | Gemini 抓到的核心 + 对 Flywheel 最值钱的点 |
|---|------|---------------------------------------------|
| 3 | 完了，我做的猫开始监视我了【AI桌宠开源】 | Qwen 3.5 Omni 实体桌宠;端到端多模态闭环;**"持续感知+异步分析" Agent 模板**;给 Agent 输出加"表达层" |
| 4 | 多Agent无人值守跑了4天，怎么编排的？ | 🔥**和 Flywheel 几乎同构**:图编排 YAML-as-核心接口、triage→coder→tester→quality_gate→reviewer→committer、**Scorecard 审计层(查证据链非口头汇报)**、Codex 编排者/Worker 执行者分离、Docker-per-node、打回/循环控制流 |
| 5 | 用旅行碎片时间帮我干活的 语音Agent：牛马 | **播报(commentary)通道**、**运行时纠偏(steering)**、DAG 状态生成式 UI、WebHID 硬件一键启动 |
| 7 | 我发现了更爽的工作方式，CLI+画板 | **DSL 作稳定中间层**(意图/渲染分离)、协作画板作核心 UI、多模态(语音+手柄)交互 |
| 9 | 我发现了多Agent协作架构的版本答案！ | 🔥 Anthropic **Managed Agents** 四层解耦:Agent+沙盒解耦/Coordinator 编排/**Session 记忆树(fork/回滚)**/SessionStore 云端记忆;pet→cattle;CubeSandbox |

**图文（5，封面/首屏级，因 get_feed_detail 超时未取多 slide）：**
| # | 标题 | 封面读到的核心 |
|---|------|----------------|
| 1 | 给AI装了一双实时gps眼睛（教程） | AI 助手加实时定位+主动环境分析(J.A.R.V.I.S. 化)、不耗电版 |
| 2 | AI写的稿一眼假？差这几个去味skill | 《去AI味十大Skill榜》清单 |
| 6 | 一人控制几十个Agent | 🔥 Telegram 截图:几十个 `lingtai*bot` agent 做 PR/codex 实现/review/测试/Kanban/发邮件——**和 Flywheel 多 Runner 同构** |
| 8 | Claude Fable 5写作测试 | Claude Fable 写作测试，多页右划 |
| 10 | 英伟达：agent 走向物理世界 | NVIDIA 物理 AI Agent 技能、Cosmos 3、CVPR、自动驾驶/机器人 |

> **观察**：这个收藏夹质量极高，多条（#4/#6/#9）是和 Flywheel **直接同构/竞品级**的多 Agent 编排架构干货——深度分析能把这些"版本答案"沉淀成 Flywheel 的设计参考。文字层 pilot 完全抓不到这些（视频/多 slide 里才有）。

## 4. 对生产 v2 的建议（据本次实测）
1. 🔴 **Gemini 走 File API + key，不依赖 CLI**（F1）——更新 SKILL + v2 设计的视频/图片读那段。
2. **下载 + get_feed_detail 都带 retry-after-idle**（F2/F3）；错开高负载窗口跑 first-run。
3. **图文笔记取完整 imageList**（多 slide 才是教程正文）——get_feed_detail flaky 要重试兜住。
4. **并发保守**：本次串行就把 load 推到边缘（叠加其它进程）；生产并行池起步要低（video=1-2）+ load gate（印证 v2 设计 §4.3）。
5. **即删纪律有效**（峰值仅 71MB）——保留。
6. 限流/封号本次未撞，**温和串行 + 登录浏览器**的安全路成立（印证接入方式 #4）。

## 5. 状态
- spike 完成，10/10 真实结果产出，方法验证 ✅，三个硬发现已记录。
- 这是 spike（非生产）；生产 v2 据本报告 + 已批架构正经走（Phase 2+，load 安全 + Annie 在场）。
- 全部 per-note Gemini 分析原文在 spike 工作目录的 `notes/*/analysis.txt`（临时，未入库；如需 Annie 看全文可整理）。

---

## 6. Antigravity CLI spike (追加，Annie 要的：能否替代付费 API)

**装 + 测了 `agy`（Antigravity CLI，Gemini CLI 官方继任者；Gemini CLI 对个人 Pro/Ultra ~6/18 sunset = F1 死因）。**

| 问 | 结论 |
|----|------|
| ① headless 装? | ✅ `curl -fsSL https://antigravity.google/cli/install.sh \| bash` → `~/.local/bin/agy` v1.0.10，无 IDE |
| ② 脚本化喂视频→返结果? | ✅ `agy --model gemini-3.1-pro --dangerously-skip-permissions -p "@video.mp4 <prompt>"`，真能 headless 分析视频 |
| ③ 模型? | Pro 给一个**模型菜单**：**Gemini 3.1 Pro**(比 2.5-pro 新！)、Gemini 3.5 Flash、Claude Sonnet/Opus 4.6、GPT-OSS 120B |
| ④ 质量 vs 付费 API File 路? | ✅ **相当或更好**：同一条视频(note3)，Gemini 3.1 Pro 抓到更多细节(Arduino IDE 2.3.7/Uvicorn/WebSockets/Bambu Studio/`0.0.0.0:8081` 控制台/健康记录时间线/作者 FanGeAI) |
| ⑤ 耗时 | ~146s/视频(比付费 API ~68s **慢**——agy 是 agentic harness，额外做 list-dir/read/view_file 步) |
| ⑥ 🔴 **auth durable for 无人值守?** | ❌ **不行**。Annie 登录后第 1 次(models)+第 2 次(视频分析)能用，但**几分钟后第 3 次调用就要求重新 OAuth 登录**(打印 URL+等 code，30s 超时)。session 短命/非持久，非交互 `agy -p` 无法稳定复用。 |
| ⑦ quota 墙? | 未测到(auth 在第 3 次先挡了)；对生产而言 moot——auth 不持久已是更大 blocker |

**🔴 干脆结论**：
- **agy/Antigravity Pro 适合 *交互/手动* 深度分析**(质量好、Gemini 3.1 Pro 更新、Pro 覆盖、省钱)，但 **auth 不持久(几分钟重新 OAuth)→ 不适合无人值守/定时的生产 Runner**(总不能每次 scheduled run 停下等 Annie 重登)。
- **生产 v2 用付费 API key 路**(静态 key、无交互重登、已验证 5 视频每条 ~$0.05、质量足)。Antigravity 作 *可选的手动深挖工具*，不进自动管线。
- (注：凭据安全全程守住——agy 重登的 OAuth code 我**没输**，让它 30s 超时；Annie 的 Google 凭据没碰。)

---

## 7. Antigravity auth 持久化深挖（追加，78c0d287）— 🔁 **推翻 §6 的 verdict**

§6 说"auth 不持久→回付费 API"。专攻 auth 卡点后**发现 §6 结论错了**：那次重登是**高负载诱发的瞬时失败**（test#2 在 load ~125 时），不是 auth 本身不持久。

**实测（低负载下）**：
- `agy models` 再调 → ✅ 成功（OAuth **自动刷新**了）。
- OAuth 凭据**持久化在 macOS Keychain**（"Antigravity Safe Storage" / "Antigravity Key" 项）+ 落 `~/.gemini/antigravity-cli/`；短命 access token + 自动 refresh（refresh token 在 keychain）。
- **auth 稳定性测试**：连跑 **5 次** `agy -p` 文本调用 → **5/5 全 ✅、零重登**（6-11s/次）。
- 再跑 **note4 视频分析**（低负载）→ ✅ 成功，**62s**（比高负载时的 146s 快一倍），质量更细（抓到精确数据:4天11小时/14万行/12.9亿 tokens/416 run 633 commit/8核CC150 + YAML 6 层解耦 + Scorecard 审计）。
- 累计 ~9+ 次调用（2 models + 5 文本 + 2 视频）**未撞 quota 墙**。

**web research 佐证**：OAuth 用短命 token + 自动 refresh，存 keychain-derived-key 加密的 credentials；"unattended 401 重登"是**已知问题**（GitHub #78 + 专文），Google 推荐的**全自动无人值守**做法 = 用 **API-key 环境变量**（Google AI Studio key，从此不弹登录）——但那 key = 付费 API，非 Pro。

### 🔁 修正后的干脆结论
- ✅ **Antigravity Pro 可用于自动化**：OAuth 持久 + 自动 refresh，低/正常负载下稳定多次调用，**免费走 Annie 的 Pro**，给**更新的 Gemini 3.1 Pro**，质量**相当或更好**。
- 🔴 **唯一风险**：**高负载**下 OAuth 可能瞬时要求重登（test#2 在 load 125 撞过）——对无人值守是 hang 风险。
- **推荐(替代 §6)**：生产 v2 **主路用 Antigravity Pro(agy + OAuth)省钱**，**付费 API key 作 fallback**(检测到重登/401 时切)。配合 v2 设计已有的 **load gate**(高负载不跑/降档)，重登风险基本规避。→ **既省钱(Pro 免费)又有可靠兜底。**
- (凭据安全全程守住:重登的 OAuth code 从没输过;Annie 自己登的 Pro。)
