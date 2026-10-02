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

> r2：Codex 设计评审 r1 推翻了 r1 草案的「registry → 全局派生投影 `meta/report-policy.json`」模型。
> 该模型在 registry 裁剪（2 天页被当成默认孤儿重新开放）、Epic 重发（新条目丢策略）、retarget（CAS 不含策略）、
> 远端写超时（registry 与投影分裂）四处都会分裂。下面是替换后的模型；实施细节以 plan.md B 为准。

### 1.1 生效值放哪
候选：
- A（r1 草案，弃）：registry 字段 + 全局派生投影对象。理由见上。
- **B（选）**：每页一个策略对象 `r/<token>/policy.json`，与页面同目录、同生共死；网关与 sweep 读它；registry 只记「预写意图 + 已确认值」用于清单与本地清理。
- C：写进对象路径 / 对象元数据 —— 路径即 URL 不能改；Vercel Blob 不支持自定义元数据。弃。
- D：网关回调 Bridge —— Bridge 只听本机。弃。

B 的好处：策略和它管的字节在同一前缀下，registry 裁剪、重发（只覆盖 `index.html`）、孤儿对象都不会让策略「丢失回默认」；
retarget 按 token 复制对象时策略自然跟着走；网关每请求直接读对象（不缓存），设置成功即下一次打开生效。

### 1.2 策略值（唯一词表）
`{kind:"default"} | {kind:"permanent"} | {kind:"days", days:1..365}`；缺省 = 默认；`DEFAULT_REPORT_RETENTION_DAYS = 14` 唯一集中设置。
过期统一由 `report-retention.ts` 的纯函数计算 —— 该文件本来就被原样复制进网关部署，Bridge、sweep、网关同一份算法。
时间基准不变（普通报告 = 首次 createdAt；Epic 稳定 token = 最新上传；audit = 自己的 uploadedAt + 父 token 的策略）。

### 1.3 一致性
- 设置是预写状态机：registry 写 pending(opId) → put 策略对象 → **无论 put 成功或超时都回读** → opId 对上才提交并回执成功；回读失败 = 结果未知，保留 pending，回执「请重跑」。
- 本地决策（裁剪本地字节等）在 pending 未收敛时取到期更晚者（保守）。
- 远端删除只看远端策略；策略读失败本轮不删；整页清理时策略对象最后删。
- sweep 与 set 共用 `ReportCriticalSection`，删前再读一次策略。

### 1.4 能力门
旧网关不读策略。门 = 对公开网关地址做行为探针：金丝雀页配**坏 schema** 策略，新网关必须 502、旧网关会 200（区分新旧部署）；合法 permanent / days → 200；
通过后在 registry hosting 写 `reportPolicy:{schema, deploymentId}`；Bridge 只在 deploymentId 与当前网关部署一致时接受非默认设置；每日维护重跑探针，失败清门告警。

### 1.5 谁能改
Claude Lead：CLI → `POST /api/reports/retention`（master；ingest 403）。Codex Lead：新 lead capability `report.retention.set/list`，复用 publish-receipt 的身份证明，且目标报告必须在该 Lead 项目范围内。已过期页面不复活。

### 1.6 成本
每页约 87 KB，1 万页永久 < 1 GB；既有 80% 存储告警继续覆盖。每次打开多一次小对象读（无缓存），按每天约 37 页的发布量与少量打开远在额度内（估算，打开次数从未统计）。

## 2. F1b 搬到 Cloudflare + 6 Gmail + 单页分享（架构层，实施等前提①③）

- 存储：R2 私有桶；网关：Worker（`report-gateway-runtime.ts` 的 `(Request)=>Response` 核心移植，依赖注入换成 R2 binding）。
  **不走**「Workers 静态文件每发一页重部署」——撞部署配额先例（FLY-2140 证据：Vercel 每日部署 100/100）。
- 新实现 `R2ReportStore implements ReportBlobStore`；`ReportHostingState.provider` 从字面量 `"vercel-blob"` 扩成 `"vercel-blob" | "cloudflare-r2"`；7 处 `.vercel.app` 硬编码收拢到 `report-url.ts` 一个函数。
- 登录门：Access 应用保护 workers.dev 网关地址（官方支持，不强制自有域名）；登录方式 Google + 一次性验证码。
- 身份：Worker 校验 `Cf-Access-Jwt-Assertion`（§0），取 `email`；**不信**明文邮箱头。
- 授权（两层，founder 提案原文）：
  - 第一层 Access 策略只放「6 个 Gmail ∪ 至少被分享过一页的朋友」。名单由 Bridge 从 registry 推导，经一个只能改**这一个** Access 应用策略的钥匙同步（钥匙只在 Bridge，Runner 拿不到）。是否改为「Access 放行任何登录、Worker 独断」是 F1b 设计节点的取舍点（后者省掉 Bridge 写 Access 的钥匙，但任何拿到链接的人都会占一个免费席位）。
  - 第二层 Worker 读投影 v2：owner 6 邮箱放行所有页；朋友只放 `sharedWith` 含自己的页。
