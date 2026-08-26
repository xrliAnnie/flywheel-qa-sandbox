# FLY-2024 Codex Design Review 存档 — 5 轮全记录

评审通道: codex-companion (persistent session, effort xhigh)。R1-R4 CHANGES REQUESTED,R5 APPROVED。

---

# Design Review — plan.md (Round 1)
Date: 2026-08-25
Author: Codex
Status: CHANGES REQUESTED

## Summary
总体方向正确：产生侧 deadline、基础设施 reaper、显式二进制部署三层边界清楚，且根因链对 rod `Context`/`Timeout` 语义的判断成立。但当前方案在 constructor I/O、既有长操作语义、测试边界及 leakless 收尸安全上仍有实现级 blocker；按现文实施会重新引入无界浏览器路径，并可能误伤或回归已有功能。

## What's Good (Keep)

- 保留 W1 + W2 双层设计：fork 修当前根因，reaper 只做 host 级最终兜底。
- 保留不改 `-headless=false`、不扩 MCP client、不给 reaper 增加新 env/flag 的 scope 约束。
- `page.Context(ctx).Timeout(d)` 的 rod 语义判断正确；`like_favorite.go:47` 与 `feed_detail.go:81` 确实是当前仓库中的正确先例。
- W3 正确认出 LaunchAgent 直接执行已安装二进制，源码合入不会自动进入生产；cookie 文件独立于 rod 临时 profile 的判断也成立。
- TS 侧复用已有三路 sensor、age/lstart fence、TERM→KILL、确认退出后计数的方向正确。

## Issues & Recommendations

1. **[HIGH] 去掉 constructor timeout 会在 3 条路径上制造新的无界 browser I/O。** `NewFeedsListAction` 在返回前执行 `MustNavigate`/`MustWaitDOMStable`（`xiaohongshu/feeds.go:18-24`），`NewPublishImageAction` 与 `NewPublishVideoAction` 也在 constructor 内导航、等待并点击 tab（`publish.go:40-70`、`publish_video.go:26-50`）。这些 constructor 只接收原始 page；service deadline 到 action 方法开始时才通过 `Context(ctx)` 挂上。按计划直接移除 constructor 的 `Timeout` 后，constructor 卡死时 action 方法永远到不了。**建议：**把 constructor 的浏览器 I/O 移进接收 ctx 的方法，或让 constructor 接收 ctx 并从第一条浏览器操作起使用 `page.Context(ctx).Timeout(d)`；新增 constructor-stall 回归测试。相应地把“整个 browser-owning goroutine 必然解卡”收窄为已被实际 ctx 覆盖的阶段，因为 `newBrowser()`/launcher 与 cleanup 本身也不受该 service ctx 控制。

2. **[HIGH] 全量改成 action 总预算会破坏两个明确存在的特殊语义。** `GetCollectionContent` 当前故意不继承累计 180s deadline，而使用 request ctx + per-op 短 timeout，注释明确说明大收藏夹可能超过 180s（`saved_content.go:110-120`）；给它加 `.Timeout(180s)` 会回归刚由 `2504691` 修好的可靠枚举，service 的 300s 才应是这条路径的总预算。另一方面，`login.go`“各方法补 60s”会覆盖 `WaitForLogin`：其循环监听的是传入的 4min ctx，但 page clone 60s 后已失效，导致 60s 后所有探测立即失败、仍空转到 4min，与“后台 goroutine 不动”矛盾。**建议：**显式列例外：`GetCollectionContent` 保持 `Context(ctx)` + per-op timeout（由 service 300s 封顶）；`WaitForLogin` 保持调用方 4min ctx，不另加 60s。审计门必须允许并核对这些有理由的 bare `Context(ctx)`，不能机械要求全消失。

