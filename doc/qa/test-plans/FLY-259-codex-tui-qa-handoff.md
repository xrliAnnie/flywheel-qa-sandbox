# QA Handoff: FLY-259 ③ Codex Lead 真交互终端 — daemon-WS runtime

**Issue**: FLY-259(Codex Lead cmux 真终端 — Codex Lead 与 Claude Lead 全对等,founder 可随时直接打字)
**Version**: v1.44.0
**Date**: 2026-06-12
**交付者**: worker-fly-242(实现方)
**接收者**: qa-fly-259(独立验证方)
**Plan**: `doc/engineer/plan/new/v1.44.0-FLY-259-codex-lead-real-terminal.md`
**PR stack**: #254(PR-B daemon-WS core)← #255(PR-C tui-window)← **PR-D(本次,runtime 装配 + 真机 bring-up)**

---

## 0. 这是什么 / 为什么要 QA

Annie 选了 ③ **全交互终端**:cmux 里那块 pane 是 codex 进程亲自画的真 TUI(不是渲染的状态视图),Codex Lead 与 Claude Lead 全对等 —— 能看到它真实干活,founder 能随时直接打字。Discord 同时还通(同一个脑)。

架构核心(SP-4 发现,**改变了原方案**):一个共享的 `codex remote-control` daemon 跑在 unix socket 上,说 WebSocket 包裹的 JSON-RPC(与 FLY-224 的 CodexLeadProcess 协议字节同构)。机器侧 WS 客户端 + TUI **共享同一个 thread**;机器发起的 turn 在 TUI 里**实时渲染**;串行化在 daemon 里完成(彻底化解了 PTY TOCTOU 问题)。

**为什么要独立 QA**:这是 founder 直接交互的活线前身,且 Discord 腿尚未过 QA。实现方(我)不自证 —— 尤其 **founder-terminal observe** 那条,必须独立验。

---

## 1. 红线(QA 全程必须守)

- **绝不碰生产 Mufasa 活线**:生产 Mufasa PID(查 `pgrep -f codex-mufasa`,本交付时 10739)、`~/.codex-mufasa`、生产 `#mufasa` 频道、生产 Mufasa bot token —— **一律零接触**。
- QA 用**隔离环境**:`CODEX_HOME=~/.codex-242`(business 账号,与生产 Mufasa 的 `~/.codex-mufasa` 物理隔离)+ 独立 lead-id + 独立 state dir + **测试 slot Discord 腿**(测试 bot + 测试频道)。
- **不切活 Mufasa**:真正的生产切换(PR-F cutover)= ship,gated on Annie 明确批准。QA 只在隔离沙箱验证,不动生产拓扑。
- Annie 的 live demo 窗(`growth-mufasa-tui-annie`,用 slot-2 `#product-lead-test`)**别动** —— QA 跑场景请用**另一个 slot**(建议 slot-3 `#ops-lead-test` / `TEST_BOT_TOKEN_3`)+ 另一个 lead-id,避免撞 Annie 的实时测试。

---

## 2. 环境搭建(QA 跑场景前)

> ⚠️ **致命隐患修正(worker-fly-242,2026-06-12)**:本节早期版本写 `CODEX_HOME=~/.codex-242` —— **那是 Annie 的 ③ 活窗共享的 home**!daemon socket 是 **per-home** 的,S1(daemon kill→重建)会**杀掉 Annie 的共享 daemon**,直接弄断她正在测的 ③。**QA 必须用独立 home `~/.codex-259-qa`**(独立 daemon socket + 非 business 的 school 账号)。我已建好这个 home 并真机验证隔离(qa daemon socket 独立、Annie 的 daemon + window 9 零影响)。

**直接用现成的隔离 launcher(我建好 + 验过)**:`/tmp/fly259-launch-qa-slot3.sh`
- 独立 home `~/.codex-259-qa`(school 账号,共享只读 standalone binary,独立 daemon socket)
- slot-3 `#ops-lead-test`(flywheel-test-3,token `TEST_BOT_TOKEN_3`)—— **非** Annie 的 slot-2、**非**生产
- lead-id `mufasa-tui-qa` → 独立 state dir + 独立 tmux 窗 `growth-mufasa-tui-qa`(window 10,不撞 Annie 的 window 9)

