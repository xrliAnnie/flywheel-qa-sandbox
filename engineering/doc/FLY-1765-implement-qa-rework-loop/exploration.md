# FLY-1765 implement↔QA 返工环断裂 — 探索

Issue: FLY-1765 (https://linear.app/geoforge3d/issue/FLY-1765/implementqa-返工环断裂qa-fail-后原-implement-体已-completed-不可复活state-not)
日期: 2026-08-14
基于: 无

## 1. 症状(founder 直令原文见 issue)

QA 判 FAIL 后,引擎按 FLY-939 原则唤醒原 implement 体返工;但原体账面已是 `completed` 终态,引擎拒绝复活终态体:

```
rework_delivery_failure  reason=holder_activation_failed:state_not_revivable:completed
rework_retry_exhausted   holdCount=1  →  run 挂死(needs_lead / held,无出口)
```

受害者:FLY-1759(run `a65fd4fe`,Lead 全人工救援)、FLY-1730 时期同签名 + 告警风暴,以及本次取证新发现的 **12+ 起**(见 §3)。

## 2. 生产 DB 取证(teamlead.db,只读)

### 2.1 FLY-1759 全链(实锤复核)

| 节点 | attempt | state | execution | 时间 |
|---|---|---|---|---|
| design | 1 | done | 9495aca6 (claude-tmux) | 00:30 → 01:51 |
| implement | 1 | done | 750f9313 (**codex-tmux**) | 01:51 → **04:33:22** |
| qa | 1 | done (FAIL) | 19a2ef1e (claude-tmux) | 04:33 → 04:47:14 |
| implement | 2 | **superseded** | 750f9313(引擎预留原体) | 04:47:14 → 04:47:15 |

- implement 体 750f9313:`status=completed`,`terminal_at=04:33:22`(**与节点完工同一瞬间翻终态**),`decision_route=needs_review`。
- rework delivery:`state=needs_lead, hold_count=1, last_error=holder_activation_failed:state_not_revivable:completed`。
- 物理体证据:Lead 06:13:38 `lead_close_runner`「清理 1759 残留 implement 体」——**失败的 wake 之后 1.5 小时,pane 还活着**。账面死了,身体活着。

### 2.2 时间线分水岭(全部 rework 台账 × holder 状态对时)

对每条 rework request,比对「holder 的 `terminal_at`」vs「rework `requested_at`」:

- **7-23 ~ 8-09**:所有 implement 目标的返工,holder 在 wake 时刻都是非终态(`alive_at_wake`)→ 返工大量 `completed`/`wake_delivered`,环是通的。最后一次成功 wake:**8-09 13:19(FLY-1663)**。
- **8-10 21:17(FLY-1574)起**:每一条 implement 目标返工都是 `TERMINAL_BEFORE_WAKE` —— holder 在 QA 判决前 15~35 分钟就翻了 `completed`。此后 **无一例外**全部 `state_not_revivable:completed`(1574/1680/1708/1686/1710/1718/1715/1726×2/1674×2/1759)。

### 2.3 issue 两个前提假设的证伪(重要更正)

1. **「implement 全走 Codex 是回归主因」— 证伪**。implement 节点自 **8-02 起每天全部**是 `codex-tmux`(8-03~8-09 期间 40+ 体),同期 QA-FAIL 返工照常送达。Codex 不是变量。
2. **「对照组:同晚 Claude 后端的 implement 体(如 1743)正常停驻」— 证伪**。DB 显示 FLY-1743 的 implement 也是 `codex-tmux` + `completed`(04:15:52);1743 的 claude 体是 design 和 qa 节点。真正停驻的对照组是 **QA 体**:QA runner 按协议发 verdict 后**不调 complete**、session 持 `running`(QA-PASS holder park 纪律),所以 qa 目标的 retest wake 一直通。
3. **「Codex 完工后不驻留」— 半真**。物理层驻留(pane 活到被 Lead 手工清);**账面层不驻留**(引擎把 session 投影成 `completed`)。断的是账面,不是身体。

## 3. 真因(代码级,全链闭合)

**回归提交:PR #795(FLY-1655「self-ship 按 terminal-land 不变量重设计」,merged 8-10 08:29 PT;首例失败 8-10 14:17 PT,部署窗吻合)。**

机制链:

1. 1655 之前:tpl_code 的 implement 节点是 runner-ship carrier(`can_ship=true`)。`resolveWorkflowGateAuthority` 返回 `runner_ship`,carrier 完工投影为 **`ship_parked`/`awaiting_review`**(`StateStore.ts:26568-26576` `projectGeneralizedCompletionTx`)—— 恰好都在 wake 可复活集合内。implement 体从节点完工到 run 收尾一直是账面停驻,QA-FAIL wake 一路绿灯。
2. #795 给模板加了 `land` 节点 + `approval_gate: node: land`,implement 的 `can_ship` 变 false(run a65fd4fe 的 pinned snapshot 实证:implement `ship=False, gate_holder=False`;land `ship=True`)。gate authority 因 `isWorkflowManifestLand` 早退变成 `mode:"land"`(非 runner_ship)→ 同一个投影函数的 carrier 分支不再命中,走 else 分支:**implement 完工 → session 立即 `completed` + `terminal_at`**。
3. wake 闸 `activateHolderForWake`(`holder-wake-activation.ts:44-51`,7-24 起未改)只认 `{running, ship_parked, design_done, awaiting_review}`;`completed` → `state_not_revivable:completed`。
4. rework coordinator(`workflow-rework-coordinator.ts:394-417`)把 `state_not_revivable:<不可逆终态>` 打成 `terminal: irreversible_actor` → `settleWorkflowReworkFailure` 中 `exhausted = terminal !== undefined || holdCount >= 5` → **第一跳直接 needs_lead**(holdCount=1),不重试、不重生 → run 挂死。
5. 没人同步改 wake 闸或投影 —— **FLY-1655 与 FLY-939 的接缝没人拥有**。这是接缝缺陷,不是任何一方单独的错。

一句话:**FLY-1655 把 implement 从「ship carrier(账面停驻到 run 结束)」改成「交完货即账面终态」,而 QA-FAIL 返工环的 wake 纪律仍然只认停驻账面 —— 环从此结构性断裂,QA 一把过则无感,QA FAIL 一次则 100% 挂死。**

「前几天还好好的」的准确解释:不是 QA 都一把过,而是 8-10 部署前旧机制真的在工作(8-03~8-09 有 20+ 次成功返工记录)。

## 4. 已排除的次要嫌疑

- **#818 FLY-1612**(8-12 15:03):只改告警/退避/needs_lead 收敛,是把本 bug 的**症状**(刷屏)治了;`terminal` 立即耗尽分支让挂死更「安静利落」,但断环者不是它(首例在它合入前 2 天)。
- **#807 FLY-1686**(8-11):QA qa-result 409 修复,另一层;窗口内 `worktree_not_ready:head_mismatch` 那几条卡是它的家族,与本签名无关。
- **#824 FLY-1718**(8-13):re-dispatch reconcile,在首例之后合入;且它是本设计里 respawn 降级路径的**依赖**而非嫌疑。

## 5. Linear 同类单收敛(issue 要求的第一步)

全库扫描(`state_not_revivable` / `rework` / `返工`):**无重复开放单**,本单为权威。相关家族:
- FLY-1462(Done):rework 永久 hold(`persisted_target_missing`)— terminated holder 误判;其 #700 修复曾被 #704 revert,设计原话「completed deliberately excluded (parked-alive shape)」是本单立场的前科背书。
- FLY-1612(Done):同一挂死的告警风暴层,已修(症状层)。
- FLY-1423(Done):旧引擎时代 qa-fail 踢回锁死,机制已换代。
- FLY-777(Backlog):status 模型支持 iteration —— 更宽的愿景单,本单不阻塞它、也不被它阻塞。
- FLY-1759:受害者单(已由 Lead 手工救援 + 单独返工),非机制单。

## 6. 通往修法的关键事实

- 身体活着 + 账面终态 → 今天唯一的死路。身体死了反而有自动重生:`classifyPhaseActorReentry`(`phase-actor-reentry.ts`)判 `replace` → dispatcher `materializeWorkflowReworkReplacement`(`workflow-engine-dispatcher.ts:968-983`)自动铸新 exec。**讽刺:体可用的情形死,体不可用的情形反而活。**
- codex 体具备 mailbox wake 通道(`plugin.ts:8410` wakeActor → `EXECUTOR_TO_TRANSPORT` → `deliverDurableTurnWake`, backend=codex,FLY-1643);8-03~8-09 的成功 wake 都发生在 codex 体上。
- **codex 完工后驻留(后续 design review 中已证实有实现)**:探索阶段曾列为未证实项;design review 核出 FLY-1269 resident controller 已实现完工后 durable phase hold + mailbox 驻留(`Blueprint.ts:1595-1621` phaseKeepAlive、`CodexTmuxAdapter.ts:515-540`、`codex-daemon-client.ts:790-846`)。活体演练做定向回归验证;alive-but-nonconsuming = FAIL 停发(详见 plan §6)。
