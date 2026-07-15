# FLY-1180 三方 Agent 身份统一 — 探索

Issue: FLY-1180 (https://linear.app/geoforge3d/issue/FLY-1180/三方-agent-身份统一discord-linear-github-存量补齐-新增标准化-统一配置自动开通)
日期: 2026-07-11
基于: 无

> **⚠️ v2 更正(权威结论以 plan.md 为准)**:本文是早期探索。经 Codex design review + Annie co-eval,以下结论已更新,**以 `plan.md` §0/§4/§9 为准**:(1) GitHub/Linear 的号池**不是**"空壳 + claim 后改名"——它俩名字/图标建号时定死、无 API 改名,只能 **identity-bound 预建**(Discord 才能空壳后改名);(2) 费用**无 per-identity seat**,但有容量上限(Discord 75/team、GitHub 100/owner),Linear 仍 Developer Preview。本文下方保留原始探索脉络,细节冲突处以 plan.md 为准。

---

## 1. Problem — Annie 到底要什么

Annie(2026-07-11,从 FLY-1170 harness agent-account 讨论岔出)喜欢「agent 能以**自己的身份**开 PR + 评论」。她要把它做成一整套:

> **每个 agent 在三方(Discord + Linear + GitHub)都有自己的身份。**

拆成三条线:

1. **存量补齐** — 现有 agent 补上 Linear + GitHub 身份(Discord 大多已有)。先补我们自己(Honey Lemon / Tadashi / Aunt Cass),再补系统里**所有** agent。
2. **新增标准化** — 以后开一个新 agent,**必须同时开 Linear + GitHub**,不能只走 Discord。产品化后一样。
3. **流程自动化** — 现状痛点是「每开一个 Discord agent 都很麻烦」。目标:**统一配置人设/名字/头像一次**,系统自动把三方身份全建好,人不用在各平台来回折腾。

外加 **费用调研**:三方各自在 10 / 100 规模的成本。

**这是一个 PRD issue,不是实现 issue。** 交付路径原文:

> 产品(HL,co-eval Annie)出 PRD:统一配置 → 自动三方开通的流程/UX + 强制三方身份策略 + 费用结论 → 拆 build issue 交 Tadashi(Discord / Linear-OAuth-agent / GitHub-App 自动开通集成)。

所以本 issue 的交付物 = **PRD 三档文档 + 费用结论 + 拆好的 build issue 清单**;真正写自动开通代码是下游 Tadashi 的 build issue。

---

## 2. Current state — 三方身份今天是怎么开的(codebase 审计)

### 2.1 Discord — 已有池化半自动(FLY-882)

- Discord **没有 API 能凭空建一个 bot Application** —— 建 App/Bot 永远是 Developer Portal 里的**浏览器动作**,只能提前批量做一次。
- FLY-882 已经建了这个基建:`~/.flywheel/discord-bot-pool/pool.json` + 每 slot 一个 `token`,预建 N=6 个空白 bot 身份;`scripts/discord-bot-pool.sh {list|verify|rename|invite-url|claim}`。
- 认领一个 Discord 身份 = `claim`(登记归谁)+ `rename`(改用户名)+ 设头像(`set-lead-avatar.sh`)+ `invite-url`(邀进 server)+ 把 token 接进 `~/.flywheel/projects.json` / `manifests/<lead>.json`(`materialize-lead-manifests.sh`,`botTokenEnv` 字段)。**这 4~5 步现在是分开手动跑的。**
- 已知坑(见 memory):`rename` 不同步 `pool.json.display_name`;`manifests.botTokenEnv` 掉成通用 `DISCORD_BOT_TOKEN` 会冒别人身份(Anna 串台事故)。

### 2.2 GitHub — 今天是**共享身份**,没有 per-agent

- 现在 agent 提交 / 开 PR 用的是**共享的 `GITHUB_TOKEN` / installation token**(`EdgeWorker.ts`:`event.installationToken || process.env.GITHUB_TOKEN`;Codex 侧 `GH_TOKEN` 经 `codex-home.ts` 注入 sandbox)。实际 commit author 往往是人类账号(`xrliAnnie`)或一个共享 bot。
- **没有** per-agent GitHub 身份的任何接线 —— 这是全新的。

### 2.3 Linear — 也是**共享身份**

- `LinearActivitySink` 把 agent 活动写进 Linear,底层是一个 `IIssueTrackerService`(共享 OAuth config / workspace)。
- **没有** per-agent Linear actor 身份 —— 也是全新的。

**小结**:Discord 有池化半自动(FLY-882),但 Linear + GitHub 是 0——今天全系统 agent 在这两方共用一个身份。FLY-1180 的存量补齐 = 从 0 给每个 agent 建 Linear + GitHub 独立身份。

---

## 3. Constraints — 平台各自的"建号"能力边界(决定架构)

这是本 PRD 最硬的现实约束:**三平台创建"原始身份容器"这一步都不是纯 headless API**,各有一个半手动步骤。

| 平台 | 建"身份容器"能力 | per-agent 身份模型 | 之后可自动化的 |
|---|---|---|---|
| **Discord** | ❌ 无 API。Portal 浏览器动作,只能**批量预建**(FLY-882 池) | 1 bot App = 1 身份 | claim / rename / avatar / invite / wire token → **全可脚本化** |
| **GitHub App** | ⚠️ **Manifest handshake**:重定向浏览器→GitHub 建 App(建号即定 name,**无 API 改名**)→回调换临时 code(1 小时内)→拿到 private key + app id。**每个 app 一次浏览器交互**,非纯 API | 1 GitHub App = 1 `xxx[bot]` 身份 | **install 普通账号仍是浏览器 owner-consent**(Enterprise Cloud 需先 bootstrap automation App 才能 API 装);token mint / commit / PR / wire → 纯 API |
| **Linear** | ⚠️ OAuth app 在 settings 建(建号即定 name/icon,**无 API 改名**)+ workspace admin 浏览器授权安装(`actor=app`) | **1 OAuth app = 1 agent 身份(严格 1:1)**;N 个身份 = N 个 OAuth app | 装好后 @mention / 派单 / 评论 → 纯 API |

**关键结论(v2 更正,以 plan.md §0 为准):** 三平台都没有"纯 API 从零建号"。**且三方不对称**:Discord 能空壳池 + claim 后 API 改名;**GitHub/Linear 名字/图标建号时定死、无 API 改名 + install/授权仍是浏览器**,只能 identity-bound 预建(照 spec 建号,非空壳后改名)。所以池对 Discord 是"匿名空壳",对 GitHub/Linear 是"照已知 agent 提前建好囤着"。

> Annie 的核心诉求「不用人工在各平台来回折腾」**可以达成**(per-agent 变成**在对话里回答几句**——plan.md 第 3 轮的 `flywheel-identity new` interview 前端,人不填文件),但 literal「零人工建号」受平台 API 限制——建号 + GitHub install + Linear 授权的浏览器动作只能摊到批量/提前。详见 plan.md §0/§3.2/§9。

---

## 4. 费用调研(2b)—— 核实 issue 初步结论

Issue 给了初步结论,我核实/补强如下(2026 官方文档 + 定价页):

> **v2 更正**:下表的费用结论以 **plan.md §4** 为准(拆"增量 seat 费"与"容量边界"两列)。此处早期"任意规模零成本 / Linear 100 硬上限 / 发确认信"结论**已被修正**。

| 平台 | 增量 seat 费 | 容量边界 |
|---|---|---|
| **Discord** | $0(bot 免费) | **一个开发者团队最多 75 apps**(不是"无限"),上百个要分多个团队 |
| **GitHub** | $0(App 不占 seat;别用 machine-user) | **一个 owner 最多 100 Apps**,到顶分多 owner/org |
| **Linear** | agent **不计 billable seat**(2026 文档确认);Free 也含 Agent 平台 | 仍是 **Developer Preview**;**官方无公开 app-count 上限**(不写成"100 硬上限") |

**Linear 两点**(以 plan.md §4/§9 为准):
1. **per-agent Insights 报表**需 Business($16 是 list price);基础身份不需要。
2. **Linear 确认信 —— Annie co-eval 决策:不发,按官方文档直接做**(原"发确认信=founder 待办"已撤销)。留 Preview 风险标注。

**净结论(修正后)**:三方**无 per-identity seat 费**;但 100 规模有真实**容量上限**(Discord 75/team、GitHub 100/owner → 需 sharding),Linear 是 Preview。

---

## 5. Design options — 统一配置 → 自动三方开通(供 co-eval)

三条线里,**线 3(自动化)**是产品设计的重心;线 1(存量补齐)和线 2(新增标准化)更多是流程/策略。

### 5.1 统一配置的形态(核心 UX 决策)

一处配置,一个 agent 的 identity spec。候选载体:

- **A. 扩展现有 fleet/manifest 配置**(`~/.flywheel/projects.json` + `manifests/` + 一个新的 `identity` 段)。贴合现有 `flywheel-fleet.sh` / `materialize-lead-manifests.sh` 基建,Tadashi 熟。
- **B. 独立的 `agents.yaml` identity registry**(name/persona/avatar/三方 handle 一张表),`flywheel-identity.sh provision <agent>` 一条命令消费。
- **C. 复用 FLY-1038 localhost 控制台**(已有 fleet 控制台在演进),把"开新 agent"做成控制台里一个表单。

**倾向**:A/B 融合——一张 identity spec(name / persona 一句话 / avatar 路径 / 部门 / 三方 flags),`flywheel-identity provision <agent>` 幂等地开三方。**注意三方接口不对称(v2 更正,详见 plan.md §0/§3.2)**:Discord = 空壳池 claim → API 改名/头像;GitHub/Linear = 名字/图标建号时定死,只能 identity-bound(从 spec 生成 create manifest 建号,建号即定身份),**不能 claim 后改名**。之后 install/token/wire → 输出"三方身份就绪"卡。控制台(C)是后续可选皮。

### 5.2 池化基建(推广 FLY-882 到三方)

- **Discord 池**:已有(FLY-882)。
- **GitHub App 池**(v2 更正:identity-bound,非空壳后改名):提前用 manifest flow **按已知 agent 的最终名字**批量建 App(名字建号时定死、无 API 改名),存 app id + private key 进池文件。provision 时 claim 已建好的 identity-bound 项 + install 到目标 repo(install 普通账号是人工浏览器 owner-consent;仅 Enterprise Cloud + 先 bootstrap 有权限的企业 automation App 才能 API 装,见 plan.md §9-E)。
- **Linear OAuth app 池**(identity-bound,非空壳后改名):提前**按已知 agent 的最终 name/icon** 建 N 个 OAuth app(建号即定、**无 API 改名**)+ admin 授权安装,存 client id/secret/actor token。provision 时 **claim 已建好的 identity-bound 项 + wire**(不 rename)。
- 池告罄时:一个 `pool replenish` 引导流程(把不可自动化的浏览器/授权步集中批量做一次)。

### 5.3 存量补齐(线 1)与新增标准化(线 2)

- **线 1**:先给 HL / Tadashi / Aunt Cass 各开 GitHub + Linear 身份(3 个 agent × 2 平台 = 6 个身份,作为**首批真机验证**),跑通后批量补齐其余存量 agent。
- **线 2**:把"三方全开"写成硬步骤——`provision` 默认三方全建;新 agent 落地 checklist / onboard 文档里加"三方身份就绪"验收项;缺任一方 = 未完成。

### 5.4 拆 build issue 给 Tadashi(初步)

1. **GitHub App 自动开通集成**(池 + manifest flow + install + per-agent token 接线,替换共享 `GITHUB_TOKEN`)。
2. **Linear OAuth-agent 自动开通集成**(`actor=app` 池 + 安装 + per-agent actor token 接线,替换 `LinearActivitySink` 共享身份)。
3. **Discord 自动化收口**(把 FLY-882 的 claim/rename/avatar/invite/wire 收成一条 `provision` 命令)。
4. **统一 identity spec + `flywheel-identity provision` 编排器**(串起三方 + 幂等 + 就绪卡)。
5.(可选)**FLY-1038 控制台加"开新 agent"表单**。

---

## 6. Open decisions —— 需 co-eval 拍板(带进 brainstorm gate)

1. **本 issue 范围** = 纯 PRD(设计 + 费用 + 拆 build issue),实现代码全部走下游 build issue 交 Tadashi?(确认 delivery path 的理解无误)
2. **自动化目标取向**:定在「**池化 + 引导式握手**」的现实边界(per-agent 一次配置,建号动作摊到批量/提前)——而非期待「纯零人工 API 建号」(平台不给)。这个现实取向 Annie 接受吗?
3. **首批存量补齐范围**:先 HL / Tadashi / Aunt Cass 三个跑通(6 身份),再全量?还是一次全量?
4. ~~Linear 100-上限确认~~ — **已决(Annie co-eval):不发确认信、按官方文档直接做**(plan.md §4);留 Preview 风险标注。
5. **统一配置载体**:倾向"identity spec + `flywheel-identity provision` 一条命令",是否 OK,还是要绑 FLY-1038 控制台。