3. **[HIGH] service 预算表没有覆盖全部可达的 browser-owning public 方法。** 当前还存在并被 MCP/HTTP caller 使用的 `UnlikeFeed`、`UnfavoriteFeed`、`GetMyProfile`、`GetFeedDetailWithConfig`（`service.go:411,492,522,590`）；其中 `GetMyProfile` 走的正是当前丢失 timeout 的 user-profile/navigate 路径。`GetFeedDetail` 又只是委托给 `GetFeedDetailWithConfig`，若二者都机械包一次会产生重复 budget。**建议：**给出完整方法 ledger，标明“真正拥有 browser 的方法”与“纯委托方法”，逐项预算和测试；`Unlike/Unfavorite` 应与对应正向操作同预算，`GetMyProfile` 应与 profile 同预算，只在 owning 层包一次。

4. **[HIGH] W1 E2E 与单测合同按当前 API 无法实现。** rod 的 `MustWait` 在 deadline 时 panic（rod `must.go:1-3,500-503`）；直接调用 `service.SearchFeeds` 不经过 `mcp_server.go:139-168` 的 `withPanicRecovery`，因此不会“返回 timeout error”，而会在测试 goroutine 中 panic（defer 会展开，但测试仍失败）。同时 action 方法只保留本地 page clone、不返回它，事后读取 action 原 page 的 `GetContext()` 看不到方法内 deadline。**建议：**二选一并写死：要么在 service/action 边界用 `rod.Try` 建立真实 error-return contract，再按现断言测试；要么从已注册 MCP handler 边界调用并断言 `IsError`，service 层测试显式 recover 后只验证 cleanup。若要测 deadline 组合，抽一个被生产代码实际调用且返回 page 的小 helper，而不是测试不可观察的局部 clone。

5. **[HIGH] rod selector 必须明确绑定 OS executable identity 和 MAIN 进程。** 计划的“argv UDD 命中，或 executable path 命中”没有写 `comm` 的 Chrome-family 前置条件，也没有排除 `--type=`。rod 的 leakless parent argv 本身携带被守护 Chromium 的 executable 与全部 `--user-data-dir` 参数，renderer/GPU 的 `comm` 又与 main 相同；模糊实现会把 leakless 或 helper 当成 browser main。**建议：**定义纯 classifier：`comm` 必须是 Chrome/Chromium family，`command` 不含 `--type=`，并要求 UDD 为 `/rod/user-data/` 或 `comm` 的真实路径位于 rod cache；分类优先级写清。沿用 headless-shot 的 exact-process probe，在发信号前按 `lstart + comm + command + stale age` 全量复核。补 rod renderer/GPU、leakless argv lookalike、node/claude argv lookalike的负例，而不只测 agent-browser/用户 Chrome/playwright。

6. **[HIGH] “按 ppid 同组杀 leakless parent”既不符合真实进程组语义，也缺少 parent identity fence。** leakless v0.9.0 以 guard 进程启动 Chromium，但在 Unix 为 Chromium 设置 `Setpgid: true`（`cmd/leakless/os_unix.go:12-18`），所以 parent 与 browser 并非同组；Chromium 退出后 guard 的 `cmd.Wait()` 会返回并退出（`cmd/leakless/main.go:46-72`），xhs 侧已有 `cmd.Wait()` goroutine 回收 guard。当前“单杀 Chromium 会留 leakless 僵尸”没有源码支持。更危险的是，仅凭 sample 的初始 `ppid` 杀 parent 没有 `comm/argv/lstart` 复核，会打开 PID reuse 误杀面；先 KILL guard 还可能绕过其 deferred group kill。**建议：**保持简单：只精确 revalidate + TERM→KILL Chromium main，并确认退出；随后观察/确认对应 leakless 自然消失。只有拿到反证后才增加 parent cleanup，届时必须 child-first、对 parent 做独立 exact identity/lstart fence，并确认 parent 退出后才计数。

