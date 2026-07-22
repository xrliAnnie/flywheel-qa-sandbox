# FLY-1432 · PR #678 work-kind seed — QA 验证报告

Issue: FLY-1432 (QA·FLY-1380 — real E2E of PR #678, work-kind seed)
日期: 2026-07-22
基于: `design.md`、PR #678、FLY-1380 codex-approved R4 plan

**QA 节点**: exec-id `a418e687-6c61-475e-94b9-c5484018bd9d`（首轮）→ `36cfbea3-4fea-4291-bd33-c4d09c79e3c5`（本轮独立复验）
**被测**: PR #678，HEAD `6a0576bd3ec3e9188ad6c012cfaf89711bf53692`
**Verdict**: **PASS**

> **本轮复验说明**：首轮报告是一个「声称」，不是事实。本轮没有继承那个 verdict，而是自己从 pinned commit
> 重新 `git worktree --detach` + `pnpm install` + build 出一份独立 dist，在这份自己编译的产物上重跑全部
> 关键结论，另加四项首轮没做的对照（D1–D4，其中 D3 补的是**生产真正会走、但首轮一次没执行到**的旧库升级路径）。逐项证据见
> [`evidence/independent-rerun-fly1432-exec36cfbea3.txt`](evidence/independent-rerun-fly1432-exec36cfbea3.txt)。
> 复验同时**更正了首轮的一个测试计数**，见 §3 C2。

## 1. 范围（诚实划界）

本次在 detached pinned checkout 上搭一间临时真机测试房，验证三件事：

1. 六个目标 identity 确实随 boot 安装并发布；
2. work-kind seed 保持 dormant，没有写入/扩张 live binding，flag-off 直选仍 fail closed；
3. 现有 wildcard 工程 routing 没被新 identity 改写，相关回归测试没有新增红项。

以下明确不在本次范围：

- **不验** cutover/binding 迁移、`pipeline.work_kind` 翻转、generalized flag 生产翻转——全不在 PR #678（plan §5 交接合同，属 cutover 单）。
- **不验** designer/prototype 模板的完整 founder 闭环运行时（负向终态、founder 试用投递是具名 engine follow-up，现状不可表达）；本 QA 只到「装了、发布了、dormant、v2 物化/admission 由 PR 单测覆盖」。
- **不重跑** codex code-review（独立门）。
- 生产 DB 的实际首次重启 burst 验收（ship note §P7）属 ship 窗，不在本 QA 房间内代跑。

## 2. 独立代码审查

- import 层 generalized flag 门只解除两处：bundle importer 不再 skip v2，StateStore seed importer 不再 throw；revision authoring/publish 和共享 dispatch predicate 保持 gated。
- `workflow-template-dispatch.ts` 相对 main byte-unchanged；真 HTTP 直选在 flag off 时返回 `409 GENERALIZED_WORKFLOW_REJECTED`，共享 predicate 为 `generalized_disabled`。
- `tpl_ops_light.yaml` 以 rename 方式变为 `tpl_generic.yaml`，`tpl_research_light.yaml` 删除；bundle 是 7 个 rollback identity + 5 个新 identity，共 12 条。
- `retireWorkflowTemplate` 先查所有 exact/wildcard refs，再判 already-retired；成功更新和 `template_retire` audit 同事务。bind 在任何写入前拒 unpublished/retired target。
- audit CHECK migration 保留旧 row/id，显式重建 update/delete/no-replace 三个 append-only trigger 和 index，二次开库不重建。
- 两份 shipped executor 合同完整：designer 强制「publish-only URL → Lead → founder-html-delivery → 可观察 check 回执 → 才开 gate」；prototype 强制自证能开、`docs_v1` materialization、判定归 founder gate。

逐项审查证据见 [`evidence/independent-diff-review.txt`](evidence/independent-diff-review.txt)。**未发现 blocking correctness/security finding。**

## 3. 测试证据

| 检查 | 结果 | 持久证据 |
|---|---|---|
| A1 · boot #1 安装/发布 6 个目标 identity；bundle 精确 12 条；旧 ops/research identity 不落库 | **PASS** | [`templates-after-boot1.txt`](evidence/templates-after-boot1.txt) |
| A2 · 同 DB warm boot #2 所有 seed import=`unchanged`，template/binding audit 零增量 | **PASS** | [`audit-counts.txt`](evidence/audit-counts.txt) |
| B1 · binding 逻辑行集 warm 前后逐字相等；5 个 work-kind category 零 binding | **PASS** | [`bindings-pre-warm.txt`](evidence/bindings-pre-warm.txt)、[`bindings-post-warm.txt`](evidence/bindings-post-warm.txt) |
| B2 · 新 seed 在场前后，生产形状 `*→tpl_eng_heavy` candidate 解析不变 | **PASS** | [`routing-selection.txt`](evidence/routing-selection.txt) |
| B3 · production Bridge HTTP stack，flag off 直选 `tpl_generic` → 409；run/spawn/tmux window 零增量 | **PASS** | [`direct-select-409.json`](evidence/direct-select-409.json) |
| B4 · 独立 flag-on 象限：显式 lead override 可选 v2；category 仍选 v1 heavy | **PASS** | [`flag-on-quadrant.txt`](evidence/flag-on-quadrant.txt) |
| C1 · PR 自带两条真机 dispatch E2E | **无 PR 新红**：两脚本的红项均在 main `11bbec10` 原样复现；其余真实 spawn/receipt/restart 与 v1 selection 均通过 | [`qa-fly-1281-tail.txt`](evidence/qa-fly-1281-tail.txt)、[`qa-fly-1307-tail.txt`](evidence/qa-fly-1307-tail.txt) |
| C2 · PR 触及的 7 个 targeted test files | **无 PR 新红**（见下方更正）：6/7 files、150/150 tests 在本轮独立 build 上 PASS；第 7 个文件 `workflow-docs-git.integration.test.ts` 本机 1 项 5000ms **超时**，在 clean main `11bbec10` 逐字同样红，且 PR #678 CI 在同一 head 上该文件全绿 | [`c2-targeted-tests.txt`](evidence/c2-targeted-tests.txt)、[`independent-rerun-fly1432-exec36cfbea3.txt`](evidence/independent-rerun-fly1432-exec36cfbea3.txt) |
| D1 · **阴性对照**：flag-on 时同一条 HTTP 请求不再被 `GENERALIZED_WORKFLOW_REJECTED` 拦，且真的走到 dispatcher（`start` 调用 0→1） | **PASS** — 证明 flag-off 的 409 与 zero-spawn 不是空过绿 | [`negative-control.txt`](evidence/negative-control.txt)、[`qa-control.mjs`](qa-control.mjs) |
| D2 · audit 表 CHECK 重建后，三个 append-only trigger 仍然生效（真库上 UPDATE/DELETE 均被 RAISE 挡回） | **PASS** | [`negative-control.txt`](evidence/negative-control.txt) |
| D3 · **真·升级路径**（旧 schema 库 → PR head 打开）：旧库确实没有 `template_retire`、迁移把 CHECK 撑开、7 条历史 audit row 逐字保留、trigger 在换表后恢复、`template_retire` 可写、retire 仍拒绝已绑定模板、二次开库幂等 | **10/10 PASS** | [`migration-control.txt`](evidence/migration-control.txt)、[`qa-migration-control.mjs`](qa-migration-control.mjs) |
| D4 · **全新项目**（从没绑过任何东西）跑 `ensureDefaultWorkflowBindings`：默认只落 `*→tpl_eng_heavy`、`light→tpl_eng_light`、`trivial→tpl_eng_trivial`；5 个 work-kind category 零绑定、5 个新 v2 identity 零绑定 | **PASS** — dormant 在「无既有 authority 压制」这一侧同样成立 | [`fresh-project-control.txt`](evidence/fresh-project-control.txt)、[`qa-fresh-project-control.mjs`](qa-fresh-project-control.mjs) |

QA artifact 另经 `node --check qa-harness.mjs` 与 tracked-source + 本目录 scoped Biome 检查，均以 exit 0 结束；repo wrapper `pnpm lint` 会扫描本 worktree 的 ignored `.pnpm-store` cache，因此没有把该 cache 噪音误写成产品 lint 结论。

主 A/B harness 共 14 项检查全绿，汇总见 [`harness-summary.json`](evidence/harness-summary.json) 和 [`harness-stdout.log`](evidence/harness-stdout.log)。该 summary 由**本轮复验**在自建 dist 上重新生成；与首轮相比，实质性证据文件（templates/bindings/audit/routing）逐字一致，只有 ephemeral 端口、tmux window id、时间戳这些跑动会变的字段不同。

**对首轮 C2 计数的更正**：首轮写的「7/7 files、154/154 tests PASS」在本轮机器负载下没有复现——`workflow-docs-git.integration.test.ts` 里 “materializes a deterministic commit … adopts it on replay” 一项 5000ms 超时。它是**超时形状而非断言形状**（同文件另外 3 条断言每次都过），并且在 clean main `11bbec10` 上逐字复现同样的红，PR #678 的 CI 在同一 head 上该 shard 又是 SUCCESS。因此结论仍是「无 PR 新红」，但计数按实测写成 150/150 + 1 项已知 flake，不四舍五入成 154/154。

## 4. 真机 E2E（isolated，built dist）

Harness：[`qa-harness.mjs`](qa-harness.mjs)。

- 起跑前逐字断言 detached checkout HEAD=`6a0576bd3ec3e9188ad6c012cfaf89711bf53692`。
- `HOME`、`FLYWHEEL_STATE_DIR`、`FLYWHEEL_COMM_ROOT`、StateStore DB 全落在 `mkdtemp` 房间；结束后清房。
- Bridge 使用生产 `createBridgeApp` HTTP stack，只监听 `127.0.0.1:0` 选出的临时端口，并断言不是生产 `:9876`。
- 房间创建唯一 tmux session；B3 前后 window id 集完全相等，dispatcher start call=0。
- fresh boot 后 DB 中 12 个 row 与 `loadBundledWorkflowSeeds()` 精确一致；目标六条都带 non-null published revision。
- warm boot 重新打开同一文件 DB，12/12 import 全部 `unchanged`；已有 wildcard authority 阻止 default seeder 扩张，binding 与 audit 不动。
- B2 使用生产 `workflow-template-selection` dist 在真实文件 DB 上解析；新 identity 在场前后均得到 `tpl_eng_heavy` revision 1。
- B3 通过真实 `/api/runs/start` 发起直选；返回 409 后 `workflow_run` row count、dispatcher 调用数、tmux windows 均不变。
- B4 在另一真实 StateStore boot 上打开 generalized flag：直选 `tpl_generic` 成功，而 category 继续解析 `tpl_eng_heavy`。

## 5. C1 红项的 main-head 对照

两条原脚本没有全绿，但逐条在当前 main HEAD `11bbec10` 对照复现，因此不构成 PR #678 回归：

1. `qa-fly-1281`：main 与 PR 均只有 `successor_and_review_dispatch_remain_unreachable` 红，其余 start、两次真 tmux spawn、credential、output/receipt、marker restart/replay、flag-off 断言全绿。该脚本另有隔离 HOME 下缺 rescue helper 的既有夹具缺口；按 `qa-fly-1307` 自带的 exact verify/create shim 运行后可到达完整功能断言。
2. `qa-fly-1307`：main 已有 9 个 bundled seed，但脚本仍硬编码 `seedIds.length === 6`；main 与 PR 都在该断言红。随后两边都被较新的 mandatory design-HTML attestation 409 挡在 design node。PR run 仍成功完成 v1 candidate 选择、snapshot materialization 和真实 design spawn。

这些是需要单独修的测试卫生/夹具漂移，不应把 main 已红误报成 FLY-1380 产品回归。

## 6. Follow-up（非阻塞）

0. **本轮补上的覆盖缺口（已在本 PR 内补测，留档说明来由）**：首轮的 harness 和 D1/D2 对照都是在「PR head 新建的库」上跑的，而 `workflow_template_audit` 的 CHECK 重建**只在旧 schema 库上才会触发**——也就是说生产上真正会走的那条升级路径，首轮一次都没执行到。D3 用「main HEAD 建库 → PR head 打开同一文件」把它补上了；今后改动这张表的迁移，应沿用这个 old-build/new-build 双侧套路，而不是只在 fresh DB 上测。
1. 更新 `qa-fly-1281`：在隔离 HOME 内自建/显式注入 rescue shim，并把 direct-to-gate 后 founder gate 的当前正确状态写进断言。
2. 更新 `qa-fly-1307`：不要硬编码 bundle 数量；改为预期 identity 集或从 SSOT 派生，并给 design probe 补 mandatory HTML attestation。

## 7. 结论

PR #678 的目标风险面已由独立真机房验证，且关键结论经**第二个 exec 在自己重新编译的 dist 上复现**：目标模板真实安装+发布；warm boot 不改 live binding/audit；work-kind categories 仍零 binding；flag-off 直选 fail closed（并由阴性对照证明这条 409 确实来自 flag gate，不是别的原因凑巧撞出来的）；flag-on 只允许显式 v2 override，自动 category routing 仍是 incumbent `tpl_eng_heavy`；旧 schema 生产库升级到本 PR 时，audit 表 CHECK 重建保住了全部历史 row 且没把 append-only trigger 弄丢。被删掉/改名的 `tpl_ops_light`、`tpl_research_light` 在 pinned head 的 `packages/`、`scripts/`、`agents/`、`.flywheel/` 里已无任何残留引用。独立 diff 审查无 blocking finding。

targeted tests 实测 150/150 绿 + 1 项 `workflow-docs-git` 超时 flake；该 flake 在 clean main 上逐字复现、在 PR CI 上是绿的。两条历史 E2E 的红项同样由 main-head runtime 对照证伪为 pre-existing harness drift。**无 PR #678 阻塞缺陷 → PASS。**
