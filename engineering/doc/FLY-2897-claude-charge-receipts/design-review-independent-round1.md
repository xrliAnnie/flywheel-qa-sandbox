# FLY-2897 plan.md — Independent Design Review, Round 1

Reviewer: fresh-context Staff/Principal review（只读；已对照 FLY-2897 worktree 代码与 gogcli@a92bd63 源码核实）

## Summary

整体方向对：只读 gog、execFile 无 shell、固定检索式、落盘 schema 装不下正文/主题/发件人、挂在 GatePoller 的 fire-and-forget scheduler、三个触发口共用一个 single-flight。gog 部分的事实（JSON 形状、`--timezone UTC` 优先于 env/config、exit code 4/6/7/10、stderr 无前缀）我逐条核对过，都成立。

问题集中在三处：(1) §5 的优先级把现有的机器取消信号（OAuth profile `subscription_status=canceled`）降成兜底，这是**回归**；(2) 写入/读取两侧有几条会把整个 store 清空或让它被整份拒收的路径，其中一条会变成每 30 分钟一次的读邮箱循环；(3) 隐私的"只读 Anthropic 收据"在实现层面并不严格：邮件正文是在精确过滤**之前**拉进内存的。

## What's Good

- 隐私边界设计：store 里没有任何字段能装主题、发件人、收据号或正文；reason 用正则约束的枚举；日志只有号名和枚举码。`switchRefreshFailureCode` 的正则会拒绝任何带 `@` 的 message，所以失败码这条路径上邮箱不会进日志。
- 诚实原则：最新收据解析失败就判 `parse_failed`，不退回更早的收据去猜；读不到时写明具体原因。
- 周期解析考虑周全：`after 17 Sep 2026` 干扰项、跨年、日历日校验、跨度 1–400 天（年付也覆盖）都有。
- 调度沿用 FLY-2869 模式，不新开 timer；`tick()` 是同步 fire-and-forget，gog 卡住也挡不住 GatePoller tick（plugin.ts:12952-12963）。gog 没有注册 SIGTERM handler（`signal.Notify` 零处命中），所以 execFile 的 kill 确实能杀掉进程。
- 三个触发口共用一个 single-flight，保证同一时间只有一个 writer。这一点很关键：写入用的临时文件名是 `${path}.tmp-${pid}`（account-detail-store.ts:212），两个 writer 并发会互相踩。

## Issues

### 1. BLOCKER — 收据 `ok` 会盖掉机器已确认的取消（回归）
- 证据：account-quota-view.ts:651-665 现在的逻辑是 detail `subscriptionStatus==="canceled"` → 显示「已取消」；plan §5 把它挪到 ③ 兜底，只要有收据读数就走 ②。现有测试 account-quota-view.test.ts:939 和 capacity-route.test.ts:677 都钉着这个行为。
- 影响：只要取消邮件漏掉（进了垃圾箱、主题改版、换了发件人），一个 OAuth 接口已经报 canceled 的号，页面上会显示一个假的「10/16 周五」扣费日。issue 最关心的恰恰是取消这个场景。
- 修复：两个来源合并，而不是二选一。
  - `free` 仍然最先判。
  - `canceled` = 收据判定为 canceled，**或者** detail 为 canceled 且 `detailObservedAt` 晚于最新收据和 resume 邮件的时间。
  - detail 判取消、收据有 periodEnd 时，显示「已取消 · periodEnd 到期」。
  - 两个方向各补一条测试：detail 较新 → 已取消；收据或 resume 较新 → ok。

### 2. SHOULD — claude-accounts.json 一时读不到，就会写出一个空 store
- 证据：`readStoreStrict` 遇到任何解析或校验失败都返回 null（account-store.ts:715-757）。plan §2.3 写的是"targets 每轮现读"，但没说读不到时怎么办。
- 影响：targets 变成 0 → 写出 `accounts: []`，所有号的读数和 `lastGood` 一起丢掉；页面全部退回「收据还没读过」，切号标记变成「切号后尚未读到」。
- 修复：accounts store 为 null 时，本轮以安全码 `accounts_unreadable` reject，不写文件。只有 store 有效时，才允许删除已经不存在的号。

