# FLY-1439 插件收据核销 producer 独立真机验收 — 探索
Issue: FLY-1439 (https://linear.app/geoforge3d/issue/FLY-1439/qafly-1437-独立真机验收-插件收据核销-producerfork-pr-17-bb0a1509)
日期: 2026-07-23
基于: 无(上游合同 = FLY-1437 plan.md/code-review.md + FLY-1426 plan.md/qa-report.md,均在各自分支/文件夹)

## 1. 这单是什么

FLY-1437(插件端 chat 收据 producer,fork PR #17)的**独立真机验收**。FLY-1437 自己的流水线被引擎缺陷(FLY-1434)卡死,正规 QA 节点派不出来,founder 拍板按旧式「QA 独立单 + 独立 runner」绕障补 QA。本单的 verdict 是 FLY-1437 ship 门的前置。

**被测物(钉死)**:fork `xrliAnnie/claude-plugins-official` PR #17,head `bb0a1509`("fix(discord): make settle proof write-ahead durable")。8 文件 +2406/−37。codex xhigh code review 2 轮 APPROVED(R1 唯一 HIGH = settle 凭证非 write-ahead,bb0a1509 修掉)。head 变更 = verdict 作废重测。

**本单性质**:能力级真机验收,不是读代码。代码审查已由 codex 完成;本单要证的是「真环境里这条链真的转」。

## 2. 被测系统速写

```mermaid
sequenceDiagram
    participant D as 真 Discord 消息
    participant P as fork 插件 (slot Lead 的 MCP 子进程)
    participant SP as spool (DISCORD_STATE_DIR/chat-receipt-spool)
    participant C as flywheel-comm CLI (PR-1, 已 merge)
    participant DB as slot comm.db lead_inbox
    participant L as slot Lead 模型
    participant PT as slot Bridge patrol

    D->>P: messageCreate (gate 放行)
    P->>C: begin (≤5s, 失败→SP fail-open)
    C->>DB: pending 行 chat:<lead>:<msgId>
    P->>L: mcp.notification (meta.receipt_id)
    P->>C: complete
    C->>DB: delivered (开追办窗)
    L->>P: reply 工具 (显式 reply_to)
    P->>SP: settle intent 落盘 (write-ahead, R1 HIGH 修复点)
    P->>C: settle
    C->>DB: processed (证据 discord_explicit_reply)
    PT->>DB: 逾期才 advanceDue 重发; processed 行零重发
```

三条腿:begin(pending)/ complete(delivered)/ settle(processed);spool 崩溃恢复(begin intent + settle intent 两个域);幂等重放;companion/stock 零行为。

## 3. 验收五条的拆解

| # | issue 验收 | 真机形态 |
|---|---|---|
| 1 | 全周期 + patrol 零重发(1437 plan §7.3) | 隔离房真消息 pending→delivered→processed;等 ≥2 个窗口周期断言零 resend child;**必须配阳性对照**(另一条不 settle 的消息在同一 patrol 下真的重发)——否则「零重发」可能只是 patrol 没在跑 |
| 2 | 崩溃恢复 + R1 write-ahead 真机复现 | begin 崩溃窗(spool intent→重放幂等)+ settle in-flight 崩溃窗(intent 先于 CLI 存在→kill→重启→重放幂等,即 codex R1 的 probe 搬到真机) |
| 3 | 记账失败不拦消息 | 注入 CLI 故障 → Discord 投递照常 + spool 落盘 + advisory 可见 |
| 4 | companion/stock 零行为 | companion 形态 Lead 收消息 → 零收据行、零告警、消息照常;stock 靠 fork 测试套 byte-compat 断言的独立复核 |
| 5 | 172 测试口径复核 | 独立重跑复现 172/411 + 审计测试真打真实字节(警惕 FLY-1435 式「显式 null 冒充省略字段」空过绿)+ 少量定向 mutation 探针 |

## 4. 三个硬问题(本次探索的核心产出)

### 4.1 怎么让 slot Lead 加载 fork PR #17 而不碰生产

审计事实:
- 生产插件装在 `~/.claude/plugins/`(cache + marketplace 双目录),`update-discord-plugin.sh` 只跟 fork **main** 同步;
- `scripts/test-deploy.sh:1113` 对 slot Lead **强制 `env -u CLAUDE_CONFIG_DIR`** → slot Lead 默认吃生产插件缓存(房间历史上就是这么依赖的,`test-deploy.sh:539-544` 还断言生产缓存形态);
- PR #17 未 merge,不在 fork main 上。

| 选项 | 判定 |
|---|---|
| A. 临时把生产 marketplace 换成 PR #17 | **拒绝**。生产 Lead 在窗口内重启就会吃到未 merge 代码;launcher 的 fork 完整性检查还可能中途把它刷回 main。「换个名字≠隔离」的教训直接适用 |
| B. 绕开 test-deploy 自己手启 Lead(--no-lead + 复刻 env 块) | 可行但要复刻 ~80 行脆弱启动逻辑(dev-channels 提示、lease 等待…),重复实现即漂移风险 |
| **C. test-deploy 加 default-off env 钩子(选定)** | 在 FLY-1439 分支给 `test-deploy.sh` 加一行受 `TEST_LEAD_CLAUDE_CONFIG_DIR` 门控的 `LEAD_EXTRA_ENV+=("CLAUDE_CONFIG_DIR=…")`(`env(1)` 后写胜出,盖掉前面的 `-u`)。不设 = 字节兼容。隔离配置目录里装 fork@bb0a1509(镜像 update 脚本的 rsync 结构),生产零接触。这也是 FLY-529 alert env 钩子的同款先例 |

**待验假设 A1**:`CLAUDE_CONFIG_DIR` 确实把插件根一起搬走(`--channels plugin:discord@claude-plugins-official` 从隔离目录解析)。计划里立 G0 冒烟门:启动后 `ps eww` 抓 MCP server 进程的脚本路径,必须落在隔离目录且该目录 `git rev-parse HEAD` = bb0a1509 —— 在终点取证,不信配置。

### 4.2 崩溃窗怎么打得确定(不靠 kill 时序赌运气)

审计事实:`claude-lead.sh:476` **无条件覆写** `FLYWHEEL_COMM_CLI` 为「启动它的 checkout」的 `packages/flywheel-comm/dist/index.js`;插件在进程启动时快照这个路径。

→ **shim 方案**:Lead 用「专用 QA worktree」启动(与 Bridge 部署 checkout 同 SHA 的另一个 worktree),把它的 `flywheel-comm/dist/index.js` 换成 ~40 行 shim:默认透明转发真 CLI(argv/stdin/exit code 全镜像)+ **记录每次调用**(时间戳/子命令/参数 → 调用账本,直接当断言证据);旗标文件切换故障模式(`fail-begin` / `hang-complete` / `hang-settle`)。三个崩溃窗全部确定性:

- begin 窗:`fail-begin` → 投递照走 + spool intent → 恢复 → drain 补账幂等;
- notify→complete 窗:`hang-complete` → 行停 pending → kill Lead session → 重启 → `[redelivery]` 重投 → delivered;
- settle write-ahead 窗(R1 HIGH):`hang-settle` → Lead 真回复 → **CLI in-flight 时断言 settle intent 已在盘上(0600)** → kill -9 → 重启 → drainSettlePass 重放 → processed + intent 删除 + 幂等。这就是 codex R1 的 `WHILE_SETTLE_CLI_IN_FLIGHT_INTENT` probe 的真机版。

Bridge 不受影响(Bridge 走库 import,不走 CLI 入口;且 shim 只在 Lead 专用 worktree)。

### 4.3 founder P0 打不打得到

审计事实:fork `server.ts:92-93` **硬编码** `readFileSync(~/.flywheel/.env)` live 解析 `DISCORD_OWNER_USER_ID`,文件优先于 env(FLY-827 教训的合同形态,QA 注入口只存在于单测参数)。真机上 founder id 恒 = Annie 的真 Discord id → 测试 driver bot 的消息恒为 **P1**。

判定:**接受 P1 主线**。P0/P1 只差 priority 字段与窗口选择,producer 三条腿完全同路;收窄 `FLYWHEEL_RECEIPT_WINDOW_P1_MIN=2` 即可等价驱动 patrol 断言。P1 attribution 本身(非 founder 作者 → priority=1)反而是被验行为之一。P0 真机腿标注诚实边界:仅当 Annie 顺手发一条真消息时补录,非阻塞。

## 5. 范围划界(诚实边界草案)

**做**:验收五条(§3)+ 环境自证(G0/阳性对照)。
**不做**:
- 重发耗尽 → founder page 升级链(FLY-1426 QA 已真机 PASS,Part B 真 Discord 证据在案);
- DM / roundtable msgKind 的真机变体(单测已覆盖;真机走 guild chat 主线);
- codex code review 重跑(独立门已过,verdict 不重复消费——队规);
- 生产环境任何变更(插件缓存/生产 comm.db/生产 .env 全部只读)。

## 6. 边界与纪律(从 issue 与队规继承)

- **执行隔离**:实施本单 QA 的 runner 不得是 `3870740d`(FLY-1437 接管评审者)或任何写过 FLY-1437 代码的会话;
- head 钉死 bb0a1509:QA 开跑前与 verdict 落笔前各核一次 fork 分支 head(`git fetch` 后比对),漂了作废重测;
- 隔离 Bridge 硬规则:`FLYWHEEL_DELIVERY_SECRET_PATH` 必设(生产 delivery secret 被清事故的队规)+ 短 `TMPDIR`;
- verdict + 证据落本单文件夹(qa-report.md),由 Lead 转录回 FLY-1437 thread;FLY-1437 ship 门等本单。

## 7. 结论方向

529 房单 slot(Bridge + 真 slot Lead)+ 隔离 CLAUDE_CONFIG_DIR 装 fork@bb0a1509 + Lead 专用 worktree 的 CLI shim 做确定性故障注入 + slot comm.db/spool/Discord API/调用账本四路取证。研究阶段把全部 env 通路与断言点落到 file:line,计划阶段给出 implement 节点可照抄的场景步骤。
