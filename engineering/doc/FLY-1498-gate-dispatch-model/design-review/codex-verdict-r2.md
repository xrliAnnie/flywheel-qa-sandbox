# Design Review — plan.md (FLY-1498) (Round 2)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 实质性补上了完成事务、可信 manifest、current gate、rework 幂等键、single-target 边界与 crash acceptance，整体模型比 Round 1 完整很多。但三条 ship 前置在 B5 并发、第二轮 rework、DAG/contract revision 和 review-subject 绑定上仍有可复现的穿透；此外 canonical Git diff 规范按现文无法产出它声称校验的字段。故设计尚不能并入活权威并进入 batch 3 实现。

## What's Good (Keep)

- C4 现在把 activation、attempt、task、writer capability、`node_completed` 与 `span_tip` 放进同一 `IMMEDIATE` 事务，并为 completion 定义稳定 event key；这正确关闭了 Round 1 的“task 永不 done/补记录”主缺口。
- manifest 改为 kernel API 侧从 worktree 现场构造，caller 只交 `{task_id, attempt_id}`；unknown source/vendor、异常 Git 对象与 family 自报都转为 fail closed，authority 方向正确。
- canonical ship target、anchor task、current gate supersession、revision 失效批准、fresh PR-head observation、expected-sha 以及 merge effect reconcile 已经分工清楚；CI 仍是 executor 的世界约束而非第四个 gate。
- rework 增加了 `rework_uid`、payload conflict、`state_version` CAS、transitive cascade 表和 attempt-scoped declared evidence；这些是 B2/B3 与 crash replay 必需的基础。
- D1 明确 `writes_code` 为模板数据，X/H 又诚实限定首版为单 worktree/单 PR；没有假装多 target 已被支持。
- L 的 mechanism→scenario 台账、V 的 13 项对抗验收、X 的可砍清单及重新生成的压缩并稿文本，均明显优于 Round 1，且 founder 原话与 Lead 的 test-only/CI/无图上 loop 裁定均被保留。
- design-only 本轮、batch 3+ 再接线的分层仍然合理；没有提前改 FLY-1497 kernel 或 v1 行为。

## Issues & Recommendations

1. **[HIGH] Review evidence 仍未绑定“本次实际被审 span”，跨族与内容域复用可被错误证据满足。**

   `plan.md:74-79` 的 `review_verdict` 只绑定 `{repo_identity, subject_head_sha, review_kind, request_ref}`；完成谓词只比较 head/kind/family，没有要求 `request_ref` 对应当前 manifest，也没有比较 `base`、`manifest.digest` 或 `classifier_version`。同一 head 上针对不同 base、文件子集或旧 review request 的 APPROVED 因而可满足当前 product span。压缩稿 `plan.md:244` 甚至省略了 `request_ref`。

   旁路场景还有第二个 authority hole：`author_family` 仅从“被审 attempt”派生，而 H 明确承认旁路提交会被归到吸收节点（`:217`）。例如 Codex 旁路写入 product code，随后 Claude 非写节点吸收该 span，再由 Codex 给出 APPROVED；机器谓词看到 `Codex != Claude` 会通过，实际却是同族自审。这样未被正确跨族评审的 product diff 可以在三个 ship 条件全绿时被 merge。

   **建议修复**：把 review subject 定义成 kernel 可核的 canonical digest，例如 `H(repo_identity, base, head, manifest_digest, classifier_version, review_kind)`，并要求 `request_ref` 的权威 receipt 正好绑定该 digest；内容域复用只能在 subject digest 相同（或明确定义、机器可证明的覆盖关系）时发生。span 的 author family 必须来自实际 writer authority；吸收的未知/旁路作者无法权威归因时须 fail closed，或改用不依赖不可证明作者归属的明确评审规则。另把 declared `review_approval` 是否必须绑定当前 task/attempt 写成无歧义谓词。V 增加 wrong-base/same-head、wrong-manifest、错误 request_ref 和旁路同族作者四个反例；这些都由现有 V9/A5/A6 场景需要，不是新增保护性场景。

