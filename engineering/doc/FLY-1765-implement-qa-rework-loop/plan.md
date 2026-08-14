# FLY-1765 implement↔QA 返工环修复 — 实施计划

Issue: FLY-1765 (https://linear.app/geoforge3d/issue/FLY-1765/implementqa-返工环断裂qa-fail-后原-implement-体已-completed-不可复活state-not)
日期: 2026-08-14
基于: research.md

## 0. 一句话

FLY-1655 之后 implement 节点体完工即被投影成 `completed` 终态,QA-FAIL 返工的 wake 闸(FLY-939 只唤停驻体)从此 100% 拒绝 —— 本计划两层修:**Fix 1 恢复账面停驻**(implement 类节点体完工投 `ship_parked` 直到 run 终结,wake 闸零改动),**Fix 2 终态残局降级受控重生**(不再首跳 needs_lead 挂死,把 Lead 手工救援机制化)。不加新 flag,不开终态复活边。

## 1. 目标 / 非目标

**目标**
- QA FAIL 后返工自动送回原 implement 体,无人工介入,run 不 held/needs_lead(体活着的一切情形)。
- 体不可用(被清/crash/部署窗遗留终态)时自动 `replacement`(FLY-1718 reconcile 续接分支/PR),同样不挂死。
- QA 一把过路径回归不破(阴性对照)。

**非目标**
- 不给 FSM 开 `completed→running` 复活边(终态免疫不变量族 FLY-1228/1731/1462-revert 保持)。
- 不改 codex daemon 运行时(除非活体演练证实 §6 风险 R1,才启用该 contingency)。
- 不批量复活 8-10 以来的存量挂死 run(个别 active 的按 1759 救援序列或等 Fix 2 自然接住)。
- 不动 FLY-1612 的告警 episode 形态、不动 runner_ship legacy 兼容路径(字节不变)。

## 2. Fix 1 — 账面停驻:engine-handoff 的 creates_pr 节点体完工投 `ship_parked`

### 2.1 投影改动(唯一状态写点)

`packages/teamlead/src/StateStore.ts` `projectGeneralizedCompletionTx`(`:26556-26640`):

```
projectedStatus =
  route === "no_code"                          → "completed"                          (不变)
  runner_ship carrier(gateAuthority.mode==="runner_ship" && carrier===node)
                                               → awaiting_review | ship_parked        (不变,legacy 字节兼容)
  【新】run.engine_owned===1 && run.gate_carrier_epoch===1
      && gateAuthority.mode==="engine_terminal"
      && node.capabilities.creates_pr === true → "ship_parked"
                                                 + park_opened(reason: "rework_reachable_wait")
  else                                         → "completed"                          (design/qa 等不变)
```

- park 台账沿用 `appendWorkflowEngineParkEventTx`(FLY-1448 durable park authority),新 reason 值 `rework_reachable_wait`,activation 级绑定与现 `runner_ship_gate_wait` 同形。
- 不写 `applyTerminalTimestamp`(非终态);`completion_disposition` receipt 照旧 `engine_gate_handoff`(不改 FLY-1731 语义 —— disposition 描述"完工的处置",park 是处置的实现)。
- 范围刻意收窄到 `creates_pr` 节点(= implement / generic 产 PR 类,QA-FAIL 与 founder rework 的目标人群,亦即 1655 前 carrier 人群)。design(`phase_design_complete`)/qa(`no_code`)不动:qa 体的停驻由 runner 协议承担(现状可用),design 目标返工无生产案例;要扩再立单。

### 2.2 park 结算(谁把停驻体收掉)

新增 StateStore 方法 `settleWorkflowRunParkedActors(runId, cause)`,在既有 run 终态写点调用(run status → `completed` / `terminated` 的全部路径,含 land 完工与判终),事务内:

1. 查本 run park 台账中 reason=`rework_reachable_wait` 且未关的 park;
2. 对应 session 仍 `ship_parked` → 投 `completed` + `applyTerminalTimestamp` + park 台账落 `park_closed`(cause: `run_terminal`);
3. 复用既有 phase-shutdown/close-runner 请求机制排队拆体(1759 事件里的 `phaseShutdownRequestId` 链路),**不新造回收机器**;
4. 只碰本 reason 的 park —— `runner_ship_gate_wait`(legacy carrier)仍归 post-ship-finalization,零交集。

replacement 取代原体时(Fix 2 或 reentry replace):`materializeWorkflowReworkReplacement` 后同样结算该体的 park(cause: `superseded_by_replacement`)。

### 2.3 wake 路径(零改动,自动复活)

`activateHolderForWake` 的可复活集合本就含 `ship_parked`;`ship_parked→running` 转移既存。返工完成后 attempt N+1 的完工再次走 §2.1 投影 → 再次停驻。环闭合。

## 3. Fix 2 — 终态残局:`state_not_revivable:<不可逆终态>` 降级 `replacement_pending`

`packages/teamlead/src/bridge/workflow-rework-coordinator.ts` `:394-417`:

- 现状:activation 失败 + `isStateStoreIrreversibleTerminalForZombie(status)` → `settleWorkflowReworkFailure({terminal})` → **首跳 needs_lead 挂死**。
- 改为:镜像 reentry `replace` 分支(`:362-381`)—— `advanceWorkflowReworkDelivery(from: delivery.state, to: "replacement_pending", error: reason, releaseOwner: true)` → 返回 `{kind:"replacement_pending"}` → dispatcher 既有 `materializeWorkflowReworkReplacement`(`workflow-engine-dispatcher.ts:968-983`)铸新 exec,节点派发走 FLY-1718 reconcile 续接分支/PR。
- 保持不变:`approved_to_ship` 不在不可逆集合 → 仍走 retry(×5 → needs_lead);其余非终态 activation 失败(commdb 错误、target 不活等)retry 路径不动;`settleWorkflowReworkFailure` 的 `terminal` 入参与 FLY-1612 告警形态保留(仍被 legacy/其它 caller 使用,不删)。
- replacement 物化失败的收敛复用 FLY-1648 既有退避(1m/2m/4m/8m → 5 次 needs_lead),不新增机制。

Fix 2 同时是**部署窗迁移方案**:上线时已在飞的 run(implement 体已按旧码投 completed)首次 QA FAIL 会命中 Fix 2 自动重生,而非挂死。

## 4. 改动清单(预估)

| 文件 | 改动 |
|---|---|
| `StateStore.ts` `projectGeneralizedCompletionTx` | §2.1 新分支 + park_opened |
| `StateStore.ts` 新 `settleWorkflowRunParkedActors` + run 终态写点接线 | §2.2 |
| `workflow-rework-coordinator.ts` | §3 terminal 分支改向 replacement_pending |
| `workflow-engine-dispatcher.ts` | replacement 后 park 结算钩子(§2.2 末) |
| 测试(见 §5) | 新增/扩展 |

无 schema 迁移(park 台账/`ship_parked`/delivery `replacement_pending` 全部既存);无新 env/flag;纯 Bridge 侧 → **单次 Bridge 重启部署,不动 Lead/Runner**。

## 5. 测试(TDD,先红后绿)

**StateStore 单测**(`StateStore.workflow-*.test.ts` 族)
1. engine_terminal + creates_pr 完工 → `ship_parked` + park_opened(reason=rework_reachable_wait)+ 无 terminal_at。
2. qa(no_code)/design(phase_design_complete)完工 → `completed` 不变(阴性)。
3. runner_ship carrier 路径逐字节回归(legacy sentinel)。
4. run → completed/terminated → 本 run rework park 全结算(completed + terminal stamp + park_closed);`runner_ship_gate_wait` park 不被碰(阴性)。
5. replacement 取代 → 原体 park 结算(superseded_by_replacement)。

**coordinator 单测**(`workflow-rework-coordinator.test.ts`)
6. holder activation 失败 `state_not_revivable:completed` → outcome `replacement_pending`,delivery 行进 `replacement_pending`,不落 needs_lead。
7. `state_not_revivable:approved_to_ship` → 仍 retry(阴性,×5 → needs_lead 不变)。
8. 瞬时 activation 错误(commdb_activation_failed 等)→ retry 路径不变(阴性)。
9. parked holder 全链 happy path:claim → reentry wake → activate(ship_parked→running)→ TURN → wake_delivered。

**跨层**
10. 逆兼容 sentinel:旧世界残留(completed implement 行 + active run + rework)→ Fix 2 自动 replacement(模拟部署窗)。

## 6. 验收 = 活体演练(issue 硬要求;QA 节点执行,真机)

**正戏(全自动,无人工介入为 PASS 判据)**
1. 造真单(QA 沙箱/低危 issue)走 tpl_code:design → implement(codex)完工 → **断言** session=`ship_parked`、park_opened 落账、pane 活。
2. QA 故意 FAIL → **断言** rework 自动 `wake_delivered`;codex 体真接到 wake 并动工(mailbox 消费 + 分支新 commit + `turn` 应答 yours)——同时闭合 R1(见下)。
3. implement attempt 2 完工 → QA attempt 2 PASS → founder gate → land → run 终态 → **断言** park 结算、session `completed`、体被回收。

**阴性对照**:第二张单 QA 一把过 → 全程与今日行为一致(implement 停驻至 run 终态后结算,无残留 park、无多余告警)。

**Fix 2 演练**:第三张单 implement 完工后手工清体(复刻 1759 残局)→ QA FAIL → **断言** 自动 replacement、新体续接同分支/PR、环走通;全程无 needs_lead/held。

## 7. 风险与边界(诚实边界)

- **R1(唯一未证实项)**:post-1655 codex 体在 daemon 提交完工后是否仍轮询 mailbox。§6-2 显式验证;若不可达 → wake 失败走 retry→reentry(体在但唤不醒 → hold/replace)不再挂死,同时启用 contingency:codex runner goal-loop 完工后保留 mailbox 轮询直到收到既有 /quit(最小腿,单独 commit)。
- **R2 容量**:体停驻到 run 终态 —— 这是 1655 前数周的生产常态回归,且 §2.2 保证 run 终态必回收;观察舰队 pane 数一个窗口。
- **R3 ship-gate 机器隔离**:FLY-1731 ship-gate admission 只认 carrier/gate holder 权威,新 park reason 与 `runner_ship_gate_wait` 分值隔离;测试 4 双向阴性覆盖。code review 重点核对项。
- **R4 显示/巡检**:`ship_parked` 是既有状态,display/watchdog 人群已兼容;巡检(FLY-1687)把停驻体列非终结 roster 属预期。
- **R5 存量台账**:不做批量手术;8-10~今的 needs_lead 存量多已收口,余量走 Lead 现成序列或部署后 Fix 2。

## 8. 交付顺序

1. TDD:测试 1-10 先红 → Fix 1 → Fix 2 → 全绿;`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(定向优先,全量按 host 负载纪律)。
2. Codex code review(`codex:rescue`)循环至 approved。
3. PR(base=main;docs 随分支);QA 节点真机 §6 演练(独立 QA,PASS 才 verdict)。
4. ship 后单次 Bridge 重启生效;观察窗:下一例真实 QA FAIL 的自动返工即生产验证。