7. **[MEDIUM] QA 与部署/收口步骤还不是可执行的确定性 gate。** 新 E2E 仍写成“build tag 或常规”，正常 suite 若直接纳入会每次等待约 90s；全局 `pgrep` 归零会被并行的真实 xhs 调用污染，应记录 baseline/测试 browser PID lineage，只断言本测试新增实例消失，并恢复 `XHS_BASE_URL`/headless 全局配置。当前 `go test ./...` 还包含未 skip、访问真实站点并拉 headed browser 的 `TestSearchWithFilters`（`xiaohongshu/search_test.go:38-68`），不能作为 hermetic 全绿门，需先改成显式 opt-in 或把确定性命令分开列出。部署命令也没有创建风险表声称的当前字节 backup：应先 build 到同目录 sibling、核对 `file`/hash、保存即时 rollback 副本、原子 rename，再 kickstart 并用 `launchctl print` + 新 PID + login probe 验证；失败时给出恢复副本并再次 kickstart 的命令。最后，“两仓两个 PR”与 merge 后 48h 再写 milestone 相冲突，应明确第三个 evidence-only PR，或调整 milestone 的落点/时序；观察标准也要允许新 deadline 触发的预期 `Tool handler panicked: context deadline exceeded`，改为验证调用时长与 rod/leakless age，而不是笼统要求 panic 日志零新增。

## Verdict

CHANGES REQUESTED — address items above

---

# Design Review — plan.md (Round 2)
Date: 2026-08-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已实质修正 Round 1 的主要架构风险：保留 constructor timeout、补齐特殊语义与 public-method ledger、收紧 rod selector、撤销无依据的 leakless parent kill，并把部署/观察收口写进交付链。当前双层方案可实现，但测试合同和 ownership 审计仍有几处与真实源码不一致；按现文实施会产生 false-GREEN 或悄悄丢掉默认单测，因此尚不能批准进入实现。

## What's Good (Keep)

- 保留 `NewFeedsListAction`、publish image/video constructor timeout，并明确 `newBrowser()`/`Close()` 不受 service ctx 控制；这正确修复了 Round 1 的无界窗口问题。
- `GetCollectionContent` 的 per-op timeout 与 `WaitForLogin` 的 caller-owned 4min ctx 已被列为例外，方向与当前源码语义一致。
- public-method 表已补入 `UnlikeFeed`、`UnfavoriteFeed`、`GetMyProfile`、`GetFeedDetailWithConfig`，且 `GetFeedDetail` 只委托、不重复预算。
- service 直调测试不再假定 rod panic 会返回 error；由测试 recover、生产继续由 `withPanicRecovery` 转换的边界正确。
- rod reaper 的 main-process classifier、`lstart + comm + command` exact probe、TERM→KILL 后确认退出再计数，以及 renderer/guard/argv lookalike 负例矩阵都与现有 reaper 结构兼容。
- 撤销主动 kill leakless parent 是正确收敛；源码显示 Chromium 独立进程组、guard 在 `cmd.Wait()` 后自然退出，当前没有第三条 kill 路径的证据基础。
- integration tag、原子 sibling build/rename、即时回滚副本、两 PR 加 48h Linear/DONE 收口的总体 sequencing 合理。

## Issues & Recommendations

1. **[HIGH] constructor-stall fixture 挂错 URL，当前硬门不会验证 constructor timeout。** `NewFeedsListAction` 在 `xiaohongshu/feeds.go:21` 调用的是 `MustNavigate(configs.BaseURL())`，即假 server 的根路径 `/`；`/explore` 是 login action 使用的路径。按 §2.3-4 只让 `/explore` 挂起时，feeds constructor 会得到根路径的正常/404 响应并继续，测试不能证明 60s constructor deadline。另一个文字误差是 `NewSearchAction` constructor 只有 `page.Timeout(60s)` clone，没有 I/O，不能声称其 timeout“覆盖 constructor 期 I/O”。**建议：**constructor-stall server 精确挂起 `/`，正常响应 `/search_result`；或改测一个实际导航到所配 endpoint 的 constructor。把 §2.2 的 rationale 限定为 feeds/publish/publish_video 的 constructor I/O，并要求修前 RED、修后 GREEN 都记录实际 elapsed 与 recovered panic。

