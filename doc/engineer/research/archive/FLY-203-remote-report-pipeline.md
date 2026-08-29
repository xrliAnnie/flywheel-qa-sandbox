# Research: Remote Report Pipeline — FLY-203

**Issue**: FLY-203（Remote report pipeline — HTML 报告自动发布托管 + Discord 截图+链接送达）
**Date**: 2026-06-03
**Source**: Brainstorm 结论记录在 Linear issue FLY-203（Annie 已拍板：托管 HTML 骨干 + 截图预览，一条 Discord 消息；纯截图方案否决；隐私 = 不可猜 URL；与本地 auto-open 共存）

---

## 1. 三块现成件审计（真读代码，非凭印象）

### 1.1 GEO-294: publish-html + Vercel deploy（可复用框架，但隐私是 GAP 不是现成件）

| 文件 | 行数 | 内容 |
|------|------|------|
| `packages/teamlead/src/bridge/publish-html-route.ts` | 70 | `POST /api/publish-html {projectName, html}`，512KB cap，projectName sanitize，token auth，无 VERCEL_TOKEN 时 501 |
| `packages/teamlead/src/bridge/vercel-deploy.ts` | 114 | Vercel REST `v13/deployments`，`target: "production"`，inline file content，poll READY（30s cap），返回 `https://triage-{project}.vercel.app` |

**关键发现 1 — issue 里"沿用 GEO-294 不可猜做法"与 shipped 代码不符**：

- GEO-294 **原 plan** 是 Supabase Storage private bucket + signed URL（不可猜、7 天 TTL）— 见 `doc/engineer/plan/archive/v1.17.0-GEO-294-triage-html-report.md` §安全决策。
- 生产翻车：Supabase Storage 不会 inline 渲染 HTML（retro `20260330-sprint-orchestrator-v1.18.md` RC-3："4 次转向"，并因此立了 **"Spike before commit"** 规则）。
- 落点改成 Vercel **确定性 production alias**（`triage-geoforge3d.vercel.app`）— 因为 Hobby plan 的 SSO Protection 把 deployment-specific URL（本来天然不可猜）全部挡掉，只有 `{name}.vercel.app` 公网可达。
- Simba 的 cos-lead agent.md 也确认生产用法就是这个固定 URL。

**关键发现 2 — production alias 每次部署覆盖上一份**：旧报告链接即死。"任何 agent 的每份报告都发布" 场景下不能直接复用单 alias。

**结论**：HTTP 端点骨架、Vercel deploy helper、512KB cap、501/502 错误语义可复用；**不可猜 URL 与多报告共存是全新工作**。

### 1.2 FLY-27: Bridge static serve（比想象窄很多）

- 实际只有 `triage-template-route.ts`（29 行）：`GET /api/triage/template` serve **一个**静态模板文件（`packages/teamlead/static/triage-template.html`），token auth。
- **没有**通用静态报告 hosting；Bridge 监听本机端口，手机远程不可达（除非加隧道）。
- 环境事实：本机装有 tailscale，Annie 手机（Pixel 9）已注册 tailnet（检查时 offline = VPN 未开）。`tailscale funnel` 可以把本地端口暴露成公网 HTTPS。

### 1.3 FLY-188 / GEO-151: visual-capture 截图能力（大部分可复用）

- `packages/flywheel-comm/src/commands/visual-capture.ts`（440 行）：驱动 `proofshot` CLI（底层 agent-browser headless Chrome），有 atomic lock（多 capture 不抢端口）、artifact discovery、vision token budget、manifest。
- 现有两个模式：`ui`（必须 `--dev-command` 起 dev server）、`3d`（model + viewer URL + angles）。
- **`proofshot start --url <url>` 已存在**（3D 模式生产在用，`--help` 验证过）→ 截"一个已发布的报告 URL"只需一个轻量新模式或直接复用 `--url`。
- 截图 = viewport 截图（`proofshot exec screenshot <file>.png`），没有 DOM 区域定位能力。
- FLY-188 增加的 `AGENT_BROWSER_PROFILE` / stream port env 透传与本需求无关（报告 URL 公开可达，无需登录态）。

### 1.4 意外发现 — Discord 投递胶水大半已存在（GEO-151 artifact_delivery 链）

