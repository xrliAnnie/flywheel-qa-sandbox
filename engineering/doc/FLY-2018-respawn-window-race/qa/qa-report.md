# FLY-2018 writer_replacement 重生体连环夭折与静默停摆 — QA 验证报告

Issue: FLY-2018 (https://linear.app/geoforge3d/issue/FLY-2018/enginebug-writer-replacement-重生体-spawn-与同名窗清理竞速ensure-heldstatusnull)
日期: 2026-08-24
基于: plan.md (R8, Codex design review 8 轮 APPROVED)

## 0. 结论

**QA PASS。**

被验证的 head: `90375f7057478191d606587e24c1c4f2e1b37dc3`（PR #938,OPEN / 非 draft / MERGEABLE,
开工前与发 verdict 前各 fetch 核对一次）。本报告自身的 docs commit 会把 head 往前推一格,
差异仅为 `engineering/doc/FLY-2018-respawn-window-race/qa/` 下的报告与 harness,零 `packages/` 改动。

四个 Fix 都用**真机**证据验过,不是"单测绿了"：真 Codex daemon（0.149.1)、真 tmux server、
真子进程信号杀、真 SQLite、真 Discord 频道投递。每一条关键结论都配了修前基线或阴性对照。

## 1. 我怎么验的（独立于实现者的证据）

实现者交了 6 个新测试文件 + 一份 daemon preflight。我没有只跑他的测试就签字,
另外自建了 5 个 harness,全部驱动**已构建的 dist**（= 会真正部署的字节),放在
`engineering/doc/FLY-2018-respawn-window-race/qa/`：

| harness | 验什么 | 真的东西 |
|---|---|---|
| `real-ensure-signal-kill-e2e.mjs` | Fix C —— issue 里那条秒死链 | 真 tmux server + 真子进程 + 真 SIGTERM + 真 `has-session` |
| `real-daemon-unauthorized-classification-e2e.mjs` | Fix A —— 真因上抛全链 | 真 `codex app-server` 0.149.1 + 真撤销 token |
| `env-breaker-safety-predicates.mjs` | Fix B —— 断路器"不该跳"的那一半 | 真 StateStore + 真 SQLite |
| `qa-fly-2018-real-discord-alert-e2e.mjs` | 告警真的到人 | 真 Discord POST + 回读 529 隔离频道 |
| `fixd-lead-notification-e2e.mjs` | Fix D —— 退避可见性 | 真 lead_events + 真 comm.db MailboxQueue |
| `real-tmux-kill-forensics.mjs` | Fix C §3.3 —— kill 取证 | 真 tmux 窗口 |

另外我把 merge-base（修前）的 `codex-runner-tui-window.ts` + `TmuxAdapter.ts` 单独 bundle
成 `/tmp/f2018base/prefix-tui-window.mjs`,**同一个 harness、同一批真输入**跑两遍,
拿到真正的 RED → GREEN,而不是"读一眼新代码觉得对"。

## 2. Fix C —— 事故现场的那条链（最重要的一条）

### 修前（merge-base bundle,真 SIGTERM,真 tmux）

```
runner-tui-window: guarded session ensure attempt 1 held (status=null): {"action":"verified","reachablePid":33412}
-> outcome={"created":false,"category":"retryable-hold","reason":"hold_lock_unavailable"}
```

这与 2026-08-24 00:13 生产日志 539287-539311 的形态**逐字一致**：helper 已经报了 `verified`,
外层只看到 `status=null` 就判 held,最终 `tuiFailure(retryable-hold, hold_lock_unavailable)` —— 重生体 4 秒夭折。

### 修后（当前 head,同一 harness、同一输入）

```
runner-tui-window: guarded session ensure attempt 1 succeeded despite exit anomaly
  (signal=SIGTERM, termination=none) — helper reported verified, re-verified
-> outcome.reason=window_id_unproven（已经走过 ensure,卡在我 stub 的建窗桩上,属预期）
```

