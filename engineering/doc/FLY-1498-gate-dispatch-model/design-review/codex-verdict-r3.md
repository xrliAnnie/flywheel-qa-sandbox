# Design Review — plan.md (FLY-1498) (Round 3)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已经关闭 Round 2 中最核心的裸-head evidence、非写者吸收 diff、二轮 lineage 闭包、Git raw 字段缺失和 completion replay 顺序问题，设计离可并稿只差一轮收口。但仍有四个 safety gaps：rework/取消等失效动作可被已 accepted 的 ship 穿透，revision 没有处理 active task 或自身 replay，copy 检测会把 product→docs/test 降档，以及一个 span 跨多个权威 writer 时 cross-family 仍按单一作者判断。三条 ship 条件因此尚未在全部已枚举交错下证明充分。

## What's Good (Keep)

- `subject_digest = H(repo,base,head,manifest_digest,classifier_version,review_kind)`、`review_requested` receipt 与 completion-time recomputation 已经真正绑定被审 span；wrong-base、subset 和 old-request 不再能靠同 head 复用。
- 非写者完成强制 authoritative HEAD==tip，并增加 read-only spawn backstop；writer handoff 又要求旧 attempt terminal 加 absent/forced-readonly，这正确修复了 B5 中“QA 抢走 writer span”的 Round 2 反例。
- rework 现在先解 `predecessor.lineage_root_id` 再沿 root edges 求闭包，且 active downstream 的 attempt/activation/capability/terminate command 同事务收口；两轮 implement↔QA 验收直接覆盖了先前漏下游的路径。
- ship command 把 `executing` 定为外呼前不可撤销点，revision 能取消 pending/claimed/accepted；这是不可逆 merge 与 SQLite authority 之间正确的线性化骨架。
- `--raw -z --no-abbrev`、A/D/M/R/C/T 状态表、head-side artifact existence、manifest 独立事件与 payload 上限均使 classifier/1s 预算比 Round 2 可实现得多。
- completion event fast path 已前置，能在 worktree 删除、HEAD 移动和 registry cutover 后重放；failed/canceled/superseded 也正确回归普通 conflict。
- L/V/X/H 与压缩稿都随详细设计更新；founder 四句原话、test-only 豁免、CI 世界约束、单 worktree 首版和 design-only/batch-3 分界保持一致。

## Issues & Recommendations

1. **[HIGH] `executing` 线性化只接到了 revision，没有覆盖所有会撤销 ship authority 的状态变化。**

   S2 只规定 revision 事务取消未 executing 的 ship command（`plan.md:122`）；D3 rework 仍只 expire gate（`:171`），S1 开新 gate/supersede 旧批准也只 expire gate（`:115`），B7 issue/task cancellation 则没有 command 处置。可复现交错是：所有节点 done、gate approved；ship command 已 claimed/accepted；Annie 要求 rework，D3 建 successor 并 expire gate；旧 command 仍可 CAS accepted→executing，PR head/tip 未变，expected-sha merge 成功。merge 时条件 2 已经不成立，但三条件只在旧 claim 时检查过。

   同一漏洞适用于 founder 改主意后开新 gate、B7 取消以及任何非 revision 的 gate revocation。它不是 expected-sha 能发现的 head race，而是旧 authority token 仍可生效。

   **建议修复**：抽成唯一的 target-scoped `invalidate_ship_authority` 事务原语，所有 rework、B7 cancellation、gate supersession/revocation、excision/revision 都必须调用：同 target 存在 executing command 时按既定不可逆规则 conflict；否则先 CAS cancel 全部 pending/claimed/accepted ship commands，再 expire/supersede gate并提交业务变更。若取消命令 CAS 失败，整个变更回滚重判。V8 增加 accepted-ship↔rework、accepted-ship↔B7 cancel、accepted-ship↔new-gate 三组双序测试。该原语由 B7/D2/D5 已枚举场景需要，不是第四个 ship gate。

2. **[HIGH] Revision 尚不是完整的 task/graph 状态机：active task 会留下活 attempt/writer，且没有稳定 graph CAS/replay contract。**

   D2 excision 只把 target task CAS→canceled 并写事件（`plan.md:152-157`）。若 target 正在运行，attempt、activation、generation/writer capability、launch/terminate command 与进程全部仍活；ship 条件 2 却立即把该 task 当 excised 放行（`:126`）。这违反 scenarios B7 的“活 attempt 终止”和 FINAL 的单 writer 红线。类似地，revision 允许修改未完成 lineage 的合同/依赖，但没有规定 active attempt 如何处理：给 running task 新增未满足依赖后，旧 runner 仍可能按 C4 完成，因为 completion 没有 dependency predicate。

   revision 本身也没有 `revision_uid`、same-key replay、different-payload conflict 或 `expected_before_graph_digest` CAS。commit 后丢响应的重试只能再次碰 task CAS；两个基于同一旧图的 revision 也没有 authority cut-off。append-only `dag_revision` 只记 before/after digest 和 excised ids，却没有钉死哪个 revision/digest 是当前成员集；若未来允许 re-add，历史 excision event 还会错误继续豁免条件 2。

   **建议修复**：选择最简单且可执行的一条规则：revision 涉及 active attempt 时一律 conflict，要求先走 D3/B7 的全生命周期终止；或在 revision 同事务复用 D3 转移（attempt+activation terminal、capability revoke、terminate outbox、task state 重算）。任何依赖变更都要重新计算 ready/blocked，并禁止旧 activation 在新图上完成。再用现有 `meta` 增加 per-issue `dag_tip`/current graph digest：caller 带稳定 `revision_uid + expected_before_digest`，事务 CAS before→after并写 `event_uid='revision:'+revision_uid`；同键同 payload返回首次结果，异 payload conflict。明确 excision 是否永久；若可 re-add，ship 只读 `dag_tip` 指向的 current membership，不能匹配任意历史事件。admission/revision 验证清单也应显式包含 `condition IS NULL` 白名单。V14 增加 active excision、active task 新增 blocker、commit-before-response replay、同 base 并发 revisions。