```
Runner: flywheel-comm notify
  → POST /events (event_type=artifact_emitted)
  → artifact-event.ts: store.getSession(execution_id) + resolveLeadForIssue + resolveChatThreadId
  → proofshot-deliver.ts: 渲染指令 markdown
  → Lead Claude session: mcp__plugin_discord_discord__reply(chat_id, message, files=[...])
```

- 带 HeartbeatService 重试、25MB/文件 + 10 文件/消息 cap。
- **限制**：`handleArtifactEvent` 第一步就 `store.getSession(execution_id)`，没有 Runner session 直接 `handled:false`。而报告的主要生产者（team-lead、Simba、未来任意 agent）**不是 Runner session** → 这条链不能直接复用为 FLY-203 的投递路径。
- Bridge 侧现有 Discord 发送（`discord-utils.ts postDiscordMessageToChannel`）**只支持 JSON 文本消息**，不支持附件（multipart）。LeadAlertNotifier 等 8 处 Discord REST 调用同样纯文本。

### 1.5 触发面现状（谁在生成报告）

- team-lead session：`/tmp/*.html`（13–20KB：ship-review、plan explainer、changes-QA、triage），生成后本地 `open`。
- Simba（cos-lead）：triage 报告 → `POST /api/publish-html`（固定 URL）→ Discord 文字报告附链接。
- 报告体积实测 13–20KB，远低于 512KB cap。
- 频道解析素材已有：`projects.json` 每 lead `chatChannel` + 项目级 `generalChannel`（geoforge3d 已配）；issue→chat thread 有 `resolveChatThreadId`。

---

## 2. 不可猜托管选型（含真 spike）

### 2.1 候选对比

| 方案 | 不可猜 | 旧链接持久 | HTML inline 渲染 | 新基建 | 风险 |
|------|--------|------------|------------------|--------|------|
| **A. 单 Vercel 项目 + 随机 token 路径（累积重部署）** | ✅ 路径 128-bit token | ✅ 重部署带上全部保留文件 | ✅（spike 实证） | 无（VERCEL_TOKEN 已配） | 部署 payload 随保留数增长（需 retention cap） |
| B. Vercel Blob | ✅ 自带随机后缀 | ✅ | ❓ 未验证（HTML 可能被强制 attachment 防钓鱼） | 需开通 Blob store + 新 SDK/API | 未验证假设 = GEO-294 翻车同款风险 |
| C. Bridge static + tailscale funnel | ✅ token 路径 | ✅ 本地文件 | ✅ | funnel 配置 + 把本机端口暴露公网 | Mac 即 server（单点）；公网暴露面；funnel 稳定性未知 |
| D. Supabase Storage | ✅ signed URL | ✅ | ❌ **生产已证伪**（GEO-294 RC-3） | — | 已死路 |

### 2.2 方案 A 真 spike（2026-06-03，遵守 "Spike before commit"）

用生产 VERCEL_TOKEN 对临时项目 `fly203-spike` 跑了两轮部署：

1. **Deploy 1**：两个文件 `r/<tokenA>/index.html` + `r/<tokenB>/index.html`（token = `openssl rand -hex 16`，128-bit）。
   - `https://fly203-spike.vercel.app/r/<tokenA>/` → **200 `text/html; charset=utf-8`**（inline 渲染 ✅）
   - tokenB 同样 200 ✅
   - 根路径 `/` → **404**（无目录列表，token 不泄露 ✅）
   - 错误 token → **404** ✅
2. **Deploy 2**：保留 tokenA + 新增 tokenC、**故意省略 tokenB**。
   - tokenA → 200（保留文件持久 ✅）
   - tokenB → 404（**省略即死 — 实证必须累积重部署**）
   - tokenC → 200 ✅
3. 部署耗时：READY 在 2–6s（poll 1–3 次 × 2s）。
4. Spike 后项目已删（DELETE /v9/projects → 204），链接全部失效确认。

**结论：选 A**。Vercel 是唯一生产已验证 + 本次 spike 全过的路径；B 的核心假设未验证；C 把本机变公网 server，运维面大且和"Mac crash 频发"的现状相性差。

### 2.3 方案 A 的设计含义