### 阴性对照（证明它读的是现实,不是 stdout 的一面之词）

| 场景 | 结果 |
|---|---|
| helper 报 verified + 外部 SIGTERM + session **不存在** | 仍然 held（20 次 attempt 全 held) |
| stdout 不可解析 + 外部 SIGTERM | 仍然 held（修前行为原样保留) |

也就是说：新逻辑**只**在"helper 说成功 **且** 真去问了 tmux 且 tmux 说在"时才放行。
`provenance` 三元组（`status` / `signal` / `terminated`)也真的出现在日志里,
以后再看到 `status=null` 能一眼分清"外部信号杀 / 内部超时 / 自己 abort"。

### kill 取证（§3.3,真 tmux)

| 场景 | 修前 | 修后 |
|---|---|---|
| 同名窗已经不在 | `kill returned non-ok (non-fatal)` | `kill skipped — window already gone` |
| 探针问不出来（server 没了） | `non-ok` | `non-ok`（**没有**被降级成"已经不在"） |

## 3. Fix A —— 真因上抛（真 Codex daemon）

用真 `codex app-server` 0.149.1 + 一份**只在临时 CODEX_HOME 里**过期/替换过的 token
（Annie 的 `~/.codex` 全程只读,凭据值不落盘不回显),完整跑生产路径（**没有**打桩 `startTurn`）：

```
goal status        : blocked
lastTurnError.code : unauthorized
failureReason      : goal ended non-complete: blocked — last turn error:
                     Your access token could not be refreshed. Please log out and sign in again. [unauthorized]
failureClass       : environment
failureCode        : codex:unauthorized
```

对照事故当晚：`sessions.last_error` 只有固定文案「goal ended non-complete: blocked」,
真因（凭据被撤销)整整 31 分钟没人看得见。现在它在第一具尸体上就写进账本。

我也独立重跑了实现者的 preflight,协议前提逐条复现：
`turn/completed.params.turn.error.codexErrorInfo === "unauthorized"`、
`turn/start` response 带 `result.turn.id`、`turn/started` **确实早于** response 到达
（pre-response 窗口是真的,不是假想的)。

## 4. Fix B —— 断路器"不该跳"的那一半

实现者的测试证了"该跳时跳"。我补的是**误停风险**那一侧（真 StateStore,13 条断言全过)：

| 场景 | 期望 | 结果 |
|---|---|---|
| 只死了一具（环境类） | 仍然铸替换体探测一次 | ✅ launchOrdinal=2 |
| 非环境类 → 环境类 | 不跳（前一具 code 不同） | ✅ run 保持 active |
| regex 合法但未 review 的 code（`codex:ratelimited`） | 两字段一并丢弃、永不跳 | ✅ |
| 首条 teardown 无分类、后到的有分类 | canonical 冻结不改写、不跳 | ✅（同时打了 loud log) |
| 同 source uid + 漂移的分类 | conflict 拒绝 | ✅ `terminal_signal_conflict` |
| 同 source uid + 逐字相同 | 幂等重放 | ✅ |
| 连续两具同 code | 第 2 具就 held,不烧完 3 次盲换 | ✅ `environment_failure_escalated`,launches 停在 2 |
| 全程无分类 | 旧的盲换配额仍然管事 | ✅ 最终 `retry_limit_exceeded` |
| 环境类 held 后 operator rework | 按 plan §2.2 被拒 | ✅ `run_not_reworkable`（阳性对照：同样的请求形状在 active run 上不会被判 malformed) |

## 5. 告警真的到人（真 Discord,529 隔离房)

这个改动**是 Discord-capable**（新增 severe 告警 + 旧告警正文加真因),所以我按规矩在
529 QA Room 跑了真投递,没有等部署：