2. **[HIGH] “相对 baseline 的新增 PID”不等于“本测试 lineage”，仍会被并发真实调用污染。** §2.3-3 目前只有一次 `pgrep` baseline；baseline 后由 LaunchAgent 或另一测试启动的 rod 进程同样属于集合差，无法据此断言它由本测试创建。测试 goroutine 的 panic 若不在该 goroutine 内 recover，也会直接使测试进程失败。**建议：**在 worker goroutine 内安装 `defer recover` 并把 outcome 送回 channel；运行中采样 `pid/ppid/lstart/comm/command`，只记录从当前测试进程派生的 leakless → Chromium 后代（同时保存 exact identity），结束后只等待这些已捕获身份消失。不要把单纯的 baseline set difference 描述为 lineage，也不要观察或清理无法证明归属的进程。

3. **[MEDIUM] browser-owning 定义和 `grep newBrowser()` 审计无法覆盖计划表中的三条间接生命周期。** `PublishContent`/`PublishVideo` 的 public body 分别调用 private `publishContent`/`publishVideo`，`newBrowser()` 在后者；`GetMyProfile` 经 `withBrowserPage` 才创建浏览器。因此“owning = 方法体自己 `newBrowser()`”与 ledger 自相矛盾，直接 grep 也不能证明所有 public entry 都已预算。**建议：**定义改成“对一次 browser lifecycle 负责的最外层 public operation，可直接或经无预算 private helper 创建 browser”；审计从每个 `newBrowser()`/`withBrowserPage` 反向追到 public caller，逐项与 ledger 做双向对应并确保只在最外层包一次。结构性保证也应写成 deadline 触发后“执行/尝试 defer cleanup”，而不是无条件“浏览器死”，因为计划自己已承认 `Close()` 可卡住并由 W2 兜底。

4. **[MEDIUM] `TestSearchWithFilters` 不能通过“一行 build tag”单独移出默认 suite。** Go build constraint 是 file-level；若直接给现有 `xiaohongshu/search_test.go` 加 `//go:build integration`，同文件的 hermetic `TestFilterValidation` 也会从默认 `go test ./...` 消失，造成覆盖缩水。**建议：**把 `TestSearchWithFilters` 移到新的 `search_integration_test.go`（同 package，文件头带 integration tag），原 `search_test.go` 保留 `TestFilterValidation` 等默认测试；验收同时证明默认 suite 不启动 browser，且带 tag 的目标测试仍能被列出/执行。

5. **[MEDIUM] 两处文字合同仍不具备单一实现解释。** `login.go` 行先要求 `:21,39,61,87` 全部补 60s，随后又声明 `:87 WaitForLogin` 不补；实现者按前半句会重新引入 Round 1 回归。48h 判据又要求把 panic 与“对应调用开始时间”配对，但当前 handler start log 没有 invocation ID，`withPanicRecovery` 只记录 tool/panic，并发 search 无法可靠关联。**建议：**把 login 行改成只列 `:21,39,61`，另列 `:87` 保持 bare caller ctx 并加 reason comment；观察判据改用可直接证明的信号（client-observed duration、无 >30min rod 进程、reaper kill receipt），或先增加同一 invocation ID/elapsed 的结构化 start/finish 日志后再要求逐调用配对。

6. **[MEDIUM] rod kill 缺少现有 one-shot 类别已有的 durable audit receipt 合同。** 当前 `handleHeadlessShot` 在确认进程退出后不仅增量计数，还调用 `insertHeadlessShotReapEvent` 写 `chrome_session_reaped`；Round 2 对 rod 只写了 result counter 与 plugin console line。ownerless host process kill 同样是实质 mutation，若没有事件，48h 只能依赖易丢的 console/进程快照，也不完全符合“照 FLY-1828 one-shot 类别”的既有模式。**建议：**计划明确在 confirmed-gone 后写一条 rod 专用 `chrome_session_reaped` event，payload 仅含非敏感 identity/age/reason/mode（不落完整 argv/UDD）；测试钉住 confirmed exit 恰好一条，fresh/raced/survived/unknown 均零条，并用该 receipt 支撑观察收口。

