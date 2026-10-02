# FLY-3137 手机能打开的原型链接 — 调研
Issue: FLY-3137 (https://linear.app/geoforge3d/issue/FLY-3137/cloudflaref3-runner-做的能用的原型给一个手机能打开的-https-链接annie-在手机上就能真的点真的存数据)
日期: 2026-10-01
基于: exploration.md

## 0. 问题一句话

runner 在本机 `127.0.0.1:<port>` 跑起一个原型（带真后端、真数据），要把它变成**手机能开的 https 链接**、贴进 issue 的 Discord thread；原型停 → 链接失效 → 卡上写「已失效」。

## 1. 通道候选（把本机端口送到外网的「管子」）

| 候选 | 要账号/域名 | 谁能打开 | 本机现状（2026-10-01 实测） | 结论 |
|---|---|---|---|---|
| A. Cloudflare 临时隧道（quick tunnel, `*.trycloudflare.com`） | 都不要 | **谁有链接谁能开** | `cloudflared 2026.6.1` 已装；spike 6 秒拿到链接、200；停隧道后 **530** | v1 唯一「零准备就能用」的通道 |
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
- 也就是说：**名单门 = F2 的「Cloudflare 路线 + 买域名」**。F2 若选 Tailscale，名单门形态就变成 D（手机装 App）。

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

## 3. 关键设计结论（喂给 plan.md）

1. **通道做成可插拔**：`quick`（v1 实现）/ `access`（F2 定成 Cloudflare 路线后接；v1 只留接口和 fail-closed 报错）。不要把 trycloudflare 写死在流程里。
2. **访问模式必须显式**：`quick` 模式 = 「临时、谁有链接谁能开」，thread 消息和评审卡上**强制**带这句标签（验收③ 的 Annie 可选分支）。没有「隐式公开」。
3. **失效判定靠事实不靠猜**：守护进程退出 / 隧道进程退出 / 原型端口探活失败 → 立刻把记录标 `expired` 并在 thread 发「已失效」；Bridge 侧再加一层「runner 会话结束」兜底。
4. **默认只绑 127.0.0.1**：隧道只转发给本机回环地址上的那个端口，不暴露局域网。
5. **不放密钥进原型**：原型在公网（quick 模式），runner 不得在原型里接真生产凭证/真用户数据——写进 runner 规则。

## 4. 参考

- Cloudflare Quick Tunnels: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- Cloudflare One 私有 web 应用: https://developers.cloudflare.com/cloudflare-one/setup/secure-private-apps/private-web-app
- Tailscale Funnel: https://tailscale.com/kb/1223/tailscale-funnel
- 出处提案: product/doc/FLY-3102-cloudflare-cf-cli/proposal.html F3（主仓）