- 频道：`#test-flywheel-alerts`（`1519421055805165842`,隔离房,**没碰生产**)
- 真消息 id：`1541358522430918756`,marker `[QA2018-907942]`
- 链路全真：真 StateStore 断路 → 真 outbox → 生产 `WorkflowEngineDispatcher.reconcileWorkflowEngineAlerts()`
  → 生产 `buildInfraAlertRouting` / `LeadAlertNotifier` / `createDiscordOps` → 真 HTTP POST → 回读验证

落地正文（回读自 Discord,不是我拼的)：

> 🚨 **【需人工】FLY-2018 节点 implement 环境类失败(codex:unauthorized),盲换无法治愈**
> FLY-2018 的 implement 节点连续两具执行体以同一环境类失败退出(codex:unauthorized),引擎已停手,
> run 已挂起(held)。最后死因: goal ended non-complete: blocked — last turn error:
> Your access token could not be refreshed. Please log out and sign in again. [unauthorized]。
> 当前恢复入口仅为 terminate 收口;凭据修复后请由外部流程另起 run/attempt。

隔离证明：生产 `~/.flywheel/alerts/queue` 与 `deadletter` 在跑前跑后逐字节一致（两者本机都不存在,
快照 `<absent>` → `<absent>`);claims.db / StateStore 全部走临时目录。

## 6. Fix D —— 退避窗不再像死机

真 lead_events + 真 comm.db MailboxQueue,20 条断言全过。Lead 实际会读到的原文：

```
[Event #1] workflow_replacement_eligibility
Stable Event: workflow-replacement-eligibility:run-1:implement:1:impl-1:1
ID: impl-1 | Issue: FLY-2018
引擎最早于 ~2026-08-24T08:11:02.000Z 重新检查(盲换 0/3);若死亡确认与 current-execution fencing 成立,将执行 铸替换体。
```

- `next_check_at` 实测 = **真 dispatch ledger 行的 created_at + 60 秒**（第一档退避),不是拍脑袋的时间
- 第 2 具环境类死亡时,同一条通知自动改口成「将执行 **环境类收口**」,措辞是条件式的,
  没有谎称"已经断路了"
- 两个 Lead runtime（mailbox / commdb)渲染**逐字相同**
- 崩溃恢复：行已 commit、投递没跑 → projector 扫到 → 第一次 `inserted`、第二次 `active`（安静重复,不刷唤醒）
- **跨部署 renderer 文本漂移**（R1 reviewer 抓到的那条)：不再永久 `mailbox identity conflict`,
  复用首份 durable materialization,Lead 读到的仍是第一版原文
- 非 current execution 的死亡：**零通知**（不会给已经被替换掉的旧体发误导消息)

## 7. 全仓门

| 门 | 结果 |
|---|---|
| `pnpm lint` | 0 error / 7 条既有 warning |
| `pnpm -r build` | 22 workspace 全过 |
| core | 221/221（含真 Terminal.app osascript 2/2） |
| edge-worker | 1292 pass / 5 skip |
| claude-runner | 876 pass / 2 skip |
| flywheel-comm | 1615 pass |
| teamlead | 9496 pass / 4 skip |
| config | 660/661 |
| 其余 14 个 package | 全绿（agent-team-transport 148、gemini-agent 172、voice-bridge 673、voice-core 321 等） |

### 非绿项逐条归因（**没有**伪报 aggregate 全绿）

并发全量跑时确实红过,每一条我都单独隔离复跑并定位到宿主环境,**没有一条落在本分支改动的文件上**：

