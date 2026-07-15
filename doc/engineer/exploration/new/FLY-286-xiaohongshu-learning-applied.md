# Exploration: 小红书学习系统首次生产应用 — FLY-286

**Issue**: FLY-286 (Xiaohongshu/YouTube learning system — apply the xiaohongshu-learning skill end-to-end)
**Date**: 2026-06-16
**Status**: Complete（brainstorm 多轮已与 Annie 经 Tadashi relay 锁定 → 进 research）

---

## 0. 一句话

把 FLY-222 已建好、已在 QA 测试槽 A0-A10 全验过、但**从未在生产真跑过**的小红书学习 loop **第一次真正用起来**；并按 Annie 在 brainstorm 中给出的**新愿景**把控制模型从"事前 prune gate"演进为"**事后 HTML review**"，同时抽出 General/Specific 两层让以后别的项目只填一个 mapping 就能用。

> ⚠️ **这不是"原样 apply 现有 skill"**：Annie 的新愿景**替换**掉现有 skill 的事前 prune-gate 控制模型（见 §4）。所以 FLY-286 是**实质性改造 + 新建**，不是一个 config wiring PR。

---

## 1. 现状（已审计 codebase，非假设）

FLY-222（PR #243, v1.36.2）已交付并 merge 了整套基建：

| 组件 | 位置 | 状态 |
|------|------|------|
| `xiaohongshu_learning` config schema + tuple 校验 | `packages/config/src/{ConfigLoader,types}.ts` | ✅ 已建 |
| state helper（lease/CAS、processed 全窗口差集、operation 幂等、next-due） | `packages/flywheel-comm/src/xiaohongshu-state.ts` + CLI `xhs-state` | ✅ 已建 |
| FINAL validator | `xhs-validate-final` | ✅ 已建 |
| skill `xiaohongshu-learning` | `flyview-skills/skills/flywheel/...` → 部署 `~/.agents/skills/` | ✅ 已建（v0.1.0） |
| thin scheduler（decision core + entry + tick.sh + plist） | `packages/teamlead/src/xiaohongshu-scheduler.ts` + `scripts/` | ✅ 已建（DRAFT，未装 launchd） |

**但生产从未启用**：① 没有任何项目（flywheel/sub/joycon）的 `.flywheel/config.yaml` 含 `xiaohongshu_learning` 块；② scheduler plist 仍是 `scripts/` 里的 DRAFT，没装进 `~/Library/LaunchAgents`；③ XHS state 目录只有一个 2026-06-09 的 QA `test-slot-3` 文件。

QA 历史（`doc/engineer/implementation/FLY-222-a0-a10-runbook.md`）：qa-fly-222 在隔离测试槽（slot 3, Bridge :19873, 2026-06-08）跑通完整 A0-A10 并全 PASS，真机建过 Sandbox FLY-236/237、验过 prune gate / fail-close / 幂等 / owner-fencing / 视频读取 / 图片 vision / `no_code` 终态。**机制可信，缺的是生产 rollout + 按新愿景的改造。**

---

## 2. Brainstorm 过程（多轮，Annie 经 Tadashi relay）

| 轮 | 我问 | Annie 答 |
|----|------|----------|
| R1 | scope split / 收藏夹 / 落点+频率 / 视频 / YouTube / 泛化范围 | 见 §3；并给出**新 first-run 愿景**（§5）；明说"第一个 scope 问题没答好，邀请你据补充再深问" |
| R2 | 收藏夹候选(列 AI 相关) / 并行选型(10 Runner vs Workflow) / 控制模型(事前 vs 事后) | 收藏夹 = claude+claude-多机；并行 = 单 Runner 内 bounded 并行；控制模型 = **事后 HTML review** |
| R3 | 白话重述确认事后模型 / 回写机制(A 网页框/B 邮件/C Sheet/D Linear) / 默认提案 | 确认事后模型；**回写 = A 网页评论框+提交**；默认提案(JSON 存储+HTML 托管+增量复用+视频并发 4-6)全过 |

---

## 3. 锁定决策

| 维度 | 决策 |
|------|------|
| **收藏夹** | `claude`(id `6884765b0000000023036a58`, ~123) **+** `claude - 多机`(id `6a30443f000000000d02a800`, ~1)，两个都做 |
| **落点 / 团队 / Lead / dept label** | target Linear project = `Flywheel`；team = `FLY`；lead = `flywheel-eng-lead`(Tadashi, canSpawnRunners=true)；dept label = `Flywheel`（唯一路由到 eng-lead，已核） |
| **频率** | weekly（每周） |
| **视频** | `video_opt_in = ON`（送 Gemini 分析；隐私已知会 Annie） |
| **YouTube** | 暂不做（现 skill+MCP 只做小红书；YouTube 是从零新能力）→ 拆 follow-up |
| **泛化范围** | 这次只做 Flywheel 收藏夹；GeoForge3D/Sub 以后 Annie 自己处理；General 层在本 issue 同步抽，**FLY-295 收口泛化层** |
| **并行** | 单 Runner 内 bounded 并行（Dynamic Workflow 风格，仅举例；核心=单 Runner 内并行，**不拆多 Runner**）。视频分析并发默认 4-6（顾及机器高负载会 crash） |
| **控制模型** | **事后 HTML review，取代事前 prune gate**（见 §4） |
| **存储** | raw 视频/音频 → 临时目录、用完即删（不进 repo，太大）；分析结果 → 持久结构化 JSON |
| **增量** | 首次 = 全量 baseline；之后每周 = 记住上次到哪、只抓+分析新增（复用现有 processed-noteId 全窗口差集） |
| **回写 UX** | A = 网页每条下评论框、写完提交（需扩一个小提交后端）|

