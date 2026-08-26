# FLY-2007 Capacity Stress Execution — Design Review R10 (exact-head freeze confirmation)

VERDICT: CHANGES REQUESTED

## 审阅快照与边界

- 本轮严格绑定 branch `flywheel-FLY-2007`、commit `2551596105afd06eef8cd69269fafaf6dae24ffc`（短哈希 `255159610`）。开始审阅时 `git status --porcelain=v1` 为空。
- 只复核 R9 两项 blocker、它们相邻的 A/N/U 发布链与 failure-retention 链；没有重开 Lead 已裁定的四态模型、A/N/U 强度、N 权威性、`delta=2.5pp`、`J=30` 或 B 曝光 `253/窗`。
- HEAD 相对 R9 被审 commit `a95e29849` 只新增 R9 报告并修改 analyser/test；spec、plan、research、exploration、simulator、wrapper 均 byte-unchanged。
- 未修改、暂存、提交或推送任何仓库文件。写入仅限本报告和隔离的 `/tmp` 诊断输出。

## R9 两项 blocking finding：exact-head 二元确认

| R9 finding | R10 状态 | exact-head 结论 |
|---|:---:|---|
| **1. hand-written counts artifact passes eligibility** | **NOT CLOSED** | **原始 artifact-forgery seam 已关闭**：CLI 不再接收 `--sensitivity`，main 动态导入 simulator 并在进程内调用 `runSensitivity()`（`analyze.mjs:1068-1079`），低于 frozen M 的 `--sim-m` 会令 eligibility 为 U（`:734-746`）。但 R9 finding 明确还包含预注册所需的参数集合/GOF/applicability gates 与 exact M；它们没有被实现或从合同中裁掉。Fresh frozen-M fixture 仍释放 authoritative A，而这三类证据完全不存在；N configuration 每点实际只跑 5000，顶层却印 `M=20000`。因此仍存在 authoritative A（以及按代码条件可达时的 N）缺少预注册证据的发布路径。 |
| **2. caller-supplied JSONL/bundle paths invent authority or substitute evidence** | **CLOSED** | main 从 `--evidence` 下的 `attempt-*` canonical `state.json` 发现 completed bundles（`:702-720,1055-1060`），并从同一批 state files 重建 ledger（`:1063-1067`）；caller-supplied `--ledger` 已被拒绝，`opts.bundles` 不参与 discovery/analyse。canonical state、目录 attempt id、completed 两向集合、四件套 hashes、replacement graph 仍全部进入 `censusProblems()`（`:414-569`）。Fresh suite 也确认 service/host failure 强制 U、不可被后续 clean window 替换，缺 `replacement_of` 的 replaceable failure 以 silent re-run 强制 U。没有找到 caller 路径让 failure 消失。 |

## BLOCKING finding

### 1. HIGH — in-process execution 证明“跑过 simulator”，但仍会在缺少预注册 model-fit/applicability evidence 时释放 A

删除 artifact 输入是正确且有效的缩界，但它没有删除 authoritative preregistration 中的下列要求：

- `spec-baseline.md:228-237` 冻结依赖参数置信集、参数提取、拟合优度门，并冻结 `M=20000`；
- `plan.md:254-271` 明定 authoritative A/N 必须同时满足：拟合优度/参数集合门、各自 configuration、W1–W3 落在预注册适用域、两个 controls；缺一即 U；
- `plan.md:304` 又把这四类证据列为开跑验收项。

exact-head 实现没有这些门：

- `runSensitivity()` 返回的 top-level keys 只有 `K/M/alpha/seed/configurations/controls/...`；没有 parameter confidence set、parameter extraction result、GOF result 或 W1–W3 applicability result。
- `eligibility()` 在 `analyze.mjs:728-746` 只消费 `b_lb_A.pass`、`range_lb_N.pass` 和三个 controls；没有读取或 fail-closed 检查上述三个预注册 gate。
- Fresh focused suite 的真实 frozen-M fixture 明确通过 CLI 得到 `authoritative_outcome=A`（test `:237-243`）。也就是说，这不是抽象的“字段缺失”：当前 release path 已经在没有这些证据的情况下真实产出 A。
- Fresh exact-head simulator 运行得到：

```json
{
  "top_M": 20000,
  "A_point_m": [20000],
  "N_point_m": [5000],
  "A_pass": true,
  "N_pass": true
}
```

`simulate.mjs:209-211` 对 N 使用 `round(m/4)`；而 eligibility 不核对 point-level `m`。所以 audit record 顶层的 frozen `M=20000` 并不代表 gate-critical #4 的每点证据达到 20000。

