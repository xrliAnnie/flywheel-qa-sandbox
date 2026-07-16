# FLY-1281 模板泛化到非三段式任务类别 — QA 验证报告

Issue: FLY-1281
日期: 2026-07-15
基于: plan.md（Codex design review APPROVED，11 轮）

**结论：FAIL（1 个 HIGH 阻断）。** 验证 head = `18fca9f2866055ae804172e838c7ce59ed782205`。

> **更正声明**：我最初报了 PASS，**那个判断是错的，已撤回**。我的全部测试都在验 DB / 收据 / flag 行为，
> **从没探过真正发给 Runner 的 prompt 文本**。Codex code review 第 2 轮点出了这一面，我独立复现后确认属实。
> 记在这里而不是悄悄改掉，因为「我漏了哪一面」本身就是这次 QA 最该留下的信息。

---

## 0. 阻断项（HIGH）— capability 隔离被 legacy ship 尾巴打穿

**现象**：当 checkpoints 开启（**flywheel 生产就是 brainstorm + approve_to_ship 全开**），一个泛化的
**no-write / no-ship** 节点（如 `tpl_research_light` 的 `research`，`completion_route=no_code`）拿到的 prompt 里
**同时**包含：

- 它自己的能力契约：`Do not request ship approval or ship/merge a PR.` + `complete --route no_code`
- **以及**互相矛盾的 legacy 尾巴：`APPROVE GATE (MANDATORY — do NOT skip)`、`complete --route needs_review`、
  `MERGE AUTHORITY`、`verify-approval`、`:cool:`

**根因**（`packages/edge-worker/src/Blueprint.ts`，FLY-47 checkpoint 注入循环）：该循环只对 `isQaRunner`
跳过 `brainstorm` / `approve_to_ship`，**没有 `isGeneralizedExecution` 的跳过分支**，所以这些 block 被追加到
泛化能力行之后。

**为什么第一轮没抓到（诚实复盘）**：既有的 `Blueprint.generalized-workflow.test.ts` 构造 Blueprint 时
**不传 checkpointConfig**，于是它那句 `expect(prompt).not.toContain("BRAINSTORM GATE")`
**是空过的**——gate 文本本来就只在 checkpoints 开启时才注入。测试名字看起来覆盖了这一面，实际没有。
这正是「标签不等于事实」：断言存在 ≠ 断言有效。我的 E2E 也只验 DB/收据，没验 prompt 文本。

**已提交的失败回归测试**（本次 QA 新增，当前对着现网代码是 RED）：
`Blueprint generalized workflow capability contract > suppresses brainstorm/approve_to_ship gates for a generalized node when checkpoints are enabled`

**我没有自己改代码** —— 三段式里我是验证方，修复归 implement 阶段。

## 0b. Codex 第 2 轮另报的 2 个 MEDIUM（我未独立复现，转给实现者判断）

1. `runs-route.ts` — `selected_by` 直接取请求里的 `leadId`，其 owning-Lead 校验挂在 legacy
   `BRIDGE_DEPT_SCOPE_REJECT` kill-switch 上；关掉该开关后 v2 run 可记录未经校验的 Lead，
   与计划要求的「服务端派生身份 + 错 Lead 403」不符。
2. `runs-route.ts` — 已 commit 的 launch 被正面证明死亡时，output-producing 节点直接永久 hold，
   没有进入计划 R9/R10 的 delivery-attempt CAS 修复；`tpl_research_light` 受影响。

> Codex 的 HIGH 描述里还说 `gh pr create` 也泄漏了 —— **我的探针显示它 absent**，这一条不成立。
> 其余（APPROVE GATE / needs_review / MERGE AUTHORITY / verify-approval / `:cool:`）**全部复现属实**。

---

## 1. 我做了什么（独立验证，不采信实现者自报）

实现者留了一份自己生成的 `qa/fresh-spawn-e2e.json`（14/14 pass）。按纪律，runner 自报不算证据，所以我：

1. **自己重跑** E2E → 14/14，与实现者的 checks 集合逐字相同。
2. **突变验证**（关键）——脚本重跑两次只能证明"确定性"，不能证明"有牙"。所以我逐条把被测护栏打断，确认测试真的变红。
3. **独立归因** 全套件失败，而不是把红字直接算在本 PR 头上。

## 2. 突变验证 — 护栏是真的（4/4）

| 打断的护栏 | 位置 | 结果 |
|---|---|---|
| D2「含写者节点 ⇒ 恰 1 QA」不变量 | `workflow-template.ts` | `workflow-template.test.ts` **RED** ✅ |
| teardown fail-closed hold（无收据不放行） | `StateStore.ts` | `event-route.test.ts` **RED** ✅ |
| `materializeWorkflowRun` flag-off 门 | `StateStore.ts` | `workflow-template-selection.test.ts` **RED** ✅ |
| flag-off 门（**编译后 dist**） | `dist/StateStore.js` | **真机 E2E** `flag_off_...` **FAIL + exit 1** ✅ |

第 4 条最关键：它证明 plan 要求的「真机 E2E 证据」本身有牙，不是自证自洽的橡皮图章。四次打断后源码树与 dist 均已还原（`git status` 干净）。

## 3. 测试套件 — 红字全部归因清楚

**首跑（污染环境）：76 failed / 7408 passed。** 这 76 条**不是本 PR 的回归**：