- **累积重部署**：发布器必须本地保留全部"在保"报告文件（`~/.flywheel/reports/`+registry），每次发布 = 全量文件重部署。
- **Retention cap 必须有**：报告 ~20KB，cap 100 份 ≈ 2MB inline JSON payload — 远低于 API 限制；不设 cap 则无限增长。
- **域名也加随机性**（防御纵深）：项目名带随机后缀（如 `fw-reports-3f9c`），首次创建后持久化。`{name}.vercel.app` 是全局命名空间，固定名可被抢注/枚举。
- **防搜索引擎**：每次部署附 `robots.txt`（`Disallow: /`）；HTML 无 `<meta name="robots">` 时注入 `noindex`。
- 现有 `/api/publish-html`（Simba triage 在用）**不动**，byte-compat；新管线走新端点。

---

## 3. 投递设计（一条消息 = 截图 + 链接）

### 3.1 谁发 Discord 消息 — 两个选项

| | 复用 artifact_delivery 链（Lead 发） | Bridge 直发 multipart（新 ~50 行） |
|---|---|---|
| 非 Runner 生产者（team-lead/Simba） | ❌ 需要 Runner session，不满足 | ✅ 任意 agent curl Bridge 即可 |
| Lead 在线依赖 | ❌ Lead 挂了消息不发 | ✅ 无依赖 |
| 重试 | ✅ HeartbeatService 现成 | 需简单错误语义（调用方重试） |
| 新代码量 | 改造 artifact-event 解耦 session（侵入大） | `discord-post-file.ts` 一个 multipart helper |

**结论：Bridge 直发**。Discord REST `POST /channels/{id}/messages` 的 multipart/form-data（`files[0]` + `payload_json`）是标准用法；沿用 `allowed_mentions: {parse: []}` 纪律。

### 3.2 截图怎么拿

- 截**已发布的 URL**（不是本地文件）：免掉 file:// 兼容问题，且截到的就是 Annie 手机将看到的东西。
- 复用 proofshot（`start --url <published-url>` → `exec screenshot` → `stop`）+ 现有 atomic lock。
- **关键区 = 设计约定而非 DOM 定位**：报告模板把 verdict 条/结论卡放顶部（现有 HTML report style guide 本来就是 max-width + 顶部 verdict 的结构），截 viewport 首屏即可。
- **优雅降级**：截图失败 ≠ 投递失败 — 退化为"纯链接 + 标题"消息（核心价值是链接可达，截图是预览增强）。

### 3.3 编排放哪 — CLI 编排（瘦 Bridge）

`flywheel-comm publish-report` 客户端编排三步：publish（Bridge）→ screenshot（本地 proofshot）→ deliver（Bridge）。理由：

- proofshot lock 本来就是 agent 侧设计；Bridge 进程不该 spawn headless Chrome（崩溃面/负载）。
- 所有 agent 同机运行（系统既有假设），截图文件直接传本地路径给 Bridge deliver 端点即可。
- Bridge 只做两件无状态的事：托管发布（带 registry）、Discord multipart 发送。

### 3.4 频道解析

`--channel` 显式参数 → 否则 `projects.json` 该项目 `generalChannel` → 都没有则**报错**（不猜）。Bot token 用 Bridge 全局 `discordBotToken`。

---

## 4. 与本地 open 共存 + 开关

- 本地流程**零改动**：agent 照旧生成 HTML + `open`。远程管线 = agent 额外跑一条 `flywheel-comm publish-report` 命令（增量叠加）。
- 开关：`FLYWHEEL_REMOTE_REPORTS=0` → CLI 直接 no-op exit 0（打印说明）；未配 VERCEL_TOKEN → Bridge publish 端点 501（沿用 GEO-294 语义），CLI 透传报错。
- Rollout = prompt 侧改动（team-lead 报告习惯、Simba agent.md、pm-triage skill 增加一行"发布远程版"），不在本 issue 代码范围内，作为 ship 后配置步骤。

---

## 5. 新工作清单（→ Plan）

1. **Bridge**: `report-registry.ts`（fs registry + retention cap）+ `reports-route.ts`（`POST /api/reports/publish` + `POST /api/reports/deliver`）+ `vercel-deploy.ts` 泛化出多文件部署函数（保留旧 `deployToVercel` byte-compat）+ `discord-post-file.ts`（multipart 附件发送）。
2. **flywheel-comm**: `publish-report` 命令（publish → screenshot(降级可跳) → deliver 编排）。
3. **测试**: 单测（registry retention/token 生成/payload 构建/路由校验/multipart 构建/CLI 降级路径）+ 路由集成（mock Vercel/Discord fetch）+ QA 真 Discord E2E（真发布 + 真消息 + 手机 viewport 点开链接）。