- 分享名单与保留期同住每页策略对象（`r/<token>/policy.json` 加 `sharedWith`），registry 镜像 + 预写状态机同 F1a；Worker 每请求读该对象（R2 强一致、不缓存授权）→ 撤销对后续请求**立即**生效（founder 验收⑤原文，不放宽成缓存时限）。
- 机器身份：Epic audit 探针、report verify、strength-two、截图这些服务端读者在 Access 开启后会被挡；F1b 用 Access service token（JWT `common_name`）定义只读机器身份，只能读报告、不能进 F2/F3，凭据只在 Bridge 侧；F6 复用。
- 旧 Vercel 链接：所有已迁移 token（默认 / N 天 / 永久，含 audit）旧地址一律 301 到受保护新地址，旧网关不再直接返回字节（否则撤销分享可从旧地址绕过）；redirect 服务按这些 token 自己的策略保留到全部到期。回滚窗口 = Vercel 仍在线期间，反向迁移含策略与 ACL；窗口外只前向修复。
- 免费额度：Access 50 席；R2 10 GB；Worker 10 万次/天 —— 按每天约 37 页远在额度内（估算）。

## 3. F2 手机只读看控制台（架构层，实施等前提①②）

### 3.1 关键约束（来自审计）
9876 上 `/`、`/sse`、`/actions/*` 不查任何东西，Host 检查也挡不住本机来的代理流量。**绝不把隧道/Serve 接到 9876。**

### 3.2 选型：独立只读监听面（两条路线共用）
在 Bridge 进程里起第二个 HTTP server，`127.0.0.1:<TEAMLEAD_REMOTE_CONSOLE_PORT>`（默认关；开关 `FLYWHEEL_REMOTE_CONSOLE=1`）：
- 只注册 `GET/HEAD`：`/`（控制台 HTML 以 `readOnly` 渲染：不含 stage/apply 代码；CSP 用每响应 nonce 放行页面自己的内联 script/style —— 现有控制台是内联脚本，`default-src 'self'` 会把读脚本也挡掉）、`/api/fleet/snapshot`（同一个 snapshot 构建器，所有 `writeCapability` 强制 false）。其它一律 404；没有任何 POST 路由 —— 改东西的处理器**物理上不在这个 server 上**（不是「拦住」，是「不存在」）。
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
- 截图挪到 Bridge 侧做（钥匙只给 Bridge；CLI/Runner 不引用）：`/deliver` 新增 `screenshot: "cloud"` 模式，**目标 URL 由 Bridge 从 reportId + 当前 hosting 绑定推导**（不接受调用方任意 URL），Bridge 调 Browser Rendering REST 截图（整页），PNG 落 previews 目录，后续沿用现有路径校验；带凭据的浏览器不跟随跨 origin 跳转。
- 页面在 F1b 后会挡在 Access 后面 → 云浏览器用 F1b 定义的机器身份（Access service token）访问；Worker 第二层按机器身份放行只读。
- Provider 开关：`local-proofshot`（默认，今天的行为）| `cloudflare`；云端失败 → 回落本机或明确「无图」，不静默。
- 先测一周用量（每天几十张，免费 10 分钟/天可能紧）+ 中文字体；超额要用付费版（5 美元/月）前先问 Annie。

## 6. F8 Runner 只读 Cloudflare 钥匙（架构层，等前提①）
- 钥匙：Account API Token，只勾 Workers Scripts **Read**、Workers R2 Storage **Read**、Account Settings **Read**，限一个账号，可加 TTL。由 Annie 在后台亲手建（agent 不制造凭据）。
- 存放：独立文件 `~/.flywheel/cloudflare-readonly.env`（只含这一把只读钥匙；与 notion 同款文件读，绕开 Runner env 白名单；**不**加进 `RUNNER_PANE_BASE_ALLOWLIST`）。Bridge 用的写类钥匙放另一个文件 `cloudflare-bridge.env`。
- 诚实边界：Runner 与 Bridge 同一个 Unix 用户，同用户可读文件不是安全边界——Runner 主动去读写钥匙文件是读得到的（与今天 `.env` 同级）。做到的是「不注入、不引用、最小权限、可撤销」；更强隔离（独立用户 / broker）交 founder 定。
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
