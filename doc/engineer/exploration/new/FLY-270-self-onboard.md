# Exploration: 把 Flywheel 自己 onboard 进 Flywheel — FLY-270

**Issue**: FLY-270 (专属 Eng Lead + Level 2 自托管开发流水线)
**Date**: 2026-06-15
**Status**: Complete（Annie 已定调，brainstorm 已完成，本文只落定结论 — 不重新 brainstorm）
**Author**: worker-fly-270

> ⚠️ 本文是 **brainstorm 结论落定**，不是重新 brainstorm。方向已由 Annie 2026-06-15 在 FLY-270 拍板锁定。
> 下游 research / plan 见 `doc/engineer/research/new/FLY-270-self-onboard.md` 与（待写）`doc/engineer/plan/draft/`。

---

## 0. 一句话

用 Flywheel 自己继续开发 Flywheel（dogfooding / self-hosting）：给 flywheel repo 配一个**专属 Eng Lead**（行为完全照 GeoForge3D 的 Peter）+ **Level 2 完整流水线**（FLY issue → Lead 开 Runner → 自动 PR），让 Annie 在 Discord 上就能驱动 Flywheel 改进自己，不再全靠手动开 terminal session。

**复用 FLY-189/190（joycon / sub）已上线的 onboard 模板**；唯一真正新的设计点 = **self-hosting ship / 重启安全边界**（Runner 改的正是跑 Flywheel 自己的代码）。

---

## 1. 现状（为什么要做）

- `~/.flywheel/projects.json` 当前已有 5 个项目：geoforge3d / sub / joycon-typeless / personal-assistant / growth。**flywheel repo 自己不在里面** —— 它至今靠 Annie 手动开 terminal + 人类 worker（如本 worker）跑全流程。
- Linear 这边 FLY- issue 已存在（**FLY team + Flywheel project**），所以新 Lead 直接读 FLY- issue 即可，不需要新建 Linear team / project。
- FLY-189/190 已经把"单 repo + 专属 Lead + 专属 bot + Level 2"这套 onboard 模板跑通并上线（Hiro/joycon、Asha/sub 生产在线），是本次可直接复用的成熟模板。

---

## 2. Annie 已定调（方向锁定，不回头）

| # | 维度 | 取值 |
|---|------|------|
| 1 | **Lead 身份** | **新建专属 Eng Lead**（独立 Discord bot + #flywheel 频道）。行为 = **完全照 Peter（GeoForge3D）那套**：思考伙伴 + Orchestrator/Architect —— 跟 Annie 讨论做什么 → 派活给 Runner → 像架构师一样控不同 issue 进度、定期汇报。**Runner = 纯执行者。** |
| 2 | **接入深度** | **Level 2 完整流水线**（FLY issue → Lead 开 Runner → 自动 PR）。`canSpawnRunners: true`。 |
| 3 | **自治分阶段** | 现在 ≈ **提案制**（扫 FLY backlog → 提候选 → 跟 Annie 讨论定今天/这周做啥）；随它更懂 Annie context → 逐步自己找活干。同 GeoForge3D 的推力。 |
| 4 | **打扰节奏** | 关键里程碑级。 |
| 5 | **体验设计** | **复用现有 Lead 模型，不重新设计**（见 memory `onboard-reuse-existing-lead-experience`）。 |
| 6 | **ship 风险** | Annie **接受** self-hosting 的 ship 风险（碰核心运行时的 PR 重启可能当场弄死系统自己）；兜底 = 真出事再开一个独立 terminal 救回来。Annie **倾向越自动越好**。 |

---

## 3. 唯一真正"新"的设计点：self-hosting ship / 重启安全边界

这次 onboard 跟 sub/joycon 唯一不同：**这个 Lead 的 Runner 改的正是跑 Flywheel 的代码。**