## Verdict

CHANGES REQUESTED — address items above

---

# Design Review — plan.md (Round 3)
Date: 2026-08-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已完整吸收 Round 2 的六项修改，W2 selector/receipt、测试隔离、lineage 追踪和 48h 可观测合同现在都具备实现基础。重新沿 public operation 的资源生命周期审计时，发现 `GetLoginQrcode` 是一个尚未纳入计划的高风险 ownership-handoff 例外：同步 timeout panic 发生时 cleanup defer 还没有注册，因此 W1 仍不能保证产生侧进程归零；另有几处 ledger 与验收表述需要收准后才能批准。

## What's Good (Keep)

- constructor-stall fixture 已改为挂起 `NewFeedsListAction` 实际访问的 `/`，并把 search/no-I/O constructor 与 feeds/publish constructor 的理由分开。
- worker-goroutine 内 recover、进程树 ancestry、`pid/ppid/lstart/comm/command` identity 与“不可归属进程不观察、不清理”的边界正确，消除了全局 `pgrep` 误判。
- browser-owning 已改为最外层 public lifecycle owner，且审计从 `newBrowser()`/`withBrowserPage` 反向追 caller，与完整 ledger 双向核对。
- `TestSearchWithFilters` 移入独立 tagged file、默认文件保留 `TestFilterValidation`，符合 Go 的 file-level build constraint。
- `WaitForLogin` 与 `GetCollectionContent` 的特殊 timeout 语义已经明确保留，不再接受机械替换。
- rod classifier 要求 Chrome-family main、排除 `--type=`、信号前复核 exact identity；不杀 leakless parent 的决策仍与 rod/leakless 源码一致。
- rod kill 在 confirmed-gone 后写非敏感 `chrome_session_reaped` receipt，并为 fresh/raced/survived/sensor-unknown 固定零事件，和现有 headless-shot mutation contract 一致。
- 48h 判据已移除无法实现的 panic/start 配对，改用 process age、rod receipt 与 client-observed duration，收口证据可直接采集。

## Issues & Recommendations

1. **[HIGH] `GetLoginQrcode` 的 cleanup defer 注册太晚；新增 60s panic 会解卡但仍泄漏浏览器。** 当前 `service.go:138-170` 在 `b := newBrowser()`、`page := b.NewPage()` 后只构造 `deferFunc`，直到 `FetchQrcodeImage(ctx)` 正常返回后才在 `err != nil || loggedIn` 分支注册 defer。Round 3 将 `login.go:61` 改成 `Context(ctx).Timeout(60s)`；若 `MustNavigate`/`MustElement` 因 deadline panic，控制流在 `service.go:149` 展开时根本没有已注册的 page/browser cleanup，`withPanicRecovery` 只转换 panic，不会补关进程。`b.NewPage()` 自身 panic 也有同样缺口。**建议：**把 cleanup ownership 在 `newBrowser()` 成功后立即 armed，并显式实现“同步方法持有 → 后台 WaitForLogin goroutine 接管”的单次 handoff（例如 nil-safe cleanup + `sync.Once` + handed-off flag）；panic/error/already-logged-in 由同步 defer 清理，只有成功启动 4min waiter 后才取消同步 ownership，由 goroutine defer 清理。不要改成无条件 `defer b.Close()`，否则返回二维码时会提前关闭扫码 browser、破坏 cookie 保存。增加 integration 用例：`/explore` 永不出现二维码元素，recover 60s panic，并非空捕获且确认该测试的 rod lineage 消失；若抽出 ownership helper，再用轻量单测钉住 handoff 后同步 defer 不关闭、后台 cleanup 恰好执行一次。