| 文件 | 并发时现象 | 隔离复跑 | 归因 |
|---|---|---|---|
| `config/repository-baseline.test.ts` | 5s timeout | 4/4 通过 | 固定 5 秒预算 + 宿主负载 |
| `claude-runner/codex-daemon-runtime.test.ts` | 4 failed | 55/55 通过 | **runner pane 的长 TMPDIR（116 bytes > SUN_LEN 103）** |
| `claude-runner/claude-profile.test.ts` | 5 failed | 119/119 通过 | 同上 + 负载 |
| `claude-runner/tmux-slot-routing.real-tmux.test.ts` | 1 failed | 1/1 通过 | 真 tmux server 并发争用 |
| `flywheel-comm/qa-result.realgit.test.ts` | 1 failed | 2/2 通过 | FLY-1686 既有真 git 定时脆弱项 |
| `teamlead` × 5 文件 | timeout | 各自单跑全绿 | 负载 |
| `teamlead/fly1674-opus46-real-tmux.test.ts` | ENOENT | washed env 下 2/2 | **runner pane env 污染（FLY-247 既有类）** |
| `teamlead/fly247-bash-suites.test.ts` | 3 failed | washed env 下 11/11 | 同上 |

`pnpm test:packages:run` 的递归跑在 config 那一个 timeout 上就 `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`
中断了,所以后面的包是我**逐包补跑**的（上表即补跑结果),这一点如实写出来,
不拿"aggregate 跑过了"冒充全覆盖。

## 8. 诚实边界（honest boundary）

1. **生产真机重放没做。** 事故 run `8bfa33b2` 现在 held,恢复动作属 operator/Lead 决策,
   我没有去碰它。我做的是在隔离环境里用**真组件**重放同一形态,不是在生产上复现。
   风险：生产 tmux server 上的并发形态（当晚 `/tmp/tmux-501` 有 52 个测试 socket)我没有复刻;
   何时补：ship 后第一具真 replacement 体出现时,看 Bridge 日志里有没有
   `succeeded despite exit anomaly` 这行即可确认。
2. **`turn/start` response 的 turn id 权威路径,只在"不打桩"的那一次跑里覆盖到。**
   我重跑实现者 preflight 的那一次(monkeypatch 了 `startTurn`)走的是
   `turn/started` 回落分支。两条路径各自被覆盖过一次,但没有同一次跑里同时对照。
   风险低（两条都真机验过);何时补：下一次真 daemon 改动时一起做对照表。
3. **529 房我没有起完整的 Bridge slot。** 我用的是"module-driven 真 Discord"路径
   （真编译函数 + 真 bot token + 真频道 POST/回读),这是 529 房对 render/relay 类改动的
   既定轻量路径。没有覆盖到"隔离 Bridge 进程 + 真 Runner 注入"的完整拓扑。
   风险：alert 路由在完整 Bridge 里还会经过 `AlertChannelHub` 的 threading 层(我这里用 notifier 直接做 rawSink)。
   何时补：如果 Lead 认为 threading 层也要证,可以在 ship 后用 `--alerts` 起一次完整 slot。
4. **`fixd` 的 Lead 通知我验到 comm.db 行为止,没有让真的 Claude Lead 读出来。**
   渲染文本、durable 行、重复安静都验了,但"Lead 看到之后会怎么做"不在本单范围。
5. **Fix D 的 Lead 通知不是 Discord 消息**,它进 Lead 收件箱;真正进 Discord 的是第 5 节那条告警。

## 9. 给 Lead 的 advisory(不阻塞 ship)

1. **`killRunnerTuiWindow` 的取证文案在一种边界下会读错。** 当调用方带了 `windowId`
   而该 id 已经不在、但**同名窗还活着**时,日志打的是
   `kill skipped — window already gone (<windowName>)`。按 id 语义这是对的（那个窗确实没了),
   但这行字面在说"同名窗不存在",而 FLY-2018 恰恰是同名窗竞速的单子。
   真 tmux 实测：`@999999` + 活着的 `FLY-2018-live` → 打出"already gone"。
   **纯日志,不影响任何控制流,活窗没被误杀**,所以我没有据此判 FAIL。
   建议把 windowId 分支的文案改成带 id 的措辞（例如 `window @<id> already gone; a different
   window named <name> is still present`)。