- 根因 = 本 QA runner 自己的 `TMPDIR` 落在 `~/.flywheel` 下，命中 FLY-245/FLY-350 故意的「workspace 不得与 ~/.flywheel overlap」安全校验；外加 ambient `FLYWHEEL_*/CODEX_*` env 泄漏，把「缺席才 fail-closed」的门用例污染成「存在」。这是已归档的环境性假失败类别。
- **scrub env + 中性 TMPDIR 后：6 failed / 7491 passed** —— 70 条当场消失。

**残留 6 条 = 高负载（load 峰值 ~102）下的竞争超时**，且全部落在本 PR **未触碰**的文件：

| 文件 | 隔离重跑 |
|---|---|
| `runs-route-registration.test.ts` | **1/1 pass**（3.0s；套件内 15.0s 超时） |
| `codex-lead-runtime.test.ts` | **114/114 pass** |
| `worktree-quarantine.test.ts` | **5/5 pass** |

> `runs-route-registration` 我特意单独查了 —— 因为 `runs-route.ts` **是**本 PR 改动面，不能想当然放过。隔离 3 秒通过，确认是负载超时而非回归。

**本 PR 自己的 12 个测试文件（clean env 隔离）：180/180 pass。**

**GitHub CI 在同一 head：Build & Test pass**（run 29457020035）—— CI 的 `TMPDIR=/tmp` + 干净 env，与我 scrub 后的结论一致，互为佐证。

## 4. 对着 plan 验收矩阵逐格核

| 组 | 核验 |
|---|---|
| D2（单独成组） | 不变量在 `validateWorkflowManifest` 内强制；写者(design/implement/qa 均 `shared_branch_writer`)⇒ `qaCount !== 1` 即 reject；两 QA 亦被同一谓词挡（qa 自身是写者）。**突变验证过。** |
| qa_exempt 同事务 | `qa_exempt` claim 与钉 snapshot 在**同一** `db.transaction` 内写入；`authority_id = qa_exempt:<runId>` 确定性 ⇒ 幂等；`issuer_kind=bridge_policy` / `subject_kind=snapshot_digest`，与 §0.2 一致。 |
| 泛化表达力 | 三个新种子 `tpl_research_light` / `tpl_product_v1` / `tpl_ops_light` 均 schema_version 2，走 generic/review/gate 无 QA 全 no-write 链 + `node_done`/`review_pass` 边 + `review_fail` 回环；registry 里 `generic`/`review` 确为非写者 ⇒ 免 QA 合法（不是靠标签，是靠 capability）。 |
| completion 两原语分立 | `commitEnrolledCompletion` 是**唯一**写 `workflow_node_completion` 的路径（route 必须等于 snapshot 的 `completion_route`；`produces_output` 缺产出 ⇒ `missing_output` + `retryable`；冲突收据 ⇒ `completion_conflict`）。`observeEnrolledTeardown` **永不建收据**，无收据即 hold。**突变验证过。** |
| 选择/权威 | v1 候选 / 无候选 ⇒ `null`（**先于** auth 检查，故 scoped+v1 仍走 legacy，符合 §0.7）；v2 ⇒ 必须 master auth + idempotencyKey + lead 选择必填 reason；`founderOverrideTemplateId` 不在公共 DTO。 |
| flag / 字节兼容 | `isGeneralizedTemplatesEnabled` 严格 `=== "1"`（`"true"` 不算，有测试钉住）；v2 物化前复检 generalized ∧ claims_write 双 flag；boot 导入跳过 v2 种子。 |
| C→D 边界 | E2E `successor_and_review_dispatch_remain_unreachable` ✅ —— C 不做后继派发/review 执行。 |
| 真机 E2E | 14/14，独立重跑复现 + 突变验证有牙。 |

## 5. 默认关闭的字节兼容 —— 结构性保证

生产今天没有任何 category binding、也没有 v2 模板，因此 `resolveWorkflowTemplateSelection` 在 `workflow-template-selection.ts:52` 的 `if (!templateId) return null` **早退**，在任何 throw / DB 写之前就返回 —— 每一次生产 start 都零 workflow run / 零 claim / 零 ctx，直接走原 legacy 路径。

我原本怀疑「OFF + 无候选的 legacy start 只在 resolver 层有覆盖、HTTP 边界没测」，查证后**证伪**：既有 `start-e2e.test.ts` 真打 `POST /api/runs/start`（不带 template），确实穿过新选择代码并断言 200 + executionId。覆盖存在，**不编造 finding**。

## 6. 未覆盖 / 边界（诚实声明）

- **ON 路径的生产 live E2E 结构上跑不了**（flag 默认 off、未在生产 config 翻 ON，强行开 = 碰生产且 founder-gated）。verdict 依据 = 隔离真机 E2E（真 Bridge HTTP 栈 + 真 TmuxAdapter fresh spawn + 隔离 teamlead.db）+ 突变验证 + OFF sentinel。**本 PR 没有在生产 config 提前翻 ON**（已核）—— live ON 验证正确地 defer 到 D（原⑦⑧）的 enable 步。
- 残留 6 条 flake 是**既有**负载敏感问题，不属本 PR，未修（scope discipline）。

## 7. 附件

- `qa/qa-verification.json` — 机器可读结论
- `qa/fresh-spawn-e2e.json` — E2E 证据（我这次重跑覆写，checks 与实现者逐字相同）
