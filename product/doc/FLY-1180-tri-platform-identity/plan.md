# FLY-1180 三方 Agent 身份统一 — 实施计划(PRD)

Issue: FLY-1180 (https://linear.app/geoforge3d/issue/FLY-1180/三方-agent-身份统一discord-linear-github-存量补齐-新增标准化-统一配置自动开通)
日期: 2026-07-11
基于: research.md

> **文档性质**:FLY-1180 的 PRD(产品需求 + 实施路线 + 拆 build issue),不是实现代码。自动开通代码由 §7 拆出的 build issue 交 Tadashi。
> **审批状态**:brainstorm gate 已过;**Codex design 3 轮 + code 5 轮 APPROVED 到 head cbd79ff9(Round 5)**;**Annie co-eval 第 3 轮新增(对话式 interview[§3.1/§3.2]、scope 锁「内部工具」[§1.1]、§11 产品化前瞻)经 Codex Round 6 CHANGES REQUESTED → 4 项已修 → 本 head 待最后一次窄复核通过**(通过后更新此状态,勿把当前 head 当已批);Annie co-eval 第 1/2/3 轮方向已收敛(§9 第 1 轮;§10 第 2 轮 Phase1 outbound/Phase2 inbound-defer;§11 外部前瞻)→ 待复核过 + merge → 拆 build issue(M-1 spike 先行)。
> **co-eval v2 修订**(据 Annie 第 1 轮):§0 automation 边界补「token-可自动化 vs 硬性人工」分界(含 GitHub Enterprise install API 细节);§4 Linear 确认信按 Annie 选择改为「不发、按官方文档直接做」;新增 §9「Annie 决策与答疑(A-F)」;exploration/research/progress 同步到 identity-bound 模型(解上轮 Codex code-review 挑的旧文档不一致)。
> **v2/v3 设计修订**(据 Codex R1/R2):三方身份模型不对称(Discord 空壳池 / GitHub·Linear identity-bound create,GitHub 建号 + install 两个人机断点)、identity inventory + typed desired/binding schema、共享→per-agent 迁移的 inbound+outbound 全面 + canonical provenance key + GitHub single-router inbound topology、token 生命周期分档 secret 合同、durable per-platform 状态机验收、费用表改"增量费 vs 容量边界"双列、build issue 先 spike 再定抽象。

---

## 0. 诚实边界声明(先读 —— HL 明确要求,别误导 Annie)

**做不到、也不承诺「一键全自动、零人工建号」。** 平台不给纯 API 建号,而且**三平台建号语义不对称**:

| 平台 | 建号能力 | 名字/头像何时定 | 结论 |
|---|---|---|---|
| **Discord** | 无建号 API,Portal 批量预建空壳(FLY-882) | **claim 后可 API 改**(`PATCH /users/@me` 改 username + avatar) | ✅ 真能"空壳池 + claim 后配置" |
| **GitHub App** | manifest handshake(每个 App 一次浏览器点击确认)**+ 首次 install 另一次人工**(App settings→Install→选 account/repos→授权;**无"建首个 installation"的 REST endpoint**) | **创建时定**(manifest 预填 name;**REST 无改 App name/logo 的 endpoint**,logo 走 settings 手动上传) | ❌ 不能空壳后改名;须 **identity-bound create + 人工 install** |
| **Linear** | OAuth app 建 + admin 授权安装 | **创建时定**(agent 展示的就是 OAuth app 的 name/icon;manifest 只在创建页预填,`iconUrl` 须 **HTTP(S) URL** 非本地路径) | ❌ 不能空壳后改名;须 **identity-bound create** |

**所以自动化的真实形态是:**

- **Discord**:空壳池(FLY-882)+ claim 后 API rename/avatar/invite/wire —— **可全自动**。
- **GitHub / Linear**:**identity-bound replenish** —— 从 identity spec **生成带最终名字/图标的 create manifest** → 人做一次 manifest handshake / OAuth app 建号(建号即定身份)→ **另一次人工 install**(GitHub:选 repos 授权;Linear:admin 授权 `actor=app`)→ 之后 token mint / verify / wire / repo-access 更新才是 API。GitHub logo 可能仍需一次 settings 手动上传。这里的"池"= **按 identity 预建/待建的 provisioning 队列**,不是可随意改名的空白容器。

**Annie 的核心诉求「不用人工在各平台来回折腾」怎么达成:**
- 日常:一个 agent 在**对话里**问你几句(name/persona/avatar/三方开关)→ 系统自动生成 spec + provision(**你不填文件、不跑命令**,见 §3.2 interview 前端)。
- **不可消除的人工**(诚实列全):① 往 Discord 池补空 bot(批量、提前);② 每个新 GitHub App 一次 manifest 建号点击 **+ 一次 install/repo-selection/授权点击**(两个人机断点,可为已知 agent 批量做);③ 每个新 Linear OAuth app 一次建 **+ 一次 admin 授权安装**(两个人机断点);④ GitHub logo / Linear icon 的托管或上传。这些**摊到批量/提前**,per-agent 体验降到"**在对话里回答几句 + 少量不可消除的授权点击**"(provision 命令由 interview agent 内部调用,操作者不跑命令)。

**「能不能连人工点也自动化」(Annie co-eval 决策 2「更激进」的 re-research)—— 诚实分界 token-可自动化 vs 硬性人工:**

| 步骤 | 能不能不用真人 | 依据 |
|---|---|---|
| GitHub App **建号**(manifest) | ❌ 无 API 建 App;只能浏览器 manifest 流(命名+点确认)。可脚本化浏览器代点,但脆弱/撞 ToS/2FA/建号有速率限制 → 当**批量补池加速器**,非可靠主路径 | 官方「cannot create Apps through the API」 |
| GitHub App **首次 install** | ⚠️ 普通 org/个人 = 浏览器 owner-consent(选 location/repos + 确认;现有 token **装不了**,设计如此)。**GitHub Enterprise Cloud** 有 Organization Installations REST API 可自动装,但**前提是先人工装好一个有 `Enterprise organization installations` 权限的企业级 automation App**、且目标是该 enterprise 拥有的 org —— **不是"买了 Enterprise 就自动",仍需一次性人工 bootstrap** | GitHub install 流程 + Enterprise Cloud Org-Installations API + 其 prerequisites |
| GitHub **token mint / 加减 repo / commit / PR** | ✅ 纯 API(App ID + PEM 即时签 installation token) | REST installations API |
| Linear OAuth app **建号** | ❌ 无 API;浏览器建 | Linear OAuth docs |
| Linear **admin 授权安装**(actor=app) | ❌ 需 workspace admin 在浏览器点授权(一次性) | actor=app 需 admin 授权 |
| Linear **actor token 使用 / 评论 / 派单** | ✅ 纯 API | Linear agents API |

> **给 Annie 的直话**:你说「如果 token 能装、那你也能帮忙做」—— GitHub install 这步:普通账号不行(浏览器 owner-consent 是硬性安全边界);GitHub Enterprise Cloud 能自动装,但要先人工 bootstrap 一个有权限的企业 automation App(不是买了就自动)。**是否上 Enterprise —— Annie 已决(§10.0):pilot 先手动,规模大再评估(§9-E)。** 其余「建号」在三方都是硬性浏览器(可脆弱代点、不推荐当主路径);token mint / 发言 / 派单全是纯 API。

> **v1 先做 M-1 feasibility spike**:对 GitHub、Linear 各真建 1 个最终命名身份,把每一步仍需人工的动作 + 「Enterprise 是否可编程 install」逐项验回本节,再定 pool 模型。§0 随 spike 结论更新。

---

## 1. 目标、范围、身份清单

### 1.1 目标 + scope 锁定
让**每个 named agent 在三方都有自己的身份**,能以自己名义开 PR、评论、被 @mention、被 delegate(Linear 是 delegate 不是 human assignee)。

> **scope 锁定:FLY-1180 = 我们自己的内部工具(Annie co-eval 第 3 轮明确)。** 目标是**给我们内部的 agent 身份 = 归因**(谁干的清楚);内部用**稍手动 OK**(Annie 原话)。**面向外部客户的产品版是另一个、更后面的设计问题**,不在本 issue 实现 —— 但把前瞻思考存进 §11「产品化考量」,等内部 dogfood 出经验再 productize。

### 1.2 三条线(与 issue 对齐)
1. **存量补齐** — 现有 named agent 补 Linear + GitHub 身份(Discord 大多已有)。
2. **新增标准化** — 新 agent = 三方身份硬性全开。
3. **流程自动化** — 统一配置一次,系统自动开通(按 §0 的真实形态)。

### 1.3 身份清单(identity inventory —— 谁拿独立身份,Codex R1#2)
- **v1 只覆盖 persistent named principals**(有稳定人设的 Lead / 陪伴 Lead / 具名 agent)。现有清单以 `~/.flywheel/projects.json` 的 `leads[]` + 已上线具名 agent 为准(pilot 前列一张确切总表)。
- **transient Runner execution 不拿独立身份**,**复用其 owning principal(派它的 Lead / 具名 agent)的三方身份**。否则身份数随执行爆炸。
- **系统级 announcer / bridge 自身**:沿用现有共享系统身份,明确列为**非目标**。

### 1.4 非目标
- 不做纯 API 零人工建号(平台不给)。
- 不给 transient runner 建独立身份。
- 本 issue 不写实现代码(交 build issue)。
- **不实现 §11 的外部客户产品 / 托管 / BYO 模式** —— §11 只是存前瞻,productize 是内部 dogfood 后单独一轮的事。

### 1.5 范围切分:两期(Annie co-eval 第 2 轮锁定 —— 核心)
共享→per-agent 是「发(outbound)」+「收(inbound)」一整条链。Annie co-eval 锁定**只做前半**:

- **Phase 1 = OUTBOUND 身份(现在做,pilot 就做这个)**:agent 以自己身份**开 PR / 评论 / 被正确归因 / commit**。这是即时价值。
- **Phase 2 = INBOUND 路由(延后,真需要再做)**:被 @mention / delegate / webhook 事件唤醒**正确的** agent。§3.3 的 single-router 拓扑 + 多 app webhook 校验 = Phase 2 的设计,**先写好放着、不实现**。

**为什么现在不需要 inbound(Annie 原话 + 实证)**:现在票都是 founder/Lead 自己写、agent 没被外人 @;而 agent 的代码评审**已由 Bridge 编排 hard-gate**(owning Runner 一开 PR,Bridge/Blueprint 强制它跑 Codex 评审 + 记录裁决当 gate,通过后可 spawn 独立 auto-QA;本 PR 的 Codex 评审即 Bridge 自动触发,活证据),触发靠 Bridge 而非 GitHub 收消息 → reviewer 只需 Phase-1 outbound 身份即可署名评论(详见 §10.2)。**inbound 真正用武之地 = 外部真人来 @ 我们的 agent / 拿 GitHub 评论当指挥台**,现在还没到。

> 这把 pilot 大大简化:**pilot 6 身份只需 outbound 跑通,完全不碰 webhook 拓扑/fan-out。**

---

## 2. 现状(为什么要做 + 迁移真实半径)

| 平台 | 现状 | 差距 |
|---|---|---|
| Discord | FLY-882 空壳池 + `discord-bot-pool.sh`,`_pool_curl_authed` 用 `curl -K -` stdin 传 token(已验证);步骤分散手动 | 收口成 provision 一子步 |
| GitHub | **共享身份**:`EdgeWorker.ts` installation token 用于 webhook reaction/fetch/reply **至少 3 处(:818/:1060/:1223)**;Runner 由 `CodexTmuxAdapter` 现场 `gh auth token` 写进 per-runner CODEX_HOME(`codex-home.ts` 是 credential sink,非 per-agent resolver) | per-agent = 0;**多 App = 多 webhook secret + inbound 身份路由**,不是换 2 个位点 |
| Linear | **共享身份**:每 repo 一个 `LinearClient(repo.linearToken)` + `IIssueTrackerService` + `LinearActivitySink`(`EdgeWorker.ts:327-358,1650`);`LinearActivitySink` API 只有 session/issue,**无 agent identity 参数**;同一 token 还进附件下载、Linear MCP、OAuth refresh/persistence;webhook 是**单 transport + 单 secret** | per-agent = 0;要让多 app 被 mention/delegate 唤醒正确 agent,须**按 app-user/OAuth-app 映射 principal + 多 app webhook 校验** |

**结论**:共享→per-agent 是一整条 **inbound(webhook 唤醒哪个 agent)+ outbound(以哪个身份发言/push/评论)** 链的迁移,不是局部替换。

---

## 3. 产品设计

### 3.1 identity spec(desired)与 binding(generated)分离(Codex R1#2)

> **人不手填这张表(Annie co-eval 第 3 轮明确)**:desired spec 是**机器工件**,由 **§3.2 的 identity-interview 前端生成** —— 一个 agent 在对话里问操作者(如 Annie)name / persona / avatar / 三方开关,再自动写出下面这段 spec 并跑 provision。**操作者只在对话里回答,绝不编辑文件 / 不填表单**(贴 Annie 工作方式:数字活 agent 干)。下面的 JSON 只是这条流水线的内部产物,不是让人手写的输入。

**desired spec**(interview 前端生成,进 registry;扩展 projects.json 的 principal 段):
```jsonc
{
  "agentId": "flywheel-product-lead",
  "identity": {
    "displayName": "Honey Lemon",
    "persona": "一句话人设",
    "assets": { "githubLogo": "…settings 上传或托管URL", "linearIconUrl": "https://…(须HTTP)", "discordAvatar": "assets/…png(本地OK)" },
    "platforms": {
      // 统一 exemption schema:enabled=false 时同层必填 exemptionReason
      "discord": { "enabled": true, "guild": "…", "permissions": "…" },
      "github":  { "enabled": true, "owner": "…", "repositories": ["…"], "permissions": {}, "events": [] },
      "linear":  { "enabled": false, "exemptionReason": "该 agent 不进 Linear 的理由" }
    }
  }
}
```
**binding/status**(系统写,机器读;**不与 desired 混在一段自写自读**)—— **typed per-platform**(Codex R2#3,让 M1b/M2b 可独立实现):
- **discord**:`{ botUserId, username, guildId, tokenEnv }`
- **github**:`{ appId, installationId, owner, repositories[], grantedPermissions, privateKeyRef, webhookSecretRef?, credentialGeneration }`(`webhookSecretRef` 仅在 per-agent webhook topology 才需;single-router 下只 router binding 有,见 §3.3)
- **linear**:`{ appUserId, clientId, clientSecretRef, accessTokenRef, refreshTokenRef, webhookSecretRef, workspace, teamAccess[], scopes[], tokenExpiresAt, credentialGeneration }`
- 公共:`verifiedAt`、provision state(见 §3.4)。**`*Ref` 是对 secret bundle 的引用**(bundle contract 见 §6);binding 只存**非秘密 ID**,秘密值不落 binding。

**平台差异须编码**:GitHub App name 全局唯一约束;Discord username ≠ 人设名可直接假定;GitHub logo / Linear icon 需可托管资产或设置动作(不是本地路径直塞)。还须定义:handle 冲突、rename、disable/deprovision、credential revoke、repo/workspace 迁移的行为。

### 3.2 `flywheel-identity` 命令族(不假设三方同接口,Codex R1#7)

- **`flywheel-identity new`(interview 前端 —— Annie 要的入口)**:一个 identity-interview agent 在**对话里**收集信息、生成 spec、再接 provision。**操作者全程只在对话里回答,不碰文件 / 不填表单。** 但入口要一个**完整、可确认、可恢复的合同**(Codex R6#1),不是"问 4 句就直接 provision":
  - **完整字段**:对话不止问 name/persona/avatar/三方开关,还要拿到 §3.1 desired schema 的全部——`agentId`、project context、以及开启的平台各自的 authority 字段(Discord guild/permissions、GitHub owner/repos/permissions/events、Linear workspace/team/scopes),关闭的平台必须给 `exemptionReason`。
  - **canonical key**:对话要**明确建立/选定** §3.3 的不可变 `(projectName, agentId)`(resume/provenance 键),不能凭空默认。
  - **安全默认只限非权限字段**:persona 措辞、头像可默认/代生成;**repo / owner / guild / workspace / scopes / 平台豁免 / canonical key 这些 authority-bearing 字段必须明确取得,禁止"不懂给默认"**(避免给出危险的 repo/scope 默认)。
  - **plan preview + 确认 + 取消/断线恢复 + 幂等**:收集完 → 对话里**展示 plan(含人机断点 + 权限/repo 摘要)**→ 操作者**明确确认**→ 才**原子写** desired spec → 进 §3.4 per-platform 状态机 provision → verify。**取消或断线只留无副作用 draft**;重复确认按 canonical key 幂等,不重复 claim/install。adapter 未就绪时诚实输出 pending/needs-human,不假装已开通。
  - 未来可选皮 = FLY-1038 控制台表单;但**默认交互 = 对话式访谈**,不是让人填 JSON。
- `flywheel-identity plan <agentId>` — **只读**,算出三方各缺什么 + 需要哪些人工动作,输出计划(不改任何东西;内部/调试用)。
- `flywheel-identity provision <agentId>` — 执行(按平台各自 adapter,见下),幂等 resume。
- `flywheel-identity verify <agentId>` — live-probe 三方真实身份(见 §3.4)。

**平台 adapter 不共享 "claim/rename/avatar/install" 死接口**,而是各实现状态机步骤:
- **Discord adapter**:blank-pool claim → rename → avatar → invite → wire。
- **GitHub adapter**:从 spec 生成 create-manifest URL(带最终 name)→ **人 handshake 建号**(人机断点 1)→(logo 上传)→ **人 install + 选 repos 授权**(人机断点 2,无 REST 建首个 installation)→ JIT mint installation token → wire。
- **Linear adapter**:从 spec 生成 OAuth-app manifest(带最终 name + 托管 iconUrl)→ **人建**(人机断点 1)→ **admin 授权 `actor=app` 安装**(人机断点 2)→ wire actor token(access/refresh)。

### 3.3 canonical provenance key + inbound topology(串台防护地基,Codex R1#3 / R2#2)
> **Phase 分层(§1.5)**:canonical provenance key = **两期都要**(Phase 1 outbound 用它按 agent 选 credential)。下面的 **inbound topology / 多 app webhook 校验 = Phase 2**,**先写好设计、Phase 1 不实现**。
- 定 **`(projectName, agentId)`** 为不可变 provenance key,从 dispatch/session 一路带到 event、credential resolver、以及**所有 resume/retry/child-session** 路径。**session key 必须含 canonical principal,不再只有 `repo#pr`**(现码 `github-webhook-utils.ts` 的 session key 只有 `repo#pr`,会让同 PR 多 agent 串 session)。**【Phase 2】** 以下 inbound 拓扑同理。
- 为 GitHub、Linear 各列一张 **inbound + outbound surface matrix**(哪些位点收 webhook 要按 app→principal 映射;哪些位点出站要按 agentId 取 credential)。build issue 按这张表逐点迁移,不靠 comment 文本 / display name 猜身份。
- **GitHub inbound topology(须先定,否则 webhook fan-out)—— 推荐 single inbound router App**:保留一个受信 router App 订阅 repo comments;**per-agent App 默认关 webhook,只负责 outbound identity**。router 对 comment 里**精确注册的 GitHub handle** 做边界安全解析 → 映射到 `(projectName, agentId)` → 用该 principal 的 credential 出站。避免 N 个 App 装同 repo 导致一条 comment N 次 delivery 的 O(N) fan-out。
  - 备选(坚持 per-agent App webhook):须接受并量化 fan-out + 每条 delivery 用对应 App secret 验签 + exact-target mention gate + `(appId, deliveryId)` dedup + self/bot-loop guard + unmentioned-comment no-op。
  - **两选一都要在 Phase 2 加 4 条验收**(不是 Phase 1 pilot 条件):同 PR @A/@B 只唤醒目标;无 mention 不建新 session;agent 自己 reply 不回环;重复 delivery 只处理一次。
- **Linear inbound**:现码是**单 `LinearEventTransport` + 单 secret**;多 app 被 mention/delegate 唤醒正确 agent,须按 app-user / OAuth-app 映射 principal + 支持多 app webhook 校验/注册(先验签再信 payload 身份,见 §6)。

### 3.4 durable 状态机 + 验收(Codex R1#5 / R2#1)
- **per-platform 状态机,含人机断点**(不假设三方同状态):
  - **Discord**:`available → reserved(agent,key) → configured → wired → verified`。
  - **GitHub**:`planned → manifest-generated → needs-human-create → created → needs-human-install → installed → wired → verified`。
  - **Linear**:`planned → manifest-generated → needs-human-create → created → needs-human-install(admin authorize) → installed → wired → verified`。
  - 通用异常态:`needs-human` / `failed-retryable`。
- claim/配置写入用**统一锁 + 原子 journal**(复用 Discord pool.json 锁的模式),重跑按 canonical key resume;写一半可恢复。
- **任一 required 平台未 `verified` → 整体 exit non-zero**(守住"三方缺一即未完成"),但仍输出机器可读 JSON + 人读卡。
- **`verified` = live probe**:immutable IDs、install target、scopes、真实 actor;**就绪卡是证据索引,不是证据本身**。Phase 1 pilot 留 **outbound** evidence:GitHub PR/comment link、Linear 以自己身份 comment/派单 evidence、Discord membership/message evidence。(inbound 的 mention/delegate 唤醒 evidence = Phase 2。)

### 3.5 共享 fallback 收紧(Codex R1#3/#4)
- 共享身份 fallback 对 **identity-managed principal 一律 default-OFF + fail-closed**;仅**显式 migration allowlist** 里的未迁移 principal 可用共享,且打 metric/audit;**M3 前归零**。
- 删除 Discord 缺失 `botTokenEnv` 回落共享 `DISCORD_BOT_TOKEN` 的隐式兜底(对 managed principal)+ 加 fail-closed 测试。

### 3.6 新增标准化(线 2)
- provision 默认三方全开;新 agent onboard checklist 加**「三方身份 verified」硬 gate**(不是自报卡,是 verify live-probe 过);缺任一方且无 `exemptionReason` = 未完成。

---

## 4. 费用与容量结论(Codex R1#6 —— 拆"增量费"与"容量/运维边界"两列)

| 平台 | 增量 license/seat 费 | 容量 / 运维边界(100 规模) |
|---|---|---|
| **Discord** | 未发现 per-bot seat 费($0) | **一个 developer team 最多 75 apps** → 100 identity 超单 team 上限,须 team sharding/ownership 策略 |
| **GitHub** | GitHub App bot **不占 seat**($0;别用 machine-user) | **一个 user/org/enterprise owner 最多注册 100 GitHub Apps** → 100 identity 正好打满 owner 上限、**无测试/备用 headroom**,须 owner sharding |
| **Linear** | 2026 文档确认 installed agents **不计 billable users**;Free 也含 Agent 平台 | agents 仍是 **Developer Preview**;**无公开 workspace app-count 上限**(不要写成"100 硬上限");per-agent Insights 需 Business($16 是 list price,≠ per-agent 费、≠ 升级净增量) |

**净结论**:三方**无 per-identity seat 费**;但 **100 规模有真实容量边界**(Discord 75/team、GitHub 100/owner → 需 sharding),Linear 是 Preview 且 app-count 上限未知。

**Linear 确认信 —— Annie co-eval 决策:不发,按官方文档直接做。** 依据:2026 官方文档已明确 agent 不计 billable seat + Free 也含 Agent 平台,基础身份成本已够清楚。**保留的风险(诚实标注,非 blocker)**:agents 仍是 Developer Preview + **官方无公开 app-count 上限** —— **接受 Preview 变动 + 未知上限风险,按实际观测设 rollout stop / 复评点**(不是"已有工程 sharding 兜底"——§9-D 的 sharding 只覆盖 Discord/GitHub,Linear 无既定分片模型)。(原「发确认信」的 rollout gate 按 Annie 选择撤销;若 Preview 期条款变动,再回来评估。)

---

## 5. 分阶段路线图(Codex R1#7 —— 先 spike 再定抽象)

| 阶段 | 内容 | 完成判据(证据) |
|---|---|---|
| **M-1 feasibility spikes** | 对 GitHub、Linear 各**真建 1 个最终命名身份**,记录全部人工步骤、manifest/icon 能力、owner limits、scopes、webhooks、token refresh、真实 inbound/outbound evidence | §0 人工清单被真实动作逐项校正;pool 模型定案 |
| **M0 identity contract** | 定稿 principal inventory、desired/binding schema、durable 状态机、secret 合同、只读 `plan/verify` + Discord adapter(**不假设三方都有 rename/avatar**) | `plan` 对一个已有 Discord agent 输出正确计划;`verify` live-probe 通过 |
| **M0.5 identity-interview 前端** | `flywheel-identity new` 对话式入口:完整字段收集 + canonical key 建立 + 校验 + plan preview/confirm/cancel + 原子写 spec + 幂等恢复(§3.2 合同) | 操作者**不碰文件**在对话里完成一个 pilot principal 的 spec;生成 spec 过 schema 校验;chat 内 preview/confirm/cancel;断线按 canonical key 恢复不重复 claim;adapter 未就绪诚实输出 pending |
| **M1a GitHub control plane** | manifest create(identity-bound,含人机 create + install 两断点)+ logo + JIT installation token mint | live-probe:installation ID + owner + selected repo set + granted permissions(不能只证明 mint 出 token) |
| **M1b GitHub runtime OUTBOUND(Phase 1)** | **只做 outbound**::818/:1060/:1223 + Runner `gh` 按 `(project,agentId)` 路由发 token/commit/PR/评论 + cutover(**inbound webhook 拓扑 = Phase 2,不做**) | pilot agent 以自己 `[bot]` 开真 PR + 评论(留 link) |
| **M2a Linear control plane** | OAuth app create(identity-bound + 托管 icon)+ admin 授权 `actor=app` + actor token(access/refresh) | 1 个 Linear agent 建成 + 授权装好 |
| **M2b Linear runtime OUTBOUND(Phase 1)** | **只做 outbound**:LinearActivitySink/client/MCP/attachment 按 agentId 路由,以自己身份评论/派单 + cutover(**inbound 多 app webhook = Phase 2,不做**) | pilot agent 以自己身份评论/派单(留 evidence) |
| **Pilot gate(Phase 1)** | HL/Tadashi/Cass 3 principal **从 `flywheel-identity new` 对话起跑**(非预写 spec)→ provision → 全过 **outbound + restart/resume + fallback-denied** 验收;+ 一次受控 **forced-expiry / refresh-CAS 并发用例** | 操作者对话完成 new→spec→provision→verify;6 身份全 verified(outbound)+ 证据齐 + CAS 用例 pass |
| **M3** | 全量迁移(outbound)+ 共享 fallback 归零 + 新-agent checklist 硬 gate;容量确认按实际阈值做 rollout gate | 全量 verified 清单;fallback metric=0 |
| **Phase 2(延后,真需要再做)** | INBOUND 路由:§3.3 single-router 拓扑 + 多 app webhook 校验 + 按 @mention/delegate 唤醒正确 agent + 四条 inbound 验收(定向唤醒/无 mention 不建/不回环/去重) | 有 use-case(外部人 @agent)时启动 |

**founder 待办(并行)**:M3 全量 rollout 超阈值前做**容量 sharding 决策**(GitHub 100/owner、Discord 75/team)。(Linear vendor 确认信按 Annie 决策**不发**,§4。)

---

## 6. Token / Secret 合同(Codex R1#4 —— "allowed secret surfaces",非绝对句)

按**生命周期分档**,而不是"永不落明文"的不实绝对句:

- **GitHub App private key(PEM,长期,多行)**:per-agent **0600 文件引用**(或明确 secret store);spec/binding 只存**非秘密的 App ID / installation ID**。
- **GitHub installation token(~1h)**:**JIT mint**(App ID + install ID + PEM 即时签)+ expiry cache;**不落 `.env` 当长期 token**。
- **Linear OAuth actor token(access/refresh)**:明确 storage、rotation、refresh 的 CAS、revoke 流程;不是永久槽位。
- **每 Linear OAuth app 的 client 凭据**:`clientId`(非秘密,进 binding)+ `clientSecretRef`(秘密,进 bundle)—— **多 OAuth app 不能共用同一 client secret**;现码从全局 `LINEAR_CLIENT_ID`/`LINEAR_CLIENT_SECRET` 构造所有 repo 的 OAuth refresh(`EdgeWorker.ts:5718`),须改成按 principal 解析各自 client 凭据。
- **每 app 的 webhook signing secret**:Linear **必然**每 app 一个 `webhookSecretRef`(须支持多 secret 校验);GitHub **仅在选 per-agent webhook 备选 topology 时**每 App 一个,选 single-router(推荐)则只 router binding 有(现码 `LINEAR_WEBHOOK_SECRET` / `GITHUB_WEBHOOK_SECRET` 都是全局单值单 verifier)。
- **Discord bot token(长期)**:env-by-name;**删除 managed principal 的共享 `DISCORD_BOT_TOKEN` 回落** + fail-closed 测试。
- **secret bundle contract**:`*Ref` 指向的 bundle 须有 schema/version、required keys、`credentialGeneration`(rotation 代);**refresh CAS 键 = canonical principal + app/client ID + generation(或旧 refresh token hash)**,成功后**原子轮换** access/refresh pair,失败不覆盖新 generation。
- **verify-before-trust**:webhook verifier **必须先按可信 endpoint/app binding 或候选 secret 集验签,再接受 payload 里的 app-user/installation identity**;绝不"先信 payload 再选 secret"。
- **通用写入规则**:atomic、0600/0700、拒 symlink / 宽权限 parent、日志 redaction。**token 传递**:shell/curl 边界用 stdin config(`curl -K -`);**进程内 client(Node SDK/fetch/LinearClient)用内存 Authorization header、不记录、不进 child argv**。
- **terminal cleanup 范围**:只清 **ephemeral copies / cache**(per-runner CODEX_HOME token、过期 installation-token cache);**长期 source(PEM / refresh token)由 revoke/deprovision lifecycle 管**,不无条件删。
- **须承认的现有明文面**:Edge config schema 把 `linearToken`/`linearRefreshToken` 存为可持久化字段且 refresh 写回 `config.json`;`codex-home.ts` 把 `GH_TOKEN` 写 per-runner 0600 `config.toml`。PRD 不假装这些不存在,build issue 要么复用其受控写入规则,要么显式收紧。

---

## 7. Build-issue 拆分(交 Tadashi)

> 建议一个 epic + 子 issue;顺序即 §5;每条独立可估算/验收。

1. **[M-1] GitHub / Linear feasibility spike(2 个薄 spike)** — 各真建 1 个最终命名身份,产出"人工步骤 + 能力/上限"事实表,回写 §0。**先于任何抽象。**
2. **[M0] identity contract + Discord adapter** — inventory + desired/binding schema + durable 状态机 + 锁/journal + secret 合同 + 只读 `plan/verify` + Discord adapter(复用 `discord-bot-pool.sh`/`set-lead-avatar.sh`/`materialize-lead-manifests.sh` registry/`_pool_curl_authed`)。
   - **[M0.5] identity-interview 前端(`flywheel-identity new`,Annie 要的默认入口)** — 对话式收集完整字段 + 建 canonical key + 校验 + plan preview/confirm/cancel + 原子写 spec + 幂等恢复(§3.2 合同)。依赖 M0 contract。验收见 §5 M0.5 行。
3. **[M1a] GitHub control plane** — identity-bound manifest create(含人机 create + install 两断点)+ logo + JIT installation token;验收 live-probe install ID/owner/repos/perms。
4. **[M1b] GitHub runtime OUTBOUND routing(Phase 1)** — outbound(:818/:1060/:1223 + Runner `gh`/CODEX_HOME)按 `(project,agentId)` 路由 + cutover;共享 fallback default-off + allowlist + audit。**inbound webhook 拓扑 = Phase 2,本期不做。**
5. **[M2a] Linear control plane** — identity-bound OAuth app create + 托管 icon + admin `actor=app` + actor token access/refresh。
6. **[M2b] Linear runtime OUTBOUND routing(Phase 1)** — outbound(LinearActivitySink/LinearClient/IIssueTrackerService/MCP/attachment/OAuth persist)按 key 路由 + cutover。**inbound 多 app webhook = Phase 2,本期不做。**
7. **[Pilot gate(Phase 1)]** — HL/Tadashi/Cass 3 principal **从 `flywheel-identity new` 对话起跑**(非预写 spec)→ **outbound**+restart/resume+fallback-denied 全过 + forced-expiry/refresh-CAS 并发用例。
8. **[M3] 全量迁移(outbound)+ 策略** — pilot 后全量批量 + 共享 fallback 归零 + 新-agent checklist 硬 gate + 容量 sharding。
9. **[Phase 2,延后] INBOUND 路由** — §3.3 single-router 拓扑 + 多 app webhook 校验 + 按 @mention/delegate 唤醒正确 agent + 四条 inbound 验收。**设计已在 §3.3 写好,等真有 use-case(外部人 @agent)再启动。**
10. **(可选)FLY-1038 控制台"开新 agent"表单皮。**

---

## 8. 开放项 / 待确认(co-eval 与 spike 回答)

1. **身份清单确切总数** — pilot 前列一张 persistent named principal 全表(desired 覆盖谁)。
2. **M-1 spike 结论** — GitHub logo 是否必须手动上传?Linear icon 托管在哪?**GitHub 是否 Enterprise(决定 install 能否编程自动化,§9-E)**?回写 §0。
3. **容量 sharding 策略** — 到 GitHub 100/owner、Discord 75/team 上限前,如何分 owner/team。
4. ~~Linear vendor 确认~~ — **Annie 决策:不发信、按官方文档直接做**(§4)。留 Preview 风险标注,不作 gate。
5. **共享→per-agent cutover 灰度** — 逐 agent + allowlist + audit,M3 归零(已定方向,细节留 M1b/M2b)。
6. ~~GitHub Enterprise 岔路口~~ — **已决(§10.0):pilot 先手动 install,规模大了再评估上不上 Enterprise。**
7. ~~决策 D GitHub inbound topology~~ — **已决(§10.0):single-router(推荐),细节交工程 spike;且整块 inbound 归 Phase 2 延后(§1.5)。**

---

## 9. Annie co-eval 第 1 轮 —— 决策落地 + 逐条答疑

### 9.0 她的 5 个决策(已落进 PRD)
| 决策 | 选择 | 落点 |
|---|---|---|
| Linear 确认信 | 不发,官方文档够就直接做 | §4 已改 + §8-4 撤 gate |
| 自动化程度 | **更激进**:尽量连人工点也自动化 | §0 新增 token-可自动化 vs 硬性人工分界表 + §9-E |
| 首批范围 | 先 HL/Tadashi/Cass 6 身份再全量 | §5 Pilot gate(已是此路径) |
| 配置载体 | identity spec + 一条 provision 命令 | §3.1/§3.2 —— **第 3 轮已把它包在 `flywheel-identity new` 对话式前端后面**(人不直接填 spec/跑命令);identity spec 变成 interview 生成的内部产物 |
| 优先级 | 先 ③ provision + ① pilot 6 | §5 M0→M1→M2→Pilot(③provision 贯穿 M0-M2、①pilot 是 Pilot gate) |

### 9.A 现实边界 re-research(2026 复核)
- **Discord**:确认无 API 建 bot;但**有池(FLY-882)后,开新 agent 不碰浏览器**——从预建空壳池 claim + 纯 API 改名/头像/邀请。浏览器只在"批量补空 bot"时。
- **GitHub**:确认「cannot create Apps through the API」——建 App 必须浏览器 manifest(命名+点确认)。
- **GitHub/Linear 能不能也做号池?** 能,但**不如 Discord 理想**(Annie 的直觉对):因为 GitHub/Linear 的名字+图标**建号时定死、无 API 改名**,池只能是——(a) **identity-bound 预建**:提前为**已知要开的 agent** 按最终名字建好囤着(最佳,本质是"提前 provision");(b) **通用匿名池**:预建 `flywheel-agent-01[bot]` 空号,但 bot 显示的就是这个通用名、不是人设名(**不理想**)。Discord 有改名 API 才能用真·空壳匿名池;GitHub/Linear 没这福气。**结论**:GitHub/Linear 的"号池"= "提前把已知 agent 建好囤着",不是"匿名空号池"。

### 9.B Linear:MCP vs per-agent token
今天连 Linear 的**机制**(MCP / SDK)可以**保留**;变的是**身份**——每个 agent 用**自己的 actor token**(actor=app 授权时拿到)去认证。不是"以后不用 MCP 了",而是**同一个连接机制、后面换成 per-agent 的身份/token**;现有共享 token 换成按 agent 路由。具体接哪个点(MCP 还是 SDK 走 per-agent token)= Linear build issue M2b 定。

### 9.C GitHub:一台机跑很多身份可行吗
**关键澄清:不是"多个 GitHub 账号"**(那才占 seat、要登录、乱),**是 GitHub Apps**(bot 身份 `xxx[bot]`)。一台机跑很多 App 身份**完全可行且便宜**:每个 App = 一个 App ID + 一个私钥(PEM 文件,0600)放硬盘;要以那身份发言,就用 PEM **即时签一个短命(~1h)installation token**。**没有 per-agent 登录、没有账号、不占 seat。** 隔离 = 每 agent 独立 PEM 文件 + 独立 installation token(按 `(project,agentId)` 取)。Tadashi 的 PR 来自 `tadashi[bot]`(一个 App),不是 Tadashi 的用户账号。这正是我们用 GitHub Apps 而非 machine-user 的原因。

### 9.D 平台上限 + GitHub scoping
- **Discord 75/team**:那个"team"是 Discord 开发者后台里**拥有这些 bot 应用的开发者团队**(不是服务器、不是 lead)。75 = 一个开发者团队最多拥有 75 个 bot 应用;每 agent = 一个。75 到顶 → 上 100 建**多个开发者团队**分片。(注:官方公开的 Discord 200/天限制是 **per-guild application-command creates**,**不是** bot/App 建号;未找到官方的 bot 建号日限。)
- **GitHub 100/owner**:一个 user/org/enterprise owner 最多注册 100 个 GitHub App;100 agent 正好打满、无 headroom → 须多 owner/org 分片。
- **GitHub App scoping 会不会太窄?** 装时选"全部 repo"或"仅指定 repo";**installation token 只能碰装了的 repo**(碰不到没装的)。这是**最小权限、是优点不是 bug**,而且**可配**——要 agent 干哪些 repo 就装哪些(或"全部")。所以"Flywheel app 只看 Flywheel repo"= 你想要多窄就多窄,不是硬限制。

### 9.E 人机断点 re-research(Annie 最在意:token 能不能装、让 agent 代做)
- **GitHub install 能不能用现有 token 装?** **看是不是 GitHub Enterprise**:
  - **普通 org/个人账号**:❌ 不行。install 是**浏览器 owner-consent**(GitHub 故意的安全边界:不能用 token 静默把 app 装进别人/自己的 repo)。所以普通账号下 **agent 代不了这一步**,是一次性人工点。
  - **GitHub Enterprise Cloud**:⚠️ **有条件**可以。Organization Installations REST API 能自动把 App 装进 enterprise 拥有的 org,但**前提是先人工 bootstrap 一个有 `Enterprise organization installations` 权限的企业级 automation App**(不是"买了 Enterprise 就自动获得无人工链")。满足这前提后,**agent 能代做后续 install**。
  - **岔路口(Annie 已决,§10.0:E → pilot 先手动,规模大再评估)**:上不上 Enterprise = 是否让 install 也自动化的关键;pilot 6 身份的 install 就手动点几下,够用。**这是我查证后的诚实结论,不是编的。**
- **Linear admin 授权(actor=app)**:❌ 需 workspace admin 在浏览器点授权(一次性);之后 actor token 使用全 API。
- **能 token 自动化 vs 硬性人工的分清**(见 §0 表):**token 纯自动化**=GitHub token mint/加减 repo/commit/PR、Linear actor token 使用;**硬性人工(或脆弱浏览器代点)**=三方的建号 + Linear admin 授权 + 普通 GitHub 的 install。

### 9.F GitHub 收消息两种拓扑(plain-language,Annie 说没懂)
一条 GitHub 评论来了,谁去处理?两种设计:
- **① Single-router(推荐)—— 一个"收发室"**:留一个受信的"收发室 App"专门收所有评论事件,看清评论 @ 了谁,再交给那个 agent 用**它自己的身份**去回。
  - 好处:一条评论**只送一次**(不重复);100 个 agent 也不炸;简单。
  - 代价:收发室是一个共享的"入口"件(但**发言身份仍是每个 agent 自己的**)。
- **② Per-agent webhook —— 每人自己收**:每个 agent 的 App 都各收一份**每一条**评论。
  - 好处:完全解耦。
  - 代价:100 个 agent 装同一个 repo → **一条评论被送 100 次** → 必须去重 + 判断到底 @ 了谁 + 防止 bot 自己回复又触发自己(死循环)。规模大就乱。
- **一句话类比**:① = 一个前台收所有信、按名字分发;② = 每封信复印 100 份、每人一份,自己翻找哪封是给自己的。**推荐 ①**。→ **Annie 第 2 轮已选 single-router(§10.0);且整块 inbound 归 Phase 2 延后(§1.5),本节设计先写好、不实现。**

---

## 10. Annie co-eval 第 2 轮 —— scope 锁定 + 决策 + 澄清

### 10.0 她的第 2 轮决策
| 决策 | 选择 | 落点 |
|---|---|---|
| D GitHub 收消息拓扑 | 先按推荐(single-router),细节交工程 spike | §3.3(归 Phase 2,先写好设计) |
| E GitHub Enterprise | pilot 先手动,规模大了再评估上不上 | §8-6;install 一次性人工点,pilot 6 身份就点几下 |
| Linear admin 授权 | OK,直接授权(含我们自己 + 产品化,做一次授权) | §3.2 Linear adapter |
| **inbound(收消息)** | **Phase 1 先不做**(原话「Phase 1 先不做 github 收消息那一部分」) | §1.5 两期切分 |

### 10.1 merge 能力 vs 授权(Annie 的 merge 问题 —— 既是产品收益、也是红线澄清)
Annie 问:agent 有了自己的 GitHub 身份,Runner 是不是就能以它们名义**自己去 merge、不用 Lead 帮**?
- **产品收益(是的一半)**:**身份本身不授予 merge 权限**;但当 App 装了目标 repo 且拿到所需 contents/PR 权限、GitHub branch/ruleset 允许、**且 Flywheel `verify-approval` 已通过(founder 已授权)**后,Runner 能以 `xxx[bot]` 名义执行这次**已获授权**的 merge / commit,**去掉了"Lead 当人肉的手"去代点的瓶颈**。
- **红线(另一半,不变)**:merge **仍要先过 founder 批准**(founder-only-authority / 绝不自 merge / branch protection **不动**);Runner **不能自己发起授权决定**。身份去掉的是"要人肉点这一下",**不是"要不要批准"**。
- **一句话**:身份让「谁干的」清清楚楚 + 不用人代点;**但「能不能 ship」永远是 founder 的 gate**。(本 PR 现在就卡在 approve gate 上未 ship = 活例子。)

### 10.2 评审走 Bridge 编排(为什么 inbound 现在不需要的实证)
agent 的代码评审**已由 Bridge 编排 hard-gate**,不靠 GitHub 收消息(以真实代码为准):
- 干活的 owning Runner 一开 PR,Bridge/Blueprint **强制它调用 Codex 代码评审**(`Blueprint.ts` / `codex-instruction.ts` 给原 execution 排 `/codex-code-review` 指令),Bridge **记录裁决并当 hard-gate**(没过不许 merge);评审通过后可再自动 spawn 一个**独立 auto-QA Runner** 复验。
- **本 PR #560 的 Codex 评审即 Bridge 这么触发**(活证据)。触发靠 **Bridge(已有)**,不是 GitHub 收消息 / 不是人在 PR 里 @;reviewer 只需 **Phase-1 outbound 身份**即可署名评论。
- 「让哪个 vendor(Claude/Codex)来审」是 Bridge 编排里的**路由细节**,不是一个 GitHub 收消息的需求。→ 连 review 都不需要 Phase-2 inbound。(注:"Codex 写 → 自动派 Claude 审"这种**对称**跨-vendor 路由当前代码里未见现成实现,是可加的编排细节,不改本结论。)

### 10.3 我们自派 reviewer vs GitHub 原生 @Claude —— 区别在上下文/协议,不在读不读 CLAUDE.md(Phase 2 rationale)
Annie 问「Claude 本来就能连 GitHub 帮 review,缺不缺上下文?」:
- **澄清**:官方 Claude Code GitHub Actions **会**读仓库根的 CLAUDE.md + 遵循项目 patterns,**不是只看 diff**。
- 真实区别是**默认上下文 / 审查协议不同**:我们 Bridge 自派的 reviewer 额外带**本机记忆 + 特定 onboard 文档 + 更严的审查协议**(如本次设计评审真去 grep 主代码库核验)→ 对我们项目更贴。
- 所以走我们自己的 Bridge-orchestrated review 更契合 —— **但不是因为原生 Claude 读不到 CLAUDE.md**。

### 10.4 inbound「不难就先做起来」? —— 诚实回应
Annie 说「不难就先做起来备着」。诚实讲:**inbound 是较难的那一半**(webhook 重复推送去重 / 判断 @ 了谁 / 防 bot 自触发回环),不是顺手小活;加上现在连 review 都被 Bridge 覆盖、暂无真 use-case → **「先做起来」性价比不高**。建议:**设计先写好放 PRD(§3.3 single-router),等真有 use-case(外部人 @agent)再动手** —— 不浪费、也不拖慢 Phase 1 的即时价值。

---

## 11. 产品化考量(前瞻活章节 —— Annie co-eval 第 3 轮要的)

> **这不是现在做产品**,是**边做内部版边记录**「以后给外部客户用时,哪些能做得更好」。等内部 dogfood 出经验再 productize。内部版(§1-§10)刻意接受"稍手动"是因为**用户是我们自己**;下面这些点是给**外部客户**时必须解决的、现在先想清存着。

**核心认知:内部工具 ≠ 客户产品。** 内部我们懂 Discord/GitHub/Linear、能容忍预建 bot;**外部客户很多本来就不用这三个平台**,让他们「自己起一堆 bot + 填配置」= 太超纲(Annie 原话)。所以产品版要在这几处做得更好:

1. **身份对客户隐形 / 少碰** —— 绝不让客户自己去建/管一堆 bot。产品在**幕后**为客户开好 agent 的三方身份;"客户不碰"= **不碰 bot 配置与凭据文件**(不是跳过授权,见第 3 点 BYO)。客户最多看到"给你的 agent 起个名字 + 头像"(甚至可默认)。§3.2 的 identity-interview 是往这个方向的第一步。
2. **给不用 Discord/GitHub/Linear 的客户,把那层抽象掉** —— 客户只在**我们的产品界面**里看到"我的 agent 团队",底下三方身份是实现细节,不暴露。客户根本不用 GitHub 时,agent 的 GitHub 身份要么不开、要么只在我们托管的 repo 里存在,客户无感。
3. **托管式 vs 自带式(BYO)—— 授权边界要诚实,别把 §0 的人机断点吹没**:
   - **(a) 托管式**:身份在 **Flywheel 控制的 org / workspace** 下,**建号 + 池运维 + 授权全由我们吸收**,客户零配置。适合不懂这些平台的客户。产品至少做 (a)。
   - **(b) 自带式(BYO)**:客户连自己的 GitHub org / Linear workspace。**我们能隐藏 manifest / 池 / 凭据运维,但替代不了客户的授权权** —— §0 的硬边界照旧:GitHub 普通 org 首次 install 仍需**客户 owner 浏览器 consent 一次**、Linear `actor=app` 仍需**客户 workspace admin 授权一次**。我们做的是"生成最短连接流",这一次 consent 之后的 token/refresh/sharding 才由我们托管。**BYO ≠ 零授权。**
4. **容量/建号的运维对客户不可见** —— §0 的"池化 + 人机断点"是**我们内部**的运维;托管式下这些被我们吸收(管池、管 Enterprise-or-not、管 sharding),客户不碰;BYO 下仅授权那一下归客户(第 3 点)。

**开放(留给产品化那轮 co-eval,不在本 issue 定)**:托管式下的成本归属(是 **workspace plan / API-Preview 稳定性 / 运营成本**,**不是** per-agent seat —— §4 已定 installed agents 不计 billable users)、客户数据隔离、per-客户 sharding、BYO consent 的产品化 UX —— 都是**产品版的问题**,内部 dogfood 后单独一轮 co-eval + PRD。