3. **[HIGH] `--find-copies` 的 best-effort 边界并非 fail-closed，会把 product_code copy 降成 docs/test 并免评审。**

   X 已承认 `--find-copies` 默认只从本次也被修改的 source 寻找 copy（`plan.md:230`）；本机 Git 官方帮助同样明确：未修改 source 只有 `--find-copies-harder` 才会进入候选。于是未修改的 `src/auth.ts` 被复制为 `docs/auth.ts` 时，当前命令会把它报告为 `A docs/auth.ts`，按新路径归 docs 并免评审；若识别成 `C`，C2 才会按两端最严归 product_code。X 所称“A 独立分类仍 fail-closed 不漏档”因此不成立，压缩稿的“R/C 两端最严”也掩盖了实际漏档。

   rename/copy 结果还可能受 rename-limit 影响；若 Git 因候选过多跳过检测而实现仍把 A/D 当正常结果，同样不是确定性 fail-closed。

   **建议修复**：对当前承诺最直接的实现是启用 `--find-copies-harder`，固定 similarity/rename-limit 语义，并把任何“检测因 limit 不完整”的 stderr/result 判为 proposal rejected；该工作在事务外且已有 10k/2MB cap。若性能上不能接受，就必须把“product source copy 到 docs/test 可降档”升级为 founder 明确认可的保护削减，不能称作 fail-closed。V6 增加“未修改 product source→docs/test copy”以及 rename-limit exhausted 两例，均不得落免评审档。

4. **[HIGH] Cross-family 的 `author_family` 仍只能表示一个 lease holder，但受支持的 C5 handoff 可让同一未完成 span 含多个权威作者族。**

   C3/D1 把整个 span 的作者归为单一“writer lease 持有 attempt”（`plan.md:79-84,147`），subject digest 也不含 author identity。反例不需要 H 的外部旁路：tip=B；Codex writer A 写 product commit H1 后因 C5 失败，tip 仍是 B；Claude writer B 保留 H1、继续写到 H2；随后 Codex review B..H2。机器把 author 记成当前 Claude，看到 reviewer Codex≠Claude 就通过，但 H1 实际来自 Codex，reviewer 对 span 的一部分是同族。H 只声明了“异族进程旁路写入”的残余风险（`:235`），没有覆盖这个完全受支持、且 authority 已知的 sequential handoff。

   同 digest 复用也没有 author binding：相同 manifest 在 writer family 改变后仍可复用旧 request，即使旧 reviewer 等于新的 authoritative author family。

   **建议修复**：要么强制 writer handoff 时 discard/隔离未完成 span，使每个可评审 span 只有一个作者族；要么权威记录自 base 起所有贡献该 span 的 writer attempt/family，令 subject digest 再绑定 canonical `author_family_set_digest`，完成时要求 reviewer family 不属于该集合。后者可由 lease handoff receipts 推导，不信 Git author metadata。V4/L 增加 C5“Codex 写一半→Claude 接手保留 diff→Codex review”及 same-manifest/different-author-set 两例。若产品决定“跨族只相对最后 lease holder”即可，也必须由 founder 明确裁定并进入 FINAL 的 honest boundary，不能由计划作者默认为满足跨族要求。

5. **[MEDIUM] 详细版、验收和压缩权威仍有几处谓词不一致，应随上述修复一起收口。**

   - V4 声称所有拒绝“零残留”（`plan.md:206`），但 C2 会在 completion 事务前持久化 `span_manifest`；非写者 HEAD≠tip、subject mismatch 等拒绝后该 append-only event 合法保留。应改成“completion 状态转移零残留”，并明确 manifest/review/obligation evidence 的预期残留。
   - D1 允许 non-writer 用“read-only checkout/分离快照”，而 V12 要求 writer commit 后 non-writer 观察 HEAD≠tip。C2/C4 必须明确这里的 HEAD 永远来自 canonical ship worktree，不是 session snapshot，否则该验收有两种相反结果。
   - §2 压缩稿保留了“fail-closed copy/单一 lease author 即跨族”的正向结论，却没有并入 X/H 的两项安全边界。`design-FINAL-v2.md` 是 living authority；任何被接受的保护削减必须在主文出现，不能只藏在 design-chain 细节。
   - max-size 成功路径还应验 `span_manifest` 事件落库在 kernel 1s budget 内；现有 V6 只验 over-limit 提前拒绝。

   **建议修复**：修正 V4/V6/V12 的精确断言，并在重新生成 §2 时保留所有 safety-critical honest boundaries、canonical HEAD 来源与 current graph/revision predicates。

## Verdict

CHANGES REQUESTED — address items above
