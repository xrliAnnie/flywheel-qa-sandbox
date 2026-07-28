# FLY-1505 Runner ship 追踪与批准保活 — 独立 QA 报告
Issue: FLY-1505 (URL 不可得,只写 issue 号)
日期: 2026-07-27
基于: plan.md、design-correction.md

**结论: FAIL(退回 implement 阶段修复)**

issue 的三条 scope **本身**全部达成并经端到端验证(§3-§6)——批准保活这条主线是好的。但 Codex code review(xhigh,round 1)在同一个 head 上找出 **4 个 MEDIUM 正确性/可靠性缺陷**(§7),我逐条独立复核后确认全部属实,其中两条(延迟 marker 用错 approval binding、`(unknown)` 覆盖真实 head)直接违反已批准计划 C3 的 durable-evidence 合同。按"所有硬门(含 codex code-review)过后才发 PASS"的规矩,verdict 只能是 FAIL。

被验证的 head: `c97f4e3791505bd1320ebb068099f1c33c450440`(PR #715,含本报告新增的 QA 测试)。
Codex review 已发到 PR: <https://github.com/xrliAnnie/flywheel/pull/715#pullrequestreview-4794851133>

---

## 1. 我验了什么(而不是"跑了一遍它自己的测试")

Implement 阶段已经把各个零件测到位了。QA 阶段我认定还没被证明的是三件事,并把它们补上:

1. **整条链没人走过。** 没有任何测试把一次真的 `POST /events` 完成事件打进真的 router,**然后**拿真的 `verifyApproval` 去读落盘后的状态。而"runner 报错 → Bridge 拦下 → 批准还能花" 这条链本身**就是**这个 issue。
2. **没有阳性对照。** 只有 `approved: true` 的断言,分不清"拦截生效了"和"这条断言根本不可能失败"。
3. **重审接缝没用真数据验过。** 抑制解析器只喂过手写 JSON;由生产写入路径真正落下来的 marker,也必须在新的批准绑定出现后停止抑制。

对应新增两个 QA 测试文件(§3),并对拦截逻辑做了**变异测试**证明它们不是空过绿(§4)。

## 2. 门与套件

| 门 | 结果 | 备注 |
|---|---|---|
| `pnpm -r build` | ✅ exit 0 | 全仓 |
| `pnpm lint` | ✅ exit 0 | 2413 文件;15 条 warning 全部 pre-existing(与本单无关) |
| edge-worker 全套件 | ✅ 1227 passed / 5 skipped | |
| teamlead 本单相关 10 个文件 | ✅ 308 passed | 含三 sink、settle helper、reconciler、gate-poller、告警管道 |
| flywheel-comm 全套件 | ✅ 1277 passed / 1 flake | `cli.test.ts > check` 并发超时;**单文件隔离重跑 43/43 全绿**,且该文件不触及本单改动(本单在 flywheel-comm 只改 `complete.ts`)→ 判定为既有并发时序 flake,非回归 |
| **GitHub CI(9 个 check)** | ✅ 全 pass @ `e8dca240`(implement 终稿 head) | 含 teamlead 3 个 shard、Unit heavy/light、Quick Gate、Script Tests —— 比我本机跑更完整,不受本机 flake 影响 |

## 3. 新增 QA 测试(已提交到本分支)

### 3.1 `packages/teamlead/src/__tests__/fly1505-qa-ship-attempt-chain.integration.test.ts`(6 例)

| # | 用例 | 断言到的事实 |
|---|---|---|
| 1-2 | `POST /events` route=`ship_attempt_failed` / `blocked`,打在真实绑定的 approved 会话上 | HTTP 200 + `warning` 含 "approved_to_ship preserved";会话状态**没变**;`session_params` 落下 head/attempt_count/review_question_id;**关服落盘后真的 `verifyApproval` 仍返回 `approved:true, reason:"approved"`** —— 这就是 FLY-1497 丢掉的那个东西 |
| 3 | **阳性对照** | 同一份 CommDB 批准、同一个 head、同一个绑定,**只把会话状态真的翻成 blocked** → `verifyApproval` 返回 `approved:false, reason:"status_not_approved_to_ship"`。证明第 1-2 例的绿是**可以变红的** |
| 4 | 字节兼容 | 非 approved(running)会话的 route=blocked **照旧**终态化为 blocked,且不写 FLY-1505 标记 |
| 5 | 新路由不是后门 | 非 approved 会话上的 `ship_attempt_failed` → **409 + retryable:false**,状态不变 |
| 6 | 重审接缝(用真 params) | 由 HTTP 链路真实写入的 `session_params`:同绑定同 head → 抑制自动重唤醒(`isRewakeCandidate` 为 false);**换成新的 question id → 抑制立刻解除**(fail-open) |

### 3.2 `packages/teamlead/src/__tests__/fly1505-qa-rewake-suppression-scope.test.ts`(2 例)

把 §8-F1 那条"抑制范围比计划措辞更宽"的取舍**钉成显式决定**:一个基线例证明没有 marker 时 W-1 dead 告警会发,一个例证明有 marker 时整个 session 被跳过。谁要按计划字面收窄抑制范围,得**有意识地**改这条期望,而不是无声地改掉。

## 4. 变异测试 —— 证明新测试不是空过绿

把 `event-route.ts` 的拦截条件强改成 `if (false as boolean)`(即回到修复前行为)后重跑:

```
Tests  3 failed | 3 passed (6)
FAIL … route=ship_attempt_failed … : expected 409 to be 200
FAIL … route=blocked … : expected { ok: true } to match { warning: StringContaining "approved_to_ship preserved" }
FAIL … 重审接缝 … : expected 409 to be 200
```

改动已 `git checkout` 完整还原(`git diff --stat` 为空)。加上 §3.1 第 3 例的阳性对照,这条链的**两端**都有独立证据。

## 5. 真机 / 真 CLI 端点验证(单测断言不到的部分)

新协议提示词里给 runner 的三段 shell/CLI 是"字符串断言"测的,我按"在终点取证"的规矩**真跑**了一遍:

| 验的东西 | 真实结果 |
|---|---|
| `COOL_ID` 提取(`${COOL_URL##*issuecomment-}` + 全数字校验) | 真 URL → `3456789012` ✅;空输出 / gh 报错文本 / `12ab` 非法尾巴 → 一律落空串 → 按提示词走 guarded fallback ✅ |
| receipt 过滤 jq(按 workflow 真实 receipt 格式构造) | `COOL_ID=222` 精确命中 900003;**`COOL_ID=111` 不会误吃 `1112` 的 receipt**(结尾那个空格是有效的防前缀碰撞);没有本次 receipt 时返回 `null` ✅ |
| fallback 的 awk 预算读取 | 对真的 `.github/workflows/ship-on-comment.yml` 输出 `30`,且全文件 `timeout-minutes` 恰好 1 处 ✅ |
| `gh run view <id> --json status,conclusion` | 对 **FLY-1497 事故当次的真 run `30323697177`** 执行 → `{"conclusion":"success","status":"completed"}` ✅ —— 既证明主追踪路径的命令是真能用的,也再次坐实事故叙述:runner 假报 blocked 的时候,这个 run 后来是**成功**的 |

workflow 侧对照核对:`ship-on-comment.yml` 的 started receipt 确实带 `trigger_comment_id=` + `run_id=` + `status=started`,提示词依赖的字段**全部真实存在**,不是设计文档里的虚构。

## 6. issue 三条 scope 的落实与诚实边界

**scope 1(窗口 10 → ≥35 分钟)**:被 Lead 批准的 design-correction 取代为更强的形态 —— runner **不再自己维护第二只时钟**,以本次 attempt 的 started receipt 拿 `run_id`,由 GitHub workflow run 的终态说了算。只有追踪链失灵才落到动态 fallback = 现读 workflow `timeout-minutes`(实测 30)+ 固定 5 分钟传播缓冲 = **35 分钟**,正好压在 issue 的硬线上。
注意这是**有意为之的联动**:若将来把 job 预算调小,fallback 也跟着变小 —— 但那时 job 自己会先到点给出终态结论,主路径立刻就能判定,不需要 runner 等满 35 分钟。所以"窗口 ≥35"从一个写死的数,变成了"永远跟着 workflow 走"。

**scope 2(善后不得使批准失效)**:§3.1 第 1-3 例端到端证明,含阳性对照。三个 completion sink(event-route / DirectEventSink / marker reconciler)口径一致。

**scope 3(模拟 job 跑 25 分钟的回归)**:**诚实边界 —— 单测跑不了 25 分钟真墙钟**,轮询窗口是提示词层由 LLM 执行的行为合同。计划 §3 已经声明了这个映射,QA 把它**加强**为:真 HTTP 完成事件 + 真 `verifyApproval` + 阳性对照(§3.1),再加上 §5 对提示词里每一段真命令的实跑。"job 还在跑时 runner 误报 → 不落终态 → 批准仍可花"这条断言意图被完整覆盖;"runner 真的等满了 25 分钟"这件事**没有**也**无法**在单测里证明,要等生产第一次真 ship 观察(计划 §6 已经把它列为撤销临时硬指令的条件)。

## 7. 阻塞项 —— Codex code review round 1(xhigh)= CHANGES REQUESTED

Codex 在 head `c97f4e37` 上跑了 xhigh review。它的 4 个 MEDIUM 我**逐条自己回源码复核过**,不是照单全收:

| # | 位置 | 缺陷 | 我的独立复核 |
|---|---|---|---|
| **M1** | `bridge/plugin.ts:8791` | boot drain 仍晚于 `gatePoller.start()`(:8401)。GatePoller 首个 tick 在 `pollIntervalMs`(3s)后触发,若 drain 比一个 tick 慢,`staleApprovedShipReconcilePass` 会在抑制 marker 落库前重发 `approval_wake` → runner 无诊断地再发一次 `:cool:` | **确认(条件性)**。`start()` 用 `setInterval`,首 tick 不是立即,所以窗口 = 一个 poll 间隔;但 drain 与 tick 之间确实有若干 await。踩中就违反 founder"`:cool:` 点一次"的规矩并白烧一次 CI |
| **M2** | `bridge/auto-qa-effects.ts:502` | 离线 drain `await` 的这个 effect 在 no-lead / no-sink / notifier dead-letter 三种情况下都**正常 resolve**,于是"告警成功"被误判,最后一份 complete marker 随即被删 | **确认**。`alertShipAttemptFailed` 在无 notifier / 无 leadId 时直接 return;`leadAlertNotifier.alert()` 也可能以 `{skipped}` 正常返回。而 reconciler 的注释合同写的是"reject → 保留 marker 重试",design-correction 第 6 条要求"等告警成功才删 marker" —— 两边对不上 |
| **M3** | `bridge/complete-marker-reconciler.ts:546` | 延迟 marker 的 `reviewQuestionId` 取自**消费时**的 session row,不是 attempt 事件本身。重启后被 drain 的 Q1 attempt,若会话已重审绑定到 Q2 且 head 未变,marker 会被写成 Q2 → **错误抑制一轮新批准的自动重唤醒** | **确认**。三个 sink 都传 `currentSession.review_question_id`;对两个 live sink 无害(attempt 刚发生),对跨重启重放的 reconciler 就是错的。计划为 **head** 做了 A/B stale 保护,**binding** 这一维漏了 |
| **M4** | `bridge/post-ship-finalization.ts:201` | `(unknown)` 哨兵的"不覆盖"保护多加了一个 `priorReviewQuestionId === reviewQuestionId` 条件。prior={真实 headA, Q1}、本次={unknown, Q2} 时保护不成立 → **真实 head 的 durable 证据被哨兵覆盖掉** | **确认**。计划 C3 白纸黑字:"unknown 只写空槽""永不覆盖已存在的真实-head 条目"。当前实现只在同 binding 下遵守 |

Codex 另有两个 LOW,与我独立找到的 F4/F5 **完全重合**(交叉印证):HeartbeatService 三条消费链未处理新 outcome kind;`--pr` 必填但不进 payload。它也同意我在 §7-F1 对 re-wake 抑制范围的判断(当前不阻断,因为 parked-phase liveness 仍独立覆盖),并指出 `plugin.ts` / `HeartbeatService.ts` 里那些"drain 先于 FLY-324/FLY-623"的注释已经失真,应随 boot 顺序一并修。

Codex 侧的验证:edge-worker 13/13、flywheel-comm 47/47、teamlead 非监听路径 303/303 通过;三包 typecheck 通过;19 个变更源文件 Biome 通过。两份 HTTP integration 在它的沙箱里因 `listen EPERM` 跑不了 —— 那两份**我在本机跑过且全绿**(§3.1),不算代码问题。它也独立复跑了 workflow receipt 字段与 shell/jq/awk 协议,结论与我 §5 一致。

**修复建议(留给 implement 阶段,不由 QA 代劳)**:M3/M4 是同一处根因的两面 —— attempt 的 approval binding 必须**随事件走**(和 head 一样),而不是消费时现读;把 binding 也纳入 stale 判定,并把 `(unknown)` 的不覆盖保护改成无条件。M2 需要让告警"被接受"成为可观测的返回值(参考 `deadAlertAccepted` 的既有形态),接受不了就保留 marker。M1 把 `gatePoller.start()` 挪到 drain 之后,或让 drain 完成前 stale-approved pass 短路。

## 8. 非阻塞发现(不影响上面三条 scope)

**F1 · re-wake 抑制的实际范围比计划措辞宽(中)**
计划 §4/§7 写的是 C7"只停自动 re-wake"。实现把抑制放进 `isRewakeCandidate`,而它是 `reconcileStaleApprovedShip` 循环里唯一的 `continue` 闸 —— 于是这一趟 pass 的**存活探测**和 FLY-1393 W-1 的一次性 `stale_approved_ship_dead` 告警也一并被跳过。
**不是无声漂流**(我一开始的判断偏重了,这里更正):`approved_to_ship` 属于 `READOPT_PARKED_STATUSES`,`readoptParkedPhase` 仍然每个心跳周期探它一次,不活就发 verdict 诚实的 monitoring-lost 告警。净效果 = 两个重叠探测器**少了一个**,不是探测消失。已由 §3.2 钉成显式取舍。建议 follow-up:把抑制收窄到只挡 `reWake` 动作,dead 判定照常走。

**F2 · plugin.ts 里 FLY-623 的注释现在是错的(低,文档准确性)**
`plugin.ts:~6672` 仍然写着 boot-seed "Runs AFTER the FLY-172 marker drain",但本单把 drain 从 `seedReconnecting()` **之前**挪到了 `heartbeatService.start()` / `gatePoller.start()` **之后**。
我验过**行为没坏**:`seedReconnecting` / readopt 两条路径对 `running` 会话本来就是 marker-first,而 `approved_to_ship` 会话在到达 marker 步骤之前就短路了(`HeartbeatService.ts:1040/1110`),所以 FLY-1505 的 marker 只会被那个 **await 了告警 sink 的 boot drain** 消费 —— 这正是本单挪位置想要的。但注释已经与代码相反,会误导后来人。

**F3 · 两处 `alertShipAttemptFailed` 接线口径不一致(低,当前不可达)**
`complete-marker-reconciler` 的注释合同是"告警 Promise reject → 保留 marker 重试"。boot drain 的接线(`plugin.ts:~8801`)返回 promise,合同成立 ✅。心跳侧的接线(`plugin.ts:~6173`)是 `void autoQaCoordinatorHolder.current?.…` —— 既不返回 promise(reject 永远观察不到),holder 在 boot 早期还是 null,而且 `AutoQaCoordinator.alertShipAttemptFailed` 内部 try/catch 吞掉一切。当前不可达(理由同 F2 的短路),但两处对同一份文档合同的实现是矛盾的。

**F4 · `HeartbeatService` 没有消费新的 outcome kind(低,当前不可达)**
`reconcileCandidateReadopt` / `…V2` / `reconcileMonitorLossLegacy` 三处只分支 `reconciled` / `duplicate_terminal` / `transient_failed` / `quarantined`,没有 `settled_ship_attempt_failed`。计划 C2(c) 要求"全部 exhaustive 消费方逐一核对补齐"。当前同样不可达(非 running 会话在 marker 步骤前短路),但一旦将来放开 parked 会话走 marker 步骤,一个已被 settle 的 attempt 会 fall through 进 tmux 探测 / monitoring-loss 分支。

**F5 · `complete --route ship_attempt_failed` 的 `--pr` 是装饰性的(极低)**
CLI 强制要求 `--pr <正整数>`,但这个值**从来没进过 payload**:`landingStatus` 只在 `pr_handoff`/`needs_review` 分支设置,`merged` 又被显式拒绝。Bridge 侧告警用的是 `session.pr_number`。所以它只是一道校验,不承载任何信息 —— 无害,但这个必填参数目前名不副实。

## 9. 我没有验的(诚实边界)

- **没有真机 25 分钟 ship**:见 §6 scope 3。生产第一次真 ship 走新协议的观察,按计划 §6 属于 Lead 确认项,不在本单 QA 范围。
- **没有验生产重启后的生效**:Blueprint 文本与 teamlead sinks 都编译进 Bridge 常驻进程,计划 §6 已把它挂在 FLY-1507 之后的统一重启窗,不为本单单独重启。
- **没有跑 teamlead 全套件**(本机已知 ~12 个 machine-state flake 会造成噪声):改用 GitHub CI 的 3 个 teamlead shard 全绿作为更干净的回归证据(§2)。