2. **[HIGH] B5 并发与单一 `span_tip` 目前会把一个 writer 的产出记到另一个非写节点，且 writer lease 仍只是声明而非可执行排他。**

   D1 允许非写者与写者在同 worktree 并行（`plan.md:131-139`），而 C2 对任何完成节点都用“当前 `span_tip` → 当前 worktree HEAD”构造 manifest。交错为：tip=B；writer W 提交到 H；并行的非写节点 Q 先完成，于是 Q 的 manifest 变成 B..H 并推进 tip；W 随后看到 H..H 空 span。W 的实际产出被归给 Q，既违反 requirement ②“合同由节点 ACTUAL outputs 派生”，也使 `author_family` 错位；V12 只验调度并行，没有覆盖这个 completion interleaving。

   此外，`writes_code=false` 是模板数据，现文没有说明 OS/worktree 层如何阻止该 session 写文件。C4 只 revoke capability 就释放 lease，而仍存活的旧 session 仍可能写磁盘；这与 FINAL §1.6 的“每 worktree 至多一活 writer”及既有 `design-v2.md:41-42` 的“旧 writer 同 host_epoch 明确 absent 前不得授新 writer”不一致。

   **建议修复**：定义可执行的 worktree-write authority，而不只是调度标签：非写者使用强制 read-only/隔离快照；只有持有效 writer authority 的 attempt 能推进 `span_tip`。非写节点若声称空 span，完成时至少必须验证 authoritative HEAD==tip，不能吸收并行 writer 的未结算 diff；若其 declared verdict 绑 head，还须定义 head 漂移后的重算/重跑。正常完成与 rework 都必须在旧 writer 已被强制降为只读或同 host_epoch 观测 absent 后才可向下一 attempt 授 writer。V12 增加“writer 已 commit、非写者先 complete”和“旧 session revoke 后继续写/新 writer 同时启动”交错。

3. **[HIGH] Rework 的第二轮 lineage 闭包会漏下游，且 active-downstream 转移没有关闭完整 activation/capability 生命周期。**

   边固定指向 admission 的 lineage-root task（`plan.md:149`），但 D3 第 4 步写的是“以 predecessor 为根沿边正向闭包”（`:154`）。第一次 rework 后 predecessor 已是 successor id；B3 第二次打回该 incumbent 时，从 successor id 查 root-edge 得不到任何下游。例：I0→Q0；第一轮生成 I1/Q1；第二轮打回 I1 只生成 I2，Q1 仍为 done，随后 I2+旧 Q1 即可满足 ship 条件 2。V11 的“同 predecessor 再打回应拒”只测重复打 I0，不覆盖合法地打回新 incumbent I1。

   对活跃下游，`:156` 只把 attempt 置 `superseded` 并重置 task；activation 仍 active、writer capability/registry 仍有效，也没有 durable terminate/reconcile command。dispatcher 要么被残留 lease 永久卡住，要么若忽略它就产生双 writer；这也遗漏了 FINAL 已批准的 rework saga 状态转移。

   **建议修复**：闭包查询必须先取 `predecessor.lineage_root_id`，再沿 root-id edges 求传递闭包；新增至少两次完整 implement↔QA 循环验收，断言每轮下游都产生/重置正确 incumbent。active-downstream 的同一事务还要 terminalize activation、revoke generation/writer capability、写稳定 effect key 的 terminate/reconcile outbox，并沿用“旧 writer observed absent 前不授新 writer”的 handoff。same-key replay 必须返回同一组 task/attempt/activation/command ids。

