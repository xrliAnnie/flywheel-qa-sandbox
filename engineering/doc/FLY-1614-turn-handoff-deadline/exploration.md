# FLY-1614 节点交接无死线无自播报 — 探索

Issue: FLY-1614 (https://linear.app/geoforge3d/issue/FLY-1614/巡检场景1-节点完成下一棒交接无死线无自播报-turn-beltfounder-gate-停滞只能靠-lead-查表发现今晚-3)
日期: 2026-08-11
基于: 无(本文件夹首篇;上游输入 = Linear issue 正文 + 11 条评论中的 founder 裁定)

## 1. 问题是什么(用一句话)

工作流引擎把「节点完成」记进了自己的账本,但把接力棒(TURN)交给下一棒 runner 的动作**会静默缺失**——没有死线、没有事件、没有自播报,停滞只能靠 Lead/founder 人肉查表或看 pane 发现;截至 2026-08-11 凌晨已累计 **7 例**,横跨所有 verdict 消费分支。

## 2. 名词表(本文档持续使用)

| 名词 | 含义 |
|---|---|
| TURN / 皮带 | `comm.db` 表 `three_stage_turn`:同一 issue 的多个阶段 runner 共享一个物理 worktree,任一时刻只有 TURN 持有者可写。Bridge 是唯一写者 |
| epoch | TURN 的单调版本号,每次交棒 +1;runner 用 `flywheel-comm turn` 自查 `yours/not-yours/no-turn` |
| activation | 引擎正规交棒时同步铸造的激活凭据行(`runner_workflow_activation`,含 submission credential);终态提交(complete/qa-result)必须附带,否则 Bridge 409 |
| 引擎 / engine | Bridge 内 generalized workflow DAG 引擎(`workflow_run` / `workflow_run_node` / activations) |
| 信箱 wake | `flywheel-comm send` 写 mailbox 并唤醒停驻 runner 的通道——与 TURN 皮带是**两条独立通道** |
| 手工交棒 | Lead 直写 `three_stage_turn`(UPDATE holder/phase/epoch)的应急手术 |

## 3. 事故形态(7 例的共同签名 + 各自差异)

共同签名:**verdict/completion 正常落账 → 引擎自己的节点账本正常推进 → belt grant 未落 / runner 未被唤醒 → 下一棒 runner 空等,全部仪表读数正常**。

| # | 日期 | Issue | 分支形态 | 停滞时长 | 发现者 |
|---|---|---|---|---|---|
| 1 | 08-03 | 1605 | qa done + founder 批准 → ship 交带 | ~28min | Lead 查表 |
| 2 | 08-03 | 1603 | 同上 | ~20min | Lead 查表 |
| 3 | 08-03 | 1602 | FAIL → rework(卡 worktree 检查);另见附观察 2 | 18min + 29min | Lead 查表 / 巡检 |
| 4 | 08-10 22:15 | 1573 | qa FAIL → rework,grant 未发(activation_id 空) | ~25min | **founder 看 cmux 截图** |
| 5 | 08-10 22:49 | 1573 | rework 完成 → retest(方向反过来) | 15min | Lead |
| 6 | 08-10 23:26 | 1676 | qa FAIL → rework | ~15min | **等棒的 implement runner 自己 ask**(第 2 层的人肉预演) |
| 7 | 08-11 00:50 | 1574 | qa FAIL → rework,run held@implement | **2.5h** | **founder 亲自看 runner pane** |

另有两条同源附观察(issue 正文):
- **附观察 1**:activation/wake 会投给**已 done 的 attempt**(FLY-1609,qa attempt 2 done 之后才到 rework activation → runner 醒来做无效工作 → 409 replay_payload_mismatch 挡下)。
- **附观察 2**:「DB 说已授予、runner 停在授予之前」——runner 上次轮询读到旧 epoch 后把 goal 标 blocked **停止轮询**,永远看不到后来的授予(空转 29min)。turn_granted 不主动唤醒目标是根源之一。

## 4. Founder 设计裁定(2026-08-10 22:23,本单修法以此为准)

原「引擎侧交接死线 fail-loud」草案**已撤回**。三层职责:

1. **第 1 层·根因修复(主体)**:研究 grant 为什么没发——不是盲补一次调用,是把缺失路径诊断清楚后修好,**确保 Bridge 自己发得出去**。
2. **第 2 层·当事人检测**:等棒 runner 超过 20-30 分钟自动告诉 Lead,由 Lead 判断。**不建中央 watchdog、不加引擎侧死线机器**(与 FLY-1569「拆 watchdog、agent 自己说」哲学同构)。
3. **第 3 层·担架**:Lead 手动交棒正式化为应急程序,先跑起来,同时取证给根因修复。

Founder 追问(08-11 00:50)追加的**硬验收**:
- 「Bridge 为什么没告诉你?」——因为**引擎自己也不知道棒没交出去**(节点账本翻页了,它自认无事);真相只存在于两本账的交叉(engine `current_node` vs belt holder),今天没有组件做这个交叉。⇒ **第 1 层验收必须含「自校验」:grant 落账后(或 verdict 消费后有限时间内)引擎自己校验两本账一致,不一致 fail-loud 告警**。不能只补一条 grant 调用。
- 第 2 层 generic 约束(founder 原话):「不希望把 Runner 做得特别复杂…要 generic…DAG 里本来就有 loop 的概念…让相对应的节点自己知道该怎么跑。」⇒ 已定方向:**检测埋进全节点共用的 `flywheel-comm turn` 命令**——同一 exec 首次 not-yours 落等待标记,超阈值(20-30min 可配)自动替 runner 发去重 ask 给 Lead,然后照常返回 not-yours。runner 零改动、prompt 零新增、拓扑无关。
- 交棒动作(引擎或人工)**必须是「写库 + 通知持有方」的原子对**;只写库不通知视为未完成的交棒(评论 #5:交了棒持有方不知道,抱着过时认知走完了一整套有说服力的「合规放弃」——失败形态是静默 + 归因错误)。引擎正规 grant 必须是**原子一整套:棒 + 目标绑定 + 激活凭据 + 唤醒**,不允许「棒到了但激活没到」的中间态。

## 5. 手工交棒的已知副作用(第 3 层文档的素材,共 5 条)

1. runner 的 `progress` 被拒(active-writer 闸读 Bridge FSM session 状态,rework 场景下已 completed)——临时口径:该 lap 跳过 progress checkpoints,直接 complete;
2. issue thread 标题不随阶段更新(标题更新挂在引擎正规交棒通路上);
3. 不唤醒已停驻 runner(必须配 `flywheel-comm send`;Codex 已 `Goal stalled` 时 mailbox 可能不被轮询,需 `tmux send-keys "/goal resume"`);
4. **无激活凭据 ⇒ 终态提交必 409**(`FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED=1` 下 CLI 无法附 workflowActivation;最致命——runner 根本交不了卷);
5. **交棒了但持有方不知道**(runner 的 TURN 认知来自上次 `turn` 返回;手工 UPDATE 零通知 → runner 以假理由「TURN 在 QA 手上」合规放弃,归因错误)。

⇒ 手工交棒必须成对:「写库 + send 告知 holder/phase/epoch」;若该节点还需提交终态,还须补铸 capability + submission credential,否则必卡 409。

## 6. 现状代码的关键事实(截至本分支 HEAD,d6536134)

- **belt 数据层**(`packages/flywheel-comm/src/db.ts:4410` `grantTurn`):带 source 的正规 grant 是一个事务:belt upsert(epoch+1)+ `runner_workflow_activation` 行 + `turn_source_history` + `workflow_source_event`(replay 幂等,payload mismatch = poison)。**不带 source 的裸 grant 也存在**(4617-),只写 belt 5 列——手工/legacy 形态。
- **runner 自查**(`packages/flywheel-comm/src/commands/turn.ts`):`yours/not-yours/no-turn`;`yours` 且 activation stale 会降级 not-yours。**not-yours 分支只返回 holder/phase/epoch,没有任何等待记账**——第 2 层的落点。
- **rework 交棒协调器**(`packages/teamlead/src/bridge/workflow-rework-coordinator.ts:287` `reconcile`):claim → 校验 → 重入探针 → worktree ready → 激活 actor → admission → grant intent → `grantTurn`(带 activation)→ projection → **`wakeActor`** → wake_delivered;每一步失败有 releaseRetryable/releaseAndHold。**机械上「棒+绑定+激活+唤醒」的原子链在这条路径已存在**。
- **legacy belt 巡检**(`packages/teamlead/src/bridge/phase-orchestrator.ts:2198` `reconcileTurnBelt`):engine-owned holder 一律跳过(2204/2217/2239);completed-QA holder 显式 return(2283,即 issue 提到的「2282 显式 return」)——PASS 后的 TURN 留给 post-ship finalization 删,巡检不动它。
- FLY-1655(#795,在本分支)已把「有 PR 的 schema-v2 DAG」的 PASS→ship 收敛为 engine-owned terminal `land` 节点;FLY-1648(#788,在本分支)已给 held rework 加 1m/2m/4m/8m 退避 + 5 次转 needs_lead。⇒ **事故当晚生产在跑哪个 build、哪些形态已被 HEAD 覆盖,是 research 必须回答的第一个问题**——不能把已修好的路径再修一遍,也不能把「HEAD 已有代码」当成「已验证有效」。

## 7. 探索性结论(带着去 research 验证的假设)

- H1:7 例不是一个 bug,而是「**grant 调用分散在多个 verdict/completion 消费点,各点各自成败,没有任何一处校验『账本推进 ⇒ 棒已交』这个不变量**」的结构病。修法应是把「消费 verdict → 推进节点 → 交棒(棒+绑定+激活+唤醒)」收敛为一条共用的原子通路 + 通路末端自校验,而不是逐点补调用。
- H2:附观察 1(投给已 done 的 attempt)与 H1 同源:activation 投递缺一个「目标 attempt 仍是 pending/admitted」的门(rework coordinator 的 `rework_target_not_reserved` 检查已有此形——需要确认其他投递点是否都有)。
- H3:附观察 2(runner blocked 后停轮询)在 wake 通道健全后降级为次要——若每次 grant 必带 wake,runner 停轮询也会被信箱唤醒;但第 2 层的 turn 命令等待记账仍需要,因为它守的是「wake 也没到」的最后一层。
- H4:第 3 层的正确形态不是「把 UPDATE 语句写进文档」,而是给 Lead 一条走引擎正规通路的命令(补铸激活 + 唤醒),SQL 手术只留作 Bridge 挂掉时的最后手段。

## 8. 明确不做(scope 边界)

- 不建中央 watchdog、不建引擎侧死线定时器(founder 已裁定,与 FLY-1569 拆 watchdog 方向一致);
- 不动 FLY-1655 terminal-land 的 ship 收敛(PASS→land 已是新形态;本单只管「棒的交接」这层);
- Lead 独立巡检兜底的判据(独立于 Bridge)= FLY-1687,不在本单;
- rework 通知层 = FLY-1612,不在本单;
- 暂停 goal 的 Codex runner 不消费信箱唤醒 = FLY-1621(相关但另单)。