这正属于本轮唯一 blocking class：如果 pilot model-fit/parameter-set 失败，或真实 W1–W3 依赖结构落在 frozen DGP 适用域外，预注册要求 authoritative outcome 必须为 U；当前代码仍可发布 A。in-process execution 消除了“手写结果”信任边界，却没有提供或显式撤销这些判决前提。

**Minimum closure（两条路任选其一，不需要恢复 caller artifact）：**

1. 在 analyser 自己控制的路径中产生并 fail-closed 消费 parameter-set/GOF/W1–W3-applicability 结果，并让每个 gate-critical point 符合冻结的 M；或
2. 在第一个 START 之前取得明确 Lead 裁决，显式从 operative preregistration/acceptance contract 删除这些要求，并把 #4 的实际 replicate contract 与输出改成不误称 `M=20000`。

单纯证明 deterministic simulator 在进程内执行，不能替代这两者。

## NON-BLOCKING recorded items

1. **Dormant `--bundle` parser residue / vacuous test wording（new）**：`analyze.mjs:1026,1035` 仍接受并存储 `--bundle`；fresh probe `--bundle /tmp/forged-bundle` 返回 rc 0，而 `--ledger` / `--sensitivity` 各返回 rc 1。它不进入 discovery 或 authority，所以不阻断；但 test `:214` 只 grep `--help`，其“CLI no longer accepts --bundle”断言为假绿。应删除 parser branch/unused opts，或把测试改成真实 unknown-argument probe。
2. **R9 carried — J=13 live residue / vacuous regex**：research `:236,252`、plan `:205,429` 仍有 operative `J=13` 文字；test `:278` 的窄 regex 不匹配这些形状。非本轮 false-A/N seam，继续记账。
3. **R9 carried — N authority doc residue**：exploration `:173` 仍写 `{A,U}` 且 N descriptive，与 spec 当日修正裁决冲突。spec/执行代码是 authority，故 non-blocking。
4. **R9 carried — ownerless global-lock liveness**：wrapper 在 `mkdir .wrapper.lock` 成功、写 pid 前崩溃仍会留下无法证明 stale 的 lock。它 fail-closed，不制造 A/N。
5. **R9 carried — rebuildable index durability**：`rebuild_index()` rename 后没有与 `write_state()` 对等的 durability fence。index 可由 canonical state 重建，故不使 failure 消失。
6. **R9 carried — seed-stability ordering comment**：simulator 注释仍称 control “runs FIRST”，实现仍先跑 cfgA/cfgN（`:209-230`）。controls 最终 veto，只是资源/叙述债。
7. **R9 carried — replacement liveness**：wrapper 仍没有合法写入 `replacement_of` 的 producer；发生 replaceable failure 后会保持 U。它 fail-closed，不是 false-A/N。
8. **Dead artifact-validation code（new）**：`expectedProvenance()` / `sensitivityProblems()`（`analyze.mjs:622-699`）仍描述并验证已删除的 artifact contract，但 main/eligibility 不再调用。当前不影响 authority，建议后续删掉以免维护者误认其仍是 release gate。

## Fresh verification ledger

- `bash scripts/__tests__/qa-fly-2007-phase0-analyze.test.sh` → **78 passed, 0 failed**, exit 0；fresh wall time **28.82s**。
- `node --check` analyser/simulator；`bash -n` wrapper/test → 全部 exit 0。
- `.github/workflows/ci.yml:863-864` 真正运行 focused suite；`scripts/__tests__/ci-structure.test.sh:398` 的 exact ordered inventory 含该 step。
- Fresh in-process frozen simulator → A points `m=20000`、N points `m=5000`，两 configuration 均 `pass=true`；输出 schema 无 parameter-set/GOF/applicability evidence。
- Fresh CLI probe → `--ledger` / `--sensitivity` 均 unknown argument；`--bundle` 仍被接受但被忽略。空 canonical root + out-of-root `--bundle` 只能得到 U。
- HEAD blob 与工作树 hash 已逐项核对：spec `cb2604be...`、analyser `7529cfec...`、simulator `4921528d...`、wrapper `42265ecd...`、test `7e5cc00e...`。

## Freeze judgment

**不得冻结 `2551596105afd06eef8cd69269fafaf6dae24ffc`，不得开始 Window 1。**

R9 finding 2 已关闭，R9 finding 1 的 caller-forged artifact seam 也已关闭；本轮不因任何 carried advisory 扣留批准。拒绝严格只基于一个仍可执行的 authoritative A release path：当前 frozen-M CLI 能在没有预注册要求的 model-fit/parameter-set 与 W1–W3 applicability evidence 时输出 A。按 operative contract，这些缺失/失败必须是 U。

VERDICT: CHANGES REQUESTED