---

## 4. 关键认知：控制模型从"事前 prune gate" → "事后 HTML review"

**现有 skill（事前）**：fetch → 逐条读 → 蒸馏草稿 → **建 issue 之前**发 Discord prune gate 让 Annie 勾选 → `xhs-validate-final`(fail-close：未拿到合法 FINAL 则零副作用) → 才建 kept issue + 写 memory。安全要害 = "Annie 没 FINAL 时绝不建 issue"。

**Annie 的新愿景（事后）**：
1. **抓+存**：先扫收藏夹全部内容，raw media（文本/视频/音频）全拿出来存（raw 临时、分析结果持久）。
2. **逐条分析**：Runner 对每条分别分析 → 自己判断：没用→跳过；有用→**自动建 follow-up issue**。
3. **日终 summary**：当天 triage 完 → 给 Annie 一份 analysis summary（分析了哪些帖、学到什么、建了哪些 issue）。
4. **人工 review**：结果做成**互动 HTML 页**，每条显示「讲了什么 + 我做了什么 action（建 issue / no action）+ 评论框」。Annie 有空 review：对的不吭声；错的/漏的在评论里写 → 发回 → Runner 按评论**调节**（关掉不该建的、补建漏的），并**从每次互动学她的判断标准**（"有用" ≈ 能让 Flywheel 更好）。

→ **差异**：控制点从「建之前先勾」反转为「先自动建、事后挑错」。这意味着现有 skill 的 prune-gate + FINAL-routing + "未 FINAL 不建" 不变量被**移除/替换**；新增 raw 存储、逐条自动建、HTML 报告、网页评论提交后端、评论→close/create 回写、从评论学习。

---

## 5. 复用 / 替换 / 新建（粗分，详见 research）

- **复用**：MCP 抓取握手；视频 yt-dlp+cookie→Gemini；图片 vision；state helper（lease、processed 差集、operation 幂等 marker、next-due）；scheduler decision core + tick.sh + plist；config schema（扩展）；`no_code` 终态；凭据卫生。
- **替换**：prune gate（步骤 7-9）→ 自动建 issue + 事后 HTML review + 评论回写。
- **新建**：raw-media 暂存层；bounded 并行逐条分析编排；analysis 结果持久结构化存储；HTML 报告生成；**网页评论提交后端 + 评论→close/create 回写**；从评论学判断标准；日终 summary。

---

## 6. General / Specific 两层（Annie 硬要求；FLY-295 收口）

核心目标：**以后别的项目只需做个简单 mapping（指定该项目对应的收藏夹名）就能用，不重走开发。**
- **Specific**：某项目的收藏夹、目标 Linear 项目、频率（= config 一行 mapping）。
- **General**：扫描 / 存储 / 逐条分析 / 自动建 issue / summary / HTML review 回写 / 从评论学习 —— 全部通用逻辑。
- 现有 config 已是 per-collection 数组（collection_id/lead_id/target_project/cadence/max_fetch/video_opt_in），mapping 雏形已在；General 层的新能力（HTML review 等）要建成通用、不写死 Flywheel。

---

## 7. 待 research / plan 解决的开放设计项

1. **🔴 回写宿主约束（research 已发现的最关键技术问题）**：FLY-203 的托管 HTML 在 Vercel 上带严格 CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:` → **JS / form 提交 / 跨域 connect 全禁**；且 founder-html-delivery 明确"Annie 常在手机上只用 Discord"。→ Annie 选的"网页评论框+提交"(A) 不能直接用现有托管页：Vercel 页手机可看但不可交互；可交互页(Bridge 本地 relaxed-CSP same-origin 提交)只能在本机、手机够不着。**需定回写架构**（见 research 选项 + 一个"她在什么设备 review"的产品确认）。
2. **General/Specific 抽象边界**：通用引擎 vs 项目 mapping 的接缝（技术设计，归 Codex review）。
3. **analysis 结果持久存储**：格式 / 位置（state helper 扩展 vs 新存储层）。
4. **逐条自动建 + 幂等**：去掉 prune gate 后，crash-safe "自动建不重复" 仍靠 operation-id marker + 建前查 Linear。
5. **首次全量 124 条的洪峰**：首次可能自动建大量 issue → 是否批处理 / 设上限 / 分批 review（产品+技术）。
6. **bounded 并行编排**：单 Runner 内串行 fetch → 并行 download+Gemini(并发 4-6) 的具体机制（Dynamic Workflow vs bounded shell 池）。
7. **从评论学判断标准**：v1 = Runner 用最佳判断 + 把 Annie 的评论沉淀进 project memory 作为"她的标准"，下次参考。

---

## 8. PR 切分（初步，详见 plan）

预计跨仓多 PR：① flywheel 基建（config 扩展 / 存储 / 回写后端 / HTML 托管 / General 引擎接口）；② flyview-skills skill（新控制流）；③ scheduler 接线 + plist 安装。**plan 定稿过 codex-design-review 后再动实现**；live pilot（真扫描 + Annie 真 review）等 load 安全 + Annie 在场，由 CoS 带跑。