### 3. SHOULD — 写入侧和读取侧的校验不对称，会导致整份被拒 + 每 30 分钟读一次邮箱
- 证据：§2.2 读取时严格校验（reason 必须匹配 `^[a-z0-9_:.-]{1,60}$`，号名要过正则），任何一项不过就整份当作没有；§2.4 规则 A 把"读不了"视为到期。但写入侧会产出读取侧不认的值：
  - Node maxBuffer 错误的 `code` 是字符串 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，被信号杀掉时 `code` 是 null，所以 `exit_<n>` 会变成大写或 `exit_null`；
  - gog 的退出码 5/8/130 没有列举（exit_codes.go:21-29）；
  - accounts.json 的号名只检查了 `typeof string`（account-store.ts:731）。
- 影响：页面一直空白，而且 minRetryMs=30min 下每天约 48 轮、每轮 8 次 gog 调用，永远不会停。
- 修复：
  - 写入和读取共用一个 `validateClaudeChargeStore`，写之前先自检，不过就 throw 安全码，不落盘；
  - reason 走白名单映射：8→`retryable`，130/signal→`timeout`，maxBuffer→`output_too_large`，其余一律 `error`；
  - targets 先过号名正则。

### 4. SHOULD — 非订阅收据会让账号卡在 `parse_failed`
- 证据：额外用量 / 美元预付额度是真实存在的产品面（account-detail-observer.ts:384 的 `prepaid/credits`；FLY-2864 research 称之为"美元预付额度"）；同一个邮箱在 API Console 买 credits 也会收到 Stripe 收据。这些收据的发件人和主题与订阅收据完全一样，但没有本期起止。按 §4.2，这个号会一直 `parse_failed` 到下次续费，最长一个月，而 `lastGood` 只能兜 48h。`--max 4` 在自动充值多次时还可能把订阅收据挤出结果。
- 修复：
  - 只有正文里有 plan 行（例如 `/\b(Pro|Max|Team)\b[^$]{0,40}plan/`）的才算订阅收据；
  - 既没有周期也没有 plan 行的，归为 `non_subscription` 并跳过；
  - 只有"有 plan 行但周期认不出"才判 `parse_failed`；
  - `--max` 提到约 10；
  - 补一条构造的 extra-usage 收据测试。

### 5. SHOULD — From 地址提取有歧义，可能被显示名绕过
- 证据：gog 输出的 `from` 是原始 From 头（gmail_messages.go:214，没有解析）；Gmail 的 `from:` 也会匹配显示名。§2.1 只写了"取出尖括号里的地址"。如果实现成"取第一个 `<…>`"，`"x <invoice+statements@mail.anthropic.com>" <evil@x.com>` 这样的 From 就能通过。
- 修复：
  - 整串锚定解析：`^(?:"[^"]*"|[^"<>]*)\s*<([^<>\s]+)>\s*$`（或者取最后一个 `<…>`，并要求它后面没有任何内容）；
  - 转小写后再做精确比较；
  - 把上面这个用例写进 §6 的伪装测试。

### 6. SHOULD — 隐私最小化：正文在过滤之前就进了内存；事件检索窗口过宽
- 证据：`--include-body` 会对 Gmail 模糊匹配到的**每一封**都执行 `Format("full")`（gmail_messages.go:197）。精确的发件人 + 主题过滤是在这之后才跑的，这和 exploration §4"不读无关邮件"对不上。另外，事件只需要最新收据之后的，但检索式扫了 400 天。
- 修复（调用次数基本不变）：
  - 先做一次只拿元数据的 search（收据 + 事件合并）；
  - 精确过滤后，只对最新周期的 1–2 封收据调用 `gog gmail get <id> --json`（JSON 带 `body`，见 gmail_get.go:88-91）；
  - 事件检索加上 `after:<最新收据 UTC 日期−1d>`。
  - 如果决定不改，就在 §6 明确写出"模糊匹配到的正文会在内存里短暂存在"这一残余风险，并请 Lead 确认。

### 7. SHOULD — 「读于」和切号标记的时间来源与无 `sources` 的行冲突
- 证据：以下几类行没有 `sources`：detail 已取消且用量读不到、operator 标记不可用、快照里没有这个号（account-quota-view.ts:976-986）。`renderReadingTime` 和 `switchMark` 遇到 `sources===undefined` 都直接返回空（page.ts:328, 377-378）。可 §5 写的是"每个 Claude 行（手填格除外）都有读于"。另外，兜底分支 ③ 显示的是 detail 数据，但标记却拿 `charge` 的时间去比。
- 修复：
  - 把收据的 readAt 放在 nextCharge 这个 cell 上（例如新增 `readAt`），「读于」从它取；
  - `sources.charge` 只用于切号标记；
  - 兜底分支 ③ 用 `detail` 作为标记的时间来源。