- **写代码阶段安全** —— worktree 隔离（Runner 跑在 `~/Dev/flywheel/worktrees/<execId>`，主 checkout 不动）。已审计确认（见 research §3）。
- **风险只在 ship 那一步** —— 涉及 Bridge / Lead runtime 的 PR，merge + build + 重启 Bridge/Lead **可能当场弄死系统自己**（包括正在干活的这个 Eng Lead，甚至触发重启的那个 Runner 自己）。
- 已审计确认：现成 CD 机制（`spin.md` Step 3.4 + `scripts/restart-services.sh`）**只在 main repo 是 flywheel 时自动跑重启** —— 也就是说，**只有这个新 Eng Lead 的 Runner 会触发"自我手术"**。其它项目（geoforge3d/sub/joycon）的 Runner 不碰这条路径。完整 trace 见 research §4。

### 这个边界要回答的核心问题

**全自动 vs hybrid**：往全自动靠，必要时 hybrid —— 不碰 Bridge/Lead runtime 的改动走自动 merge + 自动重启；碰核心运行时的改动走（已 founder-gated 的）手动门 + 安全的 detached 重启执行路径。

> ⚠️ 具体边界 + 执行机制 **留给 research/plan + codex-design-review 定**（这是本 issue 的核心技术设计任务），不在本 exploration 拍死，也不中途烦 Annie。与 **FLY-245**（write-capable Lead 的 founder gate）协同 —— 注意区分：FLY-270 的 Eng Lead 是 **Claude Lead**（照 Peter），merge 授权走现成的 `founder-only-authority` + `verify-approval`，已经是 founder-gated；FLY-270 要新解的是 **merge 之后的"重启自己"** 这一步（它不是 `/api/actions/*` 动作，不被 FLY-245 的闸覆盖）。

---

## 4. Onboard 落地清单（reuse FLY-189/190，细节见 research/plan）

- `projects.json` 新增条目（`projectName=flywheel`、`projectRoot=~/Dev/flywheel`、`projectRepo=xrliAnnie/flywheel`、`canSpawnRunners:true`、`department: engineering`）。
- 新建 Discord bot + token（写 `~/.flywheel/.env`）+ 频道（评估 #flywheel + #flywheel-core 双频道，照 joycon/sub 的 option C 拓扑）。
- Lead persona / agent 文件（`.lead/<leadId>/identity.md` + `agent.md`，照 Peter）+ **人格名**（待定，plan 阶段提 2-3 个候选给 Annie；Eng Lead 主题倾向 Disney 工程师/造物者人格，如 Tadashi / Edna / Gyro 之类）。
- launchd plist 常驻（照 `com.flywheel.lead.geoforge3d-product-lead.plist`）。
- FLY issue 的 **label / match 规则**（当前 FLY issue 无统一 label；为避免与 GeoForge3D Peter 的 `Product` label 跨线，倾向给 flywheel 一个**专属 scope label**，见 research §5）。
- `.flywheel/config.yaml`（Blueprint/Runner 侧，`team_id: FLY`）+ executor agent 文件。

---

## 5. research / plan 要解决的开放项（plan 给 Annie 选项，不擅自拍 + 不中途烦 Annie）

1. **self-hosting ship / 重启安全边界**（全自动 vs hybrid，与 Codex 在 design-review 定 + 与 FLY-245 founder gate 协同）—— **核心技术任务**。
2. **Lead 人格名 + 频道拓扑**（提 2-3 个候选 + 单 #flywheel vs #flywheel + #flywheel-core 双频道）。
3. **FLY issue 的 label / match 规则**（专属 label vs 复用 `Product`；含与 Peter 的跨线分析）。
4. **自托管部署执行者**（谁做 merge/build/重启 —— 跟安全边界绑定：inline 的 Runner？detached 的 launchd updater？还是 Annie 手动门？）。

---

## 6. 不在本次范围 / 有意不碰

- **不做真生产 cutover**：不编辑活的 `~/.flywheel/projects.json`、不真建 bot、不装 launchd、不重启 Bridge/任何 Lead。所有物料只在 PR + worktree 里交付，真上线 = Annie 的 deploy 闸（QA 过后她拍）。
- **不重新 brainstorm**（方向已锁）。
- **不重新设计 Lead 体验**（复用 Peter 模型）。
- **不引入新抽象** —— 复用现成 onboard 机制（projects.json / config.yaml / claude-lead.sh / setup-discord-lead / CD 脚本）。
