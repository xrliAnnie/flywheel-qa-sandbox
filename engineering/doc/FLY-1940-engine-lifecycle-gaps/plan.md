# FLY-1940 引擎生命周期三缺口收口 — 实施计划

Issue: FLY-1940 (https://linear.app/geoforge3d/issue/FLY-1940/引擎生命周期-三缺口收口死-session-复活直通-ship-卡-交棒不唤醒-孤儿闸监控并-19411946)
日期: 2026-08-21(R4,折入 Codex design review R1×11 + R2×4 + R3×3 + R4×2,零拒绝)
基于: research.md

## 0. 设计总纲

调研(research.md §7)把六个切面归到三门缺课:

1. **判死学**:「absent/unknown ≠ dead」——拆得越干净越判不死(④a),杀不干净又让 absent 永远到不了(⑤);
2. **投递学**:「写成功 ≠ 到达」——wake 的成功定义是 inbox 文件写返回(②);
3. **状态学**:「终态 ≠ 免疫」——`failed` 有出边所以不免疫,复活体仍是合法 writer(①);孤儿闸/死棒是「没人负责收尾的状态」(③⑥)。

本计划按这三门课组织修复。**每一条修复都优先接通已存在但断线的机制**(净删除红线):qa_passed 补 head 撤销钩子;wake 结算挂到已有的 TURN-wake ACK/onReceipt seam;founder_review 并入已有 supersede/retirement 机制(显式 allowlist);TURN 释放解除 reconciler 的 engine-owned 压制(收窄为可证形态);quiescence 探针补上 dispatcher 已在用的 absence 判死策略。

**红线遵守声明**(Tadashi [lead-instruction 86c14bc7]):不新建巡逻器/告警层(③监控 = GatePoller 既有 rider + `enqueueWorkflowEngineAlert`);净删除清单 §8;新路同 PR 删老路义务写进各 Fix;修不完的子项 §7 排优先级,零静默丢。

**依赖基线更正**(R2,merge-ancestry 实证,替代 research.md §8 的旧表):FLY-1770(`f09a3f19b` #845)、FLY-1628(`acbf39bee` #776)、FLY-1759(`e4ae3893e` #830)、FLY-1912(`f4d789396` #908)、FLY-1638 基座(`f02ecbc87` #779)**全部已在 HEAD**;FLY-1638 尚有 diverged follow-up 分支在飞。分工立场按"代码已在"重排:⑥ 的跨 epoch 收敛**归本单**(见 §6),④c 须与 1638 已合基座的 lease/tombstone 对齐。

## 1. 判死学(P0):⑤ daemon 收割 + ④a quiescence 判死 + ④d baseline 放宽

### Fix 5-A Codex daemon 按 execution 收割(⑤,P0)

**现状**:teardown 三路径只做 Playwright-MCP 收割 + tmux kill-window + 删 CommDB 行;Codex daemon 是 Bridge 的 detached 子进程,tmux 碰不到(research §5)。
**R1 修正(Codex #4)**:`pgrep -f <execId>` 对 daemon **不可靠**——`FLYWHEEL_EXEC_ID` 在 env 不在 argv,rotation shim/app-server 的 argv 不含 exec id;`daemonPid` 只在 `onThreadReady` 才持久化,spawn 与 thread-ready 之间 terminate 会拿不到 PID。

**修法**(以 socket 为身份锚,claude-runner 拥有原语,Bridge 只调用):
1. 新增 claude-runner 导出的 `reapCodexDaemonForExecution(execId)`:
   - 身份两证:确定性 socket 路径(codex-daemon-runtime 既有派生)+ `lsof` 取 socket 持有者 PID,校验其属于持久化的进程组——不满足两证不杀(fail-closed);
   - 杀法:组 TERM → 有界等待 → **socket 死亡验证**(复用 `ensureDead` 的验尸语义)→ 组 KILL;守卫复用 `createDefaultKillGroup`(拒 pgid≤1/自身/ppid/Bridge 组);
   - 补证(R3 #1 + R4 #1 定稿):`spawnCodexDaemon` 接受一个**会抛错的 `onSpawnIdentity(pgid)` 合同**,在 `spawnFn` 返回后、**第一个 await/socket 轮询之前**同步调用——原子合并进程组身份进 `session.json`;钩子抛错 → 走既有 failed-spawn kill/verify 清理(codex-daemon-runtime 既有机制重构复用,不造第二个 reaper)后 reject(不许无主 daemon 继续)。**同 PR 删除** goal-runtime 里 await 之后、吞错的 `onDaemonPid` 调用路径(新路删老路红线,禁双所有权账并存);
   - 探针配套语义(R3 #1):持久化组活着或不可判 **且** socket 缺席 → **unknown**;`absent` 判定要求「无 socket listener **且** 持久化组无存活」双证;
2. Bridge 三条 teardown 路径(`handleTerminate`/`closeRunner`/`close-tmux`)在删 CommDB 行**之前**调用该原语(经 `codexSessionStateDir(execId)/session.json` 定位,不在 Bridge 复制弱化版所有权逻辑);
3. **终态证据**:收割完成记 teardown receipt `exec_host_processes_reaped`(socket 死亡 + 组内无存活 census);残留则 receipt 记 residual + 既有 workflow_engine alert(幂等 uid=execId),不阻断 teardown 本身;
4. 非 Codex 体:pane 后代闭包沿用 FLY-1759 已 merge 的 `pid+lstart+command` 栅栏模式收割,pgrep census 仅作**旁证**不作主证。

**净删除**:`prepareCodexPhaseShutdown` 的 target_gone→legacy no-op 回退分支;运维手工 kill runbook 降级为逃生口。
**验收**:重放 e244d9c6 形态——`close_runner abandon` 后 60s 内 daemon socket 死亡、组内无存活;terminated 体不再向 CommDB 发信。**窗口期用例(R3 #1 口径,不止 thread-ready 前)**:刻意在 socket 创建**之前**暂停 spawn → 该窗口内 Bridge crash/terminate → 身份账在、收割收敛;持久化失败路径 → partial spawn 被杀验后 reject;真 wrapper/reaper 全链收敛。

### Fix 4a-A quiescence 探针判死(④a,P0)

**现状与修向**:research §4 4a——`collectRunQuiescenceEvidence` 不传 `allowMissingTargetHostAbsence` → 正规拆除的体永远 unknown→live。
**R1 修正(Codex #5)**:探针 seam 是二参类型,多处显式传裸探针——不是字面一行。

**修法**:默认探针改为**包一层策略的 wrapper**,生产 call site 停止显式传裸探针(统一走 wrapper);测试替身保持二参可赋值。校验器 `validateNeedsLeadReworkQuiescenceTx` 不动。
**R2 修正(Codex R2 #1)**:只加 `allowMissingTargetHostAbsence` 不够——`hasHostProcessByExecutionId` 仍是 `pgrep -f <execId>`,而 daemon 的 argv 不含 exec id;5-A 允许 reap 失败后 teardown 继续删 CommDB 行,会出现「socket 活 + 无 CommDB + 无 tmux + pgrep 无命中」→ 裸 wrapper 误判 dead。**wrapper 必须组合 daemon 活性主证**:
1. claude-runner 随收割原语一并导出**非破坏性** `probeCodexDaemonLiveness(execId)`(socket 两证同源:socket 存在 + `lsof` 持有者属持久化进程组);
2. 生产 wrapper 判定序:daemon socket 判活 → **非 dead**;socket/组探查不可判 → **unknown**;仅当 socket 证实缺席 + 既有 tmux/host 缺席证据齐 → **dead**。reap 失败的残活 daemon 因此天然构成 quiescence 否决(不需要额外 veto 账);
3. **回归必须打真生产 wrapper**(不许注入假 hasHostProcess):含「reap 失败→CommDB 已删→daemon 仍活」用例判非 dead;收割成功后判 dead。
**同 PR 依赖**:Fix 5-A(探针与收割共享 socket 身份派生)。
**验收**:重放 8-21 06:00Z 正门实测——canonical terminate 全家后 rework 过 quiescence 门。

### Fix 4d-A rework baseline 接受 ff 后代(④d,P0)

**修法**(不变,R1 确认 Keep):两处同构断言(rework 与 ship-carrier)统一为 `HEAD == base || git merge-base --is-ancestor base HEAD`;非 ff 改写仍拒、仍耗预算;**同 PR 收敛双拷贝为一个共享函数**。
**验收**:重放 1925 案 3——QA 推报告 commit 后 rework 一轮送达,零 hold。

## 2. 投递学(P0):② 交棒必唤醒、唤醒必回执、回执缺席必响

### Fix 2-A TURN-wake ACK 投影驱动交付结算(P0,核心;R1 #1/#2 重写)

**现状**:文件写成功 → `wake_delivered` → 停滞检测失明(research §2)。
**R1 修正**:既有 `onReceipt` 只投影 ship_carrier;`recordWorkflowCarrierWakeReceipt` 要求先处于 `wake_delivered` 才能进 `receipt_started`(停在 turn_granted 会把 carrier 回执打成 `carrier_wake_receipt_not_ready`);rework 完全没有回执投影;`claimWorkflowReworkDelivery` 每次续租刷 `updated_at` → 停滞钟被 reconcile 自己复位;漏 ACK 不消耗 hold_count;`push_count CHECK(0..2)` 改约束要 SQLite 表重建。

**修法**(以既有 TURN-wake `onReceipt` seam 为唯一回执入口,幂等投影,不改 CHECK):
1. **回执投影**:`onReceipt`(runner 跑 `flywheel-comm turn` → `ackTurnWakes` 已有链)新增幂等 StateStore 投影方法,键 = (activation, execution, epoch):
   - **rework 面**:ACK 到账 → `turn_granted → wake_delivered` 原子翻转 + 释放 coordinator ownership + 保留既有 `rework_recovered` 事件效果。`wake_delivered` 的语义从「文件写成功」**变为「接棒人已消费」**——原写成功即翻转的代码同 PR 删除(净删除);
   - **carrier 面**:同一 ACK 原子走完既有语义链(`turn_granted` 确认 + `wake_delivered` + `receipt_started`),不对既有方法在非法前置态上硬调;
   - **carrier 等待期重放语义(R2 #2 + R3 #2)**:carrier 今天在**两处**晋级——立即发送成功与下轮 reconcile 的 `wake_already_sent`;两处**同删**,统一替换为幂等中性结果 `awaiting_receipt`(rework 面同样显式定义此中性 post-send 结果,两 coordinator 同合同):
     - **耐久停驻,不是每秒重claim**(R3 #2:dispatcher 1s tick,若每中性 pass 释放-再claim,会每秒刷 generation/事件/git+活性探针):`awaiting_receipt` 落账时清 owner/lease **并写 `next_retry_at`**;hold 预算/失败账/稳定 grant 时戳/last_error 一律不动;
     - **重探节奏定死(R4 #2)**:两 coordinator 统一默认 **3 分钟**(env 可调;与既有 turn-wake T1 默认对齐,不引第二种节拍);每个中性 due pass 把 `next_retry_at` 从**当前 due 时刻**推进一档,稳定 grant 时戳不动;「每 pass 重跑 reentry 分类」= 每个 **due** pass;
     - **ACK 即时晋级旁路**:TURN receipt 投影不等 `next_retry_at`,到账立即晋级;
     - **metrics 豁免**:carrier drain 现把非 busy/settled/wake_delivered 的结果全计 held——`awaiting_receipt` 显式豁免于 held/delivered 计数;
     - **崩溃/重放覆盖**:wake-send 账已落而 ACK 未到 × Bridge 重启;重复 pass 幂等;迟到合法 ACK 晋级;stale/错 epoch ACK 拒绝;**180s 模拟 1s-tick 测试断言具体上限(R4 #2)**:3 分钟节拍下 ≤2 次 delivery claim、≤2 条 claim 事件、≤2 轮 git/活性探针、恰 1 次 TURN grant,含恰在 due 边界的行为与 Bridge 重启穿越;边界前任意时刻 ACK 即时投影晋级;
2. **推送预算不变**:保留 T0 + 验证过的 T1 两推(CHECK 不动、无表重建);第二推起挂 Fix 2-B doorbell;
3. **失败 owner 唯一化**(Codex #1 要求二选一):选 **stall 路径**——`turn_granted` 本在 30/60min stall 扫描内,但停滞钟基准从会被续租复位的 `updated_at` 改为稳定的 `grant_started_at/turn_granted_at`;5-hold 路径维持只处理显式交付失败(不叠加 ACK 超时双轨)。ACK 超时的终局处置 = stall 的既有 30min alert / 60min hold(severe,经既有 alert 位点);
4. **死体自愈**:未 ACK 期间每 reconcile pass 重跑 `classifyPhaseActorReentry`——接棒体死了自动转 replace(闭案 4「wake_delivered 投死体」);
5. 划界:Flow-1/instruction lane 的 FLY-1795 结算不动;no-transport 体(agy/kimi pr_handoff)本就不进 wake 环,transport 维度豁免。

**验收**:重放 1925 交棒——健康接棒人 ≤180s ACK 并动起来;打死接棒体重放——delivery 停 `turn_granted`,转 replace 或 30min stall alert(以 grant 时刻计龄,续租不复位),**绝无未消费的 wake_delivered**。

### Fix 2-B goal-achieved Codex 内建 doorbell(P0;R1 #3 修正)

**现状**:停驻 Codex watcher 生命周期脆弱,Lead 手工敲 TUI 能动(research §2 2d/2e)。
**R1 修正**:既有 `wake_pointer` 短语指向 `flywheel-comm inbox`——TURN 交棒必须跑 `flywheel-comm turn`;不能悄悄改 instruction-lane 短语。

**修法**:`runner-recovery-nudge` 新增**typed TURN-pointer purpose**(独立短语「run flywheel-comm turn --exec-id …」,不动 inbox 短语);在**第二次未 ACK 推送**时触发,目标限定 codex-transport 且 TUI pane 探活;既有 liveness/status/pending-gate 守卫全保留并按 goal-achieved carrier 实际 status 集实测。deps 在 plugin 调用位补齐(FLY-1448 durable-park fence)。
**同 PR 删老路**:老 receipt-triggered wake 路径在新路 live 后同 PR 删;死代码(`envelope_json` 分支、`admission_state` 读者族、无消费者的 `wake_failed` episode 生产者)一并清(接消费者或退役,二选一,本计划选**退役**——其语义被 2-A 的 ACK 停滞路径覆盖)。
**验收**:构造 watcher-dead 停驻 Codex,交棒后第二推 doorbell 注入、runner 跑 `turn` 并 ACK;实测 goal-achieved 各 status 守卫不误拦。

## 3. 状态学 A(P0):① 复活体不得直通 ship 卡(R1 #8 修正)

### Fix 1-A 开卡断言:QA PASS 必须绑当前 head(P0)

**修法**:
1. `createWorkflowGateHolderTx` 在 holder/carrier 副作用**之前**,比较规范化的 `proof.subjectDigest` 与 `input.runnerShipHeadSha`,不等则 `throw new WorkflowEngineInvariantError("runner_ship_qa_head_stale")`——走 FLY-1912 已 merge 的事务内捕获 → typed 409 `engine_invariant:<reason>` + 拒绝事件 + 幂等 Lead alert(裸 `Error` 会漏成 500,禁);
2. **qa_passed 的 head 撤销钩子**:不盲抄 design_review 版(它只在 review 节点的 materialization push confirmation 跑,Codex #8)——挂在**权威当前-head 变更位点**(`recordWorkflowNodePrBindingTx` 等 PR-binding head 写入路径),按 exact producer/run/node 绑定撤销 `subject_digest ≠ 新 head` 的 `qa_passed`(reason `materialized_head_superseded` 复用)。撤销后既有 revoked 检查免费拦开卡,QA 循环边自然要求复测;
3. founder 免 QA 通道:**本期不建**(P2,§7)。

**验收**:重放 1894 全形态——复活体带新 head 完成 → 开卡被 `engine_invariant:runner_ship_qa_head_stale` 拦下;QA 复测通过后新 head 开卡。

### Fix 1-B 复活体失去 writer 资格(P0)

**修法**:
1. `assertCurrentWorkflowWriterTx` 从 boolean 改为**结构化分类返回**(外提供 bool wrapper 兼容既有 caller),新增 session-status 谓词:session ∈ `OPERATIONAL_TERMINAL_STATUSES` → 分类 `writer_session_terminal`;session 行缺失 → fail-closed 拒绝;**幂等 completion replay 检查保持在栅栏之前**(不破坏重放);
2. 不动 workflow-fsm 边语义(「能否继续当 writer」≠「FSM 有无出边」);
3. dead-exec reconciler 的 `探活 && session 终态` 分支:静默 `continue` → 幂等 engine alert(uid=execId)上浮「复活体在场」,不自动杀(可能是 founder 留窗取证),Lead 按 FLY-1894 R5 恢复类规则处置。

**焦点测试**(Codex #8 点名):completed session 的重放/收尾上报不被误拦;`ship_parked` carrier 正常写;`awaiting_review` 权威保持;terminal session 的**新**提交被拒。
**验收**:force-fail → 复活 → POST completion/claim 全部 typed 409,alert 一次,run 零污染。

## 4. 状态学 B(P1):③ 孤儿闸收口 + 监控 + TURN 存量收敛

### Fix 3-A founder_review 并入 supersede/retirement(P1;R1 #6 重写)

**修法**(显式 allowlist,不做 blanket 退休):
1. CommDB 三处 checkpoint 过滤(`getGatesForSupersede`/`getSupersededGates`/`canSupersedeGate`)扩为显式 `{approve_to_ship, review_design, review_code, founder_review}`;
2. `TerminalGateRetirement` 的过滤改为显式 `{approve_to_ship, founder_review}` allowlist(**不是**删掉判断——否则把所有 checkpoint 一锅端);
3. **founder_review 身份解析不走可能已 prune 的 session 行**:从不可变的 gate content JSON(runId)/ holder binding 派生 issue/run 身份(`issueFor` 的 session 映射对 pruned 源返回 unmapped,Codex #6);
4. **枚举不依赖 TTL**:候选查询用 canonical「未答 + 未 superseded + relay-open」谓词,绕开 `getPendingGatesByRunner` 的 `expires_at > now` 漏网(relay-open 但已过 TTL 的闸今天会被漏掉);
5. **founder_review 退休三条件(或)**,任一才退:(a) 存在同 family 更新一轮 gate;(b) 外部终局权威(issue Done / PR merged)**当场重新验真**;(c) 其 workflow activation/holder 已非当前。单纯「源 session 终态」**不足以**退休——active/held run 可能仍拥有这张 founder 正在看的卡;
6. 原语统一:`retireQuestionGuarded` 扩展合同(接受 caller time 与 `resolved_via`,返回 `retired/already_retired/response_won/missing`),保并发 response-wins;`retireGateForTerminalAuthority` 被统一后的 approve_to_ship 专用逻辑同 PR 收敛(净删除)。

### Fix 3-B 孤儿闸监控 rider(P1;R1 确认 Keep)

GatePoller 既有 rider 家族新增一个(per-N-ticks + kill-switch env),四条与判据:
- 闸开着:canonical answerable 谓词(`relay_state != 'terminal_disposed'`,不用 expires_at);
- **run 活着 = `status ∈ {active, held}`(held 显式算活)**——QA 四格实测:真死 run 多半已 held,不算活则 1758 类两头都不报;completed/terminated run 的开闸交 Fix 3-A 退休,不 page;
- 未 superseded:`superseded_at IS NULL`(3-A 落地后跨 run 可信);
- 没人答:无 response 子行;
- 超龄 > 24h(env 可调),告警走 `enqueueWorkflowEngineAlert`(幂等 uid = 闸 id + 龄级 24/48/96h,有界重报),投 Lead 不直 page founder。

**合同缺口显式决策**:founder_review 保证「开过」≠「她看见了」。第二信号:**无 `founder_review_card_binding` 的开闸 = 从未渲染 = 构造上不可答 → 首个 tick 即上浮**(文案区分「超龄没人答」vs「从未送达」)。完整阅读回执 UX 留产品单(P2)。
**验收**:1758/1911 重放零告警(被 3-A 关掉/标掉);四条与形态上浮;无 card_binding 立即上浮。

### Fix 3-C TURN 存量收敛:可证形态分类清扫(P1;R1 #7 重写)

**决策维持**:一次性收敛(boot 全量清扫)+ 常态 rider 防再淤,不选巡检渐清(论证见 R1 版:死棒是孤儿闸再生泵;158 根同时亮红 = 监控噪音死法;boot 清扫位点已存在)。
**R1 修正**:「holder 不可逆终态」谓词盖不住全部 158(census 是死宿主探针口径——session 行可能已 prune 或 status 陈旧非终态);接口还暴露非 CAS 的 `deleteTurn`;engine-ownership 查询是历史口径。

**修法**(分类清扫,fail-closed 残余点名):
1. 释放谓词两类,各自可证:
   - (a) holder session 不可逆终态 **且** 无当前 active/held activation 引用(activation 查询用 exact 当前口径,含 held run);
   - (b) holder session 行缺失 **且** 授棒超过 grace 期 **且** 无当前 active/held activation **且** host/tmux 双缺席阳性证据(走 4a-A 的判死 wrapper);
2. 模糊行 fail-closed 保留,**清扫总结上浮残余计数与形态分布**(不承诺归零;残余按形态立 follow-up);
3. 释放只走 `deleteTurnIfCurrent`(epoch CAS);接口收编:reconciler 内非 CAS `deleteTurn` 用法同 PR 移除(净删除);
4. 谓词携带 `three_stage_turn` 自有的 run/node/attempt/activation 身份列做绑定校验;
5. 并发测试:与 `grantTurn` 两种竞态次序(先 grant 后清 / 先清后 grant)各一条用例;
6. 常态防再淤:检查并入既有 reconcile-patrol 节奏(rider 搭车,零新 timer),替代「只在 boot 一次」的孤例形态。

**验收**:部署重启后两类可证形态全释放;残余计数上浮点名;「engine-owned run + holder 活着」阳性对照不误释放;双竞态用例过。

## 5. 状态学 C(P1):④b/④c needs_lead 出口与 start 预约(R1 #9 修正)

### Fix 4b-A needs_lead resume 端点(P1)

**R1 修正**:盲重臂同一 request/delivery 会唤醒同一 terminal actor 或保留 `retain_ambiguous_grant` TURN;既有 `openOperatorRework` 已是更安全的 operator-replacement 事务。
**修法**:`POST /api/runs/:runId/rework/:requestId/resume` 做成**薄幂等 wrapper**,内部走既有 `openOperatorRework` 替换事务(新 attempt,不是复活旧 delivery);actor+reason+审计行照抄 `resumeHeldLandOperation` 模板;外部真值 = 现跑一次 4a-A wrapper 探针。
**R2 精确化(Codex R2 #3,跨库崩溃收敛合同)**:
1. **绑定校验**:`expectedNeedsLeadRequestId`(路由 `:requestId`)写进事务前置条件与幂等 payload——现有事务只按 run 取最新 needs_lead 行,路由参数必须被证明就是被替换的那条,不符返回 `resume_refused:request_not_current`;
2. **顺序与清理账**:StateStore 替换事务**先 commit**,并在事务内持久化旧交付的精确清理身份(issue, holder execId, epoch, wake id);随后按账**只**取消该 wake id + `deleteTurnIfCurrent(旧 holder, 旧 epoch)`(CommDB 侧);
3. **清理义务重驱动**:StateStore 已 commit 而清理未完的崩溃形态,由端点幂等重放或既有 patrol 按账重驱直至结清;turn-wake `canDeliver` 守卫作 outbox 崩溃兜底;
4. **测试**:错/陈旧 requestId 拒;StateStore commit 后崩溃 → 重放补清理;幂等重放;与并发新 `grantTurn` 竞态(CAS 不误删新棒)。
**定位**:④a+④d 落地后 needs_lead 发生率大降,此端点是兜底出口,P1。

### Fix 4c-A start 预约对终态 exec 失效(P1)

**R1 修正**:不能改通用 accessor(`getWorkflowStartReservationForRun` 被 active-run 分类复用,藏行会把可识别 run 打成 `*_RUN_STATE_CORRUPT`)。
**修法**:终态分类加在 `inspectWorkflowStartReplay`(或专用 `getReplayable*` accessor),返回机器可辨的 terminal-execution reason;通用 accessor 不动;实现前与 FLY-1638 **已合基座**(#779 的 lease/tombstone)及其 diverged follow-up 分支对齐,已覆盖则降为验收用例。

## 6. ⑥ finalization 跨 epoch 收敛(P1;R1 #10 重写——归本单,不再让位)

**依赖更正**:FLY-1770(#845)**已 merge**。其 retry 预算刻意 per progress-epoch:epoch 键派生自 `COUNT(land_operation_step)` + `current_step`——**任何新 step receipt 都推进 epoch 并复位 retryCount**。原 6-A(announce 按 stage+reason 发)会**制造更多 step receipt → 更频繁复位预算 → 反向恶化**。故跨 epoch 收敛是本单的活,1770 不会再补。

**修法**(R2 #4:合同定死,不留备选):
1. **Fix 6-C(新,前置)**:land operation 增加两列——独立单调 `closeout_attempt_count` + `first_closeout_attempt_at`:
   - **递增位点唯一**:仅在 `finalize()` 返回 incomplete 的 closeout release 位点(land-executor 的 finalization-partial release)原子 +1;`releaseLandOperationWithRetryAccounting` 服务的其它 retryable land 阶段(merge/CI 等)**不碰它**(全局逢 release 就加会在 closeout 之前耗尽预算——Codex R2 #4 点名的两个错误边界都排除);
   - **复位边界显式**:任何 step/notification receipt、epoch 推进、lease 续租**均不得**改它;唯二复位 = operator `resume`(比照 `resumeHeldLandOperation` 的 re-arm 语义)与 operation 被 supersede(新 operation 从 0 起);
   - **终局阈值显式**(R3 #3 边界定死):`closeout_attempt_count >= 13` **或** `now - first_closeout_attempt_at >= 48h` → `held` + 既有 severe 升级(阈值 env 可调,默认写死此二值;边界用例:attempts 12 不 held / 13 held;48h−1ms 不 held / 恰 48h held);
2. Fix 6-A(改造后):announce receipt 键 stage+reason——**仅与 6-C 同 PR**(否则反向恶化,禁独立先行);
3. Fix 6-B:`recordWorkflowLandPartial` escalationUid 的可见性龄级(1/4/8 次桶)消费 6-C **post-increment 值**(与 held 判定同源同值);
4. 根因解堵仍由 P0 承担(⑤ 杀净 + ④a 判死 → `confirmedGone` 通 → `issue_closeout_incomplete` 大头消失)。

**测试**(Codex R1 #10 + R2 #4 + R3 #3):交替 `issue_closeout_incomplete`/其它 partial 序列,贯穿 thread archive → Linear disposition → 本地清理 → 终局升级;断言**精确终局边界**(attempts 12/13 与 48h−1ms/48h 四例),不只断单调;notification receipt 注入后计数不动。
**验收**(founder 原话口径):ship 完 thread 自己消失;partial 要么收敛要么升级,无「安静停在 partial」稳态。

## 7. 优先级与舍弃清单(禁静默丢)

| 级 | 项 | 理由 |
|---|---|---|
| **P0** | 5-A、4a-A、4d-A;2-A、2-B;1-A、1-B | 三起 P0 事故直接根因;5-A↔4a-A 同 PR 硬耦合 |
| **P1** | 3-A、3-B、3-C;4b-A、4c-A;6-C、6-A、6-B | 1758/1911 慢性病;4b 兜底出口;⑥ 跨 epoch 收敛归本单(R1 #10) |
| **P2(点名不做)** | ① founder 免 QA 通道 | 零事故需要过,不先开绕过口;拒绝理由 + 既有 kickback 面临时承担 |
| | ② legacy `sendRunnerWake` 静默三兄弟接消费者 | legacy 路径,事故全在引擎路径;再出案升 P1 |
| | ③ 三套终态词表统一 | 1-B 用 OPERATIONAL 集合已闭事故形态;立独立 refactor 单 |
| | ④ founder「她读了」回执 UX | 产品单;3-B 已收敛到「未送达必上浮」 |
| | ⑤ 3-C 清扫后的模糊残余 | fail-closed 保留 + 计数上浮,按形态立 follow-up 单 |

## 8. 净删除清单(同 PR 义务)

| 删什么 | 随哪个 Fix |
|---|---|
| 「文件写成功→wake_delivered」翻转代码(rework/carrier 两面) | 2-A |
| `runner_phase_wakes.envelope_json` 死分支 + `admission_state` 无写入者读者族 + `wake_failed` episode 生产者(退役,语义被 2-A stall 路径覆盖) | 2-B |
| 老 receipt-triggered wake 路径(新 TURN-pointer doorbell live 后) | 2-B |
| `assertWorktreeReady` 与 ship-carrier 同构双拷贝 → 单共享函数 | 4d-A |
| `retireGateForTerminalAuthority` 被 `retireQuestionGuarded` 扩展合同统一后的专用逻辑 | 3-A |
| `TurnBeltReconciler` 的 engine-owned 全量跳过(收窄为谓词跳过)+ 非 CAS `deleteTurn` 用法 + 「只在 boot 一次」孤例调用形态 | 3-C |
| `prepareCodexPhaseShutdown` 的 target_gone→legacy no-op 回退分支 | 5-A |
| 手工 kill / 手动 archive runbook 常态化用法(端点保留为逃生口) | 5-A/⑥ |

## 9. PR 切分、依赖序与验收矩阵

| PR | 内容 | 硬门 | 重放验收(真机/529 隔离房) |
|---|---|---|---|
| PR-1 判死+收割 | 5-A + 4a-A + 4d-A | 5-A↔4a-A 原子耦合;同步 `onSpawnIdentity(pgid)` 钩子(pre-socket)+ 同 PR 删 post-await `onDaemonPid` 老路 | e244d9c6 树亡+socket 死;06:00Z rework 过门;1925 案 3 一轮送达;**pre-socket/pre-bind 窗口**身份+收割收敛(暂停 spawn / crash / 持久化失败三形态) |
| PR-2 投递闭环 | 2-A + 2-B | 回执投影/稳定停滞钟设计先行(#1/#2);TURN-pointer 短语与 status 守卫实测(#3) | 1925 交棒 ≤180s;死体转 replace;watcher-dead doorbell 唤起;stall 钟不被续租复位 |
| PR-3 复活免疫+开卡断言 | 1-A + 1-B | WorkflowEngineInvariantError 通道;writer 结构化分类 + 四组焦点测试(#8) | 1894 全形态:复活体 409、卡拦、复测后新 head 开卡 |
| PR-4 孤儿闸+TURN | 3-A + 3-B + 3-C | 显式 allowlist + 三条件退休(#6);两类可证谓词 + CAS-only + 双竞态测试 + 残余点名(#7) | 1758/1911 零告警;四条与上浮;无 binding 立即上浮;两类死棒清、阳性对照不误杀 |
| PR-5 出口+收官 | 4b-A + 4c-A + 6-C + 6-A + 6-B | 4b 薄 wrapper 不盲重臂(#9);6-C 先于 6-A(#10);与 1638 基座对齐(#9/#11) | needs_lead resume 全链;STALE_START 解楔;交替 partial 序列总预算单调 |

依赖序:PR-1 → PR-2/PR-3(可并行)→ PR-4 → PR-5。每 PR 独立可 ship、独立可回滚。

### 附:issue 全部追加验收 → 归属映射(Codex #11 要求)

| 追加验收(issue+comments) | 归属 Fix | 测试 |
|---|---|---|
| 1894 重放:判死→复活→完成,卡被拦要求复测 | 1-A/1-B | PR-3 重放 |
| 1925 重放:接棒人 N 秒自动起,零人工 | 2-A/2-B | PR-2 重放(N=180s) |
| 1758/1911 重放不报;四条与形态上浮 | 3-A/3-B | PR-4 重放 |
| quiescence 对「终态+无行+无 tmux+无宿主进程」判 dead | 4a-A(+5-A) | PR-1 回归 |
| wake_delivered 不得投死体算送达 | 2-A(ACK 语义)+重探转 replace | PR-2 |
| start 预约在 exec 终态后失效 | 4c-A | PR-5 |
| replacement terminal_actor 交付重试时复查 | 2-A 每 pass 重跑 reentry 分类 | PR-2 |
| needs_lead 有 Lead 侧 resume 端点 | 4b-A | PR-5 |
| Bridge 启动对 needs_lead/幻影做 reconcile 上浮 | 1-B(reconciler alive+terminal alert)+ 4b-A 入口 | PR-3/PR-5 |
| terminate 按 exec 杀全进程树,无宿主进程为终态证据 | 5-A | PR-1 |
| land finalization 收敛:thread 自己消失、每步 receipt、partial 必收敛或升级 | 6-C/6-A/6-B + P0 根因解堵(1770 已合基座之上) | PR-5 + PR-1 |
| 158 死棒收敛路径(一次性 vs 渐清,论证后选) | 3-C(boot 清扫 + rider 防再淤;两类可证 + 残余点名) | PR-4 |
| held 算不算活显式定 | 3-B(held=活) | PR-4 |
| worktree baseline 接受 ff 后代 | 4d-A | PR-1 |

## 10. 风险与开放问题

1. **2-A ACK 依赖面**:no-transport 体豁免(transport 维度);`flywheel-comm turn` ACK 是 TURN WAIT LAW 既定动作,Claude/Codex 两 vendor 都有。
2. **3-C 误释放**:双证谓词 + CAS + 双竞态测试 + fail-closed 残余;生产存量数字部署时复核(research §9 过期表)。
3. **4a-A 与中性化的宽松校验器**:只修严格版证据输入,不复活宽松版;founder 若恢复宽松版重估。
4. **高负载宿主**:所有新探针/收割带有界超时(FLY-1887 纪律);socket/lsof census 在 load>10 实测时延。
5. **529 房重放**:PR-2/3 需真 codex daemon 形态(`reference_real_codex_daemon_qa_harness` 配方);PR-4 的 1758 重放需造跨库闸/run 数据。
6. **FLY-1638 diverged follow-up**:PR-5 实现前 JIT 重读该分支状态,避免与其 tombstone 语义撞车。
7. **R5 非阻塞 advisory(实现护栏,随 PR-2 落)**:(a) 两 coordinator 与 turn-wake T1 的 3 分钟节拍**单一配置来源**,env 覆盖不得把节奏劈成两套;(b) 「恰 1 次 TURN grant」测试须强制 due 重放**复用持久化的 epoch/wake 身份**,不许靠第二次 `grantTurn` 恰好幂等蒙混。
