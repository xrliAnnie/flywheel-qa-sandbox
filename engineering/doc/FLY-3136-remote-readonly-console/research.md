# FLY-3136 手机远程只读看控制台 — 调研
Issue: FLY-3136 (https://linear.app/geoforge3d/issue/FLY-3136/cloudflaref2-annie-在任何地方用手机登录自己的-google-邮箱就能打开-bridge-控制台第一版只读)
日期: 2026-10-01
基于: exploration.md

## 1. Cloudflare 路线：Tunnel + Access（官方文档核对，2026-10-01）

**Tunnel（正式隧道）**：本机 `cloudflared` 主动向外连 Cloudflare，公网请求经 Cloudflare 转回本机某个端口。Bridge 不需要对外监听（验收 ④ 天然成立）。正式（named）隧道要求域名托管在 Cloudflare 上。
- 本机已装 `cloudflared 2026.6.1`。
- ingress 规则最后必须有一条兜底（`service: http_status:404`），cloudflared 启动时会校验。
- `originRequest.httpHostHeader` 默认空 = **不改写 Host**，本机收到的 Host 是公网主机名（如 `console.example.com`）。这正好让我们在 Bridge 侧做「Host 必须是配置的主机名」检查（防 DNS rebinding）。
- `originRequest.access: { required: true, teamName, audTag: [...] }`：让 cloudflared **自己**先验 Access JWT 再转发 —— 第二道独立校验，免费。

**Access（登录门）**：挂在主机名前，未登录 → 跳 Cloudflare 登录页；登录方式可选 Google（需在 Google Cloud 建 OAuth 客户端）或「一次性验证码发到邮箱」（零配置）。50 人内免费。通过后 Cloudflare 给每个转发到源站的请求加：
- 请求头 `Cf-Access-Jwt-Assertion: <JWT>`（浏览器还会带 cookie `CF_Authorization`）。
- JWT 为 **RS256**；公钥在 `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`（`keys` 是 JWK 数组，`public_certs` 带 `kid`）。
- 要校验：签名（按 `kid` 选钥）、`aud` 含本应用的 AUD tag、`iss` = `https://<team>.cloudflareaccess.com`、`exp` / `nbf`、`email`。
- 钥匙约每 6 周轮换，旧钥再有效 7 天 → 必须按 `kid` 从端点取，不能写死；遇到未知 `kid` 要重新拉取（限频）。

**依赖选择**：最初考虑用 Node 自带 crypto 自写 RS256 校验；Codex 设计评审 R1 指出维护成本主在 JWT/JWKS 解析与缓存生命周期（畸形输入、claims 类型、并发刷新、轮换），而 `jose@6.1.3` 已在仓库 lockfile 中（另一个包的依赖）且是 Cloudflare 官方 Node 示例所用（`jwtVerify` + `createRemoteJWKSet`）。→ **改用 `jose`**，作为 teamlead 直接依赖声明；我们只保留一层薄的邮箱授权。

## 2. Tailscale 路线：tailnet + `tailscale serve`

- 手机和 Mac 都装 Tailscale 并登录同一 tailnet；`tailscale serve --bg --https=443 http://127.0.0.1:9877` 把本机端口只在 tailnet 内以 `https://<机器>.<tailnet>.ts.net` 暴露，不经公网、不要域名。
- serve 给代理请求加身份头：`Tailscale-User-Login`（邮箱 / 登录名）、`Tailscale-User-Name`、`Tailscale-User-Profile-Pic`。**来自 tagged 设备的请求不带；`funnel`（公网）流量不带。**
- Serve 会清除客户端伪造的同名身份头再填真实身份；但**本机任何进程**直连 9877 都能自己加这个头 —— Tailscale 路线即「信任本机进程」（与今天 9876 的姿态相同，不更弱）。
- **文档未说明 serve 是否保留原 Host**。这影响「防 DNS rebinding」：身份头是普通请求头，本机上一个被 DNS rebinding 到 127.0.0.1 的恶意网页（同源）可以自己加 `Tailscale-User-Login` 头。必须靠 Host 检查挡 —— 只有 serve 转发时保留 `*.ts.net` Host（或给出不可伪造的等价信号）才成立。→ **实现期 spike 门**：真机抓一次 serve 转发的请求头；Host 若被改写成 127.0.0.1，Tailscale 适配器**不得上线**（fail-closed），改用别的绑定方式后再评。
- 本机已装 tailscale 但未登录。

## 3. 两条路线对照

| | Cloudflare（Tunnel + Access） | Tailscale（serve） |
|---|---|---|
| Annie 手机要做什么 | 浏览器打开网址，用 Google 邮箱登录 | 装 Tailscale App、登录、开 VPN 开关 |
| 要买什么 | 一个托管在 Cloudflare 的域名（每年按成本价，约 10 美元级） | 无 |
| 身份怎么到 Bridge | 签名 JWT（不可伪造，Bridge 可独立验签） | 普通请求头（只在 Host 检查成立时可信） |
| 两道独立校验 | cloudflared `access.required` + Bridge 验签 | 只有 Bridge 检查 |
| 能被 F3（原型手机打开）复用 | 能（同一个 Access 团队 / 同一套登录门） | 能，但每台看的设备都要装 App |
| 配错的后果 | Access 没挂 → Bridge 侧验签失败 → 401（fail-closed） | serve 被误开成 funnel → 无身份头 → 401（fail-closed） |

## 3.1 第三个候选：临时隧道 + `--allowed-mail`（2026-10-01 Lead 转来的 FLY-3137 实测信息，未经本节点复现）

据 FLY-3137 runner 实测：`cloudflared` ≥ 2026.9 的临时隧道（quick tunnel）支持 `--allowed-mail`，匿名访问会被带到 Cloudflare 一次性验证码登录页，名单邮箱收码即可进入；不需要 Cloudflare 账号、不用买域名。本机是 2026.6.1，需升级。公开文档里暂未查到该参数说明。

| 维度 | 评估 |
|---|---|
| 手机体验 | 浏览器 + 邮箱验证码，零安装 ✅ |
| 成本 | 无账号、无域名 ✅ |
| 网址 | **每次隧道重启都变**（`*.trycloudflare.com` 随机名）→ 书签失效、每次要把新链接发给 Annie；Bridge 的 Host 门也无法用固定配置（需启动器把新主机名回传给 Bridge，增加一条动态链路） ❌ |
| Bridge 侧能否独立验身份 | **未知**：需实测源站是否收到 `Cf-Access-Jwt-Assertion`、其 `iss`/`aud` 是什么、我们能否拿到对应 JWKS。若拿不到可验证的凭证，「登录门先于隧道」只靠一个命令行参数存在 —— 参数漏写 = 裸奔，Bridge 无从察觉 ❌（待验证） |
| 稳定性 | Cloudflare 把临时隧道定位为测试用途，有请求限额、无 SLA ⚠️ |

**结论**：对「长期在手机上看控制台」不推荐作为 v1 正式通道（网址不固定 + Bridge 侧验签能力未证实）。它更适合「临时、本来就会失效」的场景，例如 F3 的原型预览。若 Annie 选它，plan.md §6 的路线分支需要新增一个身份适配器，上线前置两个 spike：① 源站是否收到可验签的 JWT 及其 `iss`/`aud`/JWKS；② 动态主机名如何安全地传给 Bridge 的 Host 门。在两者都成立前 fail-closed（不启用远程端口）。

## 4. 推荐：Cloudflare

1. 和 founder 原话「用手机登录自己的 Google 邮箱」一致，手机零安装；
2. 身份是签名凭证，Bridge 能独立验签 —— 「登录门必须先于隧道」在代码里可证明，而不是靠配置；
3. 与 F3 共用登录门（提案已写「和 F2 共用同一套」）。

代价是买一个域名。若 Annie 不想买域名，Tailscale 适配器作为替补，但要先过 §2 的 Host spike。

## 5. Bridge 侧可复用的东西
- `FleetConsole.buildSnapshot()` / `refreshProjectConfigs()` —— 远程快照直接复用，再做一次投影去掉 `fleetScriptPath` / `commCliPath`。
- `getFleetConsoleHtml()` —— 加 `{ readOnly }` 选项，同一页面只读渲染 → 内容一致；不传参数时输出**逐字节不变**。
- `safeCompare`（`plugin.ts:714`）思路 —— 邮箱比较不需要常数时间，但 AUD 比较照常字符串相等即可。
- 测试惯例：`app.listen(0)` + 真 `fetch`（`src/__tests__/fleet-routes-mount.test.ts`）。

## 6. 安全头（远程页面）
`Content-Security-Policy: default-src 'none'; script-src 'nonce-<n>'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`，外加 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。`connect-src 'self'` 只限制页面能连到哪里（只能连自己），**不限制 HTTP 方法**；`form-action 'none'` 让页面不能提交表单。「不能改」的证据始终是服务端的方法 / 路径门（plan C3），CSP 只是纵深防御。

## 出处
- https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/cloudflared-parameters/origin-parameters/
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/
- https://tailscale.com/kb/1312/serve
