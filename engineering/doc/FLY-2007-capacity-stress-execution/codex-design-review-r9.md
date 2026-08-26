# FLY-2007 Capacity Stress Execution — Design Review R9 (exact-head freeze confirmation)

VERDICT: CHANGES REQUESTED

## 审阅快照与边界

- 本轮严格绑定 commit `a95e29849baf7396557ec101d9c2e98e248c3388`（branch `flywheel-FLY-2007`）。开始审阅时 `git status --short` 为空；所有 scoped files 的 working-tree bytes 与该 commit 一致。
- 反例 analyser 从不可变 commit blob `a95e29849:scripts/qa-fly-2007-phase0-analyze.mjs` 提取后执行；未把后续工作树漂移冒充被审对象。
- 未修改、暂存、提交或推送任何仓库文件。写入仅限 `/tmp`/隔离临时证据与本报告。
- Fresh verification：focused suite `87 passed, 0 failed`；analyser/simulator `node --check`、wrapper/test `bash -n` 通过；CI workflow 与 exact step inventory 均包含 `Test — FLY-2007 phase-0 analyser contract`。
- 绿灯未覆盖下述反例。当前 suite 的 real-simulator fixture 是真实运行，这一点成立；但 analyser 仍接受另一个未运行 simulator 的 counts-bearing stub，且 ledger-only replacement edge 仍能改变 U → A。

## R8 三项 blocker：exact-head 二元确认

| R8 finding | R9 状态 | exact-head 结论 |
|---|:---:|---|
| **1. sensitivity digest 只证明配置，不证明 simulator 执行** | **NOT CLOSED** | bare `pass:true` stub 已被关闭，但底层 finding 未关闭。digest 仍不覆盖结果；analyser 不要求 exact DGP×endpoint 集、不把 point `m` 绑定顶层 `M`、信任 seed-stability 的 `pass`，也未实现/裁掉预注册的 parameter-set、GOF 与 applicability gates。Fresh hand-written counts artifact 得到 `sensitivityProblems=[]`，完整 CLI 释放 authoritative A。真实 simulator 自己仍以顶层 `M=20000` 运行 N configuration 的每点 `m=5000`，并被 analyser 接受为 N gate pass。 |
| **2. caller-supplied ledger 可洗掉 canonical failure / replacement lineage** | **NOT CLOSED** | R8 的原始“三个 canonical service failure + completed JSONL”反例已关闭：fresh run 为 U，逐项点名 6 个 canonical mismatch。可是 canonical comparison 只看五个字段，不看 `replacement_of`、`artifacts` 或 `freeze_commit`；wrapper 从不把 `replacement_of` 写进 canonical state。只在 JSONL 给 completed row 添加 canonical state 中不存在的 `replacement_of:1`，同一 real-simulator fixture 从 U 变 authoritative A。bundle 也只按 basename 绑定：canonical evidence attempts 只有 `state.json`、没有四件套时，从另一目录传同 basename bundles 仍释放 A。 |
| **3. live J=13 authority residue** | **NOT CLOSED** | R8 点名的 spec 句已改为 30，但同一 live research 仍写 `J = 每窗 13`（`:236`）和 eligibility `J = 13`（`:252`），plan 仍写 `J=13/窗`（`:205`）及 `J=13` 的本轮等价结论（`:429`）。test `:335-336` 所谓 shape regex 不匹配这些形状，故 87/87 真空通过。按本轮“只有 false A/N 或 failure disappearance 才 blocking”的明确边界，此项在 R9 归 **NON-BLOCKING freeze hygiene**；其 CLOSED/NOT CLOSED 事实仍是 NOT CLOSED。 |

## BLOCKING findings

### 1. HIGH — counts-bearing stub 仍可冒充 frozen simulator execution 并释放 A/N

`expectedProvenance()` 仍只摘要 freeze commit、simulator blob 与顶层配置（`analyze.mjs:629-636`），不摘要 points/controls/result。`sensitivityProblems()` 的新增检查也不足以把 raw counts 绑定到 frozen run（`:646-699`）：