等价 env(launcher 已封装,列出供理解):

```bash
export FLYWHEEL_CODEX_LEAD_MODE=tui
export FLYWHEEL_CODEX_TUI_CWD=/Users/xiaorongli/Dev/growth
export CODEX_HOME=$HOME/.codex-259-qa                                   # ISOLATED — 不是 Annie 的 ~/.codex-242
export FLYWHEEL_CODEX_BIN="$CODEX_HOME/packages/standalone/current/codex"  # 必须 standalone,npm codex 无 daemon 后端
export FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES="/Users/xiaorongli/Dev/growth/.lead/mufasa-lead/identity.md,<repo>/packages/teamlead/lead-rules-base/companion-safety-contract.md"
export DISCORD_BOT_TOKEN="$TEST_BOT_TOKEN_3"            # slot-3,~/.flywheel/.env
export FLYWHEEL_LEAD_BOT_USER_ID=1493075160025272452    # flywheel-test-3 (ops-lead-test)
export FLYWHEEL_LEAD_CHAT_CHANNEL_ID=1493080995862413439 # #ops-lead-test
/bin/bash <repo>/packages/teamlead/scripts/codex-lead.sh mufasa-tui-qa /Users/xiaorongli/Dev/growth growth
```

**红线(QA 跑 S1 daemon-kill 等破坏性场景必守)**:只 kill `~/.codex-259-qa` 下的 daemon(socket `~/.codex-259-qa/app-server-control/...`)。**绝不 kill `~/.codex-242` 下的任何 daemon/进程**(那是 Annie 的活线)。kill daemon 前先确认 socket 路径属于 qa home。

QA slot 清单见 `~/.flywheel/test-slots.json`(4 个测试 bot + 频道;**全非生产**)。Annie 的活窗用 slot-2 `#product-lead-test`(`/tmp/fly259-launch-annie-discord.sh`)—— QA **别碰那个**。

**daemon-WS 关键事实(真机已验,QA 复现时注意)**:
1. `ws` 库**必须** `perMessageDeflate: false` —— daemon 对扩展 offer 直接挂断("socket hang up")。已固化在 `daemon-ws.ts`。
2. daemon 需 **standalone 安装**(`$CODEX_HOME/packages/standalone/current/codex`),npm codex 无 daemon 后端。
3. **rollout-at-first-turn**:daemon 只在一个 thread 的**第一个 turn** 才落 rollout 文件 → 无 turn 的 thread 不能被 TUI resume("no rollout found" -32600),被 evict 后不可恢复。runtime 用 **bootstrap turn**(建窗前先跑一个有界的自检 turn)+ **turnless self-heal**(saved thread-id 撞这个错就开新 thread)兜住。

---

## 3. QA 场景清单(逐条必跑 + 留证据)

> 通则:每条留**前后证据**(log / capture-pane / journal.db 行 / cursor 文件 / ps)。技术对 ≠ 产品对 —— 还要问"Annie 实际用这条会不会顺"。

### S1. daemon kill → 重建(supervisor generation-fenced rebuild)
- **做**:实例跑起来后,`kill` 掉 daemon 进程(`codex remote-control` 那个,**不是** runtime node)。
- **期望**:`DaemonConnectionSupervisor` 检测连接丢失 → generation 围栏(fence → 立即 stopGateway → 单条 rebuild loop → teardown-before-ensure → gateway LAST,R5 HIGH-2)→ ensure-daemon 重起 daemon → WS 重连 → 同 thread 恢复 → TUI 窗自愈。**无重复 gateway、无 turn 串台**。
- **证据**:runtime log 的 rebuild 序列;TUI 窗恢复后仍是同 thread;backoff 只在存活 `stableAfterMs` 后才 reset。
- **对抗点**:连续 kill 两次(rebuild 进行中再 kill)→ 验 `pendingLossGenerationId` / `stopIfRaced()` 不会起两个 generation。

