# FLY-2024 xiaohongshu-mcp Chromium 泄漏 — 探索

Issue: FLY-2024 (https://linear.app/geoforge3d/issue/FLY-2024/xiaohongshu-mcp-搜索调用卡住时泄漏一个有-dock-图标的-chromium-60s-超时被下一行-contextctx)
日期: 2026-08-25
基于: 无

---

## 1. 现象与复发史

- **2026-08-24 10:08**:Annie 的 Dock 上排着 10 个运行中的 Chromium 图标,她只说「清理一下这些东西」。止血杀掉 10 个 leakless 子进程后归零。
- **2026-08-25 09:11–09:17**(本单调研期间从日志新发现):又一批 search 调用中 **3 次卡死**,12:16 被清理。⇒ 「它会再长出来」已实证——**不到 24 小时就复发了一次**。
- 历史上 6 月、7 月也有零星同类事件(err.log 里的同签名 panic),只是没到 10 个图标的量级。
- FLY-1828(HTML 报告页验证泄漏 headless Chrome)是**同一症状、不同产生者**,已 Done 但不覆盖本路径。

## 2. 归因证据链(本单把 issue 的「进程形态推测」升级为「日志 + stack trace 确认」)

issue 边界里说「没读源码、没验证是哪些调用产生的」。本单调研补齐了这两块,证据全部来自本机:

### 2.1 卡点钉死在 search 一条路径上

`~/.codex/log/xiaohongshu-mcp.err.log`(LaunchAgent 的 stderr,logrus 输出)里,**2026-08-24T10:12:59 恰好 10 条 `tool=search_feeds` 的 "Tool handler panicked" 同时出现**,panic 原因是 `use of closed network connection` —— 正是 Annie 止血杀掉 10 个浏览器的时刻:杀浏览器切断了 CDP websocket,卡了 10–12 小时的 10 个 goroutine 才 panic 解卡。**10 个泄漏浏览器 = 10 个卡死的 search_feeds 调用,一一对应。**

每条 stack trace 都钉在同一行:

```
rod.(*Page).MustWait
  ← xiaohongshu.(*SearchAction).Search  (search.go:176: page.MustWait(`() => window.__INITIAL_STATE__ !== undefined`))
  ← XiaohongshuService.SearchFeeds      (service.go:392)
  ← AppServer.handleSearchFeeds         (mcp_handlers.go:335)
  ← go-sdk jsonrpc2 handleAsync         (异步 goroutine,ctx 不随单个 HTTP 请求断开而 cancel)
```

2026-08-25T12:16:24 又有 3 条同签名 panic(= 第二批 3 个泄漏被清理的时刻)。**全部历史 panic 都是 `tool=search_feeds`**,其它工具零记录。

### 2.2 调用来源

08-23 22:49 – 08-24 00:03(约 1.25 小时,与 issue 说的「spawn 集中在 1.5 小时窗口」吻合)共 **19 次 search_feeds 调用**,关键词全是食谱/宝宝辅食类(「烤红薯条 宝宝辅食」「焖烧杯燕麦」等),多次出现**一秒内 2–5 个并发调用**。19 次中 10 次卡死。08-25 早上又有 11 次(咖啡/食谱类),3 次卡死。调用方形态指向生活助理类 agent 的批量搜索任务;但**调用方是谁不影响修复设计**——任何 MCP client 都会触发,并发批量只是放大了命中率。

### 2.3 泄漏机制 = 四个条件叠加

1. **每次调用起一个新浏览器**:`service.go` 每个 public 方法 `newBrowser()` + `defer b.Close()`(源码确认,issue 的推测成立)。正常路径会关;**defer 只在函数返回/panic 时执行**。
2. **60s 超时被丢弃**:`NewSearchAction` 里 `page.Timeout(60s)` 设的 deadline,在 `Search()` 第一行 `s.page.Context(ctx)` 被**整个替换**掉。rod v0.116.2 源码 (`context.go:57`) 确认 `Context(ctx)` 是纯替换 (`newObj.ctx = ctx`),不是叠加。
3. **替进来的 ctx 没有 deadline**:MCP handler 侧对 ctx 零包装;go-sdk 的工具调用跑在 `handleAsync` 的独立 goroutine 上,client(Claude 的 MCP 层)超时放弃后**不断开连接、ctx 不 cancel**——日志证明卡死持续 10+ 小时直到进程被外杀。
4. **`-headless=false` 让每个泄漏都占一个 Dock 图标**:来自 LaunchAgent `com.codex.xiaohongshu-mcp.plist` 的启动参数(常驻服务,KeepAlive)。

搜索页在风控/慢加载时 `window.__INITIAL_STATE__` 永不出现 ⇒ `MustWait` 无限等 ⇒ defer 永远够不着 ⇒ 浏览器常驻。

## 3. 一个关键的新事实:它是我们自己的 fork

issue 修向里说「它是第三方工具,可能要在我们的调用侧收尾,而不是改它」。实际上:

- 本机源码在 `~/Dev/xiaohongshu-mcp`,remote origin = **`xrliAnnie/xiaohongshu-mcp`(Annie 自己的 fork)**,upstream = `xpzouying/xiaohongshu-mcp`。fork 上已有自己的 commit(如 `2504691 fix(saved_content)`)。
- `saved_content.go:115` 甚至已有注释写明 `Context(ctx)` 替换 deadline 的语义——**踩过一次坑,但只在那个文件局部处理了**。
- repo 内已存在两种正确写法:`like_favorite.go:47` / `feed_detail.go:81` 的 `Context(ctx).Timeout(d)`(顺序对了:先替换再派生,双保险);`comment_feed.go` 干脆不用 Context 只用 Timeout。
- ⇒ **修产生侧完全可行,而且是在自己仓库里改**,不依赖 upstream 接受 PR。

## 4. 方案空间

### 方向 A:fork 源码根治(产生侧)
- **A1 service 层单点兜底**:`service.go` 加统一 helper,每个 public 方法给 ctx 套 `context.WithTimeout`(按操作类型定预算)。无论 action 内部怎么写,goroutine 必然在预算内解卡 → defer 必然执行 → 浏览器必然被关。
- **A2 修各 action 的替换 bug**:统一为 `page.Context(ctx).Timeout(d)` 顺序。恢复每操作粒度的超时语义,可回馈 upstream。
- A1 是结构性保证(单点、防将来新 action 再犯);A2 是把已有语义修对。两者互补不互斥。

### 方向 B:基础设施兜底(reaper,flywheel 主仓)
- FLY-766 建了 `chrome-session-reaper.ts`(agent-browser 类别),FLY-1828 扩了 headless one-shot 截图类别。**rod chromium 类别(判据:`--user-data-dir` 含 `/rod/user-data/`)两个类别都不覆盖**——实测确认现有判据打不中。
- 新增 rod 类别:存活超过阈值(> 最长合法操作)⇒ TERM→KILL。**产生者无关**:xhs-mcp 将来更新引入回归、或其它 rod 工具进场,都兜得住。这直接回应 issue 的「别再一个产生者修一次」。

### 方向 C:headless 化(去 Dock 图标)
- 改 LaunchAgent 去掉 `-headless=false`。**不推荐入本单硬范围**:headed 大概率是风控考量(`NewPage` 走 stealth 库;小红书对 headless 有检测风险),改了可能触发风控 → Annie 的登录失效,代价是重新扫码 + 可能限流。泄漏修好后,headed 图标只在操作进行的几十秒内短暂可见,是「工作指示」不是泄漏。留作后续可选实验。

### 方向 D:客户端侧收尾(调用方超时后主动清理)
- 不可行/不值得:MCP client 拿不到服务端浏览器进程句柄;跨进程清理本质上就是 B 的 reaper。排除。

## 5. 初步取舍(带到 research/plan)

**推荐 A1 + A2 + B 三件套**:A 根治本产生者,B 兜住所有 rod 类产生者(含未来回归)。C 降级为可选后续。附带交付:第三方拉浏览器工具的盘点表(回应 issue「顺带查一遍」),落在 research.md。

**部署注意**:LaunchAgent 直接跑二进制、**不走** `xhs-start`(那个脚本才有 auto-pull+rebuild),所以 fork 修完必须显式 `go build` 替换二进制 + `launchctl kickstart -k`,否则修复不生效。这一环必须写进 plan 的验收标准。

**QA 可行性**:`XHS_BASE_URL` env(configs/browser.go:20 确认可覆盖)可指向本地假 server,返回一个永不设置 `__INITIAL_STATE__` 的页面即可确定性复现「search 卡死」,验证修复后浏览器在预算内消失。零风控风险、零真实账号依赖。
