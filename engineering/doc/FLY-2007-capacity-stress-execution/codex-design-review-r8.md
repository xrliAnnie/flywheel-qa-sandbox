# FLY-2007 Capacity Stress Execution — Design Review R8 (exact-head freeze confirmation)

VERDICT: CHANGES REQUESTED

## 审阅快照与边界

- 本轮被审对象严格绑定到 commit `2d608a86f32f9138aeb803db0ce5ffac8d6efd5c`。开始审阅时，checkout 的实际 `HEAD` 已是其直接子提交 `5f6f6883295fb358300f38093f43e07319470362`，不是请求中声明的 `2d608a86f`；两者唯一差异是本轮范围外的 `engineering/doc/FLY-2007-capacity-stress-execution/progress.md`。用户列出的四份 docs、三份 scripts 与测试在两提交间 byte-identical（`git diff --exit-code 2d608a86f -- <scoped files>` = 0），所以下述代码判断仍精确适用于不可变的 `2d608a86f` blob，而没有把后一个 HEAD 冒充成被审对象。
- 工作树开始与报告落盘前均干净；未修改、暂存、提交或推送任何仓库文件。唯一写入是 `/tmp` 下的审阅报告和隔离反例。
- Fresh verification：focused suite `85 passed, 0 failed`；analyser/simulator `node --check`、wrapper `bash -n` 通过；CI workflow 与 exact step inventory 均包含该 suite。
- 绿灯没有覆盖本轮发现的绕过。执行反例得到：canonical `state.json` 记录三个 `aborted/health_unreachable`、三个 receipt 的 `attempt_id` 均为 99、sensitivity 没有任何 point/control rows 时，只要传入的 ledger 宣称 completed 且普通 digest 可重算，CLI 仍返回 `inference_eligible=true`、`authoritative_outcome=A`、exit 0。

## R7 四项 minimum fixes：二元确认

| R7 minimum fix | R8 状态 | exact-head evidence |
|---|:---:|---|
| **1. FORGED SENSITIVITY** | **NOT CLOSED** | `expectedProvenance()` 只摘要 freeze SHA、simulator blob 和若干配置（`analyze.mjs:579-586`），**不摘要也不验证运行结果**。`sensitivityProblems()` 只检查 schema/freeze/digest（`:589-601`），随后 `analyse()` 仍直接信任两个 `pass === true`（`:691-703`）。同一个 digest 在把 `pass` 从 `false` 改成 `true` 后仍得到 `sensitivityProblems=[]`。测试自己的 A 阳性 fixture 正是手写无 points/controls 的 `pass:true`，调用公开 helper 算 digest 后得到权威 A（test `:244-260`）；test 6f 只证明错误摘要 `0000` 被拒，不能证明正确格式的伪结果被拒。另 #4 仍实际每点只跑 `M/4 = 5000`（`simulate.mjs:209-211`），而 artifact 顶层与 spec 声称 `M=20000`；parameter confidence set / extraction / GOF / applicability gate 仍未实现。 |
| **2. EVIDENCE OMISSION** | **NOT CLOSED** | extra completed row、duplicate bundle、window set、receipt window、四文件 hash required、zero/partial bundle → U 这些子项已关闭（`analyze.mjs:456-503, 604-630, 908-924`）。但 analyser 从不读取 authoritative `attempt-*/state.json`，只枚举目录名并信任调用者传入的 JSONL（`:446-463`）；也不绑定 dir suffix ↔ ledger `attempt_id` ↔ receipt `attempt_id`。执行反例中三个 canonical service failures 被伪 ledger 全部洗成 completed，receipt identity 全错，仍释放 A。replacement graph 只在 completed row **可选地**带 `replacement_of` 时才检查（`:505-517`）；wrapper 根本不产生该字段，凭据失败后成功 W1 省略 edge 的 fresh 反例得到 `censusProblems=[]`。此外 `checkIntegrity()` 不反向枚举 sample keys：向完整 bundle 加 `b31/L1` extra sample 后仍返回 `[]`。故 failure 仍可从权威路径消失。 |
| **3. FREEZE BYTES** | **CLOSED** | wrapper 先证明 commit 存在，再比较 spec + 三个 scripts 的 commit blob 与 working-tree blob（`run-window.sh:218-238`），而 reservation 到 `:241-255` 才发生；stale-real-commit 行为测试确认拒绝且不创建 attempt。analyser 在缺 `--repo-root` 时加入资格拒绝，给定 repo 时强制跑四 blob compare（`analyze.mjs:552-569, 604-609`），所以 missing repo root → authoritative U。当前 checkout 虽有 progress-only 子提交，四个 frozen blobs 与 `2d608a86f` 相同，内容冻结检查会正确绑定目标 commit。 |
| **4. RETRACTED J STORY** | **NOT CLOSED** | spec §0.2.2 已正确记录撤回与 `0.1159 → 0.1579` 判别力理由（`spec-baseline.md:49-64`），analyser/simulator 的相应注释也已修正。但同一 frozen authority 在 `spec-baseline.md:102` 仍活写“`J` 是固定的 **13**”，`research.md:241` 也仍写同一句，与紧邻的 `J=30` 合同直接冲突。R7 要求删除所有 live fixed-J13 claims；test `:309-323` 只 grep 数个旧措辞，所以这两条残留仍在 `85/85` 下全绿。 |

## BLOCKING findings

### 1. HIGH — sensitivity digest 证明的是“配置字符串可重算”，不是 simulator 结果

