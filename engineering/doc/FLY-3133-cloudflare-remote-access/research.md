# FLY-3133 Cloudflare 外用能力 Epic — 调研
Issue: FLY-3133 (https://linear.app/geoforge3d/issue/FLY-3133/epic用-cloudflare-给-flywheel-补上在外面也能用-页面保留期-登录与分享-远程控制台-手机试原型-云截图)
日期: 2026-10-01
基于: exploration.md

本页逐子单定技术方向；价格/额度出处沿用 FLY-3102 explainer 第 2 版（官方价目页链接见该页），本页只补新查的一手资料。

## 0. 新查的一手资料

| 主题 | 结论 | 出处 |
|---|---|---|
| Access 身份校验 | 应校验 `Cf-Access-Jwt-Assertion`（cookie 不保证传递）：按 `kid` 取 `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` 公钥验签，校验 `iss`=团队域、`aud`=应用 AUD tag、`exp`；邮箱取 JWT `email` claim。**不能**只信 `Cf-Access-Authenticated-User-Email` 头 | https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/ |
| Tailscale Serve | 只在 tailnet 内可见（公网要 Funnel，本设计**不用** Funnel）；自动加 `Tailscale-User-Login`，并会**剥掉**入站请求里伪造的同名头；要求 tailnet 开 HTTPS 证书，域名形如 `<device>.<tailnet>.ts.net`，不用买域名；官方建议被代理服务只听 localhost | https://tailscale.com/kb/1312/serve |
| Browser Rendering | 免费版每天 10 分钟、同时 3 个；付费版每月 10 小时，超出 0.09 美元/小时；REST「快捷动作」（含截图）与浏览器会话共用时长 | https://developers.cloudflare.com/browser-rendering/pricing/ |

## 1. F1a 页面保留期（不依赖 Cloudflare）

### 1.1 单一真相放哪
候选：
- **A（选）**：`registry.json` 的 `ReportEntry` 加可选字段 `retention`；网关读一个由 registry **派生**的「保留期投影」对象。
- B：把保留期写进对象路径或对象元数据 —— 路径即 URL，不能改；Vercel Blob 不支持自定义对象元数据。否决。
- C：网关回调 Bridge 查 —— Bridge 只听本机，网关在 Vercel，做不到也不该做。否决。

理由：registry 已是报告身份的唯一登记处（锁 + 原子 rename + 损坏即停）；投影只是它的只读副本，可随时从 registry 重算，不形成第二份可漂移的真相。

### 1.2 策略值（唯一词表）
```ts
type ReportRetentionPolicy = { kind: "permanent" } | { kind: "days"; days: number }; // 1 ≤ days ≤ 365，整数
// 字段缺省 = 默认（DEFAULT_REPORT_RETENTION_DAYS = 14，唯一集中设置，验收⑤）
```
过期时间统一由一个纯函数算：`reportExpiresAtMs(createdAtMs, policy?) → number | null`（null = 永久）。
`isReportExpired(now, createdAt, policy?)` 保持向后兼容（不传 policy = 今天的行为，`>=` 边界不变）。
这两个函数在 `report-retention.ts` —— 该文件**本来就被原样复制进网关部署**，所以 Bridge、sweep、网关天然用同一份算法，无需第二份实现。

`createdAt` 的基准不变：普通报告用 registry `createdAt`（网关侧用迁移 manifest 或对象 `uploadedAt`，与今天相同）；
Epic 稳定 token 按最新一次上传计时（今天的语义）。所以「Epic 稳定页设成永久」= 不用再为续期手动重发。

### 1.3 投影对象
- 路径 `meta/report-policy.json`（**不在 `r/` 前缀下**，sweep 永不扫到它），private，`allowOverwrite: true`。
- 内容：`{"schema":"flywheel.report-policy.v1","overrides":{"<token>":{"kind":"permanent"}|{"kind":"days","days":N}}}`，只含非默认项，按 token 排序、确定性序列化；registry 记 `hosting.reportPolicyDigest`（sha256）用于对账。
- 设计成 F1b 可扩展：v2 在每项上加 `sharedWith`（见 §2）。同一个投影 = 同一个「每页策略」通道，不另起分享名单文件。

### 1.4 网关怎么读
- 每个请求先确认 token 存在（今天的流程），再取投影（进程内缓存 60 秒）。
- 投影 404 → 没有覆盖项（首次上线即兼容）。
- 投影读失败或 schema 不认识 → 若有 ≤10 分钟内的上次成功值就用它，否则 **502 fail-closed**（与网关今天对 Blob 读失败的处理一致）。
- 只有缩短（如 2 天）依赖投影才能「按时失效」；延长依赖投影才能「过 14 天仍可开」。两个方向都由同一份投影决定，没有隐含默认。
- 子资源 audit 跟随父页的策略（今天「父页 TTL 为准」的语义不变）。

### 1.5 网关能力门（防止「Bridge 说永久、网关仍按 14 天 404」）
先例：gzip-v1 是「网关部署 + 探针通过后才写数据门」。F1a 照抄：
`pnpm migrate:report-hosting --deploy-gateway-only` 部署后，校验部署模块导出 `reportExpiresAtMs` 且网关入口引用投影读取器（复用 `assertGatewayLocalImportsResolve` 的导出检查），通过后在 registry `hosting` 写 `reportPolicy: "v1"`。
Bridge 在该门未写时，**拒绝任何非默认设置**（409 `gateway_not_policy_capable`），设回默认始终允许。retarget 到新账号时门随网关重新证明。

### 1.6 写入顺序与并发
全部在 registry 锁内：读最新 registry → 算新状态 → 渲染投影 → **先 put 投影** → 再原子 rename registry。
- put 失败 → 什么都没变，返回 502。
- put 成功、rename 失败 → 投影领先 registry；每日 sweep 和下一次设置都会「从 registry 重算投影，digest 不同就重写」对账。领先期间最坏情况 = 一个页面比 registry 记载早/晚失效，直到对账（≤24h）；不会删除对象（删除只看 registry，见下）。
- sweep 删除只用 registry 里的策略；registry 读失败 → 本轮不删（fail-closed）。

### 1.7 三处过期执行点都改
网关（§1.4）、`stageReport` 裁剪（按条目策略；永久条目不裁剪、本地文件不删）、每日 sweep（`sweepExpiredReports(now, createdAtByToken, policyByToken)`；不在 registry 的孤儿对象照旧按 14 天）。
retarget（换账号搬运）按策略判断「仍有效」并在新 store 写投影后再 CAS 切换。

### 1.8 谁能改、怎么改
- Bridge：`GET /api/reports/retention`（非默认清单，验收④）、`POST /api/reports/retention`（设/改/清）。挂在既有 `reportsAuthMiddleware` 下：**只认 master token**；ingest token（Runner）只允许 `POST /publish`，今天的中间件已经拒绝其它路由 —— Runner 不能给自己的页面续命。
- CLI：`flywheel-comm report-retention set <url|token> <permanent|default|Nd>`、`flywheel-comm report-retention list [--json]`；`set` 输出一句「这页现在永久保留」/「这页将于 <日期，太平洋时间> 失效」供 Lead 回 founder（「你怎么用」）。
- 已过期（按当前策略）或不在 registry 的 token：拒绝（404/410），**不复活**已过期页面。
- 输入校验：token `^[0-9a-f]{32}$`；URL 只取 `/r/<token>/`；days 整数 1–365。

### 1.9 成本
按每页约 87 KB，1 万页永久 < 1 GB；既有 80% 存储告警继续覆盖。每次页面打开多一次投影读，但有 60 秒缓存。

## 2. F1b 搬到 Cloudflare + 6 Gmail + 单页分享（架构层，实施等前提①③）

- 存储：R2 私有桶；网关：Worker（`report-gateway-runtime.ts` 的 `(Request)=>Response` 核心移植，依赖注入换成 R2 binding）。
  **不走**「Workers 静态文件每发一页重部署」——撞部署配额先例（FLY-2140 证据：Vercel 每日部署 100/100）。
- 新实现 `R2ReportStore implements ReportBlobStore`；`ReportHostingState.provider` 从字面量 `"vercel-blob"` 扩成 `"vercel-blob" | "cloudflare-r2"`；7 处 `.vercel.app` 硬编码收拢到 `report-url.ts` 一个函数。
- 登录门：Access 应用保护 workers.dev 网关地址（官方支持，不强制自有域名）；登录方式 Google + 一次性验证码。
- 身份：Worker 校验 `Cf-Access-Jwt-Assertion`（§0），取 `email`；**不信**明文邮箱头。
- 授权（两层，founder 提案原文）：
  - 第一层 Access 策略只放「6 个 Gmail ∪ 至少被分享过一页的朋友」。名单由 Bridge 从 registry 推导，经一个只能改**这一个** Access 应用策略的钥匙同步（钥匙只在 Bridge，Runner 拿不到）。是否改为「Access 放行任何登录、Worker 独断」是 F1b 设计节点的取舍点（后者省掉 Bridge 写 Access 的钥匙，但任何拿到链接的人都会占一个免费席位）。
  - 第二层 Worker 读投影 v2：owner 6 邮箱放行所有页；朋友只放 `sharedWith` 含自己的页。
- 分享名单的单一真相仍是 registry（`ReportEntry.sharedWith`），投影 v2 是派生；撤销 = 改 registry → 重写投影 → Worker 缓存 ≤60 秒内生效（验收⑤「立刻打不开」以缓存上限为准，QA 实测）。
- 旧 Vercel 链接：切换后 Vercel 网关只读保留到最后一个默认期页面过期（≤14 天）；永久页迁到 R2，Vercel 网关对迁移过的 token 回 301 到新地址；之后下线 Vercel。回滚 = registry `hosting.provider` 切回（retarget 同款 CAS）。
- 免费额度：Access 50 席；R2 10 GB；Worker 10 万次/天 —— 按每天约 37 页远在额度内（估算）。

## 3. F2 手机只读看控制台（架构层，实施等前提①②）

### 3.1 关键约束（来自审计）
9876 上 `/`、`/sse`、`/actions/*` 不查任何东西，Host 检查也挡不住本机来的代理流量。**绝不把隧道/Serve 接到 9876。**

### 3.2 选型：独立只读监听面（两条路线共用）
在 Bridge 进程里起第二个 HTTP server，`127.0.0.1:<TEAMLEAD_REMOTE_CONSOLE_PORT>`（默认关；开关 `FLYWHEEL_REMOTE_CONSOLE=1`）：
- 只注册 `GET/HEAD`：`/`（控制台 HTML 以 `readOnly` 渲染：不含 stage/apply 代码，页面加 CSP `default-src 'self'`）、`/api/fleet/snapshot`（同一个 snapshot 构建器，所有 `writeCapability` 强制 false）。其它一律 404；没有任何 POST 路由 —— 改东西的处理器**物理上不在这个 server 上**（不是「拦住」，是「不存在」）。
- 进程内直接调用快照构建函数，不反向代理到 9876（避免 Host/Origin 伪造类问题）。
- 身份校验（纵深防御，门本身是 Access / tailnet）：
  - 路线 Cloudflare：验 `Cf-Access-Jwt-Assertion`（JWKS + aud + iss + exp）且 email ∈ owner 名单；
  - 路线 Tailscale：`Tailscale-User-Login` ∈ owner 名单（Serve 会剥伪造头）。
  - 配置不全 → 监听面拒绝启动（fail-closed）；校验失败 → 403。
- 承认的边界：本机任意进程可以直连这个只读端口并伪造头 —— 它们今天本来就能读 9876，所以不扩大暴露面。
- 通道：Cloudflare = 正式隧道 ingress `console.<域名>` → `127.0.0.1:<port>`，Access 应用挡在前面；Tailscale = `tailscale serve --bg <port>`（不用 Funnel）。
- 一句话关掉：关开关 + 停隧道 / `tailscale serve reset`；9876 本机控制台不受影响（验收⑤⑥）。

### 3.3 路线对比（给 Annie 定）
| | Cloudflare 隧道 + Access | Tailscale Serve |
|---|---|---|
| 要买 | 一个挂在 Cloudflare 上的域名（按成本价，每年一笔） | 不用 |
| 手机要装 | 不用，浏览器 Google 登录 | Tailscale App 并登录 |
| 和 F1b/F3 复用 | 同一套 Access | F3 可复用；F1b 仍是 Access |
| 本机已有 | cloudflared 已装 | Tailscale 已装 |

## 4. F3 手机试原型（架构层，等 F2 路线）
- 默认：复用 F2 的通道 + 登录门，给原型一个子地址（CF：ingress 规则 `proto-<短 id>.<域名>`；Tailscale：`tailscale serve --https=<端口>`），只放 owner 名单。
- 「临时、谁有链接谁能开」（临时隧道）只作为 founder 在卡上显式选的选项；卡上写清，并在原型停时标「已失效」。
- 原型本身可写（它的数据就是要被试的），但它不是 Bridge；挂上去的只有原型端口。
- 评审卡合同不变：founder_review 仍绑定 HTTPS 托管卡；原型链接放在卡里（`product_design.md:152-163`）。

## 5. F6 云截图（架构层，等前提①）
- 截图挪到 Bridge 侧做（钥匙只在 Bridge；CLI/Runner 不碰）：`/deliver` 新增 `screenshot: "cloud"` 模式，Bridge 调 Browser Rendering REST 截图（整页），PNG 落 previews 目录，后续沿用现有路径校验。
- 页面在 F1b 后会挡在 Access 后面 → 云浏览器用 Access service token（`CF-Access-Client-Id/Secret` 头）访问。
- Provider 开关：`local-proofshot`（默认，今天的行为）| `cloudflare`；云端失败 → 回落本机或明确「无图」，不静默。
- 先测一周用量（每天几十张，免费 10 分钟/天可能紧）+ 中文字体；超额要用付费版（5 美元/月）前先问 Annie。

## 6. F8 Runner 只读 Cloudflare 钥匙（架构层，等前提①）
- 钥匙：Account API Token，只勾 Workers Scripts **Read**、Workers R2 Storage **Read**、Account Settings **Read**，限一个账号，可加 TTL。由 Annie 在后台亲手建（agent 不制造凭据）。
- 存放：`~/.flywheel/.env` 的 `CLOUDFLARE_READONLY_API_TOKEN`（与 notion 同款文件读，绕开 Runner env 白名单；**不**加进 `RUNNER_PANE_BASE_ALLOWLIST`）。与 release 的写钥匙名字不同，互不覆盖。
- 用法：flywheel-skills 仓的一个只读 skill（`cf-readonly`），脚本只发 GET 到 `api.cloudflare.com`；**不用 cf 公测版**（issue「不做」③）。钥匙本身只读是第一道防线，脚本只发 GET 是第二道。
- 撤销：Annie 在后台删钥匙即刻失效；一页 runbook 写清「在哪、能读什么、谁能撤、怎么撤」，经 Annie 同意（验收①）。
- 验收里的「写操作被拒」用原始 curl 对写接口证明 CF 返回 403（不是靠 skill 拦）。

## 7. F5 安装包流水线改用 cf（挂起）
触发条件 = cf 正式版（公测结束，单独设密钥可用）。届时一次迁完：`payload-activation.yml` 的建桶 / 设生命周期 / 4 处设密钥 / 部署全换 cf；同步改 `release-workflows-structure.test.sh` 与 `activation-config.test.mjs` 的命令原文断言；Worker 名、桶、密钥名不变。本 Epic 不做任何 F5 改动。

## 8. 依赖与顺序（技术视角）
```
前提①账号 ─┬─> F8 ─> (F1b/F6 出问题时 Runner 自查)
           ├─> F1b（还需前提③ + F1a 的策略投影）
           └─> F6（F1b 后需 Access service token）
前提②路线 ─> F2 ─> F3
F1a（无前提）─> F1b
F5：等 cf 正式版
```
与提案建议顺序一致：先拍板 → 第一批 F1a、F2、F8 → 第二批 F1b、F3 → 第三批 F6 → F5 挂起。
