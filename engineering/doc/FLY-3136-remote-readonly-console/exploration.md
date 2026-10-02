# FLY-3136 手机远程只读看控制台 — 探索
Issue: FLY-3136 (https://linear.app/geoforge3d/issue/FLY-3136/cloudflaref2-annie-在任何地方用手机登录自己的-google-邮箱就能打开-bridge-控制台第一版只读)
日期: 2026-10-01
基于: 无（上游产品提案 = 生产仓 `product/doc/FLY-3102-cloudflare-cf-cli/proposal.html` F2 + `explainer.html` 第 7 格）

## 1. 要解决什么

Annie 不在电脑前时，用手机登录自己的 Google 邮箱就能看到 Fleet 控制台（项目 / Lead / 功能开关 / 定时任务的模型 / runner 默认设置）——内容和本机一致；第一版手机上**不能改任何东西**。

六条验收（原文压缩）：① 外网手机登录后能看、内容一致；② 没登录 / 别的邮箱打不开；③ 远程任何「改」都做不了；④ Bridge 仍只听本机；⑤ 远程通道断了本机照常；⑥ 一句话怎么关。

## 2. 现状审计（本 worktree 代码，v1.55.0 沙箱快照）

> 注意：本 worktree 是 `flywheel-qa-sandbox` 快照，比生产 `~/Dev/flywheel` 落后（例：生产有 `management-change-coordinator.ts`、工作流 / 模型表板块，这里没有）。设计**按本 worktree 现有接缝**做；生产只作参考。设计的核心（独立只读监听 + 身份门 + 白名单）与控制台具体板块无关，生产里多出来的板块落地时同样走「快照投影 + 只读渲染」两个点即可。

### 2.1 Bridge 只听本机
`packages/teamlead/src/config.ts:9,25-29` —— `TEAMLEAD_HOST` 必须是 `127.0.0.1 / localhost / ::1`，否则启动即抛错。`plugin.ts:4325` `app.listen(config.port, config.host)`。✅ 验收 ④ 今天就成立，设计不能破坏它。

### 2.2 控制台今天的「锁」—— 逐个接口

| 接口 | 读 / 改 | 今天怎么守 | 走隧道（直连 9876）会怎样 |
|---|---|---|---|
| `GET /` (`plugin.ts:1177`) | 读（页面 HTML） | **无任何检查**，注释「loopback only」 | 直接放行 |
| `GET /sse` (`plugin.ts:1184`) | 读（运行状态推送） | **无任何检查** | 直接放行 |
| `GET /health` | 读 | 无 | 放行 |
| `/actions/*` (`plugin.ts:1230`) —— approve / terminate / reject / retry… | **改** | **无任何检查**（注释「no auth (loopback only)」），仅 FLY-175 founder-consent 中间件，默认 `off` | **直接放行 —— 能批准 / 终止 runner** ⚠️ |
| `GET /api/fleet/snapshot`、`/flag-report.html`、`/progress` (`plugin.ts:1376-1475`) | 读 | `loopbackSelfOrigin(Host)` | 隧道带来的 Host 是外网域名 → 403；若隧道把 Host 改写成 `127.0.0.1:9876` 则放行 |
| `POST /api/fleet/{stage,apply,flag/*,runner/*}` | **改** | loopback Host + same-origin(Origin/Referer) + 一次性 confirmToken + 审计 | Host 是外网域名 → 403；若 Host 被改写，则只剩 Origin 检查挡着（偶然挡住，不是设计挡住） |
| `/api/*` 其余 | 读+改 | `tokenAuthMiddleware(apiToken)`（未配 token 时**直接放行**） | 视生产是否配 token |
| `/xhs-review/*` | 读+改 | loopback Host + same-origin + session token | 同上 |

**结论**：「把隧道接到 9876」= 把 `/actions/*`（无鉴权的改动入口）和 `/sse` 一起暴露，只剩前面的登录门。哪怕登录门只放 Annie，也违反验收 ③（远程不能改）；而且一旦登录门配错（Access 应用没挂上），整台 Bridge 裸奔。**隧道绝不能指向 9876。**

### 2.3 控制台页面是怎么拿数据的
`bridge/fleet-console-html.ts`：单页 + 内联 `<script>`，只 `fetch("/api/fleet/snapshot")` 渲染；改动走 `POST /api/fleet/*stage|apply`，进度走 `EventSource("/api/fleet/progress")`，还有一个「整页 / 手机版」链接到 `/api/fleet/flag-report.html`。渲染完全由快照驱动 → **只要给一个只读快照 + 只读模式的同一个页面，内容就和本机一致**。

快照 `ConsoleSnapshot`（`fleet-console-model.ts:123-142`）：`leads`、`featureFlags`、`perIssueModels`、`projectRunnerDefaults`、`cronModels`、`runnerCapabilities`、以及两个本机路径 `fleetScriptPath` / `commCliPath`（只给本机「复制命令」用，远程不该带出去）。已是「secret-free 白名单 DTO」（不含 LeadConfig / bot token）。

### 2.4 本机已有的工具
- `cloudflared 2026.6.1` 已装（`/usr/local/bin/cloudflared`）。
- `tailscale` 已装但**未登录**（`tailscale status` → Logged out）。
- 生产「手机上能看到的功能开关页」= `flag-report.html` 发布到托管页的一份静态副本（FLY-709），不是活的控制台。

## 3. 关键约束 / 洞察

1. **登录门必须先于隧道**：Bridge 无法区分「本机浏览器」和「隧道来的请求」（都来自 127.0.0.1）。所以身份必须在 Bridge 这一侧**再验一次**（纵深防御），不能只信隧道前面的登录门配置正确。
2. **只读要靠「物理上没有改的路」**，不能靠「页面不显示按钮」：远程入口只挂白名单上的几个 GET，其他一律不存在。
3. **远程与本机互不影响**：远程入口坏了 / 配错了 / 隧道断了，9876 本机控制台必须原样工作（验收 ⑤）。
4. **路线未定**（Cloudflare vs Tailscale，账号，域名，允许的邮箱）—— 已于 2026-10-01 向 Lead 提问（question `1966b943`）。设计需做到「Bridge 侧路线无关，路线只是一个可切换的身份适配器 + 一份隧道配置」。

## 4. 备选方向（brainstorm）

| # | 方向 | 评价 |
|---|---|---|
| A | 隧道直连 9876，前面挂 Cloudflare Access | ❌ 暴露 `/actions/*` 改动入口 + 全部无鉴权读接口；登录门是唯一一道门 |
| B | 隧道直连 9876，但让隧道把 Host 改写成 127.0.0.1 让 `/api/fleet/*` 通过 | ❌ 同 A，而且等于主动「伪装成本机」绕过 anti-rebinding 守卫 |
| C | 在 9876 里加「远程模式」中间件，按请求头区分远程 / 本机 | ❌ 远程与本机共用一个 express app，任何以后新加的路由默认对远程开放（默认放行），验收 ③ 守不住 |
| D | **独立的只读监听**（同一 Bridge 进程，另一个本机端口如 9877，独立 express app，只挂白名单 GET）+ 在 Bridge 侧验身份（Cloudflare Access JWT / Tailscale 身份头）+ 隧道只指向 9877 | ✅ 默认拒绝；与 9876 物理隔离；复用同一个 `FleetConsole.buildSnapshot()` 与同一个页面（只读模式）→ 内容一致 |
| E | 独立进程反向代理（Caddy / 小 Node 进程）转发白名单 GET 到 9876 | 可行但要伪造 Host 才能过 9876 的守卫；多一个进程要守护；无优势 |
| F | 静态发布快照（像 flag-report 那样定时发布到托管页） | 不是「活的控制台」，且托管页无登录门（链接即权限）；founder 明确要的是「在任何地方打开控制台」 |

**选 D。** 具体在 research.md / plan.md 展开。

## 5. 待 Lead / Annie 定的事
1. 路线：Cloudflare（自有域名 + Tunnel + Access，手机零安装）还是 Tailscale（手机装 App，不要域名）。**本设计推荐 Cloudflare**（理由见 research.md §4）。
2. Cloudflare 账号 + 是否已有 / 愿意买的域名。
3. 允许登录的 Google 邮箱（1 个还是多个）。
4. Access 的登录方式：Google 登录（要在 Google Cloud 建一个 OAuth 客户端）还是「一次性验证码发到 Gmail」（零配置）—— 两者对 Annie 都是「用 Google 邮箱登录」。
