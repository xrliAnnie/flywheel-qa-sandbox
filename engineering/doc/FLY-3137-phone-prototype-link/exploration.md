# FLY-3137 手机能打开的原型链接 — 探索
Issue: FLY-3137 (https://linear.app/geoforge3d/issue/FLY-3137/cloudflaref3-runner-做的能用的原型给一个手机能打开的-https-链接annie-在手机上就能真的点真的存数据)
日期: 2026-10-01
基于: 无（出处：主仓 product/doc/FLY-3102-cloudflare-cf-cli/proposal.html F3，提案第 4 版 Annie ✅）

## 1. 要解决什么

runner 做出一个**跑着的网页应用原型**（有真后端、能存数据），现在只能在 runner 那台电脑的 `localhost` 上看。要：

1. 原型跑起来 → issue 的 Discord thread 里出现一个手机能开的 https 链接；
2. 手机上能真的点、填、保存；
3. 只有名单邮箱能开，**或**页面上明确写「临时、谁有链接谁能开」（Annie 选）；
4. 原型停 → 链接失效，卡上写「已失效」；
5. 评审期间链接一直能开。

原生 App 不在范围。runner 不搬上云（FLY-1688 结论）。

## 2. 现状审计（代码事实）

| 关注点 | 事实 | 位置 |
|---|---|---|
| 「原型只在本机看」规则 | 规则真身在 prototype 角色提示词 Step 3：用 `proofshot` 录屏，或 `publish-report` 发**静态页**；「**runner 从不直接往 Discord 发 founder 材料**，交给 Lead 发唯一一张官方卡」 | `.flywheel/agents/engineering/prototype-executor.md:127-137`（:166/:238/:319 重复） |
| 静态页托管 | `publish-report` → Bridge `/api/reports/publish`（Vercel，token 路径）→ `/api/reports/deliver` 发到**项目 general 频道**（不是 issue thread）；消息体 `buildReportMessage` | `flywheel-comm/src/commands/publish-report.ts`；`teamlead/src/bridge/reports-route.ts:169-383` |
| 隧道 | 代码里**零** cloudflared/trycloudflare；`edge-worker` 有已废弃的 Cloudflare tunnel 桩（抛错）和未使用的 ngrok 依赖 | `edge-worker/src/SharedApplicationServer.ts:104-141` |
| runner → thread | runner 只能 `ask --report` 给 Lead，由 Lead 发 thread；**没有** runner 直接发 thread 的接口 | `flywheel-comm/src/commands/ask.ts` |
| Bridge 自己发 thread 的先例 | FLY-605 gate 兜底、stuck 通知、infra 通知：`getChatThreadByIssue` 定位 thread → `postFounderThreadCore` 发帖，固定模板、`allowed_mentions:{parse:[]}`、审计事件 | `teamlead/src/bridge/founder-thread-notifier.ts` |
| 改已发消息 | 已有 `editDiscordMessageInChannel`（auto-qa 用来零抖动地改置顶卡） | `teamlead/src/bridge/discord-utils.ts:201`、`auto-qa-effects.ts:210` |
| runner 调 Bridge 的鉴权 | runner 面接口统一 `tokenAuthMiddleware(config.ingestToken)`（`/events`、`/review-requests`）；runner 环境有 `FLYWHEEL_INGEST_TOKEN`、`FLYWHEEL_EXEC_ID` | `teamlead/src/bridge/plugin.ts:1278-1310` |
| 进程归属与回收 | FLY-766 chrome 回收器：靠 `~/.flywheel/runner-state/<execId>/` + `.flywheel-owner.json` 把进程归属到会话，**按 OS 进程名（comm）而不是 argv 匹配**（曾经因 argv 匹配误杀 runner 自己）；会话进入结果态（除 `approved_to_ship`）才杀 | `teamlead/src/bridge/chrome-session-reaper.ts` |
| runner 状态目录 | `FLYWHEEL_RUNNER_STATE_DIR=~/.flywheel/runner-state/<execId>` 已存在 | TmuxAdapter 注入 |
| 「评审卡」 | 代码里没有这个概念；只在 issue 文本里出现 | — |

本机工具：`cloudflared 2026.6.1` 已装；`tailscale 1.84.2` 已装但**未登录**；无 Cloudflare 账号证书、无自有域名。

## 3. 关键缺口

1. **没有「把本机端口变成公网 https」的能力**——要新增。
2. **没有「链接活着 ↔ 原型活着」的绑定**——隧道和原型谁先死都要能被发现。
3. **没有「卡」**——要一个 thread 里能「从可用改成已失效」的消息，而且只有发它的一方能改它 → 卡必须由 Bridge 发（不是 Lead 手写、也不是 runner 直接发）。
4. ~~名单门依赖 F2~~：初判如此；后经 research.md §2.2 实测，cloudflared ≥2026.9 的临时隧道自带邮箱名单门（`--allowed-mail`），不需要域名/账号。F2 只影响固定域名的 `named` 档。

## 4. 方案方向（brainstorm）

### 方向 A：通道可插拔，v1 用临时隧道 + 显式「临时」标签（推荐）

- runner 跑 `flywheel-comm preview start --port <p>`：起一个**脱离 runner 的看守进程**（supervisor），由它起 `cloudflared` 临时隧道、拿到链接、确认能打开、登记到 Bridge；Bridge 在 issue thread 发一张固定模板的**原型卡**（含「⚠️ 临时：谁拿到链接谁能开」）。
- 看守进程每 15 秒探活本机端口；原型或隧道一死 → 关隧道 → 通知 Bridge → Bridge **改卡**为「⚫ 已失效」。
- Bridge 兜底：runner 会话进入结束态 / Bridge 重启时发现残留 → 杀掉看守进程和隧道、改卡。
- 名单门作为第二种通道 `named` 留接口；F2 定了只补通道实现，不改流程、不改卡。
- 优点：今天零准备就能用；验收 ①②④⑤ 全满足，③ 走「明确写临时」分支；把名单门的形态留给 F2，不提前绑定域名决策。
- 缺点：临时链接谁拿到谁能开；无在线保证；不支持 SSE。

### 方向 B：等 F2 定了直接做名单门

- 满足验收③最强的分支，但被 F2 路线 + 买域名 + Cloudflare 账号阻塞；今天什么都交付不了。

### 方向 C：Tailscale Funnel

- 安全级别和 A 一样（公网谁有链接谁能开），却要登录 Tailscale、开 MagicDNS/HTTPS/funnel 属性，且只能用 3 个端口 → 多原型并行难。没有比 A 更好的地方。否决。

### 方向 D：把原型部署到云上（Workers/Pages）

- 原型背后是本机的程序和数据，搬上云 = 重写原型，违背「throwaway 原型」原则和 FLY-1688 结论。否决。

**选 A**，并在 Codex R1 后做了两点修正（见 plan.md v2）：① 访问方式扩成三档，`quick_email`（临时隧道 + 邮箱名单门）是推荐档，验收③主分支今天就能满足；② 不再用 runner 侧看守进程，隧道由 Bridge 统一起、管、关。

## 5. 需要定的点（已发 Lead 非阻塞问题 96cbf510）

1. F2 路线是否已定？——未定前 v1 只交付 `quick` 通道。
2. 访问方式由 Annie 选：设计里做成**项目配置项必须显式设置**（`quick` / `named`），没设置时 `preview start` 拒绝并提示「Annie 还没选访问方式」——不给隐式公开。

## 6. 风险

| 风险 | 处理 |
|---|---|
| 临时链接被转发 / 被猜 | 子域名随机；卡上明确「临时、谁有链接谁能开」；原型规则禁止接真凭证/真用户数据；原型停即失效；看守进程有最长寿命（默认 12 小时） |
| 卡说「已失效」但隧道其实还活着 | 先杀隧道、确认退出，再改卡；Bridge 兜底杀进程按「pid + 进程启动时间 + 进程名」三重核对，不按 argv 匹配（FLY-766 教训） |
| 卡说「可用」但其实已经死了 | 看守进程 15 秒探活；看守进程自己死了 → Bridge 兜底扫描发现 pid 不在 → 改卡 |
| runner 的 Bash 工具结束时把子进程一起杀掉 | 看守进程用 detached + 新进程组启动，pidfile 落在 runner-state 目录 |
| 原型用了 SSE | 卡上/规则里写明；runner 改用轮询或 WebSocket |
| 隧道服务条款 | 只用于评审（测试和开发），不用于生产；符合官方定位 |
