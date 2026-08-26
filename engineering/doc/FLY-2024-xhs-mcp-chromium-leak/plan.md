# FLY-2024 xiaohongshu-mcp Chromium 泄漏 — 实施计划

Issue: FLY-2024 (https://linear.app/geoforge3d/issue/FLY-2024/xiaohongshu-mcp-搜索调用卡住时泄漏一个有-dock-图标的-chromium-60s-超时被下一行-contextctx)
日期: 2026-08-25(R5,依 Codex Round 1–4 反馈修订)
基于: research.md

---

## 0. 一句话

产生侧根治(fork 仓给每个操作装上够得着的 deadline)+ 基础设施兜底(flywheel 主仓 reaper 新增 rod 类别),让「search 卡死」从**永久泄漏一个 Dock Chromium** 变成**预算内解卡、进程归零**;即使产生侧将来回归,reaper 30 分钟内也会收掉。

## 1. 范围与仓库拆分

| 工作流 | 仓库 | 内容 |
|---|---|---|
| W1 产生侧根治 | `xrliAnnie/xiaohongshu-mcp`(fork,`~/Dev/xiaohongshu-mcp`) | service 层单点超时兜底 + 修 action 层 ctx 顺序 bug + Go 测试 |
| W2 兜底 reaper | flywheel 主仓 | `chrome-session-reaper.ts` 新增 rod 类别 + vitest |
| W3 部署与验证 | 本机 | 原子化二进制替换 + `launchctl kickstart` + 生产验证(时机由 Lead 确认) |

两仓 **两个 PR**:flywheel 主仓 PR 含 W2 + 本 doc 文件夹 + milestone 文件;fork 仓 PR 含 W1。W3 在两 PR 合入后执行;48h 观察项收口写 Linear issue 评论 + DONE 报告,**不为观察开第三个 PR**(milestone 记 ship 事实,观察结论补进 issue)。

## 2. W1 — fork 仓根治(Go)

### 2.1 W1a:service 层单点兜底

`service.go` 每个 **browser-owning** public 方法入口统一包 deadline:

```go
ctx, cancel := context.WithTimeout(ctx, budget)
defer cancel()
```

**browser-owning 的定义**:对一次 browser lifecycle 负责的**最外层 public operation**——`newBrowser()` 可能在方法体内,也可能在其调用的无预算 private helper 里(`PublishContent`→`publishContent`、`PublishVideo`→`publishVideo`、`GetMyProfile`→`withBrowserPage`)。**只在最外层包一次**。

**完整方法 ledger**:

| 方法(service.go) | 类型 | 兜底预算 | 依据 |
|---|---|---|---|
| SearchFeeds / ListFeeds | owning | 90s | action 60s |
| UserProfile / **GetMyProfile** | owning | 90s | action 60s(GetMyProfile 走 navigate+profile,正是当前无超时路径) |
| LikeFeed / **UnlikeFeed** / FavoriteFeed / **UnfavoriteFeed** | owning | 90s | action 60s(正反向同预算) |
| CheckLoginStatus / DeleteCookies | owning / 无浏览器 | 60s | login 无自带超时;DeleteCookies 纯文件操作,统一包上无害 |
| GetLoginQrcode(同步段) | owning(**ownership-handoff 特例,见下**) | 60s | 后台 `WaitForLogin` goroutine 已自带 4min 预算(`service.go:161`),**不动** |
| ListSavedContent / ListCollections / **GetCollectionContent** | owning | 300s | action 180s;GetCollectionContent 的 per-op 模式由本 300s 封顶(见 2.2 例外) |
| PublishContent | owning | 8min | action 300s |
| PublishVideo | owning | 15min | action 300s + 5min 视频处理 |
| **GetFeedDetailWithConfig** | owning | 12min | action 10min |
| **PostCommentToFeed / ReplyCommentToFeed** | owning(**action-owned bounded exception**) | 12min(对浏览器操作是 no-op,见下) | `comment_feed.go:24-26,83-86` **接收但故意不消费 ctx**,从原始 page 自建 60s / 5min Timeout——本就有界,非泄漏源。service 包装**不进入**其浏览器操作;它的 future-regression 兜底只有 W2,**不属于 W1a 的结构性保证**。本单不改其 caller-cancellation 语义(改 ctx threading = 取消语义变化,超出必要范围) |
| GetFeedDetail | **委托** GetFeedDetailWithConfig | 不包 | 只在 owning 层包一次 |

**审计方法(双向)**:从每处 `newBrowser()` **与** `withBrowserPage`(及任何等价 helper)**反向追到 public caller**,与上表逐项双向对应——只 grep `newBrowser()` 追不到经 helper 的三条间接生命周期(以上为 2026-08-25 审计快照);发现表外新方法 → 按同类操作归档预算。

**结构性保证的准确边界**:service ctx 覆盖「**消费 ctx 的** action 浏览器操作」阶段——ctx 到期 → rod `Must*` panic → panic 展开**执行/尝试** `defer b.Close()/page.Close()` 清理。`newBrowser()` 启动阶段与 `Close()` 清理阶段本身**不受**该 ctx 控制,`Close()` 也可能对无响应浏览器卡住;comment 两方法不消费 ctx(见 ledger)——这些缺口全部由 W2 reaper 兜底,这正是双层的意义。

**GetLoginQrcode 的 ownership-handoff 修法(R3 发现的 HIGH 缺口)**:现状 `service.go:138-170` 在 `newBrowser()`/`NewPage()` 之后**没有立即注册**任何 cleanup——`deferFunc` 只在 `FetchQrcodeImage` 正常返回后的 `err != nil || loggedIn` 分支注册,或移交给后台 goroutine。给 `login.go:61` 补上 60s Timeout 后,`FetchQrcodeImage` 内 panic 时**没有任何已注册的 defer**,浏览器照样泄漏(只是从「永卡」变「解卡但泄漏」)。修法:
- `newBrowser()` 成功后**立即 arm** cleanup(nil-safe + `sync.Once`,`b.NewPage()` panic 也被覆盖);
- 同步路径 `defer` 该 cleanup:panic / error / 已登录 三种出口都由它清;
- **成功启动 4min `WaitForLogin` goroutine 时做单次 handoff**(标记 handed-off → 同步 defer 变 no-op),此后由 goroutine 的 defer 清理,`sync.Once` 保证恰好执行一次;
- **后台 goroutine 必须自带最外层 `defer recover`**(R4 HIGH):`Close()` 走 `browser.MustClose()`(可 panic);同步路径的 cleanup panic 有 `withPanicRecovery` 接,但 handler 返回后的后台 goroutine 里 deferred cleanup panic **按 Go 语义直接终止整个 MCP 进程**——W2 只能收残留浏览器,救不了 service-wide 崩溃。合同:goroutine 内 recovery defer **先注册**(LIFO 后执行、能捕获)、cleanup defer 后注册(先执行);cleanup panic 记日志吸收,未清干净的 Chromium 交 W2。若抽 helper,加 **panicking-cleanup 单测**:后台路径 panic 不向进程顶层传播,且 `sync.Once` 仍恰好执行一次;
- **不许**改成无条件 `defer b.Close()`——返回二维码后同步函数就返回了,无条件 defer 会当场关掉扫码浏览器、破坏 cookie 保存流程。

### 2.2 W1b:修 action 层 ctx 顺序

目标模式 = 方法内 `Context(ctx).Timeout(d)`(repo 既有正确先例 `like_favorite.go:47` / `feed_detail.go:81`)。**constructor 的 `Timeout(d)` 一律保留**——理由限定在 **feeds/publish/publish_video 三个 constructor 有真实浏览器 I/O**:`NewFeedsListAction`(`feeds.go:18-24`,导航 `configs.BaseURL()` 根路径)、`NewPublishImageAction`(`publish.go:40-70`)、`NewPublishVideoAction`(`publish_video.go:26-50`)在 constructor 里就执行 `MustNavigate`/等待/点击,constructor Timeout 是这段 I/O 唯一的界(去掉它 = 制造新的无界窗口)。其余 constructor(如 `NewSearchAction`)的 `Timeout` clone 无 I/O、保留只为不做无意义的搬动,不声称它覆盖任何 constructor 期 I/O。

| 文件 | 改法 |
|---|---|
| `search.go` | `Search()` 首行改 `page := s.page.Context(ctx).Timeout(60 * time.Second)`;constructor `Timeout(60s)` 保留(无 I/O,仅避免无意义搬动) |
| `feeds.go` / `user_profile.go` | 同上(60s;user_profile `:24,109` 两处都改) |
| `saved_content.go` | 逐处判据:**方法体已是「`Context(ctx)` + 每步 `op(d)`/`Timeout(d)` 派生」的 per-op 模式 → 保留原样并补注释**(`GetCollectionContent` `:115-120` 属此类,系 fork commit `2504691` 特意修的可靠枚举语义,由 service 300s 封顶;机械加 `.Timeout(180s)` 会回归它);其余裸 `Context(ctx)` 替换处改 `Context(ctx).Timeout(180s)` |
| `publish.go` / `publish_video.go` | 方法内改 `Context(ctx).Timeout(300s)`;constructor `Timeout(300s)` 保留;publish_video `:73` 的 5min 派生保留 |
| `login.go` | `:21,39,61` 三处 `Context(ctx)` 后补 `.Timeout(60s)`;**`:87`(`WaitForLogin`)不动**——保持 bare `Context(ctx)` + reason 注释(轮询由 qrcode goroutine 的 4min caller ctx 驱动;套 60s 会让 60s 后探测全部立即失败、空转到 4min) |
| `navigate.go` | `:19,29` 补 `.Timeout(60s)` |
| `comment_feed.go` | 不动——**action-owned bounded exception**(不消费 ctx、自带 60s/5min 界,见 §2.1 ledger;基底修复对它**没有作用**,勿误读为「自动正确」) |
| `search_pagination.go` | 不动——从修正后的入参 page 派生 `Timeout(60s)`,基底修好后**自动正确** |

**审计门(修订)**:不要求 bare `Context(ctx)` 全消失;要求**每一处保留的 bare `Context(ctx)` 都有注释说明理由**(per-op 模式 / 调用方 ctx 已有界),其余全部为 `Context(ctx).Timeout(d)` 形态。此外**显式枚举「接收 ctx 但故意不消费」的 action**(现状:`comment_feed.go` 两处——grep `Context(ctx)` 发现不了这一类,必须按方法签名逐一过),逐文件对照 research §2 表核对。

### 2.3 W1 测试(TDD:先 RED)

**测试合同(修订)**:rod `Must*` 在 ctx 到期时 **panic**(不是返回 error);`service.SearchFeeds` 不经过 `mcp_server.go:139` 的 `withPanicRecovery`。测试合同据此定为:**测试自身 `defer recover()`,断言「预算内解卡(panic 或返回皆可)+ defer 清理已跑 + 本测试拉起的 rod 进程消失」**。不改生产 error 语义(生产的 panic→error 转换已由 withPanicRecovery 承担)。

新文件 `service_timeout_test.go`,`//go:build integration` tag(确定性但真起浏览器、三个串行 case 合计 ~6–8min,不进默认 suite):

1. `httptest` 假 server,按用例分路由:**泄漏用例**给 `/search_result` 返回永不设置 `window.__INITIAL_STATE__` 的合法 HTML(确定性复现 `search.go:176` 卡点)、`/` 正常;**constructor-stall 用例**反过来——`NewFeedsListAction` 导航的是 `configs.BaseURL()` **根路径 `/`**(`feeds.go:21`),所以挂起 `/`、`/search_result` 正常。
2. `XHS_BASE_URL` 指向假 server + `configs.InitHeadless(true)`;**`COOKIES_PATH` snapshot 后指向 test-owned 临时文件**(不只清空——`NewBrowser` 经 cookie loader 读它;temp 路径既不读 Annie 的真实 cookie,也给 QR fixture 意外进 save path 留安全边界),teardown 恢复;**同时 snapshot、清空、teardown 恢复 `XHS_PROXY`**(`browser.NewBrowser` 每次创建都直接读它传给 rod launcher——开发机若配代理,httptest 流量与 Chromium argv 都被外部配置污染,还可能把代理凭据带进 exact command 记录)及任何测试实际读取的 browser env;测试结束恢复全部全局配置(env + configs 均为进程级全局)。**失败日志不输出完整 Chromium command,只输出脱敏 identity/hash**。
3. **泄漏用例(`TimeoutE2E`,唯一做真实 RED→GREEN 的用例)**:被测调用放 worker goroutine,goroutine 内 `defer recover()` 并把 outcome(panic 值/error/elapsed)经 channel 送回主测试;进程断言用**进程树 lineage 追踪**,不是 baseline 差集——运行中采样 `pid/ppid/lstart/comm/command`,只捕获**从本测试进程派生**的 leakless→Chromium 后代并保存 exact identity(pid+lstart+comm+command),结束后只等待这些已捕获身份消失(baseline 差集会把 LaunchAgent/并发测试新起的进程误算进来;无法证明归属的进程不观察、不清理)。**非空 capture gate(反空过绿)**:worker 启动后轮询采样到明确上限,**硬断言至少捕获到 1 个属于测试 ancestry 且满足 rod main identity 的 Chromium**(及其 leakless parent;guard 缺失需给出源码支持的显式例外),才允许进入 disappearance 断言——空捕获集直接 fail,否则 sampler 时序/解析错误会立即「全部消失」假绿。断言 ≤120s 解卡。RED:现状 150s 不解卡即 fail;**RED 与 GREEN 都记录实际 elapsed 与 recovered panic 值**。
4. **constructor-stall 用例(characterization,baseline 即 GREEN)**:假 server 挂起 `/`,`NewFeedsListAction` 应在 constructor Timeout(60s)+余量内 panic 解卡。constructor Timeout 在基线本就存在,此用例**没有自然的修前 RED**——它是防止「实施时误删 constructor Timeout」的回归钉。**非 vacuous 证明用一次 mutation check**:临时删掉 `NewFeedsListAction` 的 `Timeout` → 该用例应 RED(受外层 watchdog 上限)→ 恢复 → GREEN,记录并明确标注为 mutation check,不冒充 TDD RED。
5. **QR cleanup 用例(integration)**:假 server 的 login 页永不出现二维码元素 → `GetLoginQrcode` 在 60s+余量内 panic 解卡(recover 非空),且该用例的 rod lineage 消失(复用 3 的非空 capture gate)——钉住 §2.1 ownership-handoff 修法。若实现抽出 ownership helper,另加轻量单测:handoff 后同步 defer 不关闭、后台 cleanup 恰好执行一次(`sync.Once`)。
6. **既有测试 hermetic 化**:`xiaohongshu/search_test.go:38-68` 的 `TestSearchWithFilters` 访问真实站点且拉 headed 浏览器、未 skip。Go build constraint 是**文件级**,直接给现文件加 tag 会把同文件的 hermetic `TestFilterValidation` 一起拖出默认 suite——**把 `TestSearchWithFilters` 移到新文件 `search_integration_test.go`**(同 package,文件头 `//go:build integration`),原文件保留默认测试。
7. **integration 运行纪律(R4)**:lineage 的根是 OS test process,不是单个 test case——两个自然 RED 用例(`TimeoutE2E`/`QrcodeCleanup`)在 RED 阶段会故意留浏览器到进程退出,同一 binary 里跑会互相污染 capture。规定:
   - integration 测试**不得 `t.Parallel`**;
   - **RED 证据各用独立进程 + anchored regex + `-count=1`**:`go test -count=1 -tags integration -run '^TestTimeoutE2E$' ./...`、`'^TestQrcodeCleanup$'` 分开跑;
   - mutation check 前后同样 `-count=1` + 显式 test/watchdog timeout(否则恢复源码后 `go test` 可能复用缓存结果,GREEN 没真跑);
   - 修后才允许 combined GREEN。
8. 验收命令(分开列,确定性):`go test ./...`(默认,hermetic:不触网、不拉浏览器,且 `TestFilterValidation` 等仍被执行——用 `go test -list '.*' ./xiaohongshu/` 证明)+ `go test -count=1 -tags integration -run '^Test(TimeoutE2E|ConstructorStall|QrcodeCleanup)$' -timeout 15m ./...`(combined GREEN;**`-count=1` 为硬门**,防浏览器 E2E 被缓存结果替代;耗时上限按三个串行 case 计,~6–8min,15m timeout 留余量)。

(R1 曾计划「`GetContext()` 断言 deadline」单测——方法内局部 clone 不可观察,已删;由行为级用例 3/4 覆盖。)

## 3. W2 — reaper 新增 rod 类别(flywheel 主仓,TS)

`packages/teamlead/src/bridge/chrome-session-reaper.ts`,照 FLY-1828 one-shot 类别(selector `:442-460`、常量 `:47`、TERM→KILL、退出确认后计数)的既有模式:

- **selector(纯 classifier,判据全部显式)**:
  1. `comm` ∈ Chrome family(本形态实测 comm=`Chromium`;沿用文件内既有 family 判据形状);
  2. `command` **不含 `--type=`**(排除 renderer/GPU/utility helper——它们 comm 与 main 相同);
  3. `--user-data-dir=` 路径含 `/rod/user-data/`,**或** 可执行路径含 `/.cache/rod/browser/`;
  4. 与既有类别互斥性显式注释(agent-browser=`agent-browser-chrome-` UDD、用户 Chrome=`~/Library/...`、playwright=`ms-playwright`,判据不重叠)。
- **发信号前 exact-process probe**(沿用 headless-shot 既有模式):按 `lstart + comm + command` 全量复核后才 TERM→KILL,防 PID reuse。
- **不主动杀 leakless guard**(R1 断言撤回:leakless 以 `Setpgid` 起 Chromium、guard 在 `cmd.Wait()` 返回后自然退出,rod launcher 有回收 goroutine——「单杀 Chromium 留僵尸」无源码支持)。**child-first 只杀 Chromium main**、确认退出后计数;guard 是否残留列为 48h 观察项,拿到反证再立后续单。
- **阈值**:`ROD_BROWSER_MAX_AGE_MS = 30 * 60_000` 常量(> 最长合法操作 GetFeedDetail 10min / PublishVideo ~15min 预算的 2 倍)。**零新 env/flag**。
- **刻意不要求 owner marker**(1828 同款决策:rod 浏览器由 xhs-mcp 服务拉起,天然无 Flywheel 归属)。
- **计数 + durable receipt**:结果加 `killedRodBrowser` / `skippedRodFresh`;`plugin.ts:7229` 日志行补齐。**confirmed-gone 后写一条 rod 专用 `chrome_session_reaped` 事件**(照 `handleHeadlessShot` 的 `insertHeadlessShotReapEvent` 既有合同——ownerless host kill 是实质 mutation,只有 console line 撑不起 48h 观察收口),payload 仅含非敏感 identity/age/reason/mode,**不落完整 argv/UDD**。
- **vitest(先 RED)**,fixture 用生产实抓形态:
  - 正例:31min 的 rod Chromium main(TERM→KILL、退出确认后计数);
  - 边界:29min 不杀;
  - **负例**:rod renderer(同 comm + `--type=renderer` + 同 UDD)、leakless guard(argv 携带 Chromium 路径与 `--user-data-dir` 参数的 lookalike)、node/claude 进程 argv 里含 `/rod/user-data/` 字符串的 lookalike、agent-browser、用户 Chrome、playwright——全部零影响;
  - **receipt 合同**:confirmed exit 恰好一条 `chrome_session_reaped` 事件;fresh/raced/survived/sensor-unknown 均零条;
  - sensor unknown 时空过(既有行为不变);既有类别测试零回归。

## 4. W3 — 部署与生产验证

research §5:LaunchAgent 直接跑二进制,不部署 = 生产还是旧字节。**原子化步骤**(执行时机报 Lead 确认;重启打断进行中的 xhs 调用,cookie/登录不受影响——issue 已实证):

```bash
cd ~/Dev/xiaohongshu-mcp && git pull --ff-only origin main
BIN=~/tools/xiaohongshu-mcp/xiaohongshu-mcp-darwin-arm64
go build -o "$BIN.new" .
file "$BIN.new" && shasum -a 256 "$BIN" "$BIN.new"        # 构建产物核验
cp "$BIN" "$BIN.bak-pre-fly2024"                          # 即时回滚副本(目录已有 .bak 先例)
mv "$BIN.new" "$BIN"                                      # 原子 rename
launchctl kickstart -k gui/$(id -u)/com.codex.xiaohongshu-mcp
launchctl print gui/$(id -u)/com.codex.xiaohongshu-mcp | grep -E "pid|state"   # 新 pid
# login probe:mcp__xiaohongshu-mcp__check_login_status 返回「已登录」
# 回滚(如失败):cp "$BIN.bak-pre-fly2024" "$BIN" && launchctl kickstart -k gui/$(id -u)/com.codex.xiaohongshu-mcp
```

**部署后观察项(48h,判据只用可直接证明的信号——当前日志无 invocation ID,panic 无法与并发调用逐一配对,不假装能配)**:
- `err.log` 新增的 `Tool handler panicked: context deadline exceeded` 属**预期**(新 deadline 在干活),不计入失败;
- **硬判据 1**:`ps` 无存活 >30min 的 `/rod/user-data/` Chromium 实例;leakless guard 无长期残留(§3 观察项);
- **硬判据 2**:reaper 的 rod `chrome_session_reaped` receipt——0 条 = 产生侧根治独立生效;>0 条 = 兜底接管过(说明产生侧仍有路径,顺藤摸);
- **硬判据 3**(有真实调用发生时):client 侧观察到的调用时长 ≤ 对应预算 + 余量;
- Annie 的 Dock 不再积累图标。
- 收口:结论写 Linear issue 评论 + DONE 报告(不开第三个 PR)。

## 5. 验收标准(硬门)

1. **E2E(Go,integration tag)**:泄漏 + constructor-stall + QR cleanup 三用例按 §2.3 合同绿。修前 RED 记录**只适用于 `TimeoutE2E` 与 QR 用例**(自然 RED);constructor-stall 是 characterization,以 mutation check 证明非 vacuous(§2.3-4),不冒充 TDD RED。均记录 elapsed + recovered panic。
2. **审计门**:按 §2.2 修订版——保留的 bare `Context(ctx)` 全部有理由注释,其余为 `Context(ctx).Timeout(d)` 形态;`grep -rn "Context(ctx)" xiaohongshu/*.go` 逐处对照。service 层按 §2.1 双向审计(`newBrowser()`/`withBrowserPage` → public caller ↔ ledger)。
3. **hermetic 门**:默认 `go test ./...` 全绿且不触网、不拉浏览器;`TestSearchWithFilters` 已移入独立 `search_integration_test.go`,且默认 suite 仍包含 `TestFilterValidation` 等原有测试(`go test -list` 证明,防覆盖缩水)。
4. **reaper vitest**:§3 正/边界/负例 + receipt 合同全绿;既有类别零回归。
5. **flywheel 主仓全量门**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`。
6. **Codex code review** 两仓 PR 各自 approve(`codex:rescue` 通道)。

## 6. 不做(诚实边界)

- **不改 `-headless=false`**:headed 大概率是风控考量(NewPage 走 stealth;headless 检测风险 → 登录失效代价 = Annie 重扫码)。泄漏修复后图标只在操作进行的几十秒内可见,属工作指示。若仍嫌闪,另立实验单。
- **不动 playwright census 的 audit-only 定位**(FLY-1867 既定 scope)。
- **不向 upstream 提 PR 作为验收**(fork 自足;回馈 upstream 可选后续)。
- **不改 MCP client 侧**(服务端自带 deadline 后 client 行为无关紧要;research §3)。
- **不迁移 LaunchAgent 到 xhs-start**(auto-update 分叉治理另议;本单只做一次显式构建替换)。
- **不做 leakless guard 主动收尸**(无僵尸证据;先观察,拿到反证再立单)。
- **修复不让搜索「变好」**:风控/慢页面导致的失败依旧失败,只是从「永久卡死+泄漏」变成「预算内解卡+零泄漏」。调用方会看到更多显式超时错误——意图内行为。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `b.Close()`(CDP MustClose)对无响应浏览器卡住/panic,defer 清理不完整;`newBrowser()` 启动段不受 service ctx 控制 | **同步路径**:cleanup panic 由 `withPanicRecovery` 接住,残留浏览器交 reaper;**后台路径(QR waiter)**:goroutine 自带 recover(§2.1,否则 panic 崩整个进程),吸收后交 reaper。30min 兜底,双层互备 |
| reaper 误杀 | 阈值 30min > 最长合法 ~15min;29min 不杀 + 负例矩阵(renderer/guard/lookalike)有测试钉住;发信号前 exact-process probe |
| 部署漏做/构建产物错 | §4 原子化步骤含 hash 核验 + 回滚副本 + 新 pid 验证;DONE 报告必含部署证据 |
| 测试污染全局状态(env/configs 进程级) | 测试 teardown 恢复;lineage-scoped 进程断言不受并行真实调用影响 |
| `GetCollectionContent` 语义回归 | §2.2 显式例外 + 注释;review 时对照 fork commit `2504691` |

## 8. 实现 chunk(供后继 implement 节点)

| chunk | 内容 | 依赖 |
|---|---|---|
| `go-fix` | W1a + W1b + §2.3 测试(先 RED 后 GREEN),fork 仓 PR | 无 |
| `reaper` | W2 + vitest,flywheel 主仓 PR(捎带本 doc + milestone) | 无(与 go-fix 并行) |
| `deploy` | W3 原子部署 + 验证 | 两 PR 合入;时机报 Lead |
| `observe` | 48h 观察收口 → Linear 评论 + DONE 报告(无第三个 PR) | deploy |