2. **[MEDIUM] Post/Reply comment 的 service deadline 当前并不能覆盖 action，ledger 的名称和预算依据也不准确。** public 方法实际名是 `PostCommentToFeed` / `ReplyCommentToFeed`；`comment_feed.go:24-26,83-86` 明确忽略传入 ctx，分别从原始 page 建 60s 和 5min timeout。因此最外层 `context.WithTimeout` 会被传入但完全不参与 browser operation，§2.1“service ctx 覆盖 action 阶段”和表中“action 10min”都不成立；§2.2 的 `Context(ctx)` grep 也发现不了这种“接受但不用 ctx”的例外。**建议：**若本单坚持不改变 comment 的 caller-cancellation 语义，就在 ledger 中用准确函数名、实际 60s/5min 预算标成“action-owned bounded exception”，明确其 future-regression 兜底只有 W2，不属于 W1a 的结构性保证；审计门同时枚举“接收 ctx 但故意不消费”的 action。若确实要求 W1a 覆盖它们，则必须另行设计 ctx threading，并接受/测试取消语义变化，不能把现有 wrapper 当成有效兜底。

3. **[MEDIUM] lineage cleanup 断言仍可能在“一个进程也没捕获”时 vacuous GREEN。** §2.3-3 说明只等待已捕获身份消失，但未要求 capture 集合非空；若 sampler 启动时序或 parser 有误，空集合会立即满足“全部消失”，无法证明真实 Chromium/leakless 被观察和回收。**建议：**worker 启动后轮询到明确上限，硬断言至少捕获一个属于测试 ancestry 且满足 rod main identity 的 Chromium，并捕获其 leakless parent（或对 guard 缺失给出源码支持的显式例外），再允许进入 disappearance gate；保存并复核完整 `pid+lstart+comm+command` identity。新增 QR cleanup 用例也复用同一非空 gate。

4. **[LOW] 两处测试/文字 provenance 仍自相矛盾。** §2.2 前文已正确说明 `NewSearchAction` constructor 无 I/O，但 `search.go` 表格仍写“constructor Timeout 保留（覆盖 constructor 期 I/O）”。另外 constructor timeout 在当前基线本来就存在，因此 constructor-stall 测试是 baseline-GREEN 的 characterization/regression test，不会和 search leak test 一样自然产生“修前 RED”；§2.3/§5 笼统要求两者都有修前 RED 会制造虚假 TDD 证据。**建议：**删除 search 表格中的 I/O claim；明确只有 `TimeoutE2E` 做真实 baseline RED→GREEN，constructor test 记录 baseline GREEN。若要证明后者非 vacuous，可临时 mutation 删除 `NewFeedsListAction` timeout，运行测试得到受外层 watchdog 限制的 RED，再恢复并 GREEN，明确标为 mutation check。

## Verdict

CHANGES REQUESTED — address items above

---

# Design Review — plan.md (Round 4)
Date: 2026-08-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 已关闭 Round 3 的四项问题：QR 同步/后台 ownership、comment action 例外、非空 lineage gate 与 RED/characterization provenance 都已准确进入设计，W1/W2 主体可以按现有架构实现。尚有一个 QR 后台 goroutine 的进程级崩溃风险，以及 integration RED/mutation 证据的隔离与缓存问题；二者会让当前风险声明或验收记录失真，因此本轮仍请求修改。

## What's Good (Keep)

