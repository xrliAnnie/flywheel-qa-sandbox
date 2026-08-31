# FLY-2104 周扫描裁决通知 — 独立 QA 报告（QA Runner）
Issue: FLY-2104 (https://linear.app/geoforge3d/issue/FLY-2104/flage扫描-周扫描裁决页改发-discordflywheel-notification不再建-linear-单)
日期: 2026-08-28
基于: plan.md（实施方自评报告见同目录 qa-report.md，本文件是独立复核，不引用其结论作证据）

## 0. 被测版本

| 项 | 值 |
| --- | --- |
| 分支 | `flywheel-FLY-2104` |
| 本地 HEAD | `c45ff5c7e6fc38f2a5fd2e9f649cad489c210664` |
| `git ls-remote origin` HEAD | `c45ff5c7e6fc38f2a5fd2e9f649cad489c210664`（已推送，本地=远端） |
| 实测用 dist 编译自 | `49f6ec40a`。`git diff --stat 49f6ec40a..HEAD` 只有 `progress.md` + `milestones/FLY-2104.md` 两个文档文件 ⇒ **dist 与 HEAD 代码等价** |
| 对照基线 | `origin/main` = `a8cf9e3bfc1559f82e76d2fbafc58bfd3c45aae5` |

## 1. 结论

**PASS。**

三条验收里，1（手动触发路由）和 3（消费 `value_last_changed`）在真 Bridge + 真 store 上判别性验证通过；
2（结果发 Discord）的**全链路机制**在隔离房用真 Discord API + 真 Vercel 托管页 + 真浏览器验证通过，
随后又在真正的 `#flywheel-notification` 完成真投递与逐字独立回读（见 §5）。

## 2. 验收逐条

| 验收项 | 证据 | 判定 |
| --- | --- | --- |
| 手动触发 `POST /api/flag-scan/run` 200 + 真跑一轮 | §3 RED/GREEN 对照 | **PASS** |
| 周日 08:00 PT 定时路径不受影响 | §3.3 | **PASS** |
| 一次真实扫描结果出现在 Discord（浅色页 + 批注框 + 一键复制经真浏览器验证） | §4 全链路实测；§5 生产频道真投递 + 逐字独立回读 | **PASS** |
| 0 候选发一行「本周 0 候选」 | §4.1 真 Discord 读回 | **PASS** |
| Linear 不再出现 `flag 周扫描 · N 个候选` 单 | §3.4 | **PASS** |
| 消费 `value_last_changed`（含 NULL / no_clock 语义） | §3.5 判别性实测 | **PASS** |

## 3. 手动触发路由 —— 真 Bridge RED/GREEN 对照

方法：按 `reference_529_env_pin_disables_fleet_console` 的隔离 HOME 配方，各起一台**真 Bridge**
（`HOME=/private/tmp/fly2104qa`、独立端口、独立 DB、`FLYWHEEL_DELIVERY_SECRET_PATH` 指向隔离目录、
先 unset 整个 `FLYWHEEL_*/TEAMLEAD_*/DISCORD_*/VERCEL_*` 命名空间）。生产 Bridge（9876）全程未被触碰。

### 3.1 RED —— `origin/main` (`a8cf9e3bf`)，端口 19881

```
POST /api/flag-scan/run  (Bearer 正确)  → HTTP 404  {"error":"not found"}
POST /api/does-not-exist (Bearer 正确)  → HTTP 404  {"error":"not found"}
```

两者**逐字相同**：main 上这条路由注册在 `startBridge` 第 7601 行，而兜底 404 在 `createBridgeApp`
第 4238 行 —— 同一个 `app`，注册在兜底之后 ⇒ 永远匹配不到。缺陷属实。

### 3.2 GREEN —— 分支代码，端口 19876

```
POST /api/flag-scan/run  (Bearer 正确)  → HTTP 200  {"status":"pending","runId":1}
POST /api/does-not-exist (Bearer 正确)  → HTTP 404  {"error":"not found"}   ← 对照组：兜底 404 在同一 app 里确实活着
```

第二行是**判别性对照**：它证明这次 200 不是因为兜底被拿掉了。分支上路由在 4254 行、兜底在 4287 行。

「真跑一轮」的证据（隔离 DB `teamlead-19876.db`）：

```
flag_scan_runs : run_id=1 run_token=2026-08-28-e86d296051ae5e6f status=committed candidate_count=0
flag_scan_state: 38 行（alert_system / loop_profiler / cmux_view_helper / doc_flow …）真实注册表采样
flag_scan_run_legs: discord 腿已认领并进入投递（当时隔离环境无 Discord 身份 ⇒ fail-closed 为 ambiguous）
```

### 3.3 fail-closed 与定时路径

真 Bridge 上逐条实测（端口 19882）：

```
无 token            → 401
错 token            → 401
Host: evil.example  → 403 {"error":"loopback host required"}
{"dryRun":"yes"}    → 400 {"error":"body must be {dryRun?: boolean}"}
{"nope":1}          → 400 {"error":"body must be {dryRun?: boolean}"}
```

定时路径：`latestFlagScanSlotAtOrBefore()` / `flagScanIsDue()`（周日 08:00 America/Los_Angeles）
在本分支 **逐字未改**，只是被挪进 `singleFlightEntry("scheduled", …)`。`plugin.ts` 的定时接线无 diff。
语义核对：手动 force 落在工作日不会吃掉本周的周日槽（`committedAt(周五) < slot(周日08:00)` ⇒ 仍 due）；
只有周日 08:00 之后的 force 会去重掉当周槽，那是正确的去重不是缺陷。

行为变化（值得 Lead 知道，不是缺陷）：手动入口从 `recoverPending()` 改成 `runNow()` ——
旧写法即使可达也只会「续跑 pending」，新写法才真的强跑一轮，这正是验收要的。

### 3.4 Linear 腿

`flag-retirement-production.ts` / `flag-retirement-scan.ts` 全文对 `Linear` 零命中（main 上有 8 处）。
新 run 的 `owedLegs()` 只会产出 `lead_notify`(有债时) + `discord`；历史 run 上遗留的 `linear` / `report`
腿由 `settleRetiredFlagScanLeg()` 直接落 `degraded`，**不触发任何外部动作**。
⇒ 不会再产生 `flag 周扫描 · N 个候选` 的 Linear 单。

### 3.5 消费 `value_last_changed` —— 判别性实测

在隔离 Bridge 的真 store 里对三个 flag 做时钟改写（`flag_values.value_last_changed` +
`flag_value_changelog.MIN(changed_at)`），三者的**登记时间都是 60 天前**，只有 `value_last_changed` 不同：

| flag | first_registered | value_last_changed | 预期 | 实测 |
| --- | --- | --- | --- | --- |
| `alert_system` | 60 天前 | **NULL** | 候选，稳定 60 天（NULL ⇒ 按首次登记算） | 候选，页面显示 **60 天** ✅ |
| `loop_profiler` | 60 天前 | 30 天前 | 候选，稳定 **30** 天（不是 60） | 候选，页面显示 **30 天** ✅ |
| `shipped_husk_force` | 60 天前 | 2 天前 | **不入选**（2 天 < 7 天阈值） | 未出现在候选里 ✅ |

第二、三行是判别点：如果实现只读「首次登记」而不读 `value_last_changed`，
`loop_profiler` 会显示 60 天、`shipped_husk_force` 会被误判成候选。两者都没发生。
真 Bridge dry-run 返回 `candidateCount: 2`。

`no_clock` 侧：`clockReadiness` 非 `ready` 时才回落到「两次相同采样」的 streak 起点，
且 `streakSamples < 2` 时返回 `sampling`（不产候选、不产 Lead 债务）；
`listFlagValueClocks` 逐 flag 读取，单个 flag 的审计损坏只把该 flag 降级为 `no_clock:degraded`，
不会拖垮整轮（`enrichFlagViewsWithStore` 的 per-flag try/catch 实证）。

## 4. 真 Discord 投递 —— 隔离房全链路实测

被测发件身份是**真的** Claude Infra Bot（`/users/@me` 实测 id `1524829037825101975`，用户名 `claw-infra-bot`）。
探测发现该 bot 在本 guild 里只能访问两个频道：`#claude-infra-bot`（1524885436848410705）与
`#flywheel-notification`（1521630422918758472）；四个 `*-test` 频道对它一律 403。
因此隔离实测选 `#claude-infra-bot` 作替身频道（§5 解释为什么不选生产频道）。
access.json 用的是隔离 HOME 下我自己写的一份，**founder 的 `~/.claude/channels/discord-flywheel-eng-lead/access.json` 全程零写入**（sha 前后一致）。

### 4.1 0 候选路径（真 API 读回为准）

```
postDiscord -> {"status":"done", preflightSucceeded:true, rootMessageId:"1542775532477878352"}
Discord GET 读回 -> author=claw-infra-bot
  content = 🤖[自动] 本周 0 候选 · `flywheel:flag-governance run=qa-zero-mtcjk87h`
```
一行、不建 thread、不建 handoff —— 与设计一致。

### 4.2 候选路径（走完整生产 Bridge，不是 harness）

隔离 Bridge（分支代码）上一次真 `POST /api/flag-scan/run`，2 个候选，腿证据：

```
preflightSucceeded : true
reportUrl          : https://fw-reports-1d9445.vercel.app/r/7df79bedc95b146a4e54f146f094fa5a/
rootMessageId      : 1542777368538517584
threadId           : 1542777368538517584
handoffMessageId   : 1542777372825096194
inboxDeliveryId    : infra_alert:flywheel-eng-lead:flag_scan_handoff:2026-08-28-b793c0d951ffee6f
```

Discord API 读回（ground truth，不是发送端自述）：

```
root   : claw-infra-bot | 🤖[自动] 📊 **flag 周扫描 · 2 个候选
         `flywheel:flag-governance run=2026-08-28-b793c0d951ffee6f`** · flywheel
         https://fw-reports-1d9445.vercel.app/r/7df79bedc95b146a4e54f146f094fa5a/
thread : name="flag 周扫描 · 2026-08-28" parent=1524885436848410705 archived=false
in-thread: claw-infra-bot | 🤖[自动] <@1516207680836866219> Annie 会在这里问/定 flag；请在本 thread
           解释并把裁决写回 verdict + preflight. `flywheel:flag-governance handoff run=…`
托管页 : HTTP 200, 6624 bytes
```

这条链路经过的是**分支自己的** reports 路由（隔离 Bridge 由本分支 dist 启动），
所以 `resolveDiscordBotToken`（每次投递重解析发件身份）也在这次实测里跑到了。

腿最终 `status=ambiguous` 是**正确的 fail-closed**：隔离环境没有活的 Lead 去 ACK handoff 邮件，
`handoff.done=false` ⇒ 不落 `done`，等 Lead 签收。不是投递失败。

### 4.3 真浏览器验证（Claude-in-Chrome，preflight 三连先跑过）

打开的是上面那个**真托管页**，不是本地文件：

- 浅色页：`document.documentElement` 的 `color-scheme` 实测 `light`；全文 `prefers-color-scheme` 命中 **0**；截图确认 Apple 浅色（#f5f5f7 底、白卡）。
- 批注框：两张候选卡各有「裁决」下拉 + 「一句理由 / 备注」textarea。真键盘输入 `QA-2104 keep: alert routing still gated` 后，`localStorage` 落键
  `flag-governance:/r/<reportId>/:alert_system = {"verdict":"留","reason":"QA-2104 keep: alert routing still gated"}`
  —— 键按**报告路径**分域，不会串到别的报告。
- 一键复制：真鼠标点「复制全部」，状态位显示 **「已复制，请贴到本报告的 Discord 结果 thread」**（成功态，非 `copy-fail` 类），fallback textarea 保持 `display:none` ⇒ `navigator.clipboard.writeText` 真成功。
- 刷新后重开，两张卡的裁决与备注**原样恢复**。

截图：`/Users/xiaorongli/.flywheel/runner-state/5b4aeb50-2778-4d9b-b63c-bb09d9083237/browser-tmp/claude-chrome-screenshots-WC6GeH/screenshot-1787897246625-0.jpg`

收尾：只删了我自己写的那两个 localStorage 键（**没有**整域清空），关掉自建 tab，
并删除了本次在 `#claude-infra-bot` 产生的全部 QA 消息（DELETE 204 ×3，复扫频道零残留）。

## 5. 生产频道送达补验（已完成）

隔离验证之后，真正的 `#flywheel-notification` 已完成一次真投递；root message id 为
`1542781506152439860`。QA 又从 Discord 独立读回该消息并做逐字核对，内容与发送证据一致，
因此此前「没有发进 `#flywheel-notification`」的声明已经失效，生产频道验收现记为 **PASS**。

但这次真投递通过 QA harness 注入的**内存 access fixture**，绕过了生产 `access.json` 前置；
它证明投递与回读链路可用，不代表生产 access 已授权。生产 `access.json` 仍缺
`groups["1521630422918758472"]`；若不补，周日扫描会 fail-closed、零投递。
`allowBots` 已包含实际发件 bot `1524829037825101975`，更正结论不变：**只差 groups**。
ship 前 founder 仍需在 `#flywheel-notification` 走一次 `/discord:access`。

这条 QA 送达验证消息按 Lead 要求继续留在频道作为证据，等 FLY-2104 ship 后再删除。

## 6. 回归

| 命令 | 结果 |
| --- | --- |
| 变更聚焦 7 个文件（route-mount / scan / production / store-runtime / StateStore ×2 / reports-route） | **121/121 PASS** |
| `pnpm --filter flywheel-config test:run` | **680/680 PASS**（44 文件） |
| `pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__` | **3019/3022 PASS**（1 skip，2 失败见 §6.1） |

### 6.1 teamlead bridge 套件的 2 个失败 —— 与本单无关，且是负载型抖动

第一遍跑出 6 个失败，其中 4 个是 **harness 自伤**：runner 的 `TMPDIR` 落在
`~/.flywheel/runner-state/<exec-id>/browser-tmp/…`，unix socket 路径超过 `sun_path` 104 字节上限，
报 `EINVAL listen … lead-inbox.sock`。换成短 `TMPDIR=/private/tmp/f2104t` 复跑，这 4 个全绿。

剩余 2 个（`Test Files 2 failed | 233 passed`）：

| 用例 | 全套并发耗时 | 单独复跑 |
| --- | --- | --- |
| `worktree-quarantine.test.ts > submodule state change → fail retained` | 6497ms ❌ | **2177ms ✅** |
| `terminal-thread-archive.test.ts > M9 scheduler — >24h old items drop to low-frequency retries…` | 5310ms ❌ | **2580ms ✅** |

两个文件都**不在** FLY-2104 的 22 文件 diff 里，二者与 flag 扫描 / 路由 / Discord 投递无任何调用关系；
单独复跑耗时腰斩且全绿 ⇒ 高负载下的超时抖动，不是本分支引入的回归。
（当时机器上并行跑着另外几个 runner，我自己的探针也因同样负载出现过一次 6s curl 假超时。）

## 7. 生产零污染证明

| 判据 | 开跑前 | 收尾后 |
| --- | --- | --- |
| `~/.flywheel/.env` sha256 | `f5881097…dcd4fb` | **相同** |
| `~/.flywheel/projects.json` sha256 | `a76b08b0…f177c401` | **相同** |
| `~/.flywheel/` 条目数 | 225 | **225** |
| founder 的 `discord-flywheel-eng-lead/access.json` | 未写入 | 未写入（`ea2c047b…271559`） |
| 生产 Bridge (9876) | `ok:true` sha `a8cf9e3bf` | `ok:true` sha `a8cf9e3bf`，uptime 连续未重启 |

我起的两台隔离 Bridge 全部按**精确 PID** 停掉（未用任何按进程名的批量杀法），生产那台 PID 1693 全程未动。

## 8. 诚实边界（补验与没测的部分）

1. **生产频道已补验，但 access 用了内存 fixture**（§5）：root `1542781506152439860`
   已真投递并由 QA 逐字独立回读；生产 `access.json` 仍缺对应 groups 授权，
   该消息保留到 ship 后再删。
2. **没有跑 529 房的 N-to-N**（两台真 Lead + Bridge）。本单的 Discord 面是 send / render / thread，
   不含 Runner↔Lead↔founder 中继、不含 roundtable、不含跨 Lead 协同，按角色合同走了
   module-driven 真 Discord harness 这条轻路。**代价**：Tadashi 真人收到 handoff 邮件后
   在 thread 里回复的那一段没有真 Lead 演过一遍。
3. **handoff 邮件的 ACK 语义**在隔离房用桩（`inspectLeadInbox` 恒 ACKED / 真 Bridge 侧无活 Lead）。
   真实 Lead 签收后腿从 `ambiguous` 转 `done` 的那一跳**未实测**。
4. **`reconcileDiscord` 的翻页/去重**（>100 条消息、跨页找 marker）未造压力样本。
5. 候选是我**改写 store 时钟**造出来的，不是自然积累的 7 天。改写只动 `flag_values` /
   `flag_value_changelog` 两张表的时间列，没有改被测代码。
6. `runNow()` 在有 pending run 且未 stall 时走 `processPending` 而不是强跑新一轮 —— 
   实测撞到过（返回 `{"status":"pending"}`），行为合理但**没有单独针对它出用例**。

## 9. 未复核别人的结论

实施方自评报告里「整包 725 文件 / 9658 测试」「17 个 workspace package 全 PASS」等数字我**没有复跑**，
本报告不引用它们作证据。我自己跑到的范围逐条列在 §6。