### S2. TUI kill → 重建(ensureTuiWindow 无条件 stale-kill)
- **做**:`tmux kill-window` 杀掉 `<project>-<lead>` TUI 窗,但 runtime node 还活。
- **期望**:下一次 ensure(连接重建 / health recovery 触发)→ `ensureTuiWindow` **无条件 stale-kill** 旧窗 + 重建,attach 回**同一个机器拥有的 thread**(founder 端 resume same thread)。
- **证据**:窗重现 + `isTuiWindowAlive` identity-echo 探针通过(`#{window_name} #{pane_dead}`)。
- **注意**:identity-echo 探针 —— 窗不存在会静默 resolve 到 current window,别被骗(已在 PR-C 处理,QA 验它真生效)。

### S3. founder 打字分流(TurnDemux:founder turn vs 机器 turn)
- **做**:在 TUI 窗里**手动打字**发一个 turn(模拟 founder);同时/前后让机器侧也发 turn(Discord 来一条)。
- **期望**:
  - founder 打的 turn → 事件**永不到达 executor facade** → 只在 `onFounderTurnCompleted` 记一次 observation;
  - 机器侧 turn → `claimTurn` 认领 → early deltas replay → completion 投递 → turn 释放(late straggler 被 tombstone 丢弃)。
  - **二者不串台**。
- **证据**:journal.db 里 founder turn 是 `founder-terminal` source 的 **completed** 行(且**绝不**进 `listUnfinished`);机器 turn 正常完成。
- **对抗点**:notification-before-response(early delta 在 claim 前到)→ 验 pending-dispatch hold/claim/replay(R5 HIGH-1);overflow(>256 held)→ `claimTurn` 返 false → 走 ambiguous 路径(R2 MED-3 poisoned claim)。

### S4. founder-terminal observe(**实现方不自证 —— 这条独立验最重要**)
- **做**:founder 在 TUI 连发几个 turn,夹杂机器 turn。
- **期望**:`LeadJournal.recordObservation()` 给**每个** founder turn completion 插一行 `source="founder-terminal"` state=`completed` 的 TERMINAL 行;这些行**永远不出现在** `listUnfinished()`(否则 health probe 会把它当未完成活儿误判)。
- **证据**:直接查 `journal.db` 的 `observations`/对应表;`idempotencyKey = founder:<turnId>`(重复事件不重复插 → 幂等)。
- **为什么独立验**:这是 founder 直接交互的可观测性根基,实现方自测有盲区。

### S5. Bridge 出站 exactly-once(切 bridge 模式)
- **做**:用 `FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge` + `FLYWHEEL_BRIDGE_URL` + `FLYWHEEL_API_TOKEN` 起一个隔离实例(**指向测试 Bridge,不碰生产**),让它发出站消息;制造重试/重复投递。
- **期望**:`CodexOutboundSender` 经 outbox db(`config.outboxDbPath`)去重 → 同一条 outbound **恰好一次**到 Discord(HIGH-5:生产 exactly-once 必须 Bridge sender)。
- **证据**:outbox db 行 + Discord 频道实际只出现一条。
- **注**:Annie 的 live 腿是 **direct** 模式(无 Bridge),这条要 QA 单独搭 bridge 模式验。

### S6. turnless self-heal + bootstrap(rollout-at-first-turn)
- **做**:(a)删掉 state dir 里的 `thread-id` 让它开新 thread → 验 bootstrap turn 在建窗前跑、rollout 落地;(b)手造一个 saved thread-id 指向无 rollout 的 thread → 验撞 "no rollout found" 时**只**对这个错开 fresh thread(其它 resume 错必须 rethrow,记忆丢失不能静默)。
- **期望**:两种情形 TUI 窗都能起来 + 对话连续;非 turnless 的真 resume 错误**不被吞**。
- **证据**:log 的 "bootstrap turn completed (rollout persisted)" / "saved thread has no persisted rollout (turnless) — starting a fresh thread";rollout 文件出现。

