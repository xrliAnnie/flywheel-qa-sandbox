# FLY-1180 三方 Agent 身份统一 — 调研

Issue: FLY-1180 (https://linear.app/geoforge3d/issue/FLY-1180/三方-agent-身份统一discord-linear-github-存量补齐-新增标准化-统一配置自动开通)
日期: 2026-07-11
基于: exploration.md

> 本文核实三平台"建号 + 接线"的技术细节 + 费用,给 plan.md 和拆 build issue 提供事实底座。所有平台事实以 2026 官方文档为准。
>
> **⚠️ v2 更正(权威以 plan.md 为准)**:早期版本 §5 曾把 GitHub/Linear 池写成"claim + rename",**当前正文已改为 identity-bound**(GitHub/Linear 名字/图标建号时定死、无 API 改名;池是照 spec 预建)。容量上限(Discord 75/team、GitHub 100/owner)+ install 边界(普通账号浏览器 / Enterprise Cloud 需先 bootstrap automation App)以 **plan.md §0/§4/§9** 为准。

---

## 1. 三平台"建号"能力精确边界

这是本 PRD 的技术地基:**每个平台创建"原始身份容器"都有一个不可 headless 的半手动步骤,而且三方还有其它人机断点(GitHub install owner-consent、Linear admin 授权);装好后的运行时 token / 发言 / 派单才是纯 API。**(GitHub/Linear 名字/图标建号时定死,无 API 改名——详见下表与 plan.md §0。)

### 1.1 Discord — 无建号 API,池化提前批量建(FLY-882 已落地)

- Discord **没有** API 从零建 Application/Bot。建 App 永远是 Developer Portal 浏览器动作。
- FLY-882 已建池基建。库函数(`scripts/lib/discord-bot-pool-lib.sh`)已提供 per-agent 运行时所需全部**纯 API** 步骤:
  - `pool_claim <slot> <name>` — 登记归属(不 rename/invite)。
  - `pool_rename <slot> <username>` — `PATCH /users/@me {username}`。
  - `pool_invite_url <slot> [perms] [guild]` — 生成 OAuth2 邀请链接。
  - avatar:`scripts/set-lead-avatar.sh --bot <x> --image <png>` — `PATCH /users/@me {avatar}`。
- **可自动化边界**:claim / rename / avatar / invite-url 全脚本化;只有"往池里补空 bot"是 Portal 浏览器动作(批量、提前)。

### 1.2 GitHub App — Manifest flow 建号需 1 次浏览器点击;install 1 次;token 纯 API

依据官方 [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):

- **建号**:Manifest handshake ——重定向到 GitHub 页,**注册者必须在浏览器点击确认创建**(不可 headless)。回调换临时 code。
- **换 code**(1 小时内)返回:`id`(App ID) + `pem`(private key) + `webhook_secret`。
- 支持 **org 拥有**:`https://github.com/organizations/ORG/settings/apps/new`。
- **install 到 repo**:一次浏览器授权(install 按钮);之后
- **installation access token 生成 = 纯 API**:用 App ID + pem 签 JWT → `POST /app/installations/{id}/access_tokens`。
- **可自动化边界**:建号 1 次浏览器点击(建号即定 name,**无改名 API**)+ install 1 次浏览器点击(普通账号 owner-consent;Enterprise Cloud 需先 bootstrap automation App 才能 API 装);per-agent 运行时的 token 生成 / commit-as-bot 纯 API(**无 rename**)。`xxx[bot]` 身份**不占 seat**。

### 1.3 Linear — OAuth app 严格 1:1 一个 agent 身份;install 需 admin 授权

依据官方 [Getting Started – Agents](https://linear.app/developers/agents) + [OAuth actor authorization](https://linear.app/developers/oauth-actor-authorization):

- **建号**:在 workspace settings 建一个 OAuth application(浏览器动作)。**每个 OAuth app = 一个 agent 身份(严格 1:1)** —— 「the name and icon of your application will be how the agent appears in workspaces where it is installed」。N 个身份 = N 个 OAuth app。
- **install**:`actor=app` 授权流,**需 workspace admin 授权**安装(「admin permissions are required to complete the installation」);安装时创建一个专属 user 代表该 agent,拿到自己的 token / scopes / teams。
- **装好后**:agent 像普通 user —— 可被 @mention、派单、评论、协作(原生 API)。
- **可自动化边界**:建 OAuth app + admin 授权安装 = 浏览器动作(批量提前);装好后的 actor token 使用 = 纯 API。

### 1.4 汇总

| 平台 | 建号(半手动) | install(半手动) | 运行时(纯 API) |
|---|---|---|---|
| Discord | Portal 建 bot(池已存在) | invite-url(可脚本生成链接) | claim / **rename** / avatar / token wire(Discord 有改名 API) |
| GitHub App | manifest 1-click(**建号即定 name,无改名 API**) | **普通账号浏览器 owner-consent**(Enterprise Cloud 需先 bootstrap automation App 才能 API 装) | JWT→installation token / commit-as-bot(**无 rename**) |
| Linear | settings 建 OAuth app(**建号即定 name/icon,无改名 API**) | admin 浏览器授权 `actor=app` | actor token 使用 / 评论派单(**无 rename**) |

**结论(v2 更正,以 plan.md §0 为准)**:三平台不对称 —— **Discord 空壳池 + claim 后改名;GitHub/Linear 无改名 API,须 identity-bound 预建**(照 spec 建号)。半手动步骤(建号 + GitHub install + Linear 授权)批量摊到提前;per-agent 运行时 token/发言/派单是纯 API。

---

## 2. 现有 provisioning 机制(要复用 / 要扩展的)

### 2.1 Lead/agent 身份 registry(现状)

- **`~/.flywheel/projects.json`** → `leads[]`,每条:`agentId` / `chatChannel` / `botTokenEnv` / `model` / `match.labels`(见 `fleet/example/projects.json`)。
- **`scripts/materialize-lead-manifests.sh`** 从 projects.json 生成 `~/.flywheel/manifests/<project>-<agentId>.json`(field-for-field 对齐 claude-lead.sh self-write)。
- **token 引用**:`botTokenEnv` 存**env 变量名**(如 `CASS_BOT_TOKEN`),真 token 在 `~/.flywheel/.env`;wrapper 间接展开 `${!BOT_TOKEN_ENV}`。**token 从不进 projects.json / manifest / argv。**

→ **统一 identity spec 就是扩展这张 registry**:desired 段 + 系统写的 typed binding(github/linear/discord 各字段)—— **以 plan.md §3.1 typed binding + §6 secret 合同为准**(binding 只存非秘密 ID,秘密走 `*Ref`)。

### 2.2 Token 安全模式(复用 + 分档,以 plan.md §6 为准)

- Discord 池 lib 的 `_pool_curl_authed`:token 经 `curl -K -`(stdin config directive)传,**永不进 argv/ps**;`set-lead-avatar.sh` token 按 env 变量名读、不上命令行、不打印。这是 **shell/curl 边界**的复用模式。
- **但不同 token 生命周期不同,不能一句"env-by-name + 永不落明文"带过**(见 plan.md §6):GitHub PEM = 长期多行私钥,宜 **0600 文件引用 / secret store**;GitHub installation token ~1h 应 **JIT mint** 不落 `.env`;Linear 有 access/refresh 生命周期 + bundle/CAS;**进程内 SDK(LinearClient/fetch)用内存 Authorization header**、不走 curl。且须承认现有受控明文面(Edge config 的 `linearToken`、`codex-home.ts` 的 `GH_TOKEN` 0600 config.toml)。

### 2.3 现有 Linear / GitHub 是**共享身份**(要替换的)

- **GitHub**:`EdgeWorker.ts` 用 `event.installationToken || process.env.GITHUB_TOKEN`(共享);Codex 侧 `GH_TOKEN` 经 `codex-home.ts` 注入 sandbox。全系统 agent commit/PR 共用一个身份(常是人类账号 `xrliAnnie` 或一个共享 bot)。
- **Linear**:`LinearActivitySink` 底层是一个共享 `IIssueTrackerService`(共享 OAuth / workspace)。
- → **存量补齐 = 从 0 给每个 agent 建 per-agent Linear + GitHub 身份**,并把这两处的共享 token 换成 per-agent token(按 agent 路由)。这是最大的一块工程改动。

---

## 3. 费用调研核实(2b)

> **v2 更正**:以 **plan.md §4** 为准(拆"增量 seat 费"与"容量边界")。此处早期"免费无限 / 100 硬上限 / 发确认信"已修正。

| 平台 | 增量 seat 费 | 容量边界 |
|---|---|---|
| **Discord** | $0(bot 免费) | **一个开发者团队最多 75 apps**(不是"无限"),上百个分多团队 |
| **GitHub** | $0(App 不占 seat;别用 machine-user) | **一个 owner 最多 100 Apps**,到顶分多 owner/org |
| **Linear** | agent **不计 billable seat**(2026 文档);Free 也有 Agent 平台 | **Developer Preview**;官方**无公开 app-count 上限**(不写"100 硬上限") |

**Linear 两点(以 plan.md §4/§9 为准):**
1. **per-agent Insights 报表**需 **Business($16 list price)**;基础身份不需要。
2. **Linear 确认信 —— Annie co-eval 决策:不发,按官方文档直接做**(原"发确认信=founder 待办"已撤销);留 Preview 风险标注。
3. **OAuth app 1:1 运维**:100 agent = 100 OAuth app,建号浏览器动作 ×100(可批量);运维最重,但费用 $0。

**净结论(修正后)**:三方**无 per-identity seat 费**;但 100 规模有真实**容量上限**(Discord 75/team、GitHub 100/owner → 需 sharding),Linear 是 Developer Preview 且官方无公开 app-count 上限。Linear 确认信按 Annie 决策**不发**。

---

## 4. 自动化可行性结论

- **可行**:Annie 的核心诉求「统一配置一次 → 系统自动三方开通,不用人工来回折腾」**可达成**,机制 = 池化 + 引导握手 + per-agent 纯 API 编排。
- **边界**:literal「零人工建号」不可行(三平台都不给纯 headless 建号 API)。折中 = 把建号/授权的浏览器动作**批量摊到提前**(池 replenish),per-agent 体验降到**在对话里回答几句**(§3.2 interview 前端,人不填文件/不跑命令;plan.md 第 3 轮)。
- **风险点**:(a) GitHub manifest 1 小时时限 → replenish 脚本要在窗口内换 code;(b) Linear 1:1 OAuth app → 100 规模建号运维重,需 replenish 引导;**Linear 无公开 app-count 上限 = 接受 Preview + 未知上限风险,按实际观测设 rollout stop/复评点**(确认信按 Annie 决策**不发**);(c) 三方 token 安全接线按生命周期分档(plan.md §6),不是一句 env-by-name。

---

## 5. Build-issue 技术拆解(交 Tadashi 的初步形状)

> 供 plan.md 细化;每条注明**复用点**。

1. **统一 identity spec + `flywheel-identity provision` 编排器**
   - 扩展 projects.json/manifest registry 加三方字段;一条幂等命令串三方 claim→configure→wire→输出就绪卡。复用:materialize-lead-manifests 的 registry + `_pool_curl_authed` 安全模式。

2. **GitHub App 池 + 自动开通集成**
   - `github-app-pool.sh`:manifest replenish(浏览器握手**按最终名字 identity-bound 批量建 App**,无 rename)+ claim + install(普通账号浏览器 owner-consent;仅 Enterprise Cloud + 先 bootstrap 有权限的企业 automation App 才能 API 装,见 plan.md §9-E)+ JWT→installation token 生成 + wire。替换 `EdgeWorker` 共享 `GITHUB_TOKEN` 为 per-agent installation token(按 agent 路由)。复用:codex-home.ts 的 GH_TOKEN 注入点。

3. **Linear OAuth-agent 池 + 自动开通集成**
   - `linear-agent-pool.sh`:OAuth app replenish(**按最终 name/icon identity-bound 批量建**,建号即定、无改名 + admin 授权 `actor=app`)+ claim + actor token(access/refresh)wire。把 `LinearActivitySink` 共享身份换成 per-agent actor(按 agent 路由)。

4. **Discord 自动化收口**
   - 把 FLY-882 的 claim/rename/avatar/invite/wire 收成 `provision` 一条命令的一个子步(目前分散手动)。复用:discord-bot-pool.sh 全部。

5. **(可选)FLY-1038 控制台"开新 agent"表单** — 统一配置的可视皮,后续。

6. **新增标准化(策略)** — onboard/新-agent checklist 加"三方身份就绪"硬验收项;`provision` 默认三方全开;缺任一方 = 未完成。