- `GetLoginQrcode` 已明确采用“立即 armed cleanup → 成功返回二维码后单次 handoff → waiter goroutine 最终 cleanup”的 ownership 模型，并禁止会提前关闭扫码 browser 的无条件 `defer b.Close()`。
- nil-safe cleanup 覆盖 `b.NewPage()` panic，`sync.Once` 保证同步与后台路径最多清理一次；QR timeout integration case 能钉住此前“解卡但仍泄漏”的缺口。
- comment ledger 已使用真实 public 签名 `PostCommentToFeed` / `ReplyCommentToFeed`，准确记录 action 自有 60s/5min timeout、service ctx 对浏览器操作无效及 W2-only future backstop。
- action 审计门不再只 grep `Context(ctx)`，还要求逐方法枚举“接收 ctx 但故意不消费”的入口，能覆盖 comment 这类反例。
- lineage gate 现在要求先捕获非空、test-ancestry 下的 rod main 与 leakless parent，再验证 exact identity 消失，不会因空集合假绿。
- `TimeoutE2E`、`QrcodeCleanup` 与 constructor characterization/mutation 的证据类型已经分开，没有再把 baseline-GREEN 冒充 TDD RED。
- W2 的 selector、age fence、exact-process probe、confirmed-gone receipt 与负例矩阵仍然完整；部署与 48h 收口顺序没有新增依赖冲突。

## Issues & Recommendations

1. **[HIGH] handoff 后的 cleanup panic 不在任何 recovery boundary 内，会终止整个 MCP 进程。** `headless_browser.Close()` 在 `headless_browser.go:146-149` 调用 `browser.MustClose()`，计划和风险表也承认它可能 panic。同步路径的 cleanup panic 尚可被 MCP `withPanicRecovery`（`mcp_server.go:139-168`）或 HTTP recovery 接住；但 `service.go:159-170` 的 `WaitForLogin` 是独立 goroutine，handler 已经返回，它的 deferred cleanup panic 不会沿回 handler stack，而是按 Go 语义使整个进程退出。W2 能处理残留 Chromium，却不能避免这次 service-wide interruption；这与当前“Close panic 由 reaper 兜底”的统一表述不符。**建议：**ownership-handoff 合同明确要求后台 goroutine 自带最外层 `defer recover`，注册顺序保证 cleanup defer 先执行、recovery defer 后捕获，并记录 cleanup panic；或让 shared cleanup 内部 panic-safe。panic 被吸收后，未清干净的 Chromium 才交给 W2。若抽 helper，增加 panicking-cleanup 单测，钉住后台路径不向进程顶层传播且 `sync.Once` 仍只执行一次；风险表同步区分“同步 handler recovery”与“后台 goroutine recovery”。

2. **[MEDIUM] 两个自然 RED 不能在同一个 test binary 中作为独立 lineage 证据，mutation GREEN 还可能命中 Go test cache。** lineage 的根是 OS test process，而不是单个 Go test case。修前 `QrcodeCleanup`/`TimeoutE2E` 都会故意留下 browser 直到 test process 退出；若用 §2.3-7 的同一次 `go test -run 'TimeoutE2E|...|QrcodeCleanup'` 收 RED，前一用例的残留也是后一用例的合法 descendant，污染 capture。constructor mutation 又先有 baseline GREEN，恢复源码后若不禁 cache，`go test` 可复用先前成功结果而不真正执行 restored GREEN。**建议：**规定 integration tests 不得 `t.Parallel`；两份 baseline RED 各用独立进程和精确 anchored regex 运行，例如 `go test -count=1 -tags integration -run '^TestTimeoutE2E$' ...` 与 `'^TestQrcodeCleanup$'`；mutation 前后同样加 `-count=1`，并用显式 test/watchdog timeout。最终修后才运行 combined GREEN。把 `-count=1` 写入硬门，避免浏览器 E2E 被缓存结果替代。

3. **[MEDIUM] integration 环境还未隔离源码中实际生效的 `XHS_PROXY`。** `browser.NewBrowser` 会在每次创建时直接读取 `XHS_PROXY` 并把它传给 rod launcher（`browser/browser.go`）；计划只设置/恢复 `XHS_BASE_URL` 和 headless。开发机若配置了代理，localhost `httptest` 流量与 Chromium argv 都会受外部配置影响，破坏“确定性、本测试 lineage”的前提，并可能让 exact command 记录携带代理凭据。**建议：**三个 integration cases 统一 snapshot、清空并 teardown 恢复 `XHS_PROXY`（以及任何测试实际读取的 browser env）；失败日志不要输出完整 Chromium command，只输出脱敏 identity/hash。相应地把测试总耗时说明从当前 `~90s` 改成三个串行 case 的真实上限，并给 combined command 留足显式 timeout。

