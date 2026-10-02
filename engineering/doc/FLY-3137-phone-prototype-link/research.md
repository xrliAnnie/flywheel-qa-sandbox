# FLY-3137 手机能打开的原型链接 — 调研
Issue: FLY-3137 (https://linear.app/geoforge3d/issue/FLY-3137/cloudflaref3-runner-做的能用的原型给一个手机能打开的-https-链接annie-在手机上就能真的点真的存数据)
日期: 2026-10-01
基于: exploration.md

## 0. 问题一句话

runner 在本机 `127.0.0.1:<port>` 跑起一个原型（带真后端、真数据），要把它变成**手机能开的 https 链接**、贴进 issue 的 Discord thread；原型停 → 链接失效 → 卡上写「已失效」。

## 1. 通道候选（把本机端口送到外网的「管子」）

| 候选 | 要账号/域名 | 谁能打开 | 本机现状（2026-10-01 实测） | 结论 |
|---|---|---|---|---|
| A. Cloudflare 临时隧道（quick tunnel, `*.trycloudflare.com`） | 都不要 | **谁有链接谁能开** | `cloudflared 2026.6.1` 已装；spike 6 秒拿到链接、200；停隧道后 **530** | `quick_public`：零准备就能用 |
| A′. 临时隧道 + `--allowed-mail`（邮箱一次性验证码） | 都不要（访问者也不需要 Cloudflare 账号） | **只有名单邮箱** | 需 cloudflared ≥2026.9（2026.9.3 实测可用，本机现装 2026.6.1 没有该参数） | `quick_email`：验收③主分支，**不依赖 F2/域名**（推荐） |
| B. Cloudflare 正式隧道 + Access 登录门 | Cloudflare 账号 + **挂在 Cloudflare 上的自有域名** + Zero Trust 配置 | 只放名单邮箱（Google 登录或一次性验证码） | 无 `~/.cloudflared/cert.pem`，无账号/域名 | 验收③「名单门」唯一满足者；**依赖 F2 路线拍板 + 域名** |
| C. Tailscale Funnel | Tailscale 账号；MagicDNS + HTTPS + funnel 节点属性 | 公网谁有链接谁能开（Funnel 本身不鉴权） | `tailscale 1.84.2` 已装但 **Logged out** | 和 A 同一安全级别却要更多准备；只能 443/8443/10000 三个端口 → 多原型并行难 |
| D. Tailscale Serve（只在私网） | Tailscale 账号 + Annie 手机装 App 登录 | 只有私网设备 | 同上 | 满足「只有我能开」，但不是「点链接就开」；属于 F2 选 Tailscale 时的形态 |
| E. 部署到云（Workers/Pages/Vercel） | 账号 | 视配置 | — | 不在范围：原型跑在 runner 本机、背后是本机程序和数据；搬上云 = 重写原型（FLY-1688 结论：不把 runner 搬上云） |

### 1.1 临时隧道的官方限制（决定 v1 的诚实边界）

- 最多 **200 个同时进行中的请求**，超了回 429 —— 一个人在手机上评审完全够。
- **不支持 SSE（服务器推送事件，一种让页面实时收到后端更新的技术）** —— 原型若靠 SSE 做实时刷新，经隧道会失效；WebSocket 不在限制清单里。设计里要求 runner 在 thread 里写明这条。
- **没有在线时长保证**、受 Cloudflare 服务条款约束、官方说明「用于测试和开发，不用于生产」。原型评审正是「测试和开发」。
- 链接是随机子域名（例：`https://him-seasonal-offer-erp.trycloudflare.com`），每次重开都变。所以「评审期间一直能打开」(验收⑤) 靠的是**评审期间原型和隧道一直不停**，不是靠链接固定。

来源：Cloudflare Quick Tunnels 文档 https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/

### 1.2 名单门（Access）的前提

- self-hosted 应用必须挂在**你 Cloudflare 账号里的一个有效域名**的子域名上；`trycloudflare.com` 不能挂 Access。
- 一次性验证码（OTP）登录：Zero Trust → Identity Providers 加 One-Time PIN，不需要 SMTP；Google 登录要在 Google 云控制台建一个 OAuth 应用。
- 免费版 50 人以内。
- ~~也就是说：名单门 = F2 的「Cloudflare 路线 + 买域名」~~ —— **被 §2.2 推翻**：临时隧道自 2026.9 起自带邮箱名单门（`--allowed-mail`），不需要域名。F2 只影响「固定域名的正式隧道」这一档（`named`）。

来源：Cloudflare One — 私有 web 应用 https://developers.cloudflare.com/cloudflare-one/setup/secure-private-apps/private-web-app ；FLY-3102 讲解页第 7 格引用的 create-remote-tunnel 与 one-time-pin 文档。

### 1.3 Tailscale Funnel 的前提

需要 v1.38.3+、MagicDNS、tailnet HTTPS 证书、policy 里给节点 `funnel` 属性；只能用 `*.ts.net` 名字、只能听 443/8443/10000；带宽有不可配置的上限。来源：https://tailscale.com/kb/1223/tailscale-funnel

## 2. 本机 spike（2026-10-01，真跑）

```
python3 -m http.server 48137 --bind 127.0.0.1
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:48137
→ 6s 后日志出现 https://him-seasonal-offer-erp.trycloudflare.com
→ curl 200，正文正确
→ kill cloudflared，3s 后 curl → 530
```

证明了三件事：① 无账号能拿到 https 链接；② 链接从 cloudflared 的 **stderr 日志**里解析（`https://[a-z0-9-]+\.trycloudflare\.com`）；③ 停隧道链接立刻死（530）。另知：隧道活着但原型进程死了 → 502（Cloudflare 回源失败）。这两种都要被「活性探针」识别为失效。

### 2.2 邮箱名单门 spike（2026-10-01，真跑；Codex R1 #12 提示后补做）

官方文档（https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/ ，标注更新于 2026-09-30）：`cloudflared tunnel --url … --allowed-mail a@x.com[,b@y.com]`，访问者填邮箱收一次性验证码，不需要 Cloudflare 账号；可重复或逗号分隔；支持 `*@domain`。

```
gh release download 2026.9.3 --repo cloudflare/cloudflared   # 下载到 scratchpad，不动本机安装
./cloudflared --version            → 2026.9.3
./cloudflared tunnel --help        → 有 --allowed-mail（2026.6.1 没有）
./cloudflared tunnel --no-autoupdate --url http://127.0.0.1:48138 --allowed-mail fly3137-spike@example.com
→ 5s 出链接；日志 "Your protected quick Tunnel has been created" / "Authentication: One-Time PIN (using Cloudflare Access)"
→ 日志里邮箱打码：allowed-mail:*****
→ 匿名 curl：302 → https://login.trycloudflare.com/authorize?hostname=<本隧道主机>&state=…；原型内容未泄露
```

结论：名单门今天就能做；外网就绪探测在该模式下应判定「302 到 `login.trycloudflare.com` 且 `hostname` 等于本隧道」。未实测：真邮箱收码登录后的会话时长、手机浏览器登录体验——放进真机 QA。

## 3. 关键设计结论（喂给 plan.md）

1. **访问方式三档、可插拔**：`quick_email`（名单门，推荐）/ `quick_public`（临时、谁有链接谁能开）/ `named`（F2 正式隧道，v1 占位）。
2. **访问方式必须显式**：配置里不设就不开；`quick_public` 下卡片**和原型页面**都必须写明「临时、谁有链接谁能开」。没有「隐式公开」。
3. **失效判定靠事实不靠猜**：隧道由 Bridge 自己起、自己记 pid、自己关；确认隧道进程已退出后才把卡改成「已失效」（plan v2 §5）。
4. **默认只绑 127.0.0.1**：隧道只转发给本机回环地址上的那个端口，不暴露局域网。
5. **不放密钥进原型**：原型在公网（quick 模式），runner 不得在原型里接真生产凭证/真用户数据——写进 runner 规则。

## 4. 参考

- Cloudflare Quick Tunnels: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- Cloudflare One 私有 web 应用: https://developers.cloudflare.com/cloudflare-one/setup/secure-private-apps/private-web-app
- Cloudflare Quick Tunnels（含 --allowed-mail）: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- Tailscale Funnel: https://tailscale.com/kb/1223/tailscale-funnel
- 出处提案: product/doc/FLY-3102-cloudflare-cf-cli/proposal.html F3（主仓）