2. **`enqueueLeadEvent` 的 nudge 收窄是全局的,不只作用于新事件类型。**
   现在只有 `outcome === "inserted"` 才 `nudge()`。由于 delivery id 含 event_id、
   新事件必然 inserted,所以正常路径行为不变;受影响的只有"同 event_id 重投"——
   这类重投不再立刻唤醒 Lead,要等 LeadInboxLoop 的周期 tick。**只损失延迟,不丢消息**,
   但这是一处跨所有 lead event 类型的行为收窄,建议 Lead 知悉。
3. **plan §5 列的测试清单没有全部落成committed 测试。** 例如 Fix B 的
   「非 env → env 不熔断 / 跨 attempt 不继承 / 未知 code 不熔断」、Fix D 的
   「两个 Lead loop 不交叉扫描 / offline recipient 不 hot-spin / at-least-once processing」
   在仓库里没有对应的 committed 用例。**这些行为我在本单用 harness 实测过并全部正确**,
   所以不是缺陷;但作为回归保护,它们目前只活在我的 QA harness 里,没有进 CI。
   建议 Lead 决定要不要把 `env-breaker-safety-predicates.mjs` 的 13 条转成 vitest 用例。
4. **auth 轴自愈仍未做**（plan 明确列为非目标)。断路器能止血,但凭据修复还是人工。
   FLY-513 相邻,建议另立 issue。

## 10. 复现命令

```bash
pnpm -r build
node engineering/doc/FLY-2018-respawn-window-race/qa/real-ensure-signal-kill-e2e.mjs
FLY2018_TUI_MODULE=/tmp/f2018base/prefix-tui-window.mjs \
  node engineering/doc/FLY-2018-respawn-window-race/qa/real-ensure-signal-kill-e2e.mjs   # 修前基线
TMPDIR=/tmp/short node engineering/doc/FLY-2018-respawn-window-race/qa/real-daemon-unauthorized-classification-e2e.mjs
TMPDIR=/tmp/short node engineering/doc/FLY-2018-respawn-window-race/qa/env-breaker-safety-predicates.mjs
TMPDIR=/tmp/short node engineering/doc/FLY-2018-respawn-window-race/qa/fixd-lead-notification-e2e.mjs
node engineering/doc/FLY-2018-respawn-window-race/qa/real-tmux-kill-forensics.mjs
set -a; . ~/.flywheel/.env; set +a
TMPDIR=/tmp/short node engineering/doc/FLY-2018-respawn-window-race/qa/qa-fly-2018-real-discord-alert-e2e.mjs
```

> 注：`TMPDIR` 必须短。runner pane 默认的 TMPDIR 有 116 bytes,会撞 AF_UNIX `sun_path` 103 上限,
> 让真 daemon / 真 tmux 类 harness 出现与代码无关的假失败(第 7 节归因表里就是这一条)。

## 11. Ship 前置：分支与当前 main 有一处 CLAUDE.md 冲突（不是本次改动的缺陷）

发 verdict 前复核 PR #938 时,`mergeable` 从 `MERGEABLE` 变成 `CONFLICTING`。归因如下,
**不是我这次提交造成的**：

- 我的 QA 提交 `443376a22` 是**纯新增**,11 个文件全部在
  `engineering/doc/FLY-2018-respawn-window-race/qa/` 下,零 `packages/` 改动。
- 拿**我提交之前**的 head `90375f705` 对当前 `origin/main`（`533adc64f`)做 `git merge-tree`,
  **同样只有一个冲突,同样是 `CLAUDE.md`** —— 即冲突在我动手前就已经存在,
  成因是 `origin/main` 在这期间前进了,双方都往里程碑表尾部追加了行。
- 冲突面只有 `CLAUDE.md` 一个文件,没有任何代码文件冲突。

处理建议(属实现者/Lead 的动作,不在 QA 授权内,我没有碰)：把当前 main 合/rebase 进来、
保留双方的里程碑行即可。**注意**：这会推出新的 head,本次 PASS 绑定的 gate-entry head
（`443376a22e30dbb37e379142c85b68901145b82e`)随之失效,需要按流程在新 head 上重新走 QA verdict。
