# FLY-3133 Cloudflare 外用能力 Epic — 探索
Issue: FLY-3133 (https://linear.app/geoforge3d/issue/FLY-3133/epic用-cloudflare-给-flywheel-补上在外面也能用-页面保留期-登录与分享-远程控制台-手机试原型-云截图)
日期: 2026-10-01
基于: 无（上游为 product/doc/FLY-3102-cloudflare-cf-cli/proposal.html 第 4 版 + explainer.html 第 2 版，founder 9-30 批）

> 审计基线：生产仓 `~/Dev/flywheel` main @ `9fcbdebb1`（只读）。本工作树是 QA 沙箱分支，
> 其 `packages/` 比生产旧（不含 `report-retention.ts` 等），因此下文所有代码引用指生产 main。

## 1. 这张单是什么

Epic，不是一张可以一口气做完的单。founder 已拍：开 F1a、F1b、F2、F3、F6、F8；F5 挂起等 cf 正式版；
F4 → FLY-555、F7 → FLY-3131。三条共同前提（Cloudflare 账号 / F2 路线 / 6 个 Gmail 清单）要 Annie 定，
「做到对应单之前问她」。

本 design 节点的产物 = **Epic 级技术设计**（各子单的架构、接口契约、依赖、负向守卫、验收证据）
+ **第一个可实施增量 F1a 的实施级计划**。F1a 是唯一不依赖三条前提的子单（提案原话「不需要 Cloudflare」），
也是建议顺序第一批里唯一能立刻开工的。

## 2. 现状审计（逐子单，带出处）

### 2.1 托管页（F1a / F1b / F6 共用）

| 事实 | 出处 |
|---|---|
| 14 天是代码常量 `REPORT_RETENTION_MS`，`isReportExpired(now, createdAt)` 用 `>=` | `packages/teamlead/src/bridge/report-retention.ts:1-4` |
| 该文件被**原样复制**进 Vercel 网关部署（`api/report-retention.js`） | `report-hosting-migration.ts:73-93` |
| 过期在三处执行：①网关每次打开按对象年龄 404；②`stageReport` 发布时裁剪 registry + 本地文件；③每日 Blob sweep | `report-gateway-runtime.ts:96-124`、`report-registry.ts:843-921`、`report-blob-store.ts:369-417`、`report-hosting-maintenance.ts:52` |
| FLY-203 的 100 条 / 10MB 上限**已删**（FLY-2283），现在 TTL 是唯一规则；FLY-2283 合同：「每条链接从本次创建起完整可访问 14 天」 | `report-registry.ts:843-845`、`doc/reference/remote-report-pipeline.md:59-60` |
| 报告登记 = JSON 文件 `~/.flywheel/reports/registry.json`（不是 SQLite），主键 `token`（32 hex），mkdir 锁 + 原子 rename；字段 `{token, projectName, title?, createdAt, bytes, mutable?, capabilityOwner?}` | `report-registry.ts:286-353,410,978` |
| 没有任何「钉住 / 保留」字段，也没有发布后改元数据的接口或 CLI；`resumePublish` 明确拒绝续期 | `report-registry.ts:743-788`、`reports-route.ts` 路由只有 publish/deliver/verify/receipts |
| 网关拿不到任何每页元数据，过期纯按对象年龄（迁移 manifest 例外） | `report-gateway-runtime.ts:96-109` |
| 「Epic 固定页每天重传续命」**已不存在**（FLY-2751 删掉所有自动发布）；Epic 稳定页现在 `last_published_at + 14d` 过期 | `lead-rules-base/runner-patrol-rules.md:23`、`epic-page-route.ts:171-189` |
| 存储抽象 `ReportBlobStore`（bind/putReport/putEpicPage/putRawObject/deleteReports/sweepExpiredReports…），唯一实现 `VercelBlobReportStore`；Vercel 专有痕迹散在 `provider:"vercel-blob"`、`vercelProjectName`、`.vercel.app` 硬编码（7 处） | `report-blob-store.ts:47-78,133,460`、`reports-route.ts:118`、`report-url.ts:7-9` 等 |
| 网关核心是 `(Request) => Response` + 可注入依赖，移植到 Worker 成本低 | `report-gateway-runtime.ts:63` |
| 网关单独重部署已有命令：`pnpm migrate:report-hosting --deploy-gateway-only`；先例：gzip-v1 「网关部署 + 四项探针通过后才写数据门」 | `doc/reference/remote-report-pipeline.md` 账号轮换手册 |
| 截图在 CLI 侧：`captureReportScreenshot()` 驱动 ProofShot/agent-browser，PNG 落 `~/.flywheel/reports/previews/<reportId>.png`；Bridge `/deliver` 校验路径在 previews 根下 ≤25MB；失败降级为只发链接 | `flywheel-comm/src/commands/publish-report.ts:243,340-611`、`reports-route.ts:159-232` |
| 本机 Chrome 残留靠 `chrome-session-reaper.ts`（60s 间隔） | `chrome-session-reaper.ts:47`、`plugin.ts:12794-12880` |

### 2.2 Bridge 控制台（F2 / F3）

**审计最重要的发现**：Bridge 判断「本机」只看 `Host` 头，不看 TCP 对端地址；而且有三处根本不查：

| 路由 | 保护 | 出处 |
|---|---|---|
| `GET /health` | 无 | `plugin.ts:3139` |
| `GET /`（控制台 HTML） | 无（注释写 loopback only，只靠绑定地址） | `plugin.ts:3247-3255` |
| `GET /sse` | 无 | `plugin.ts:3257` |
| `POST /actions/:action`（approve / terminate / retry / reject / defer / shelve） | **无**；`fcMw` 在 `decisionMode=off`（默认）时直通 | `plugin.ts:3303-3306`、`actions.ts` |
| `/api/fleet/snapshot`、`/progress`、`/flag-report.html` | 只查 Host 是否 loopback 名 | `plugin.ts:3570-3613`、`loopback-origin.ts:21-47` |
| `/api/fleet/*/stage|apply` | Host + same-origin + 60 秒一次性 confirmToken（确认「请求没变」，不确认「是谁」） | `fleet-routes.ts:80,196`、`fleet-admin.ts:143-173` |

隧道（cloudflared）和 Tailscale Serve 都是**从本机 127.0.0.1 发起**连接到 9876。所以：
- 若把隧道直接接到 `127.0.0.1:9876`：`/actions/*` 无任何检查可达 → 外网（只要过了登录门）能 approve/terminate。
- 若用 `httpHostHeader: 127.0.0.1:9876` 让控制台能读：Host 检查也通过；自己构造 `Origin` 的客户端还能过 same-origin。
- 结论：**9876 永远不能接隧道**。远程只读必须是一个**只有读路由的独立监听面**（见 research §2）。

`TEAMLEAD_HOST` 必须是 loopback（`config.ts:56-61`），这条保持不变。
控制台页面本身会从浏览器 POST `/api/fleet/changes/stage|apply`（`fleet-console-html.ts:701-732`），页面无 CSP；
已有「只读」显示概念（服务端 `writeCapability` → 页面显示只读理由，`management-section-registry.ts:202-210`）。

### 2.3 原型（F3）

「能跑的原型只在本机看」不在任何规则文件里原文出现；对应的真实规则是
`.flywheel/agents/nodes/product_design.md:124-174`：交付物是 localhost URL 上的真实代码，
founder_review 绑定的必须是 HTTPS 托管评审卡（`flywheel-comm/src/founder-review.ts:285-286`），
localhost URL 只放在卡里面。F3 要做的是给卡里的 localhost 原型一个手机能开的 https 地址。

### 2.4 Cloudflare 现状（F5 / F8）

- 唯一在 Cloudflare 上的东西：安装包分发 Worker `flywheel-onboard-endpoint` + R2 桶 `flywheel-payloads`
  （`packages/payload-endpoint/wrangler.toml`），workers.dev 子域 `xrliannie-b`。
- 唯一一把 CF 钥匙：GitHub `release` 环境 secret `CLOUDFLARE_API_TOKEN`（Workers Scripts Edit + R2 Edit + Account Settings Read），
  只在 main 上的 `payload-activation.yml` 里用；`CLOUDFLARE_ACCOUNT_ID` 是 repo variable。
- 测试写死 wrangler 命令原文：`scripts/__tests__/release-workflows-structure.test.sh`（S4a：任何提到 CLOUDFLARE 的 workflow 必须是 release 环境）、
  `packages/payload-endpoint/__tests__/activation-config.test.mjs:281-288`。
- Runner 环境是**白名单**：`TmuxAdapter.ts:195-247` 用 `env -i` + `RUNNER_PANE_BASE_ALLOWLIST` 起 pane；
  `tmux-environment-scrub.ts` 再洗一遍。Codex Lead 洗 `/TOKEN|SECRET|KEY/i`（`secret-broker.ts:36`）。
  现有「从文件读钥匙」的先例是 notion skill（`$NOTION_TOKEN` → `~/.flywheel/.env` → `~/.config/notion/api_key`），
  正因为文件读能绕开 env 白名单。**没有现成的「给 Runner 一把只读外部钥匙」模式。**
- founder-only-authority 合同没有一条明写「给 Runner 钥匙」，但惯例是：真钥匙的值只有 Annie 有、agent 不搬运（FLY-1323 §7b、notion skill）、
  `runbooks/founder-authority.md` 禁止 agent「制造凭据」。

## 3. 隐含假设与需要更正的说法

1. 提案说 F1a「Epic 固定页现在是靠每天重新上传才一直在」—— 已过时（FLY-2751），现在 Epic 页 14 天不手动发就过期。
   F1a 正好顺带解决它（可把 Epic 稳定 token 设成永久）。
2. 提案说「发布停了 42 分钟」出自 FLY-2538 —— 实际证据在 `engineering/doc/FLY-2140-epic-page-content-model/implementation-evidence.md:907`（Vercel 每日部署配额 100/100）。不影响设计结论：F1b 不能走「每发一页重部署一次」。
3. F1a 设「2 天」= 比 FLY-2283「完整可访问 14 天」更短。这是 founder 显式的单页覆盖，合同文字要同步改成「默认 14 天，可单页覆盖」。
4. 「控制台按网址名判断，走隧道会被拒」只对 `/api/fleet/*` 成立；`/`、`/sse`、`/actions/*` 不查。F2 设计必须以此为前提。

## 4. 方案方向（每子单 2–3 个候选，研究里定）

| 子单 | 候选 | 倾向 |
|---|---|---|
| F1a 保留期 | A. registry 字段 + 全局派生投影；B. 每页策略对象 `r/<token>/policy.json`；C. 写进对象路径/元数据；D. 网关查 Bridge | **B**（r2：A 在裁剪/重发/retarget/写超时时会分裂，见 research §1） |
| F1b 搬 CF | A. R2 + Worker 网关 + Access；B. Workers 静态文件每页重部署 | **A**（B 撞部署配额，先例 FLY-2140） |
| F1b 分享 | A. Worker 读 Access JWT 邮箱 + 每页 ACL；B. 每页一个 Access 应用 | **A**（B 应用数爆炸、改名单要改 CF 配置） |
| F2 远程控制台 | A. CF 正式隧道 + Access（要域名）；B. Tailscale Serve（手机装 App）；两者都接**独立只读监听面** | 路线由 Annie 定；只读监听面两条路线共用 |
| F3 原型 | A. 复用 F2 的通道 + 登录门；B. 临时隧道（谁有链接谁能开） | **A** 默认，B 仅作 founder 显式选的「临时」选项 |
| F6 云截图 | A. Browser Rendering REST `/screenshot` 从 CLI 调；B. Worker 内 Puppeteer | **A**（改动最小，接在 `captureReportScreenshot` 这一刀） |
| F8 只读钥匙 | A. Account API Token 只读权限 + 文件读 skill；B. 放 Runner env 白名单 | **A**（与 notion 先例一致，可撤销，不改 Runner env 合同） |

## 5. 范围外（与 issue「不做」一致）

不把 Runner 搬到 CF（FLY-1688）；多机（FLY-555）；外部推送入口（FLY-3131）；cf 公测版不进日用主路径；
不开大额付费项（超免费额度先问 Annie）；不部署、不 merge、不重启（独立 updater 负责）。
