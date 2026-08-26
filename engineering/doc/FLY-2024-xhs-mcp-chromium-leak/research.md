# FLY-2024 xiaohongshu-mcp Chromium 泄漏 — 调研

Issue: FLY-2024 (https://linear.app/geoforge3d/issue/FLY-2024/xiaohongshu-mcp-搜索调用卡住时泄漏一个有-dock-图标的-chromium-60s-超时被下一行-contextctx)
日期: 2026-08-25
基于: exploration.md

---

## 1. rod 的 Context/Timeout 语义(源码确认,v0.116.2 = go.mod 锁定版本)

`~/go/pkg/mod/github.com/go-rod/rod@v0.116.2/context.go`:

```go
// :57 — 纯替换:原 ctx(含 Timeout 设的 deadline)被整个丢弃
func (p *Page) Context(ctx context.Context) *Page {
    newObj := *p
    newObj.ctx = ctx
    return &newObj
}
// :71 — 派生:在当前 ctx 之上叠加 deadline
func (p *Page) Timeout(d time.Duration) *Page {
    ctx, cancel := context.WithTimeout(p.ctx, d)
    ...
}
```

⇒ **`page.Timeout(60s)` 之后再 `page.Context(ctx)` = 60s 被丢弃**(issue 标题的断言,源码级成立)。
⇒ **正确顺序是 `page.Context(ctx).Timeout(d)`**:先换上请求 ctx,再派生 deadline —— 得到「d 与 ctx 取更早者」的双保险。

## 2. 泄漏面全量 audit(`~/Dev/xiaohongshu-mcp/xiaohongshu/`)

| 文件 | constructor | 方法内 | 判定 |
|---|---|---|---|
| `search.go:164/170` | `Timeout(60s)` | `Context(ctx)` 替换 | ✗ 坏 — **实际打出全部泄漏的路径**(卡点 `:176 MustWait(__INITIAL_STATE__)`) |
| `feeds.go:19/29` | `Timeout(60s)` | `Context(ctx)` 替换 | ✗ 坏 |
| `user_profile.go:18/24,109` | `Timeout(60s)` | `Context(ctx)` 替换 ×2 | ✗ 坏 |
| `saved_content.go:51/57,119,184,223` | `Timeout(180s)` | `Context(ctx)` 替换 ×4 | ✗ 坏(`:115` 注释显示作者**知道**这个语义,只做了局部说明没修) |
| `publish.go:42/78` | `Timeout(300s)` | `Context(ctx)` 替换 | ✗ 坏 |
| `publish_video.go:27/59` | `Timeout(300s)` | `Context(ctx)` 替换(`:73` 又对替换后的 page 派生 5min,该段有界) | ✗ 坏 |
| `login.go:16/21,39,61,87` | 无 Timeout | `Context(ctx)` ×4 | ✗ 无自带超时,全靠 ctx(ctx 无 deadline 时无界) |
| `navigate.go:14/19,29` | 无 Timeout | `Context(ctx)` ×2 | ✗ 同上 |
| `like_favorite.go:47` | — | `Context(ctx).Timeout(60s)` | ✓ 正确(顺序对) |
| `feed_detail.go:81` | — | `Context(ctx).Timeout(10min)` | ✓ 正确 |
| `comment_feed.go:26,86` | — | 只 `Timeout`,`:25` 注释明确不用 Context | ✓ 有界(但不响应调用方取消) |

`service.go` 的资源模式:每个 public 方法 `newBrowser()` + `defer b.Close()` + `b.NewPage()` + `defer page.Close()`(如 `SearchFeeds` `:383-392`)。例外:`GetLoginQrcode` `:137-170` 把清理挪进 goroutine,自己套了 `context.WithTimeout(context.Background(), 4min)` — 有界。
`newBrowser()` (`:559`) → `browser.NewBrowser(configs.IsHeadless(), ...)` → `headless_browser.New`;`Close()` = `browser.MustClose() + launcher.Cleanup()`(`headless_browser@v0.3.0:147`)。`NewPage` 走 **stealth**(`stealth.MustPage`)⇒ 该工具本来就在对抗风控,`-headless=false` 大概率同源(headless 检测),**改 headless 有风控/登录失效风险,不能顺手改**。

## 3. 为什么 client 侧救不了(服务端必须自带 deadline)

stack trace(err.log)显示工具调用跑在 go-sdk 的 `jsonrpc2.(*Connection).handleAsync` 派生 goroutine 上(`go-sdk@v0.7.0`)。实证:卡死的 goroutine 存活 10+ 小时,期间调用方(Claude 的 MCP client,默认约 60s 工具超时)早已放弃 —— **client 超时/放弃不会 cancel 服务端 handler 的 ctx**。唯一解卡事件是浏览器进程被外杀 → CDP websocket 断 → rod `Must*` panic(`use of closed network connection`)→ `withPanicRecovery`(`mcp_server.go:139`)捕获。
⇒ 设计原则:**不依赖客户端取消;服务端 handler/service 层必须自带 deadline。**

## 4. 日志取证(方法可复用)

- 日志位置:LaunchAgent 定义 stdout=`~/.codex/log/xiaohongshu-mcp.log`(GIN HTTP 访问日志,123MB),stderr=`~/.codex/log/xiaohongshu-mcp.err.log`(logrus 业务日志 + panic stack,718KB)。**logrus 默认写 stderr,业务证据全在 err.log**。
- 关键查询:`grep "Tool handler panicked" err.log` → 时间分布;`grep "搜索Feeds - 关键词" err.log` → 调用记录。
- 结果(详见 exploration.md §2):panic 全部 `tool=search_feeds`;08-24T10:12:59 十连 panic = 止血时刻;08-25T12:16:24 三连 = 第二批清理;08-23 晚 19 次调用 10 卡死,08-25 早 11 次调用 3 卡死。

## 5. 部署链现状(修复生效的关键一环)

| 项 | 事实 |
|---|---|
| 生产进程 | pid 1494,`~/tools/xiaohongshu-mcp/xiaohongshu-mcp-darwin-arm64 -headless=false -port 127.0.0.1:18060`,已跑 4 天 |
| 启动方 | LaunchAgent `~/Library/LaunchAgents/com.codex.xiaohongshu-mcp.plist`,`KeepAlive=true`,`RunAtLoad=true`,env `COOKIES_PATH` + `XHS_BASE_URL=https://www.rednote.com` |
| ⚠️ 分叉 | LaunchAgent **直接跑二进制**,不走 `~/tools/xiaohongshu-mcp/xhs-start`(只有该脚本有 auto-pull + `go build` 逻辑)⇒ **改完 fork 源码必须显式 `go build` 替换二进制 + `launchctl kickstart -k gui/$UID/com.codex.xiaohongshu-mcp`,否则生产还是旧字节** |
| 源码 | `~/Dev/xiaohongshu-mcp`,origin=`xrliAnnie/xiaohongshu-mcp`(fork,可自主 merge),upstream=`xpzouying/xiaohongshu-mcp` |
| 消费方 | 全局 `~/.claude.json` mcpServers(http `127.0.0.1:18060/mcp`)⇒ 所有 Claude 会话可调;Lead 层挂 `xiaohongshu-memory-rules`;`xiaohongshu-learning` skill;历史上还有 Codex 侧(LaunchAgent label 是 `com.codex.*`) |
| cookie | `~/.config/xiaohongshu-mcp/cookies.json`(持久),**不在**临时 user-data-dir 里 ⇒ 杀泄漏浏览器不影响登录(issue 已验证) |

## 6. reaper 现状与缺口(flywheel 主仓)

- `packages/teamlead/src/bridge/chrome-session-reaper.ts`(942 行):Bridge 挂载(`plugin.ts:7163-7245`),boot + 每 60s periodic,单飞守卫。既有类别:
  1. **agent-browser 归属型**(FLY-766):comm=「Google Chrome for Testing」或路径 `~/.agent-browser/browsers/`,`--user-data-dir` 含 `agent-browser-chrome-`;
  2. **headless one-shot 截图**(FLY-1828):argv 同时含 `--headless` 与 `--screenshot`,`HEADLESS_SHOT_MAX_AGE_MS = 5min`(`:47`),TERM→KILL escalation;
  3. playwright orphan(FLY-1867):**audit-only census**,不杀。
- 进程采样 `collectChromeSweepSample` (`:308`) 是**全量 `ps -Awwo`**(`:171-198`),不按进程名预过滤 ⇒ rod Chromium(comm=`Chromium`,路径 `~/.cache/rod/browser/chromium-*/`)**已经在 sample 里**,只是没有类别判据认领它。
- **rod 类别判据(本单新增)**:argv `--user-data-dir=` 路径含 `/rod/user-data/`(rod launcher 固定 pattern,本次泄漏 10 个实例逐一符合),或可执行路径含 `/.cache/rod/browser/`。伴生的 **leakless 启动器进程**(rod 的守护 wrapper,父进程死后杀浏览器;xhs-mcp 不死所以不触发)需随浏览器一并收(按 PPID/进程组)。
- **阈值**:fork 内最长合法操作 = `feed_detail` 10min / `publish_video` 5min+300s;登录 qrcode goroutine 4min。取 **30min**(最长合法操作 ×3,与 FLY-766 orphan grace 30min 一致)。

## 7. 会拉浏览器的第三方工具盘点(issue 要求「顺带查一遍」)

| 产生者 | 进程形态 | 兜底现状 |
|---|---|---|
| xiaohongshu-mcp(rod) | `~/.cache/rod/browser/chromium-*` + leakless,headed,Dock 图标 | ❌ 无 → **本单 L2 补** |
| agent-browser | Chrome for Testing,`agent-browser-chrome-` UDD | ✅ FLY-766 reaper |
| raw Chrome one-shot 截图 | `--headless --screenshot` | ✅ FLY-1828 reaper(5min) |
| Playwright MCP(plugin) | Chrome for Testing/ms-playwright | ⚠️ FLY-1867 audit-only census(记账不杀)— 既定 scope,不在本单动 |
| claude-in-chrome | 驱动用户自己的 Chrome,不新起浏览器进程 | N/A 无泄漏面 |
| 全局 mcpServers 其余(linear-api 远程) | 无本地进程 | N/A |

⇒ 本机「会新起浏览器进程」的产生者只有前四类;rod 类别补上后,**杀伤型兜底覆盖全部非-census 类别**。

## 8. QA 复现配方(确定性,零风控、零真实账号依赖)

`configs/browser.go:19-28`:`XHS_BASE_URL` env 覆盖 BaseURL;`makeSearchURL`(`search.go:240`)用 `configs.BaseURL()` 拼搜索 URL。
⇒ 起本地 HTTP 假 server,`/search_result` 返回一个**永不设置 `window.__INITIAL_STATE__`** 的页面 → `search.go:176 MustWait` 必卡 → 用 `XHS_BASE_URL=http://127.0.0.1:<port>` 起被测 xhs-mcp(隔离端口,不碰生产 18060)→ 调 `search_feeds`:
- 修复前(红):浏览器进程持续存活(复现泄漏);
- 修复后(绿):预算内工具返回超时错误 + **rod Chromium/leakless 进程归零**(`ps` 断言)。
Reaper 侧(TS)另有 vitest 单测面:`chrome-session-reaper.ts` 已有 deps 注入(`listCommByPid`/`listCmdByPid`/`listAgeByPid` 可 mock),按既有测试模式喂假进程表断言分类/kill 决策。

## 8.5 与改写后 issue 正文的对齐(2026-08-25 19:50 UTC 正文更正后核对)

issue 正文在本节点起跑后被整体改写(推翻了旧假设「每次会话拉一个且从不关」)。逐项核对,**本设计与新正文完全同向、无需改动**:

| 新正文断言 | 本设计对应 |
|---|---|
| 修法 =「给等待设上限」,不是「会话结束关浏览器」(那个本来就有) | plan §2 全部内容;research §2 早已记录 defer 一直在、正常路径会关 |
| 主修 `s.page.Context(ctx).Timeout(60s)` | plan §2.2 同一写法(并按 Codex 评审扩到同仓库同模式文件 + service ledger 兜底;正文说「实现由 owner 定」,已在 plan 论证) |
| 兜底「按 rod user-data-dir 闲置时长回收孤儿浏览器,唯一兜住下一个未知卡点的层」 | plan §3(reaper rod 类别,30min) |
| 改 headless 只是让泄漏隐形,别拿它替代 | plan §6 第一条 |
| 验收必须行为级:注定卡住的搜索 → 报错返回 + 进程自行消失;只验参数会放过「设了然后被覆盖」 | plan §2.3 TimeoutE2E(MCP 边界收到报错由 withPanicRecovery 转换;测试层 recover 断言解卡 + lineage 消失) |

新正文补充的实证(本文档采信并引用):
- **64 秒对应表**:08-25 泄漏的恰是 3 次「间隔 ≈64s」的调用(= 调用方 60s 超时放弃换词重试),各泄漏浏览器的 DevTools `/json/list` 实得卡住页面与搜索词一一对应;调用方 60s 放弃后服务端又卡 3 小时 = 「client 取消救不了」的又一实证(呼应 §3)。
- **调用方确认为 Belle 的小红书学习**(非 Flywheel 侧;机制与调用方无关)。
- **同源实证**:线上二进制 `go version -m` 的 `vcs.revision` = fork HEAD `2504691…`——「读的源码 = 线上行为」已实证(强于本文档 §5 的推断);二进制 `+dirty` 是 6/20 构建时刻状态,推测为未跟踪 docs 目录(正文明标非实证)。
- **运维语义**:`kill <leakless-pid>` 无效(leakless 忽略 SIGTERM),须 `kill -9` Chromium 主进程——进一步佐证 plan §3 的 child-first 决策(reaper 对 Chromium main TERM→KILL escalation,不碰 leakless)。

## 9. 会过期的结论(as-of 2026-08-25,续接前先重核)

| 结论 | as-of | 重核命令 |
|---|---|---|
| 生产进程 pid 1494 / 已跑 4 天 | 2026-08-25 12:44 | `ps aux \| grep xiaohongshu-mcp-darwin` |
| 当前 rod chromium 泄漏数 = 0(12:16 清理后) | 2026-08-25 12:50 | `ps aux \| grep -c '/rod/user-data/'` |
| reaper 无 rod 类别 | 2026-08-25(本分支 HEAD) | `grep -n "rod" packages/teamlead/src/bridge/chrome-session-reaper.ts` |
| fork HEAD = `2504691` | 2026-08-25 | `git -C ~/Dev/xiaohongshu-mcp log --oneline -1` |
| panic 计数(10+3)与时间分布 | 2026-08-25 | §4 的 grep 命令 |
| rod 版本 v0.116.2 | 2026-08-25 | `grep go-rod ~/Dev/xiaohongshu-mcp/go.mod` |
