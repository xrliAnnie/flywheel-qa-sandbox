# Exploration: 从零起一个全新项目 (tidal-echo) — FLY-284

**Issue**: FLY-284 (Onboard a brand-new project from scratch via Flywheel — start-from-zero flow)
**Date**: 2026-06-16
**Status**: Complete（brainstorm 已与 Annie 多轮对话式完成，方向锁定）
**Author**: runner-4059d190

> brainstorm 以 Annie 硬要求的**对话式、一问一答、自适应多轮**方式完成（经 Tadashi 双向 relay 到 [FLY-284] thread）。本文落定结论，下游 research / plan 见同名文件。

---

## 0. 一句话

Annie 要一个**内容 / 自媒体项目** (`tidal-echo`)，帮她做内容。本 issue 的交付 = **把这个新项目的"框架"从零搭起来**（repo 骨架 + Discord + Lead 权限/access + Flywheel wiring + Linear team/project/label + 一个 content 部门 + 两个 Lead）。框架搭好后 Annie **直接跟新 Lead 聊**具体怎么做内容 —— 具体内容生产（数字人/配音/视频/平台策略）**不在本 issue**。

---

## 1. Annie 已定调（brainstorm 多轮结论，方向锁定）

| # | 维度 | 取值 |
|---|------|------|
| 1 | **项目名 / repo** | `tidal-echo`（Annie 超爱"潮汐一般的回响"——浪漫 + 回响/反馈多，寓意贴自媒体） |
| 2 | **位置** | `~/Dev/tidal-echo`（与现有项目一致，统一在 `~/Dev`） |
| 3 | **GitHub repo** | `xrliAnnie/tidal-echo`（私有；建仓走 founder-gated 步骤） |
| 4 | **架构** | **CoS + 1 个 content 部门 Lead，一开始就立两个**（Annie 选 B；她预见以后除 content 还会加别的 Lead，要 CoS 一开始就管起来） |
| 5 | **CoS Lead** | **Triton**（海王，Ariel 的父亲；统领、把关，同"小美人鱼"宇宙） |
| 6 | **Content Lead** | **Ariel**（小美人鱼，标志性的"声音"，贴她的内容/配音方向） |
| 7 | **Content Lead 职责** | ① 先帮她 research、定内容做什么/风格方向；② 之后每周一起产出内容（端到端，照 sub 的 content-executor 模型） |
| 8 | **交付边界** | 这次只"搭框架"。框架好了 Annie 直接跟 Ariel 聊实现 |

**明确出界（Annie 原话"这里不用讨论"，只当未来那个 Lead 的背景）**：数字人（录她声音，ElevenLabs/MiniMax）、内容生产（动画/视频+剪辑+传 YouTube）、平台策略（短/长/文字分发）。**本 issue 不做、不深问。**

---

## 2. 我审计后的关键事实（为什么 from-scratch 是真有缺口的）

- 现有三次 onboard（FLY-189 joycon / FLY-190 sub / FLY-270 self-host）跑通的是同一套成熟模板，但**都从一个已存在的 repo + 已定的 idea 起步**。
- `tidal-echo` 的真正新缺口 = **前半段**：idea→建 GitHub repo→建 Linear project/label→`.flywheel`/`.lead` 骨架。`doc/engineer/onboarding/new-project-flywheel-setup.md` 的 "Out of scope (v1.28+)" 明确把 `flywheel init` scaffolder + 建仓集成 defer 了 —— 这正是本 issue 要补的零到一缺口。
- 后半段（Discord bot / projects.json / launchd / executor agent / doc-flow）已成熟，**复用、不重造**。

## 3. 兄弟 issue（无 scope 重叠）

- **FLY-283**（onboard 已存在的 repo / re-onboarding）已被 Annie 并入 **FLY-285**（Mufasa+Belle re-onboard + 升级 COE）。
- 所以 **FLY-284 干净地就是"全新、零 repo"这一支**。COE / 多层 roster 的深探归 FLY-285；本 issue 的 CoS+Content 两层是为 tidal-echo 自身搭的、最小可用形态。

---

## 4. research / plan 要解决的开放项（plan 给推荐，机械的自定，真取舍才问 Annie）

1. **交付物形态**：薄 `flywheel init` scaffolder（可复用）vs 只为 tidal-echo 走一遍清单（一次性）。research 倾向：**FLY-205 模式** —— 做一条最小可复用 setup 路径，tidal-echo 是它第一次真实运行。
2. **Linear 结构**：~~新建 project under 现有 team（照 sub）vs 新建专属 team~~ → **Annie 拍定（2026-06-16）= 新建专属 team「TIDE」（issue key `TIDE-NN`）** + 两个 routing label（`Tidal-Echo` content / `Tidal-Echo-Triage` CoS）。config.yaml `team_id: TIDE`。team 创建归 cutover。
3. **建 bot 必须 Annie 手动**（token/2FA/邀请/频道）—— plan 列清"哪些她手动"。
4. **live-cutover 边界**：照所有过往 onboard —— **物料只在 PR/worktree 交付，不碰 live config / 不真建 bot / 不装 launchd / 不重启 Bridge**，真上线 = Annie 的 deploy 闸。