- configuration 只要求 `points.length === K` 且 L1/L2 各出现至少一次（`:676-680`）；不要求 frozen `g01..g08 × {L1,L2}` 恰好各一次，重复/虚构 DGP 均可；
- 只要求 point `m > 0`（`:682-686`），不要求 `point.m === sens.M === 20000`；
- positive/oracle 没有 frozen control identity 或 `m` 绑定，seed-stability 更是只信 `pass === true`（`:663-670`）；
- spec §7 与 research §C.7 仍要求 parameter confidence set、参数提取、GOF 与 W1–W3 applicability gate；artifact schema、simulator 与 analyser 均没有这些 gate。

Fresh exact-blob counterexample 手写了：顶层 `M=20000`；两个 configuration 各 16 个 points，但只重复两个虚构 DGP label；每点 `covered=m=200`；positive `0/200`、oracle `200/200`、seed-stability 只有 `pass:true`；digest 用公开 helper 按 frozen config 重算。未调用 simulator，结果为：

```text
sensitivityProblems=[]
authoritative_outcome=A (lower bound exceeds the SLO)
inference_eligible=true
```

这不是“攻击者必须伪造不可核验事实”的理论问题，而是当前 consumer 明确把手写事实当成已执行证据。并且 frozen simulator 的真实 `--m 20000` fresh run 输出：

```json
{"top_M":20000,"A_point_m":[20000],"N_point_m":[5000],"A_pass":true,"N_pass":true}
```

原因仍是 `simulate.mjs:210-211` 对 `range_lb_N` 使用 `m/4`；analyser 没有 point-M fence，所以预注册要求每点 20,000 时仍可释放 N。

**Minimum closure:** analyser 必须验证 exact frozen DGP×endpoint/controls schema、每个 gate-critical point/control 的 exact M、从原子 runs 重算 seed-stability，并实现或显式裁掉 parameter-set/GOF/applicability contracts。要证明 deterministic frozen simulator 的执行结果，最直接的闭环是 analyser 自行运行 exact frozen simulator并比较 canonical result；仅给 caller 可自行计算的普通 digest 或自报 counts 加 checksum 仍不是 execution proof。

### 2. HIGH — JSONL 仍能发明 canonical replacement authority，bundle 也未绑定 canonical attempt

原始 service-failure 洗白 seam 的五字段比较确实生效（`analyze.mjs:449-476`）。但 authority 对账到此为止：

- comparison 只覆盖 `attempt_id/window/state/disposition/reason`（`:466-470`）；
- replacement graph 消费 JSONL 的 `replacement_of`（`:539-565`），却从不要求 canonical state 有同一 edge；
- wrapper 的 START/TERMINAL state producer（`run-window.sh:255,270`）完全没有 `replacement_of`；
- artifact verification 消费 JSONL `artifacts`（`analyze.mjs:506-529`），不与 canonical state 的 hashes 对账；
- bundle→attempt 仅用 `basename(b.dir)`（`:481-505`），没有 `realpath(bundle) == realpath(evidenceDir/a.dir)`。

Fresh counterexample 使用刚才真实运行的 frozen sensitivity artifact和同一组三个完整 bundles：

```text
canonical state attempt-001 = aborted/operator_credential
canonical state attempt-002 = completed/window 1, no replacement_of

JSONL 无 replacement_of:
  authoritative_outcome=U
  reason=no completed attempt names it in replacement_of

仅在 JSONL attempt-002 添加 replacement_of:1:
  authoritative_outcome=A
  inference_eligible=true
```

因此 failure 行没有被物理删除，但它的 fail-closed 后果可由 caller-supplied index 中一个 canonical truth 不存在的 edge 消失；这正是 R8 finding 的 authority class。