### 8. SHOULD — 页面路由的测试缝必须保证测试封闭；另有三处测试钉住了现有格式，§7 没有列出
- 证据：
  - 现有的 manual 路径在没有测试缝时会退回 `FLYWHEEL_STATE_DIR` / home 目录（plugin.ts:2123-2131）。如果收据 store 照抄这个写法，capacity-route.test.ts:677（personal1→「已取消」）在开发机上会读到真实文件（personal1=free），变成只在本地失败。
  - capacity-snapshot.test.ts:1983-1985 钉住了旧的兜底文案。
  - switch-refresh-trigger.test.ts:78-80 是对数组元素做精确匹配，日志行追加 `chargeRefresh=` 之后必挂。
- 修复：`accountPageClaudeCharges` 缺省时一律视为 null（与 `accountPageVercel` 同样的写法，plugin.ts:2170），由 startBridge 显式传入默认路径（参照 9671）；§7 把这三个测试文件标为"改"。

### 9. NIT — 调度细节
- 参照 reading-scheduler.ts:159，每轮结束后算好 `nextDueAt`，不要每 3 秒（plugin.ts:12942）读一次文件再校验。
- `generatedAt` 或 `readAt` 比现在晚 60 秒以上时要视为到期，否则一个时钟偏移的文件会让读取永远停掉。
- 新的 `tick()` 放在 `switchRefreshTrigger.tick()` 之后，或者单独包一层 try，防止它抛错把切号触发器跳过。

### 10. NIT — `withCeiling` 只是协作式超时
- 证据：account-quota-refresh.ts:75-86。收据腿现在嵌在 FLY-2830 的切号轮（switch-refresh-trigger.ts:128-147）和 `?refresh=1` 里；只要有一个 promise 永远不 settle（比如并发池写错），之后所有切号轮都会被卡住。
- 修复：排队中的号在开始前检查 `signal.aborted`；`createClaudeChargeRefresh` 内部再加一个硬性的 race 上限。

### 11. NIT — 失败分类
- 「No auth for」改用 `/^No auth for /m` 按行匹配：gog 的 slog WARN 也会写到 stderr（root.go:124-128），可能排在前面。
- 解析 stdout 的 `JSON.parse` 必须包在 try 里：V8 的 SyntaxError 信息会带上输入片段。

### 12. NIT — 解析细节
- 同周期合并改为只按 periodEnd 作 key（升级补差的那张收据 periodStart 可能不同）。
- 同一分钟的两封收据要有确定的 tie-break（取 periodEnd 较晚的）。
- `parseGogDate` 返回 null 的情况（gog 解析不了 Date 头时会原样输出，gmail_date.go:18-21）：这封邮件直接丢弃。
- 把"收据周期是太平洋时间的日历日"的证据写进 plan（personal 那封 09-05 00:06 UTC 的收据写的是 "Sep 4"），因为"不做时区换算 + today 取太平洋日期"这个设计依赖它。

### 13. NIT — 其他
- 号对应的邮箱变了时，要丢弃 `lastGood`（可以存一个 email digest，与 plugin.ts:2144 的 identityKeys 做法一致）。
- 收据「读于」换一个独立的 class，并写成「收据读于」，避免和身份格的 `.reading-time` 断言混在一起（account-quota-page.test.ts:805-809）。
- 每次 Codex 切号也会重读 4 个 Claude 邮箱。这是 issue 的要求，保留；但切号本身不可能改变扣费日，可以请 Lead 决定：nextCharge 格是否干脆不参与切号标记（CODEX_CELL_SOURCE 是 Partial 的先例）。

关于 Q6：`lastGood` + 48h 不算过度设计。FLY-2894 plan §4 本来就是这么建议的，成本只是一个字段加一行显示，而且在每天只读一次的节奏下，它能扛住一次偶发的读失败。免费号检测已经在 plan 里。真正缺的是 #1（detail 取消的合并）和 #2（accounts 读不到时的处理）。

## Verdict

**CHANGES REQUESTED**：需要修 1 个 BLOCKER（#1）和 7 个 SHOULD（#2–#8）；NIT 可以在实现时顺手处理。