### S7. Discord 腿 round-trip(Annie 正在 live 测的这条)
- **做**:在测试频道(QA 用 #ops-lead-test;Annie 用 #product-lead-test)发消息。
- **期望**:入站 REST 轮询(`after=<cursor>`,首启 baseline 到最新**不回放历史**)→ 路由进 executor → 机器 turn → 出站(direct 自己 bot token 直发)→ Discord 回复 + **TUI 窗同步可见**(同一对话)。
- **证据**:`inbound-cursor.json` 推进;Discord 收到回复;TUI 窗显示同一 turn。
- **已知未过 QA**:Discord 腿是新接的,撞坑正常 —— 记进 finding 列表。

### S8. persona 注入(thread-params baseInstructions)
- **做**:起实例后问 TUI "你是谁"。
- **期望**:回 Mufasa 人格(温暖陪练腔,非工程腔)—— persona 经 `FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES` → `readBaseInstructions` → thread params `baseInstructions` 注入(FLY-224 原机制经 daemon 生效)。
- **证据**:回复语气;(我交付时已自验:"你是谁呀?"→「…我是 Mufasa。大概就是陪你聊聊、偶尔会戳穿你糊弄的那个朋友。」)

### S9. chat-only 守卫(write-capable 拒启动)
- **做**:用 `FLYWHEEL_CODEX_LEAD_SANDBOX=workspace-write`(或 danger-full-access)起 TUI runtime。
- **期望**:**拒绝启动**并报错(`sandbox=... is write-capable — the ③ TUI Lead is chat-only until FLY-245. Refusing to start.`)。HIGH-1 移植:能写代码的 TUI Lead 在自己 shell 能绕过 Bridge 闸,故 fail-close 到 FLY-245 founder action path 就位。
- **证据**:启动即抛错,无 runtime 起来。

### S10. cwd polish(**已知缺陷,记录非阻塞**)
- **现象**:TUI 窗内显示的 directory 是 daemon 的 cwd(本交付为 `~/Dev/flywheel/worktrees/fly-259`),**不是** `FLYWHEEL_CODEX_TUI_CWD`(`-C` 值)—— 因为 `codex resume --remote` 保留 session 的 cwd。
- **期望**:QA 确认这只是显示问题(不影响功能/对话/persona),记成 polish follow-up,不阻塞 ship。

---

## 4. Review-pinned 契约(QA 抽查是否真守)

| 契约 | 位置 | 验法 |
|------|------|------|
| R4 HIGH-1 frame/line 转换 | `WsTransport.ts` | 出站 line-buffer→frames,入站 frames+"\n";一帧一 JSON ↔ 换行分隔 |
| R5 HIGH-2 generation fencing | `DaemonConnectionSupervisor.ts` | S1 场景 |
| R5 HIGH-1 pending-dispatch | `TurnDemux.ts` / `wireDemuxedProcess` | S3 notification-before-response |
| R2 MED-3 poisoned claim | `TurnDemux.ts` | S3 overflow → claimTurn false |
| R4 HIGH-4 multi-pin | `tui-window.ts buildTuiCommand` + thread params + config.toml | TUI 起来后 read-only + `approval_policy="never"` 生效(CLI flags `-s read-only -c 'approval_policy="never"'`) |
| HIGH-5 production exactly-once | `CodexOutboundSender` | S5 |
| chat-only contract | `main()` 守卫 | S9 |

---

## 5. 交付时已自验(实现方,**不算 QA 通过**)

- 测试全绿:shell 18/0,vitest codex 套件 266/266(含 tui-runtime glue 6/6)。
- 真机 bring-up:productized launcher 全链(launcher→home 校验→daemon→WS→thread self-heal+bootstrap→TUI 窗活着+可见 bootstrap exchange→sidecar+gateway+supervisor up),隔离 home、零生产接触。
- persona 注入真机验(S8 上面那句)。
- Discord 测试腿接线实证:`inbound-cursor.json` baseline 到 #product-lead-test、direct 出站、同 thread 复用。

**这些都是实现方自测,QA 必须独立重跑 S1–S10 并留独立证据。** 尤其 S4 founder-terminal observe。

---

## 6. QA 验完报什么

- 每条 S1–S10:PASS / FAIL + 证据路径。
- 撞到的 bug(Discord 腿大概率有)→ 列 finding,我修。
- 最终 verdict:全 PASS 才报 team-lead → 才谈 PR-F cutover(再 gated on Annie ship 批准)。