4. **[LOW] action 表仍有一处与已接受例外相反的旧句。** §2.2 最后一行把 `comment_feed.go / search_pagination.go` 合写成“不动（已有界；基底修好后自动正确）”；comment 已明确不消费 ctx，因此基底修复对它没有作用，只有 pagination 才会随基底修正。**建议：**拆成两行：comment = action-owned bounded exception、与基底无关；pagination = 从修正后的入参 page 派生，自动正确。这样实现者不会重新误读 Round 3 已关闭的边界。

## Verdict

CHANGES REQUESTED — address items above

---

# Design Review — plan.md (Round 5)
Date: 2026-08-25
Author: Codex
Status: APPROVED

## Summary

Round 5 已关闭此前所有 blocker。产生侧 deadline/cleanup ownership、QR 后台 panic containment、action 例外、非空且归属明确的进程断言，以及 reaper exact-kill/receipt 合同现在彼此一致，并能在现有 Go 与 TypeScript 架构中按两个并行 PR 实现；部署和 48h 收口也有明确依赖与可验证证据。

## What's Good (Keep)

- `GetLoginQrcode` 的资源所有权现为完整状态机：`newBrowser()` 后立即 armed、同步异常负责清理、二维码返回后单次 handoff、waiter goroutine 最终清理，且 `sync.Once` 防止重复执行。
- 后台 goroutine 先注册 recovery defer、后注册 cleanup defer，LIFO 顺序保证 cleanup 先运行、panic 后被同 goroutine 吸收；这正确补上了 handler recovery 无法覆盖后台栈的边界。
- `TimeoutE2E` 与 `QrcodeCleanup` 分别在独立 test process 收集自然 RED，constructor 用 baseline-GREEN + mutation check；anchored regex、`-count=1`、禁止 `t.Parallel` 和显式 watchdog/15min timeout 使证据非缓存、非串扰。
- process gate 必须先捕获至少一个 test-ancestry 下的 rod Chromium main 及其 leakless parent，再按完整 exact identity 等待消失；空集合无法通过。
- `PostCommentToFeed` / `ReplyCommentToFeed` 已诚实标为 action-owned bounded exception，实际 60s/5min timeout、service ctx no-op 与 W2-only future backstop 都写清，未扩大 caller-cancellation 语义。
- action 审计同时覆盖 bare `Context(ctx)` 与“接收但不消费 ctx”的方法，service 审计从 browser factory/helper 反向映射 public ledger，能够发现新路径漂移。
- rod reaper classifier 只命中 Chrome-family main，排除 helper/lookalike，信号前复核 `lstart + comm + command`，confirmed-gone 后才计数并写非敏感 durable receipt。
- W3 保留原子 sibling build/rename、即时 rollback、kickstart/new-pid/login probe；观察项区分 root fix 与 reaper backstop，不依赖不存在的 invocation correlation。

## Issues & Recommendations

1. **[LOW, non-blocking] 更新一处旧耗时说明。** §2.3 开头仍写 integration 文件“耗时 ~90s”，而 §2.3-8 已正确按三个串行 case 估算为约 6–8min。实现 PR 顺手统一成后者，避免执行者误判本地 gate 时长；不影响设计批准。

2. **[LOW, implementation note] `COOKIES_PATH` 应指向测试临时文件，而不是仅清空。** `browser.NewBrowser` 会经 cookie loader 读取 `COOKIES_PATH`；Round 5 已要求隔离“任何测试实际读取的 browser env”，实现时应把它 snapshot 后设置到 test-owned temp path，再 teardown 恢复。这样既不读取 Annie 的真实 cookie，也给未来 QR fixture 意外进入 save path 留出安全边界。该要求属于现有环境隔离条款的具体落实，不需要扩 scope。

## Verdict

APPROVED — ready to implement