4. **[HIGH] “DAG/合同 revision”只有 gate expiry，没有定义当前图、已完成合同的重验证或与 ship claim 的线性化。**

   D2 只规定 revision 写审计并 expire gate（`plan.md:142-145`）；图校验只写在 admission。于是已 done 节点的合同可被加强、依赖可被新增或改成 cycle，旧 `node_completed` 仍保留 done；重新取得同 head founder approval 后，ship 条件 1/2/3 全可通过，但当前合同从未满足。`plan.md:124` 还允许“剪掉某节点再 ship”，然而现有 17 表没有 graph-membership/tombstone 语义：物理删除会碰 FK/审计，置 canceled 又会被条件 2 拒，置 done 则谎称成功。

   另有不可逆动作竞态：T1 ship claim 验完旧 gate；T2 revision/rejection expire gate；T3 executor 以未变的 expected-sha merge。expected-sha 只防 head 漂移，不会观察 DAG/gate revision。现文没有说明 claim 是否是不可撤销的 authority 线性化点，也没有规定 revision 如何 fence 已 claim/accepted/executing 的 merge。

   **建议修复**：把 revision 定义成完整状态机事务：重跑 endpoint/self-cycle/cycle/condition/≤32/contract schema 校验；明确 current graph membership 的可落地表示；对已完成但受影响的 lineage，禁止原地改合同，或通过与 D3 相同的 successor+cascade 使其重新赚取证据。明确 ship claim 与 revision/rejection 的串行规则：若 revision 先赢则 claim 必须失败；若 claim 先赢，要么明确它是不可撤销授权且 revision 拒绝/延后，要么 revision 同事务 cancel/fence 尚未执行的 command。该 command-authority 规则不是第四个 ship gate。V/L 增加 done-contract-strengthening、删节点、revision cycle、≤32 越界及 claim↔revision 两种顺序。

5. **[HIGH] C2 的 canonical Git diff 规范按字面不可实现，异常对象与 artifact 谓词仍没有确定结果。**

   `plan.md:53` 指定 `git diff --name-status -z --find-renames`，但 `--name-status` 只输出 status/path，不输出它随后要求的 old/new mode 与 blob。对本分支同一 diff，name-status 实际只有 `M <path>`，而 `git diff --raw` 才输出 `:100644 100644 <oldblob> <newblob> M <path>`。同时命令未启用 copy detection，却声明 copy 两端取最严；add/delete 的 absent 侧在 raw 格式是 mode `000000`，按“非 100644/100755 一律拒”会让所有新增/删除失败；C2 允许 100644↔100755 两端，V6 又要求 mode-only 拒，二者冲突。

   artifact 也仍不够精确：`digest_policy=pin` 没有 expected digest/cardinality；删除一个匹配路径的 regular old blob 可能被误判为“交出产物”，但合同应要求 head 侧存在。最后，≤32 只约束 rework 节点数，不限制 manifest entries/bytes；把任意大的全量 manifest 放进 `node_completed` 仍可能越过 kernel 1s 事务预算。

   **建议修复**：改用能真实提供字段的固定格式（如 `git diff --raw -z --no-abbrev ...`），并逐 status 定义 parser、absent-side sentinel、rename/copy detection policy、mode-only 与 Git hash-format 行为；不能声称 copy 就不启用 copy 识别。artifact descriptor 增加 expected digest（pin 时）、匹配 cardinality、head-side regular-blob existence 与 add/modify/rename 允许表。admission/completion preflight 再给 manifest entry/byte 上限，超限在开事务前 fail closed；V6/V10 覆盖 add/delete/copy/chmod 与上限边界。

6. **[MEDIUM] Completion 的 idempotent fast path 顺序不成立，且把正常失败 attempt 误称为不变量破坏。**

   C2 会先访问 worktree、读取新 tip 并重建 manifest，C4 又先做 live identity fence（`plan.md:50-61,85`），但 `:95` 才说 terminal attempt+completion event 返回 no-op。commit 后响应丢失时，worktree 可能已删除/移动，registry 也可能已 cut over；合法 replay 会在看到 idempotency event 之前失败。并且 attempt 因 `failed|canceled|superseded` 正常 terminal 时本来就没有 completion event，不能一概按“terminal without event = invariant broken”处理。

   **建议修复**：明确 kernel 的 authenticated idempotency fast path先查 `completion:<attempt_id>`；若 event 的 task/attempt、terminal_reason=`completed` 及记录结果一致，直接返回已录结果，不依赖 live worktree/active activation。只有 event 不存在且 attempt 仍 active 才构造 manifest并走 C4；terminal_reason 为 failed/canceled/superseded 返回正常 conflict，只有数据库声称 `completed`/task done/tip 已推进而 event 缺失时才 fail loud。V5 增加 replay 时 worktree 已删、HEAD 已移动、registry 已换代及三种非 completed terminal reason。

## Verdict

CHANGES REQUESTED — address items above