摘要没有覆盖 `configurations`、points、`covered/m/lcb`、controls 或 `pass`，也没有把 artifact 的 K/M/seed/alpha 与 frozen constants 做等值校验。它既不是签名，也不是执行证明；任何人都能调用导出的 `expectedProvenance()`，或者把一份真实失败 artifact 的 `pass` 改成 true 而保持摘要不变。

Fresh full-CLI counterexample：三份完整、全违约 bundle + 手写 sensitivity（无 points、无 controls、只有公开可算的 digest 与两个 `pass:true`）得到：

```json
{
  "cli_exit": 0,
  "inference_eligible": true,
  "authoritative_outcome": "A",
  "ineligibility_reasons": []
}
```

因此 authoritative A/N 仍能在没有预注册要求的敏感性原子证据时发布。R7 #1 的核心 bypass 仍在。

**Minimum closure:** analyser 必须要求 exact frozen schema 与全部原子 rows/controls，逐项检查 frozen K/M/seed/alpha/per-point level/DGP/endpoint，重新计算每点 LCB、controls 和最终 pass；#4 按裁决跑每点 20000 或取得并记录显式裁剪；实现或显式裁掉 spec 已承诺的 parameter-set/GOF/applicability contract。若保留 digest，它还必须覆盖 canonical result content，不能把普通 checksum 当运行证明。

### 2. HIGH — canonical failure 与 identity/replacement lineage 仍可被 caller-supplied ledger 洗掉

Spec §9 明定 `state.json` 是 durable truth、JSONL 只是可重建 index；production consumer 却不读 state。Fresh full-CLI counterexample把三个 `state.json` 都写为 `aborted/health_unreachable`，同时传入声称 completed 的 JSONL，并把三个 receipt `attempt_id` 全写为 99。四文件 hash 均真实匹配，analyser 返回 authoritative A。也就是说服务失败不仅没有强制 U，反而能完全消失。

独立 replacement 反例为：attempt 1 = W1 `operator_credential` aborted；attempt 2 = W1 completed 但无 `replacement_of`；attempt 3/4 = W2/W3 completed。所有 canonical state、目录、hash、window 都存在，`censusProblems()` 返回 `[]`。当前 wrapper 没有任何 `replacement_of` producer，所以所谓 graph validation 只验证调用者碰巧提供的边，不能证明每次合法重跑都有边，更没有同窗、一对一与 target-completeness。

同一 evidence seam 还会忽略 summary 没有覆盖的额外 sample key；这让“精确 30 blocks”的完整性合同不是双向的。

**Minimum closure:** analyser 从 evidence root 读取每个 canonical `state.json`，重建或逐字/结构比较 JSONL；强制 directory suffix、state/ledger/receipt attempt ID 与 window 全相等；completed rows 与 bundles 双向等集并只允许四个 canonical artifact keys；每个合法 replacement 必须具名、同窗、一对一、无链环且总数 ≤2，wrapper 必须实际写该 lineage；反向拒绝所有 summary 未覆盖的 sample keys。

### 3. MEDIUM — frozen J authority 仍含未撤回的 live `J=13` 声明

`spec-baseline.md:100` 说 `J=30`，`:102` 随即说 fixed 13；`research.md:241` 同样残留。这个 exact-head 不能同时把二者当预注册事实。它不构成另一个 false-A 执行绕过，但它是 R7 明列的 freeze minimum，且当前 contract test 对它真空通过，所以在 exact-head freeze gate 上仍属 BLOCKING。

**Minimum closure:** 将两条 live fixed-13 句改为 fixed-30，并让 contract test 扫描四份 live docs + 三个 frozen scripts 的 fixed-J13 / retracted-coverage claim，而不是只匹配一个旧措辞。

## NON-BLOCKING advisories（继续记账，不影响上述 verdict）

1. global lock 在 `mkdir` 成功、`pid` 写入前崩溃仍会留下 ownerless lock；当前行为是等待后拒绝，fail-closed 但不收敛（`run-window.sh:101-123`）。
2. `rebuild_index()` 的 rename 后仍没有与 `write_state()` 对等的 durability fence（`:183-202`）；index 可重建，故不是 false-A blocker。
3. simulator 注释声称 seed-stability control “runs FIRST”，实际 gate-critical configurations 在 `simulate.mjs:207-211` 先执行，control 到 `:228-231` 才执行；最终 controls 会 veto，故只是资源/叙述债。
4. `exploration.md:173` 仍把当前权威集写成 `{A,U}`、N descriptive；spec §0.2.1 与 executable 已恢复 N。spec 是冻结 authority，所以不另列 blocker，但 live exploration 应同步记录修正。

## Freeze judgment

**不得冻结 `2d608a86f`，不得开始 Window 1。**

Freeze-byte 强制门本身已关闭，但另外三项 R7 minimum fixes 不是 CLOSED。尤其前两个已有 current exact-code 的可执行 authoritative A 反例：普通 digest 仍允许伪造 sensitivity pass；caller-supplied ledger 仍能抹掉 canonical service failures、receipt identity 错误与 replacement lineage。`85/85` 通过不能抵消这些反例，因为 suite 的 A 阳性路径本身使用无原子结果的手写 sensitivity，而真实 simulator consumer test 接受 `(A|U)`，不能证明 real artifact 是释放 A 的原因。

本轮不重开已延期的 B-strength #1/#3，也不以 non-blocking advisory 扣留批准；拒绝只基于上述仍可释放无证据 A/N 或让 failure 消失的执行路径，以及 R7 明列但仍矛盾的 frozen J minimum。

VERDICT: CHANGES REQUESTED
