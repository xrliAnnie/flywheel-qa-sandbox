# FLY-1063 GitHub PR 🆒 → 自动 CI/CD ship — 实施计划（PRD，方案 B）

Issue: FLY-1063 (https://linear.app/geoforge3d/issue/FLY-1063/prd-github-pr-comment-自动-cicd-ship系统-全-repo-通用annie-点名-hl-出-prd)
日期: 2026-07-09
基于: exploration.md + research.md + proposal.md（同文件夹）；Annie 2026-07-09 拍板（经 HL brief d0e35e21）

> **与统一 CI/CD PRD（FLY-1098）的关系**：Annie 2026-07-09 定：本 PRD（Option-B ship 流程）**先 ship**，随后其内容作为 **FLY-1098 统一 CI/CD PRD 的「ship 段」输入**并入；CI/CD 其余议题（门禁 / CI / deploy 的统一设计）在 FLY-1098 推进。本文件是那条 ship 段的已定稿源。

---

## 0. Annie 拍板结论（本 PRD 的前提，不再重开）

| # | 问题 | Annie 的决定 |
|---|------|--------------|
| Q1 | source of truth | **方案 B**：**Discord = 授权源**（她说 cool 就是 founder 授权），**GitHub = 执行 + 门禁**，不是竞争授权 |
| Q2 | 身份分离（bot vs 她本人账号） | **暂不做**，先用她的 GitHub 账号。**列 follow-up，并注明：产品化给外部用户时是前置**（理由见 §7） |
| Q3 | 第一批 repo | **FlyView + GeoForge3D**。**FlyView = flywheel 本仓**（Annie 2026-07-09 确认，「Flavio」= FlyView = Flywheel 的产品名，不是另一个 repo）。故第一批 = **flywheel + GeoForge3D** |
| — | 关键设计意见 | **所有 repo 用同一个 flow，变的只是 gate 的重量** |
| — | 记账 | **「记账」是流程里的一等步骤**，🆒 flow 最后一步自动销账 |

写死一句话：**Discord 授权，GitHub 执行。**

> **命名已确认（Annie 2026-07-09）**：**FlyView = flywheel 本仓**（是 Flywheel 的产品名，不是另一个/待建 repo；`xrliAnnie/flyview` 实测 404 正因它不是独立 repo）。故第一批 = **flywheel + GeoForge3D**（两者实测都存在：`xrliAnnie/flywheel`、`xrliAnnie/GeoForge3D`），与「Flywheel-first」一致。

---

## 1. 目标 / 非目标

**目标**
1. 把「Discord 授权 → GitHub 执行」这条链**从提示词契约变成机械保证**。
2. 所有 repo 走**同一个 🆒 flow**，形状恒定、gate 重量可变。
3. 🆒 flow 收尾**自动销账**，让三本账（Linear / Bridge session / GitHub PR）不再各说各话。

**非目标**
- ❌ 不做身份分离（Q2，follow-up）。
- ❌ 不设计门禁（Prow）/ CI / deploy 的**内部实现** —— 那是 eng 交付（§6），本 PRD 只在流程层引用「有个门禁 + CI/CD + deploy」。
- ❌ 不做「GitHub 亲发 🆒 作审批」（方案 A 已被否，相关分析留档 research §C 供 follow-up）。

---

## 2. 核心流程（Annie 亲述的 5 步）

```mermaid
flowchart TD
    A["① Annie 在 Discord 拍 cool<br/>(= founder 授权，唯一授权源)"] --> B
    B["② Runner 去 GitHub 触发门禁<br/>(发 🆒 comment)"] --> C
    C{"③ 门禁 + CI/CD 全跑<br/>鉴权 → gate → CI"}
    C -- 全绿 --> D["自动 squash-merge to main"]
    C -- 任一红 --> X["❌ 不 merge，回报失败"]
    D --> E["④ deploy（各 repo 自己的方式）"]
    E --> F["⑤ Runner 回 Discord 报搞定<br/>+ 自动销账 + 清理 worktree/session/thread"]
```

关键读法：**②③ 只是执行与门禁**。授权在 ① 就发生了，且只在那里发生。GitHub 侧**永不产生授权**，只负责「核验授权是否存在」并执行。

---

## 3. 恒定形状 + 可变 gate 重量（Annie 的核心设计意见）

**形状恒定**（每个 repo 都一样）：

```
🆒  →  鉴权  →  gate / CI  →  merge  →  记账
```

**变的只是「gate」这一格的重量**：

| gate 档 | 适用 repo | gate 内容 |
|---------|-----------|-----------|
| 重 | 代码 repo（flywheel、GeoForge3D） | 门禁（Prow 类）+ 全套 CI：build / typecheck / lint / test |
| 中 | 配置 / skill repo（flywheel-skills） | lint + contract fixture + blocklist |
| 轻 | 纯文字 / 视频 / 内容 repo | 极轻，甚至只有格式检查 |
| 空 | 纯素材 repo | 无 gate —— **但照样走 🆒 flow**，等于「🆒 → 鉴权 → merge → 记账」 |

**这正好落在 reusable workflow 上**：

- 中央一份 `workflow_call` 核心 workflow，封装恒定形状里的 **🆒 → 鉴权 → merge → 记账**；
- 每个 repo 一个**瘦 caller**，把自己的 gate 作为一个 job 注入；**轻 repo 就声明一个空 gate**。

**机制可行性（已核实）**：本仓是**个人账号下的 private repo**（非 org），但 GitHub 自 2022-12 起 GA 支持**私有仓跨 repo 复用 reusable workflow**，只需在中央 repo 的 Settings → Actions → General → Access 选 *"Accessible from repositories owned by `<user>`"*。所以「中央一份 + 瘦 caller」在我们这个非-org 形态下**成立**。
（代价：个人账号**没有** org 级 `.github` 模板仓、**没有** org audit log。）

---

## 4. ⚠️ 核心 eng 硬要求：GitHub 侧必须去核账本

> 这是本 PRD 最重要的一条。**不做这条，方案 B 的「Discord 才拍板」就是假的。**

### 4.1 现状漏洞（实测，非推测）

今天 `ship-on-comment.yml` 的授权闸**只检查 commenter 有没有 write 权限**（`ship-on-comment.yml:34-54`）。它**从不查任何审批账本** —— 不读 CommDB、不读 StateStore、不调 verify-approval、不经 Bridge。

→ **任何有写权限的人 / 进程，在 PR 上打一个 🆒，就直接 ship 了。Annie 在 Discord 根本没批过。**

### 4.2 威胁模型（落到本仓真实情况）

实测：`xrliAnnie/flywheel` 的 collaborator **只有 `xrliAnnie` 一人**（admin）。所以「任何有写权限的人」在今天**不是外部第三方**，而是：

> **这台 Mac 上任何持有她 gh token 的 agent / 进程** —— 每个 Runner、每个 Lead、任何被 prompt 注入或跑飞的 agent、任何残留进程。

它们**今天**能做的：跳过 `verify-approval`，直接 `gh pr comment --body ":cool:"` → 合并进 main。拦住它们的**只有提示词契约**（`Blueprint.ts:1474-1481`），没有任何机械闸。这正是 Annie 要的「Discord 拍板」被架空的路径。

### 4.3 附带发现：**根本没有 branch protection**

`Blueprint.ts:1481` 写着「the project's own CI/CD + **branch protection** is the hard merge boundary」。实测这句话**不成立**：

```
gh api repos/xrliAnnie/flywheel/branches/main/protection
→ 403 "Upgrade to GitHub Pro or make this repository public to enable this feature."
```

**private repo + GitHub Free ⇒ branch protection 这个功能根本不可用。** main 上没有任何保护，也**无法**配置「required status check」。（FLY-350 M-2 当时的结论是「admin 能绕过」；真相比那更弱 —— 闸门压根不存在。）

这条直接影响 §4.4 的机制选型：**不能依赖「branch protection 要求某个 check 通过」来落地闸门**。

### 4.4 硬要求陈述

> **REQ-1（必须）**：🆒 flow 在 merge 之前，**必须独立核验「这个 PR head 存在一条 founder 批准的 gate 记录」**，复用现有账本判定（founder-attributed 的 `approved:true` + **绑定 head sha** + Codex review 硬闸）。**不得**仅以「commenter 有 collaborator 写权限」作为放行依据。
>
> **REQ-1a（必须，Codex R1 HIGH-1）**：现有 `verify-approval` **不能**只靠 `--pr-head <sha>` 调用。它需要 **`--exec-id`** 和一个 CommDB 路径（`--db` / `--project` / `FLYWHEEL_COMM_DB`），内部按 `sessions WHERE execution_id = ?` 查（`verify-approval.ts:222-226`；CLI 参数 `index.ts:823-851`）。而 GitHub `issue_comment` 事件只给 `(owner/repo, PR number, commenter)` —— **PR head sha 还要再调 GitHub PR API（`pulls.get`）取**（现有 workflow 就是这么拿的，`ship-on-comment.yml:56,:86`；`issue_comment` payload 不直接带 head sha），且**没有** Flywheel `execution_id`、也没有 project 名。因此必须新增一个 **`cool-ship-gate` resolver**：输入 `(owner/repo, prNumber, headSha)` → 映射 repo→`projectName` → 在 StateStore 里选出**恰好一个**匹配 session：条件 = `pr_head_sha==headSha` **且 `pr_number==prNumber`**（两者都要，Codex R2 LOW —— 只靠 head sha 在极端情况可能撞车/复用）**且** `awaiting_review`/`approved_to_ship` → 用显式 `execId` + `commDbPathForProject(projectName)` + `stateDbPath` 调账本判定。**0 个或 >1 个匹配一律 fail-closed**（不 merge + PR 留言）。
>
> **REQ-1b（必须，Codex R1 HIGH-2）**：这个 gate job 跑在 Annie 的 Mac（账本所在机）上，**绝不能执行 PR head checkout 里的 verifier 代码**（不 `pnpm install`、不跑 PR 的 `node packages/...`、不跑 PR 的任何 package script）。它只跑**可信代码**：已部署的 main checkout 里预装的 `flywheel-comm`/gate helper，或一份 pin 到 main 的干净 checkout。**PR head 的 build/test 留在 GitHub 托管 runner（`ubuntu-latest`）上**，与本地账本 job 分离。merge job `needs: [ledger_gate, ci_gate]`。
>
> **REQ-2（必须）**：核验失败 ⇒ **不 merge**，并在 PR 上留下可见的失败原因。静默放行 = 违规。

### 4.5 机制候选与推荐（实现细节归 eng，此处给方向、约束与理由）

难点：**账本在 Annie 的 Mac 上（Bridge / CommDB / StateStore 都是 localhost）；而 GitHub 托管 Actions 跑在云端 `ubuntu-latest`，够不着。**

| # | 机制 | 评价 |
|---|------|------|
| **M1** | **在 self-hosted runner（Annie 的 Mac）上加一个 gate job**，经 `cool-ship-gate` resolver（REQ-1a）→ 账本判定；merge job `needs:` 它 | ✅ **推荐**。账本就在本地，复用**生产同一套**判定，保真度最高。GEO-175 早已规划过 self-hosted runner。**但必须满足 REQ-1a（resolver）+ REQ-1b（只跑可信代码）才成立** |
| M2 | Bridge 在批准通过后往该 head 写一条 check-run，workflow 断言其 `app.id` | **结构性**归属断言需要 GitHub App —— 属 Q2 已推迟的身份分离。且**不能**作 required-status-check 硬墙（无 branch protection，见下）。**可**作 workflow 内部断言，但保真度低于 M1（挡不住直接 push / 手动 merge） |
| M3 | Runner 在 🆒 里带 HMAC 签名的一次性 ship token，workflow 用 repo secret 验签 | 引入共享密钥 + 重放/nonce 管理；且在无 branch protection 的仓里，能改 main 的 agent 也能捞到密钥 → 并未真正收口 |
| M4 | Bridge 暴露公网 verify 端点给 workflow 调 | 引入入站攻击面。不推荐 |

**推荐 M1**（满足 REQ-1a/1b 前提下），它有一个**关键安全性质（已查证）**：

> `issue_comment` 事件触发的 workflow，**永远使用默认分支（main）上的那份 workflow 文件**，PR 分支**改不动**它（`GITHUB_REF`/`GITHUB_SHA` 都是默认分支）。

所以「哪个 job 编排、gate 怎么跑」这道闸**无法被 PR 分支上的 YAML 改动绕过**。但——**这只保护 YAML，不保护 job 内执行的代码**：若 gate job 去 checkout 并运行 PR head 的 verifier，仍会执行到被篡改的代码。这正是 REQ-1b 存在的原因。

**M1 的已知边界（必须诚实写出，交 eng 权衡）**：
- 依赖 Annie 的 Mac 在线；Mac 离线 ⇒ ship 停摆（可接受：Runner 本来就跑在这台机器上）。离线时 UX 要明确：是「job 挂起等 runner」还是「显式 failed + PR 留言」，eng 定。
- 只适用于**账本在这台机器上**的 repo（flywheel、GeoForge3D 都是）。没有 Bridge 账本的 repo（纯内容 repo），gate job 按档位省略（§3「空 gate」）——那类 repo 本就没有「Discord 授权」这条链，形状仍一致。

> **REQ-2a（必须，诚实边界，Codex R1 MED-5）**：M1 关掉的是**「用 gh token 发 :cool: 绕过账本」**这条路和角色混淆，**不是**「同机恶意进程直接改账本 / 直接 push main」。`verify-approval` 源码自陈：`comm.db`/`teamlead.db` **不是进程级完整性边界**（`verify-approval.ts:35-42`）；同机有写权限的进程可以伪造可信来源。PRD 不夸大 M1 的防护面。→ 交 eng 的前置检查：账本 DB 文件权限、self-hosted runner 跑在哪个用户下、FLY-175 `DECISION_MODE` 是否 `enforce`。
>
> **REQ-2b（必须 —— 对齐谓词，且必须跑在「无 bypass」的 strict 姿态，Codex R1 MED-3 + R2 MED）**：Bridge 侧 finalization 用的不是裸 `verifyApproval`，而是 `evaluateShipEligibility`（= 合并批准侧 `verifyApproval` + QA 侧 `evaluateQaShipGate`，`ship-eligibility.ts`），再经 `computeShipDecision` / `merge-ship-gate.ts` 决定能否落终态。GitHub 侧的 gate **应对齐同一个 `evaluateShipEligibility` 谓词**，避免「GitHub 放行了、Bridge 却判不该 ship」的分叉。若刻意只覆盖「Discord 批准 + Codex」而把 QA 留给独立 job，需**显式写明**并证明「approval 不可能在 QA-required 状态满足前被写入」。
>
> **关键（否则 REQ-1 的「机械保证」是空的）—— strict 无-bypass 姿态**：这套谓词自带多个 **bypass env 开关**，任一打开都会让「未经 founder 授权 / 未过 Codex / 未过 QA 的 head」溜过去。所以 GitHub gate **不能**照搬谓词的默认姿态，**必须以 strict 姿态运行：对任何一个会削弱「founder 授权 + Codex + QA」的 bypass 开关一律 fail-closed（不 merge）**。已知的开关（Codex R2+R3 核出，eng 落地时须对着 `ship-eligibility.ts` + `verify-approval.ts` 核全，别漏）：
> - `FLYWHEEL_MERGE_APPROVAL_GATE=0` → **整个跳过** `verifyApproval`（`ship-eligibility.ts:239`）；
> - `FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0` **或 founder id 解析不到** → Lead 自批也能通过（`verify-approval.ts:320`）；
> - `FLYWHEEL_CODEX_HARD_GATE=0` → 跳过 Codex 硬闸（`verify-approval.ts:379`）；
> - `FLYWHEEL_QA_DONE_GATE=0` → QA 侧直接返回通过（`ship-eligibility.ts:124`）。
>
> **要求**：strict 模式要么不认这些 bypass、要么在 gate 里前置断言它们全「开且可解析」，任一不满足即 fail-closed。**唯一 sanctioned 例外 = `codex_skip` session**（显式批准的免 Codex 例外，照旧尊重）。若 QA 交给独立 CI job 承担，则**显式限定这一条 QA 例外**并证明「该 job 必须通过才能 merge」。不这么做，「Discord founder 授权 = 机械保证」在生产任一 bypass 打开时就不成立。

> **REQ-3（应做，Codex code R1 HIGH — 我原来写得不够）**：给 `main` 上真正管得住 admin 的保护。**两点都要，缺一不可**：
> 1. **拿到可用的 branch protection**：个人账号私有仓的 branch protection 需 **GitHub Pro**（Free 不行）；**注意 Free org 一样没有** —— org 私有仓的 branch protection 需 **Team / Enterprise**。所以「转 Free org」并不能解决，必须是「个人 Pro」或「Team+ org」。
> 2. **显式禁止 admin 绕过**：即便配了保护，**管理员默认可绕过**。而 `xrliAnnie` 正是 admin —— 不勾 **「Do not allow bypassing the above settings」/ `enforce_admins`**，保护对她（以及任何以她 token 行事的 agent）等于不存在。这条正是本题威胁模型的核心，必须打开。
>
> 否则 main 永远敞着，任何机械闸都只是「正门上锁、后门大开」。这条独立于 🆒 flow，但**不做它，REQ-1 的价值会被 admin-token 直接 push 绕过**。建议一并交 eng 评估。

### 4.6 上线次序（迁移，必须显式 —— Codex R1 MED-4）

REQ-1 会**改动合并闸**。若在 self-hosted runner + resolver + 可信 helper 就位并验证**之前**就改 `ship-on-comment.yml`，会让**现有每一个 Runner 的 :cool: ship 全部 fail-closed**。所以次序必须是：

1. 装/注册 self-hosted runner（Annie 的 Mac）；
2. 从 main 部署可信 `cool-ship-gate` helper + repo→project 映射 + PR→exec resolver；
3. 拿一个已知的「已批准 / parked」session **dry-run** resolver + 账本判定，确认判定正确；
4. workflow 里先以 **observe / report-only** 模式挂 `ledger_gate` 跑一轮（只报告、不阻断），核对它对真实 ship 的判定；
5. 确认无误后，才把 merge job 改成 `needs: ledger_gate`（正式阻断）。

> 好消息（Codex 核实）：M1 与现有 Runner 时序**不冲突**——Discord 批准后 session 停在 `approved_to_ship`，Runner 发 :cool: 后**只有 PR 真 merged 才标 completed**；且 `verify-approval` **不自己** `git rev-parse HEAD`，而是校验调用方传入的 `--pr-head`，所以从 workflow 把 PR API 的 `head.sha` 传进去是可行的。唯一风险就是上面的**上线次序**。

---

## 5. 「记账」作一等步骤（Annie 亲口列进流程）

### 5.1 要解决的病

三本账各说各话（Annie 今晚的质疑）：

- **Linear**：活干完了，issue 还挂在 Backlog；
- **Bridge**：一堆 session 状态还显示「在跑」，其实早死了；
- **GitHub**：PR 合了，但相关状态仍是 dormant。

### 5.2 要求

> **REQ-4（必须）**：🆒 flow 的**最后一步**自动销账，把该 issue 的三本账推到一致的终态：
> 1. **Linear** issue → Done；
> 2. **Bridge** session → 终态 + landing 状态写实（`merged` + merge commit sha）；
> 3. **GitHub** PR → merged、分支删除、thread/worktree/session 清理（Annie 的第 ⑤ 步）。
>
> **REQ-5（必须）**：销账必须**幂等**（重跑不产生第二次副作用）且**失败可见**（销账失败要留痕/告警，不得静默吞掉 —— 静默吞就是这个病的成因）。

### 5.3 与现有机制的接点

现有 FLY-369 cascade（landing signal → `stage set completed` → 自动清理 + thread 归档 + Linear Done）已经是这件事的雏形，但**它挂在 Runner 自 ship 这条路上**。本 PRD 要求把销账做成 **🆒 flow 自身的一步**，这样无论谁触发的 🆒、Runner 是否还活着，账都能销掉。

---

## 6. 归属：哪些是 eng 交付（→ Tadashi）

本 PRD **只到流程层**。以下**技术实现**为 eng 交付，打 `Flywheel` label 路由到工程：

- 门禁（Annie 以 **Prow** 作类比；是否真的引入 Prow、还是用现有 GitHub Actions 组合，**选型归 eng**）；
- CI/CD 的具体 job 编排；
- 各 repo 的 deploy 腿（flywheel 走本机 self-ship launchd 更新器；GeoForge3D 走它自己的部署）；
- §4.5 的机制落地（M1 self-hosted gating job 的具体实现）；
- §5 销账的具体实现与幂等保证。

---

## 7. Follow-up：身份分离（产品化给外部用户时的**前置**）

Annie 决定**现在不做**，先用她自己的 GitHub 账号。但必须列为 follow-up，且写明**产品化对外时这是前置**。理由（Annie 给的四条）：

1. **不能让 bot 用客户本人的账号发言**；
2. **审计要分清「谁拍板」vs「谁执行」**；
3. **bot 应当最小权限，不该是 ADMIN**；
4. **bot 发疯时，炸的范围要有界。**

现成底稿见 **research.md §C**（四维取舍 + 实测证据），结论摘要：

- **GitHub App** 提供**结构性判别式** `user.type == "Bot"`（本仓 `linear[bot]` 实测证实），是硬判别；
- **专用 bot 机器账号**只能靠 **login 白名单**（软判别），但安装便宜（个人账号 Free 版私有仓 collaborator 无限、$0）；
- 两条路都绕不开一条机制约束：**workflow 自带的 `GITHUB_TOKEN` 发的 comment 不会再触发 workflow**（官方防递归），所以机械 🆒 必须来自 PAT 或 App installation token。

> 现状实测：**100% 的真实 ship run，actor 都是 `xrliAnnie` / `type=User`** —— 「谁拍板」与「谁执行」在 GitHub 上**零区分度**。这正是理由 ② 的实证。

---

## 8. Rollout（Flywheel-first）

| 阶段 | repo | 说明 |
|------|------|------|
| P0 | **flywheel**（= FlyView，Annie 已确认同一仓） | 先跑通：M1 gating job + 销账 + 瘦 caller |
| P1 | **GeoForge3D** | 第二个代码 repo，验证 gate 重量可变 + deploy 腿 per-repo |
| P2+ | 其余 repo（flywheel-skills / 内容 repo…） | 验证「轻 gate / 空 gate」档，形状不变 |

不强求一步到位做成 generic 模板；**先在 flywheel 落地，形状对了再抽 reusable workflow**。

> **空 gate 语义须先说清（Codex R2 LOW）**：对**没有 Bridge 账本**的 repo（纯内容 / 素材 repo），🆒 flow 里**没有** REQ-1 的账本核验这一环 —— 因为这类 repo 本就不存在「Discord 授权」这条链。它的「空 gate」= 「🆒 → commenter 鉴权 → merge → 记账」，授权语义**退化为「commenter 是被授权者」的普通鉴权**（不是 founder 账本授权）。这个区别必须在**广泛 rollout 之前**在瘦 caller 的约定里写死，避免有人以为「空 gate repo 也有 Discord 授权保护」。

---

## 9. 风险与 open questions

| # | 项 | 状态 |
|---|----|------|
| R1 | ~~FlyView 是否就是 flywheel 本仓~~ | ✅ **已确认（Annie 2026-07-09）：FlyView = flywheel 本仓**。第一批 = flywheel + GeoForge3D |
| R2 | 无 branch protection（Free plan 限制），main 敞着 | REQ-3，建议一并解决 |
| R3 | M1 依赖 Mac 在线 | 可接受（Runner 本就在这台机器） |
| R4 | 「门禁」是否真的引入 Prow | 选型归 eng |
| R5 | REQ-1 落地后，**现有 Runner 的 `:cool:` 路径必须同步**（它今天不带任何可核验凭据，只靠先跑 verify-approval 的契约） | eng 拆单时一并处理 |

---

## 10. eng 拆单建议（交 Tadashi，打 `Flywheel` label）

1. **[P0] `cool-ship-gate` resolver + 可信 gate helper（REQ-1a/1b）** —— 输入 `(repo, PR#, headSha)` → repo→project 映射 → StateStore 选唯一匹配 session → 用显式 `execId`+CommDB+StateStore 调账本判定；**只跑 main 侧可信代码**，绝不跑 PR head。0/多匹配 fail-closed。
2. **[P0] 🆒 flow 去核账本 + 阻断合并（REQ-1/REQ-2）** —— self-hosted `ledger_gate` job 调 #1 的 helper；merge job `needs: [ledger_gate, ci_gate]`（PR-head 的 build/test 留 `ubuntu-latest`）；失败在 PR 留言。**按 §4.6 次序上线**（先 observe/report-only 一轮再阻断）。
3. **[P0] 对齐 `evaluateShipEligibility` 谓词 + 跑 strict 无-bypass 姿态（REQ-2b）** —— gate 用与 Bridge finalization 同一谓词；**且对任何削弱「founder 授权 + Codex + QA」的 bypass 开关一律 fail-closed**（已知 4 个：`FLYWHEEL_MERGE_APPROVAL_GATE`/`FOUNDER_ATTRIBUTION_GATE`/`CODEX_HARD_GATE`/`QA_DONE_GATE` + founder id 可解析；eng 落地对着源码核全）。唯一例外 = `codex_skip`；QA 若交独立 job 则显式限定并证明该 job 必须通过。
4. **[P0] 销账做成 🆒 flow 一等步骤（REQ-4/REQ-5）** —— Linear / Bridge landing / GitHub 三本账推终态，幂等 + 失败可见。
5. **[P1] branch protection + 账本完整性前置（REQ-3/REQ-2a）** —— 给 main 上锁：**个人 Pro**（或 Team+ org，Free org 无效）**且**开 `enforce_admins`/「Do not allow bypassing」（否则 admin xrliAnnie 直接绕过）；再核账本 DB 文件权限、runner 用户、FLY-175 `DECISION_MODE` 姿态。
6. **[P1] 抽 reusable workflow + 瘦 caller** —— 恒定形状集中一份，gate 作为可注入 job；轻 repo 声明空 gate。
7. **[P1] GeoForge3D 接入** —— 验证 gate 重量可变 + per-repo deploy 腿。
8. **[follow-up] 身份分离** —— 产品化对外前的前置（§7）。

---

## 附：本 PRD 引用的实测/查证清单

> `gh api` 各行为 **runner 于 2026-07-09 在已认证 shell 实测**（date-stamped measurement）。Codex R1 review 环境的 gh token 失效、无法 fresh revalidate 这几行 —— 故此处以「runner 实测 + 日期」为准，非 Codex 二次确认。源码/文档行 Codex 已独立核对。

| 断言 | 来源 |
|------|------|
| 只检查 write-collaborator，不查账本 | `.github/workflows/ship-on-comment.yml:34-54` |
| Runner 发 🆒 且 :cool: 是唯一 merge 路径 | `packages/edge-worker/src/Blueprint.ts:1479, :1481` |
| verify-approval 的 8 道 fail-closed 判定（含 head-sha 绑定、Codex 硬闸） | `packages/flywheel-comm/src/commands/verify-approval.ts` |
| 唯一 collaborator = xrliAnnie(admin) | `gh api repos/xrliAnnie/flywheel/collaborators` |
| **无 branch protection**（Free plan 403） | `gh api repos/xrliAnnie/flywheel/branches/main/protection` |
| 100% 真实 ship run actor = xrliAnnie / type=User | `gh api .../actions/workflows/254044724/runs` |
| GitHub App comment 结构性可辨（`linear[bot]`, `type=Bot`） | `gh api repos/xrliAnnie/flywheel/issues/524/comments` |
| `xrliAnnie/flyview` 无独立 repo（FlyView = flywheel 本仓，Annie 确认）；GeoForge3D / flywheel-skills 存在 | `gh api repos/xrliAnnie/<name>` + Annie 2026-07-09 确认 |
| `issue_comment` workflow 恒用默认分支的文件，PR 分支改不动 | https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows |
| `GITHUB_TOKEN` 发的事件不触发新 workflow（PAT / App token 会） | https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow |
| 私有仓 reusable workflow 跨 repo 复用 GA + Access 设置 | https://github.blog/changelog/2022-12-13-github-actions-sharing-actions-and-reusable-workflows-from-private-repositories-is-now-ga/ |
| 个人账号 Free 版私有仓 collaborator 无限 | https://docs.github.com/get-started/learning-about-github/githubs-products |
