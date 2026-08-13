# FLY-1730 Discord 插件 chat-receipt 配套断代 — 独立 QA 报告

Issue: FLY-1730 (https://linear.app/geoforge3d/issue/FLY-1730/bug配套断代-discord-插件仍调用已拆除的-chat-receipt-cli-每条-founder-消息结算永败内部告警直喷)
日期: 2026-08-12
基于: plan.md

> **时态标注约定**(Tadashi 2026-08-12 指令 b8576e03):每条结论标 `[生产现状]`(此刻 main / 生产载体上就在跑)、`[本分支]`(只在本 PR 分支)、`[合并后]`(合入并部署后才成立)。

## 0. 判定

**PASS** —— 判定绑定两个 head:

| 交付物 | head | 说明 |
|---|---|---|
| 主仓 PR #817 | `b06ce21b` | checker dual marker + 测试 + docs(= `00ea4ef3` 的代码 + 本报告一个纯文档 commit;`git diff 00ea4ef3..b06ce21b -- packages/ scripts/` 为空) |
| 插件 fork PR #23 | `a3117e1c` | 收据面拆除 + 告警面净删(行为主体) |

PASS 的范围:**合入 + 部署后**,founder 频道不再出现 `⚠️ Chat receipt settlement recovery has failed N times…`,且入站/回复链路无回归。PASS **不覆盖**部署本身(§6 诚实边界)。

## 1. 事故链复现 —— 先证明「病还在」

### 1.1 `[生产现状]` 断代此刻真实存在

不读代码默认值,直接读**生产插件缓存字节** `~/.claude/plugins/cache/flywheel-plugins/discord/0.0.4/`(只读):

| 探针 | 结果 |
|---|---|
| `server.ts` 里 `chatReceiptRuntime.settle` 调用点 | 1 |
| `server.ts` 里 `channel.send({content: \`⚠️ …\`})` 告警闭包 | 1 |
| `chat-receipt-runtime.ts` 里 `'chat-receipt'` CLI 动词 | 1 |
| `chat-receipt-runtime.ts` 里告警原文 `Chat receipt settlement recovery has failed` | 1 |

它调用的那条 CLI(生产 `flywheel-comm` dist,构建于今天 10:13 / `4f246f52`):

```
$ node …/flywheel-comm/dist/index.js chat-receipt settle
Unknown command: chat-receipt          exit=1
$ node …/flywheel-comm/dist/index.js chat-ingest --version-probe --json
{"command":"chat-ingest","protocolVersion":1,"ok":true}   exit=0
```

⇒ `[生产现状]` 断代成立:生产插件调的动词在生产 CLI 上已经不存在,`chat-ingest` 那条活着。

### 1.2 全称词的反例(按指令 b8576e03 第 2 条自查)

issue 原文的「每条 founder 消息结算永败」需要收窄:**只有回复真正带上 reply 引用时**才走到 settle —— 生产 `server.ts:1248-1252` 的门是 `!receiptSettled && reply_to && sentMessageCarriesReference(sent, reply_to)`。**反例**:Lead 不带 `reply_to` 直接发言,不触发 settle,不产 intent。
准确说法:**每条被「带真实 reply 引用的回复」回过的 founder 消息**,都会产生一次必败 settle。

## 2. 真机 A/B —— 同一条真 Discord 链路,只换插件字节

两侧都是**真进程**:真 `server.ts`(不是模块桩)、真 bot token、真频道、真 gateway、真 REST、真 `flywheel-comm` CLI。差异只有插件字节。

| | 旧字节(fork main `49c8c47` = 生产 0.0.4) | 候选字节(fork PR#23 `a3117e1`) |
|---|---|---|
| bot / 频道 | `flywheel-test-3` / `#ops-lead-test` | `product-lead-test` / `#product-lead-test` |
| founder 真消息入站 | ✅ `inserted_inbox` | ✅ `inserted_inbox` ×2 |
| 带 `reply_to` 的真回复 | ✅ 送达 | ✅ 送达 ×5 |
| 落盘 settle intent | **有** `chat-receipt-spool/settle/1537229138317021184.json` | **无**,`settle/` 目录从未被创建 |
| 插件 stderr | `settle failed for 1537229138317021184: Unknown command: chat-receipt`<br>`pending scan failed: Unknown command: chat-receipt` | 零 `settle` / 零 `chat-receipt`(grep 计数 0) |
| 频道内部告警 | **真发出来了**(见下) | **零** |

**旧字节在真 Discord 里发出的告警原文**(22:45:45Z,`#ops-lead-test`):

```
⚠️ Chat receipt settlement recovery has failed 6 times for message 1537229138317021184.
```

与 Annie 11:09 亲撞的那条**逐字同形**(同措辞、同次数 6、只是 message id 不同)。intent 落盘状态 `attempts: 7, advisedAt: 2026-08-12T22:45:46.071Z`。
⇒ 我的探针不是空的,它真的能抓到这个症状。

**候选字节的静止窗**:22:44:45Z → 22:59:45Z,15 分钟,`#product-lead-test` 零 `⚠️`、spool 零新文件、stderr 零 settle 痕迹(§4)。

## 3. 模块级差分 —— 同一条真 CLI,老/新 runtime 对照

`scratchpad/qa-fly1730-differential.ts`:两个 runtime 都用**真实部署的 flywheel-comm CLI**(只注入时钟/定时器,避免退避等 30 分钟;spawn 路径是 runtime 自己导出的 `runCommand`,argv 只做旁路记录)。

```
OLD: settle_returned=false
     cli_verbs_spawned=["chat-receipt"]
     settle_intents_on_disk=["1537154904257204294.json"]     ← issue 里那条真 message id
     channel_advisories_sent=[{chatId:"…", text:"Chat receipt settlement recovery has failed 6 times for message 1537154904257204294."}]

NEW: accept_inbound_lane="mailbox"
     cli_verbs_spawned=["chat-ingest"]         ← 真跑通,lane=inserted_inbox
     ingest_intents_left=[]
     settle_dir_created=false
     channel_advisories_sent=[]                ← 我故意往 options 里塞了 advise 间谍,它一次没响
     runtime_has_settle_method=false
     runtime_has_adviseBroken_method=false
```

## 4. 静止窗与残留

- 候选 state dir 结构:只有 `chat-receipt-spool/ingest/`(空),**没有** `settle/`。
- `chat-receipt` 字符串在候选源码里只剩 spool 目录名常量(`join(stateDir,'chat-receipt-spool')`)—— 与 plan §2.2 D4 允许的唯一位置一致。
- `advisedAt` 字段保留(stall 日志一次性闩),与 plan D1 显式保留项一致,不是残留。
- 告警面:候选 runtime **没有** `AdviseFn` 类型 / `advise` option / `adviseWithMarker` / `adviseBroken`;`server.ts` 里那个唯一发 `⚠️` 的 `channel.send` 闭包已删。`fetchAllowedChannel` 保留(还有 5 个正常调用点),符合 plan D2「仅当 advise 是唯一调用者才删」。

## 5. 自动化门(我自己重跑的,不是转述)

| 门 | 结果 |
|---|---|
| 插件 fork `bun test` @ `a3117e1` | **178 pass / 0 fail**(9 文件,407 断言)。PR body 写 177 是上一 commit 的旧数,当前 head 是 178 |
| 主仓 `discord-plugin-ops.test.sh` | **24 passed / 0 failed**,含新增三态:pointer checker 收旧 marker / 收新 marker / 两者皆缺则拒 |
| 主仓 `discord-plugin-cutover.test.sh` | **23 passed / 0 failed** |
| FLY-1645 残留门(主仓) | passed(1421 files) |
| FLY-1645 残留门(跨仓,候选插件) | passed(1421 main + 17 plugin) |
| **残留门阳性对照** | 同一把尺子对**旧字节**跑 → **FAIL**,15 条命中(`reconcilePendingPass` / `receipt_id` / `handle-receipt` / `FLYWHEEL_MAILBOX_DISCORD` …)。⇒ 这道门不是空过绿 |
| 插件 fork PR #23 CI | `test` pass |
| 主仓 PR #817 CI | 9/9 全绿(Quick Gate / Script Tests / Unit×5 / NPM / CI OK) |

我**没有**在本机跑全量 vitest 套件:主仓本次 diff 是 3 个 shell 文件 + 文档,`git diff origin/main...HEAD -- packages/` 为空,而本机跑全量套件会把生产 Bridge 压垮(既有教训)。无沙箱全量结论以 PR #817 的 CI 为准,上表已列。

## 6. 部署顺序 —— 这是最容易出事的地方

`[生产现状]` 生产已安装的 checker `~/.flywheel/bin/check-discord-plugin.sh:77` 逐字要求 `ChatReceiptRuntime`:

```
for marker in 'allowBots' '[reply-guard]' 'ChatReceiptRuntime'; do
```

`[本分支]` 候选插件 `server.ts` 里 `ChatReceiptRuntime` 命中数 = **0**(`ChatIngestRuntime` = 2)。

⇒ `[合并后]` 如果先切插件缓存、后装 checker,`restart-services.sh` 的 `check_discord_plugin_fork()` 会返回 2,`:970-976` 在任何 build/service 变更**之前** `exit 1` —— 整波 Lead 重启被拦住(fail-closed,不会坏,但会卡住)。

**必须的顺序**(plan §4 Phase A→B,我这里只是把它证实了):
1. 先合主仓 #817 → 从 deployed checkout 显式跑 `scripts/install-discord-plugin-ops.sh` → `grep ChatIngestRuntime ~/.flywheel/bin/check-discord-plugin.sh` 确认收敛;
2. 再合插件 #23 → 走 managed updater 切缓存 + 重启载体。

Phase A 对现网**零风险**:我拿**本分支的新 checker** 对**活着的生产 0.0.4 缓存**做了只读实测 —— `OK: discord@flywheel-plugins matches fork main (49c8c478…) with all critical markers`,exit 0;老 checker 对同一份缓存同样 exit 0。新旧 checker 对现状同判,所以 checker 可以先行落地。

## 7. 诚实边界(honest boundary)

1. **没测生产部署本身**。plan §5 的 A1–A5 是**部署后**验收(切缓存 + 重启载体 + 15 分钟生产观察窗),那是 ship 节点的事。我测的是「同样的字节在真 Discord 上的行为」,不是「生产切换过程」。**风险**:managed updater 切缓存失败 / 版本号撞号 / 重启波被 checker 拦住 —— 前两者由 updater 自身 fail-closed 兜,第三者由 §6 顺序兜。**何时补上**:ship 节点按 runbook 执行,并做生产侧 15 分钟观察窗。
2. **版本号 0.0.5 需要 merge 前 JIT 复核**。fork main 当前是 0.0.4,PR #23 取 0.0.5;但 fork 还有 6 个 open PR(#19/#20/#21/#22 等)。若 #21 抢先落并占了 0.0.5,#23 必须顺延 0.0.6 —— 同版本号改写会让 CLI 判「already latest」而不更新缓存。**这条我只能提醒,不能替 merge 时刻做**。
3. **没用 529 房的 Lead 形态跑**。两次 `test-deploy.sh` 都卡在与本单无关的宿主问题(隔离 CLAUDE_CONFIG_DIR 缺登录/onboarding 态;我 runner 的超长 `TMPDIR` 撑爆 unix socket 上限打死 Bridge)。我改用**更贴题**的形态:直接把候选 `server.ts` 当真进程跑,接真 bot / 真频道 / 真 CLI。**少掉的那一层**是「Claude Lead 读到插件的 MCP instructions 后的自然行为」;补偿是我手工驱动了 MCP `reply` 工具(同一个 tool,同一条码路)。**风险**:低 —— 本单删的是 settle 与告警面,不是 Lead 的判断面;但 `deliveryInboundInstruction()` 从「带 receipt_id 必须显式 reply_to」改回 stock 文案,**Lead 的回复习惯是否改变**没有被真 Lead 行为验证过。**何时补上**:部署后生产观察窗自然覆盖(Lead 每天都在回 founder)。
4. **`FLYWHEEL_MAILBOX_DISCORD=0` 的运行时回切,在候选插件里没有了**(`readMailboxFlag` 已拔)。这是 FLY-1645 的既定终局(主仓 `feature-flags/truth.ts:286` 已把它登记为 retired),不是本单新引入的偏差 —— 但意味着**二级回滚只能靠回 0.0.4**,而回 0.0.4 前必须确认生产 `.env` 里 `FLYWHEEL_MAILBOX_DISCORD=1` 还在(我实测:**还在**)。所以 plan §4 Phase C「A1–A5 全过之前不许删这个 flag」是硬约束,别提前解锁。
5. **旧字节的告警我是催出来的**。为了在一分钟内看到 ⚠️,我用 6 次真 `reply_to` 把 attempts 顶过阈值,而不是等它自然重试 20 分钟。这不改变机制,但**「多久会响」这个量我没测**。

## 8. 我踩的坑(留给下一个人)

- `test-deploy.sh` 起 slot 前先 `export TMPDIR=/tmp/<短名>`。runner 默认 TMPDIR 太长 → tsx 的 IPC unix socket 路径超 `sun_path` 上限 → `EINVAL` → Bridge 起来就死。
- teardown 的 cmux lease 交接默认 60s 不够(生产 watcher 一轮扫描 > 60s),`FLYWHEEL_QA_TEARDOWN_LEASE_WAIT_S=300` 即可,**不要**去动生产 watcher。
- 部署中途失败后**必须**显式 `test-teardown.sh <slot>` 再重来:失败路径只释放锁不清 session-id,残留 session-id 会让下一次 `--resume` 确定性崩溃 → launchd 每 3 秒重拉一次的死循环,而 `lead.log` 里只有一行 `Starting …`。
- 隔离 `CLAUDE_CONFIG_DIR` 要能跑起 Lead,除了凭据还要 `~/.claude.json`(onboarding 态);否则 Claude Code 停在主题选择向导上,外面只看得到「Lead did not become ready」。
- Discord 网页版合成输入:同一个 tab 连发第二条常常吞字符。发送前 zoom 一眼输入框再回车。

## 9. 证据清单

| 证据 | 位置 |
|---|---|
| 真机 A/B 频道记录 | Discord `#product-lead-test`(候选,零告警)/ `#ops-lead-test`(旧字节,⚠️ 原文) |
| 候选插件 stderr | scratchpad `new-plugin.log` / `new-harness.out` |
| 旧字节 stderr + settle intent | scratchpad `old-plugin.log` / `old-harness.out` / `/tmp/fly1730-live/old-state/chat-receipt-spool/settle/*.json` |
| 模块级差分 harness | scratchpad `qa-fly1730-differential.ts` |
| 真机 live harness | scratchpad `qa-fly1730-live.mjs` |