另一个 fresh full-CLI counterexample 的 canonical evidence root 中三个 attempt 目录都**只有 `state.json`**，没有 `samples.csv/summary.csv/meta.txt/receipt.json`。caller 从另一目录传入同 basename bundles，并在 JSONL 自报其 hashes；结果仍是 authoritative A、`ineligibility_reasons=[]`。所以 analyser 证明的不是“canonical attempts 产生了这些四件套”。

**Minimum closure:** analyser 应从 `evidenceDir/attempt-*/state.json` 重建 authority graph，而不是允许 caller JSONL 增加 authority-bearing fields；canonical state 必须包含并对账 `replacement_of`、freeze identity 与四件套 hashes；wrapper 必须原子地产生该 lineage（否则 legitimate replacement 诚实保持 U）；每个 analysed bundle 必须 realpath 绑定到同一 canonical attempt directory，并核对 canonical hashes。

## NON-BLOCKING recorded items

1. **J=13 live residue / vacuous regex（R8 finding 3，R9 边界下 non-blocking）**：operative research/plan 句仍与 J=30 ruling 冲突；broad shape scan 命中，而当前 contract regex exit 1。应修正文档并让 regex 覆盖 `J = 每窗 13`、`J=13/窗`、`J = 13 个单元` 等形状。
2. **R8 advisory 1 carried**：global lock 在 `mkdir` 成功、pid 写入前崩溃仍留下 ownerless lock；fail-closed 但不收敛。wrapper 本轮 byte-unchanged。
3. **R8 advisory 2 carried**：`rebuild_index()` rename 后仍无与 `write_state()` 对等的 durability fence；index 可重建，故不是 false-A blocker。wrapper 本轮 byte-unchanged。
4. **R8 advisory 3 carried**：simulator 注释仍称 seed-stability control “runs FIRST”，实现仍先跑两项 gate-critical configurations（`simulate.mjs:207-230`）。controls 最终 veto，所以仅是资源/叙述债。simulator 本轮 byte-unchanged。
5. **R8 advisory 4 carried**：`exploration.md:172-173` 仍写 authoritative `{A,U}`、N descriptive，与已生效的 N-authoritative ruling 不一致；spec 是执行 authority，所以本轮不另列 blocker。
6. **Replacement liveness**：在堵住 JSONL-only edge 后，当前 wrapper 没有任何合法 replacement producer；replaceable failure 后只能永久 U。它是 fail-closed 的可执行性缺口，不是 false-A。

## Fresh verification ledger

- `bash scripts/__tests__/qa-fly-2007-phase0-analyze.test.sh` → **87 passed, 0 failed**。
- `node --check` analyser/simulator；`bash -n` wrapper/test → exit 0。
- `.github/workflows/ci.yml:863-864` 实际运行 focused suite；`scripts/__tests__/ci-structure.test.sh:398` 在 exact ordered inventory 中列名。
- exact-blob hand-written sensitivity counterexample → eligible authoritative A。
- R8 canonical service-failure counterexample → U，6 个 field mismatch（该原始形状 CLOSED）。
- real-simulator replacement counterexample：无 edge U；JSONL-only forged edge A。
- real-simulator canonical-empty-root/out-of-root-bundles counterexample → eligible authoritative A。
- broad J=13 operative-shape scan → hits；current contract regex → no hits。
- 报告落盘后 scoped blob comparison 与工作树状态复验：无 repository mutation。

## Freeze judgment

**不得冻结 `a95e29849baf7396557ec101d9c2e98e248c3388`，不得开始 Window 1。**

本轮不因 carried advisories 或 J 文档残留单独扣留批准；拒绝严格基于两条仍可执行的 authoritative A/N release 路径：未运行 frozen simulator 的手写 counts artifact 可通过资格门；caller-supplied JSONL/bundle paths 仍可发明 canonical replacement authority或替换 canonical evidence。`87/87` 通过不能抵消反例，因为 suite 没有这两个负向 fixture。

VERDICT: CHANGES REQUESTED
