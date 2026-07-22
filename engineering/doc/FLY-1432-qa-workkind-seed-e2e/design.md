# FLY-1432 QA·FLY-1380 work-kind seed 真机 E2E — QA 设计(handoff)

Issue: FLY-1432 (QA·FLY-1380 — real E2E of PR #678, work-kind seed)
日期: 2026-07-22
基于: PR #678 head `6a0576bd`(branch `flywheel-FLY-1380`)、`engineering/doc/FLY-1380-seed-workkind-templates/plan.md`(codex-approved R4)、FLY-1426 qa-report.md(报告标准)、Lead instruction `8415cbcc-d951-4314-8f90-44a1fcb9a677`

## 0. 一句话

对 PR #678(dormant work-kind 模板 seed)搭真机隔离房 E2E:证 **① seed 模板真落库(6 identity 安装+发布)② dormant 未激活(binding 逻辑行集/审计零增量 + flag-off 直选 409)③ 现有派发 routing 未坏**(生产形状 category 选择仍走 tpl_eng_heavy + PR 自带两条真机 dispatch E2E 全绿),产出 FLY-1426 标准的 qa-report.md + 持久证据。

## 1. 铁律(来自 dispatch + Lead instruction,逐条约束 implement 节点)

1. **独立 QA,不许改 1380 实现**:PR checkout 只读;发现缺陷 → 记 qa-report + FAIL/升级,绝不顺手修。
2. 被测锚定 **head `6a0576bd`**:harness 起跑前 `git rev-parse HEAD` 断言逐字相等;不匹配 → 立停(防 head 漂移,PASS 前再核一次)。
3. **零生产污染**:隔离 HOME / `FLYWHEEL_STATE_DIR` / comm root / 唯一 tmux session;不触生产 `~/.flywheel`、生产 Bridge(:9876)、生产 DB;managed env 快照+恢复(照 qa-fly-1307 的 `MANAGED_ENV` 集)。
4. **PASS 必须有真机证据**:每条断言落 evidence 文件(SQL 快照 / HTTP body / 脚本 stdout),commit 进本 doc 文件夹,留到 Annie 验收完。
5. codex code-review 是独立门(Bridge merge 时 enforce),本 QA 不重跑、不据以卡 verdict(FLY-1426 同款口径)。

## 2. 房间设计(隔离配方)

照 `scripts/qa-fly-1281-generalized-template-e2e.mjs` / `qa-fly-1307-template-dispatch-e2e.mjs` 的既有隔离模式:

- **PR checkout**:`git worktree add <scratch>/pr-6a0576bd 6a0576bd --detach`(共享 object store;branch 已 fetch)→ `pnpm install --frozen-lockfile` → `pnpm build`(两脚本 import `packages/{claude-runner,teamlead}/dist/*`,必须先 build;seed 安装入口 = `plugin.ts:3964 importBundledWorkflowSeeds(store)` Bridge boot 路径)。
- **房间根**:`mkdtempSync(qa-fly1432-)`;`HOME`→房内、`FLYWHEEL_STATE_DIR`→房内、`FLYWHEEL_COMM_ROOT`/`FLYWHEEL_COMM_BACKEND` 房内;tmux session `qa-fly1432-<pid>`。
- **生产形状 flags**(A/B 主矩阵):`FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1`、`FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1`、`FLYWHEEL_WORKFLOW_CLAIMS_READ=1`、`FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES` **unset(off)** —— 与生产现状一致(dispatch on + generalized off,plan §P3)。
- **flag-on 象限**(B4)单独 boot,仅房内开 `GENERALIZED=1`。
- **harness 形态**:`qa-harness.mjs` 单文件,module-driven boot 生产 Bridge HTTP 栈(`packages/teamlead/dist/bridge/plugin.js`,照 qa-1281 boot 骨架),**commit 进本 doc 文件夹**作可复跑证据(比 FLY-1426 的 scratchpad 即弃更 durable;QA 证据留存铁律)。

## 3. 测试矩阵(全部真机,断言写死)

### Phase A — seed 真落库

| # | 动作 | 断言 |
|---|---|---|
| A1 | fresh DB,boot #1(生产形状 flags) | `workflow_template` 恰含预期 6 identity:`tpl_eng`、`tpl_eng_land_v1`、`tpl_product_designer`、`tpl_product_prototype`、`tpl_generic`、`tpl_product_v1`,各自 `current_published_revision` 非空(装了**且发布**);`tpl_ops_light`/`tpl_research_light` **不存在**(fresh 房不装已删 seed);`tpl_eng_heavy` 等旧 v1 identity 照常在(bundle 未删旧 eng 三件套 land/heavy —— 以 PR head bundle 清单为准取期望集,harness 从 `workflow-template.js` 导出的 bundle 清单派生,不硬编码) |
| A2 | 同 DB warm boot #2 | 全部 seed import `unchanged`;`workflow_template_audit` 行数零增量(幂等,plan §P7「一次性 burst」口径) |

### Phase B — dormant 未激活

| # | 动作 | 断言 |
|---|---|---|
| B1 | boot #1 后快照 → warm boot #2 后再快照 | `workflow_category_binding` **排序后逻辑行集**逐字相等 + binding audit 计数相等(生产验收口径同款,plan §P7);**任何 work-kind 类别(`WORK_KIND_CATEGORIES`)零 binding 行** |
| B2 | 生产形状 fixture(项目恰一行 `*→tpl_eng_heavy`)category 选择 | 选择解析 = `tpl_eng_heavy`(与 seed 安装前逐字相同的 candidate 解析;经 `workflow-template-selection` dist 对房内真 DB 跑) |
| B3 | `POST /api/runs/start` 显式 `templateId=tpl_generic`(flag off) | HTTP 409 `generalized_disabled`;`workflow_run` 零新行;零 spawn(tmux 无新 window) |
| B4 | flag-on 象限(房内) | 显式 templateId+selectionReason **可**选中 v2(lead-override 是 PRD 允许路径,不算破坏 dormant);category 选择仍解析 v1(dormant 只由 binding 缺席保证)——四格口径照 plan §P3 |

### Phase C — 现有派发 routing 未坏

| # | 动作 | 断言 |
|---|---|---|
| C1 | 在 PR checkout **原样跑** PR 自带两条真机 E2E:`scripts/qa-fly-1281-generalized-template-e2e.mjs` + `scripts/qa-fly-1307-template-dispatch-e2e.mjs`(自带隔离,真 TmuxAdapter probe runner + 真 dispatcher + 真 docs materializer) | 双双全 PASS —— 同时证:旧路径 category start→dispatch→completion 整链未坏 + PR 的 P2 消费者清理(两脚本被 PR 改写)真机真跑绿,不是纸面迁移 |
| C2 | PR checkout 跑 PR 触及的测试文件:`workflow-template`、`StateStore.workflow-templates`、`workflow-template-selection`、`workflow-template-routes`、`workflow-engine-dispatcher`、`workflow-docs-git.integration`、`workflow-template.test`、`feature-flags-registry` | 全绿;若现红,按既有口径用 **main HEAD 对照证伪**(pre-existing machine-state flake ≠ 回归),报告里逐条列 |

### 独立代码审查(报告 §2,轻量)

对 PR diff 做独立走读(不重做 design review):重点核 ① import 层 flag 门解除恰 2 处、dispatch 谓词未动 ② `retireWorkflowTemplate`/bind 守卫 fail-closed 形状 ③ 两份 shipped executor 的合同锚点存在(publish-only→Lead→回执→gate 顺序、超时≠批准)。发现问题按严重度进 verdict。

## 4. 证据与报告合同

- 证据落 `engineering/doc/FLY-1432-qa-workkind-seed-e2e/evidence/`:`templates-after-boot1.txt`、`bindings-{pre,post}-warm.txt`、`audit-counts.txt`、`direct-select-409.json`、`harness-stdout.log`、两脚本输出尾段、C2 测试 summary。
- `qa-report.md` 逐节照 FLY-1426 格式:范围(诚实划界)/ 独立代码审查 / 测试证据表 / 真机 E2E / Follow-up / 结论;头部写明被测 head `6a0576bd` + QA 节点 exec-id。
- **Verdict 纪律**:PASS 仅当 A/B/C 全绿(或红项经 main-HEAD 对照证伪为 pre-existing);FAIL 单消费不可逆,发前三查;严禁「工具说成了」当证据 —— 每条 PASS 都要指到 evidence 文件。

## 5. 诚实边界(报告必须原样带上)

- **不验** cutover/binding 迁移、`pipeline.work_kind` 翻转、generalized flag 生产翻转 —— 全不在 PR #678(plan §5 交接合同,属 cutover 单)。
- **不验** designer/prototype 模板的完整 founder 闭环运行时(负向终态、founder 试用投递 = 具名 engine follow-up,现状不可表达);本 QA 只到「装了、发布了、dormant、v2 物化/admission 由 PR 单测覆盖」。
- **不重跑** codex code-review(独立门)。
- 生产 DB 的实际首次重启 burst 验收(ship note §P7)属 ship 窗,不在本 QA 房间内代跑。

## 6. implement 节点执行顺序

1. scratch worktree checkout `6a0576bd` + `pnpm install --frozen-lockfile` + `pnpm build`;
2. 写 `qa-harness.mjs`(照 §2/§3 A+B,骨架抄 qa-fly-1281 boot 模式)→ 跑绿,证据落盘;
3. C1 原样跑 PR 两脚本;C2 targeted vitest;红项走 main-HEAD 对照;
4. 独立代码走读(§3 末);
5. 写 `qa-report.md` + evidence commit 到 `flywheel-FLY-1432` 分支并 push;
6. 全程 progress ledger(`progress.md`)按 phase/cursor 更新;清房(worktree remove、tmux kill、env 恢复)。
