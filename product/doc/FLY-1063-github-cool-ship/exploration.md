# FLY-1063 GitHub PR 🆒 → 自动 CI/CD ship — 探索

Issue: FLY-1063 (https://linear.app/geoforge3d/issue/FLY-1063/prd-github-pr-comment-自动-cicd-ship系统-全-repo-通用annie-点名-hl-出-prd)
日期: 2026-07-09
基于: 无（本 issue 为起点；参考 doc/engineer/research/archive/GEO-175-cicd-pipeline-implementation.md）

> **本文档定位（Honey Lemon brainstorm gate 确认）**：这一版是**给 Annie 的 co-eval 提案**，不是 PRD、不下 verdict。核心是把「source of truth 分叉」讲清楚 + 给推荐 + 点明前置条件，让 Annie 拍方向。拍完方向后才拆 eng issue、才写实现级细节。

---

## 1. Annie 的原话与她真正想要的

原话（2026-07-09，[FLY-1023] thread）：

> 「我其实是希望我们在 Flywheel 中也做 🆒 这个系统。我不觉得 Discord 的这个和那个是等价的。你帮我出一个 PRD issue，让 Honey Lemon 去做一下。我希望在 PR 那边，也就是在我们的 codebase（GitHub）那边，加一个 🆒 comments 的东西，以后应该每一个 repository 都要有这个东西。」

拆出三个明确诉求：

1. **入口在 GitHub**：她要能在 PR 那边（GitHub）发 🆒，而不是只在 Discord。
2. **Discord ≠ GitHub**：她明确说两者「不等价」。
3. **全 repo 通用**：以后每个 repo 都要有。

### 1.1 一个可能颠覆假设的现状发现

**flywheel 其实已经有 🆒 ship workflow 了** —— `.github/workflows/ship-on-comment.yml`：在 PR comment 里发「:cool:」→ 跑全套 CI（build/typecheck/lint/test）→ squash-merge → 删分支。

但它今天的实际用法是：**Runner（以 xrliAnnie 这个机器身份）在 Discord 批准通过之后，自动补发一条「:cool:」来触发合并**。也就是说：

- 真正的「授权」发生在 **Discord**（founder 在 thread 里说 ship / 点 ✅ → Bridge 把 founder-attributed 的 `approved:true` 写进 CommDB 的 `approve_to_ship` gate + 绑住 PR head sha + 过 Codex review 硬闸）。
- GitHub 上的「:cool:」只是这个决定**下游的机械触发器**，founder 本人根本不碰 GitHub。

所以 Annie 说的「不等价」抓得非常准：**今天的 GitHub 🆒 不是一个「审批面」，只是一个「执行按钮」**，而且这个按钮是 bot 替她按的。她想要的，是一个她**亲自**能在 GitHub 上、**看着真实 diff**、按下去就 ship 的入口。

### 1.2 因此本 PRD 真正的问题不是「从零造 🆒」

不是造 🆒（它存在），而是：

- 把 GitHub 从「bot 镜像 Discord 决定的地方」升级为「**founder 可以亲自审批并 ship 的一等入口**」；
- 定义清楚 GitHub 入口和 Discord 入口的**关系**（谁是 source of truth）；
- 把它做成**全 repo 可复用**的形态。

---

## 2. 核心分叉：source of truth（要 Annie 拍）

Annie 自己的话里有歧义 —— 最早的诉求（「在 GitHub 加 🆒 + 和 Discord 不等价 + 想亲自看 diff」）指向一个方向，她后来在 [FLY-1023] §7 描述的先后顺序又指向另一个方向。所以这里**不锁死**，两个选项都摆出来。

### 选项 1 — GitHub 🆒 = 与 Discord ✅ 平级的第 3 个 approval source（HL 推荐、更贴她最早诉求）

- Annie 亲自到 GitHub PR，看真实 diff / 文件 / CI 状态，直接发 🆒 → 就 ship。
- 这条 founder 亲发的 🆒 被识别为一次**正式 founder 审批**，写进**同一个 gate 账本**，满足 verify-approval，然后走完全一样的 self-ship + 部署链。
- **账本（gate ledger）= 唯一 source of truth**；Discord 和 GitHub 是**两个平级入口**，都往这一个账本里写。
- 对 Annie 的体感：GitHub 和 Discord 是「同一个决定的两个门」，在哪个门拍都算数、都记账、都同样安全。

### 选项 2 — Discord 主授权，GitHub 🆒 = runner 的执行触发器（贴她后来 §7 的先后顺序）

- 保持今天的形态：Annie 在 Discord 拍板 → runner 去 GitHub 发 🆒 → 合并。
- GitHub 🆒 不承载 founder 授权，只是执行。Discord 是 source of truth。
- 这版的「全 repo 通用」= 把「跑 CI + 合并 + 记账」这套 workflow 标准化到每个 repo，但**审批仍只在 Discord**。

### 两个选项的共同底座

无论哪个选项：**账本是唯一 source of truth**（不会出现「Discord 说批了、GitHub 没记」这种账目分裂）。区别只在于「**founder 亲发的 GitHub 🆒 算不算一次授权**」。

### HL 推荐

**选项 1**。理由：更贴 Annie 最早、最具体的诉求（她要「亲自在 GitHub 看真 diff 再拍」），也真正回答了她说的「不等价」——只有把 GitHub 做成一等审批面，两个入口才真正等价可选。但这是 founder 决策，**留给 Annie 拍**。

---

## 3. 选项 1 的真前置：GitHub 上的 founder 身份识别（不解决就做不了）

这是整套里最关键、也最容易被忽略的一环。

**问题**：今天在 GitHub 上，机器身份（Runner 发 :cool: 用的）和 Annie 的个人账号**是同一个账号 `xrliAnnie`，而且是 repo 的 ADMIN**。

后果：workflow 只能看到「一条 :cool: 来自 xrliAnnie」，**无法区分**这是：

- (a) Annie **亲自**看完 diff 按的 🆒（= 一次真授权），还是
- (b) bot **机械**补发的 :cool:（= 一次执行）。

选项 1 的整个安全性建立在「能可靠识别 founder 亲发的 🆒」之上。所以前置是：**把 bot 的机械触发身份和 Annie 的个人审批身份分离**——比如给 Runner 的机械 :cool: 用一个专用 bot 账号 / GitHub App，让 `xrliAnnie` 这个个人账号重新变成「只有 Annie 本人」的身份。这样 workflow 一看 commenter 是谁，就能分清「人拍的」还是「机器按的」。

（选项 2 不强依赖身份分离，因为 GitHub 🆒 本来就不承载授权——但要防「非 founder 的 collaborator 误触」，仍需要某种身份判断。）

这条 HL 已确认：**身份分离作为选项 1 的前置，写进提案**。

---

## 4. 另外两个已基本达成一致的设计点（提案里作推荐）

### 4.1 全 repo 通用形态 → reusable workflow（推荐）

三种候选：

| 形态 | 是什么 | 优 | 劣 |
|------|--------|----|----|
| **Reusable workflow（推荐）** | 中央 repo 放一份 `workflow_call` 的核心 workflow，每个 repo 放一个 5 行的瘦 caller，deploy 腿按 repo override | GitHub 原生、可审计、升级只改中央一份、deploy 天然可 per-repo 覆盖 | 每个 repo 仍要放一个 caller 文件（可用现成分发脚本一键装） |
| GitHub App | 一个装到 org 的 App 统一监听所有 repo 的 comment | 零 per-repo 文件 | 重、要维护一个服务、审计面更黑箱、和现有 workflow 生态不一致 |
| 逐文件 sync | 像 flywheel-skills 那样把 workflow 文件同步进每个 repo | 复用现成 sync 机制 | 每个 repo 一份全量拷贝，升级=N 份漂移风险 |

推荐 reusable workflow：**通用的核心（🆒 → 身份校验 → CI → merge → 记账）集中一份**，各 repo 只挂一个瘦 caller + 自己的 deploy 腿。

### 4.2 deploy 是与 merge 分开的第二条腿（推荐）

- merge 和 deploy 是**两条独立腿**。今天 flywheel 的 :cool: 只 merge，不 deploy；部署由本机 launchd 的 self-ship 更新器（pull main + 重启服务）单独承接，而且**只服务 flywheel 自己**。
- 各 repo 的 deploy 各不相同（GeoForge3D → Vercel；flywheel → 本机 self-ship；flywheel-skills → skills-sync…）。
- 所以**通用的只到「🆒 → 身份校验 → CI → merge → 记账」**；deploy 由每个 repo 自己的 hook / 后续步骤承接。这也正是 reusable workflow 形态的天然好处。

---

## 5. 交付与流程

- **交付物**：本文件夹下 `exploration.md`（本文）+ `research.md`（现状+机制调研）+ `proposal.md`（给 Annie 的 co-eval 提案）+ 一份 founder 面交互 HTML（HL 投递，非 Runner 直投）。
- **流程**：产出 → 报 HL → HL 投给 Annie co-eval → Annie 拍 source-of-truth 分叉 → 拆 eng issue（打 Flywheel label 路由到 eng）。
- **本版不做**：不写完整 PRD、不下 verdict、不碰 founder approve gate、docs-only 不触发 QA。
- **Flywheel-first**：先在 flywheel repo 落地跑通，再谈铺开；rollout 目标 repo 清单待 Annie 确认（含 HL 提到的一个待定 repo）。

---

## 6. 留给 Annie / 后续的开放问题

1. **source of truth 分叉**：选项 1 还是选项 2？（本提案核心，要她拍）
2. **身份分离**（选项 1 前置）：接受用一个独立 bot 账号 / GitHub App 来发机械 :cool:、把 xrliAnnie 还原成「只有 Annie」的个人审批身份吗？
3. **rollout 清单**：除 flywheel 外，第一批要装的 repo 有哪些？（HL 提到有一个 repo 身份待确认）
4. **branch protection / admin-actor**：xrliAnnie 是 ADMIN 能绕 branch protection（FLY-350 M-2 已知），选项 1 落地时要不要顺带收紧非-admin 结构性保护？（可作后续）
