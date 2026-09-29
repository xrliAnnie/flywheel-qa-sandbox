# FLY-2922 重开同头收口与 QA@4 — 实施计划
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-29
基于: research.md

> **执行边界：** 本计划由 DAG 的 implement 与 QA 节点按 TURN 顺序执行。design 节点只交付本计划，不执行以下步骤、不调度后继、不请求 ship。

**目标：** 把 PR #1374 收敛到一个同时具备 latest-main ancestor、同头代码复审 APPROVED、精确头 `CI OK` 的冻结头，再由 QA@4 在自己占用的隔离双房中跑完真实 Claude 设计评审与九步 recovery driver。

**架构：** 使用一个 40 位 head SHA 贯穿 merge、review、CI、房间部署和 QA evidence。实现阶段是“头收口器”；QA 阶段是“运行时证据采集器”。任何写入导致 head 变化，所有下游证据必须从该新 head 重绑。

**技术栈：** Git/GitHub PR、TypeScript/Vitest、Bash harness、tmux slot namespace、SQLite StateStore/CommDB、Flywheel review/room receipts。

---

## 1. 当前基线与完成判据

设计时快照：PR head `6e21a123d34bb53ee29b8536503133d714f46435`，main `b165d649013d6b52899f395865e68d948c2f4831`，PR clean/mergeable，CI run `36544821509` 全绿。

这个快照不是永久常量。implement 开始时必须重新取值。实现阶段只有在以下四条同时指向最终 `HEAD` 时才可 `complete --route needs_review --pr 1374`：

1. `origin/main` 是 `HEAD` 的祖先；
2. `origin/flywheel-FLY-2922` 与 GitHub PR #1374 head 都等于 `HEAD`；
3. 当前 review question 的 `reviewVerdict=APPROVED` 且审阅对象是 `HEAD`；
4. GitHub 在 `HEAD` 上给出 `CI OK`，不是祖先提交的绿。

QA@4 只有在以下证据齐全时才 PASS：双房 claim 属于当前 QA；房间 source head = 冻结 `HEAD`；设计评审真实走 Claude；driver Steps 1–9 全部成功；Step 6/7 的 old→new actor/dispatch 证据可从持久账本复核；证据已快照；两个房位均由 owner teardown。

## 2. Task 1 — implement 取得 TURN 并冻结远端身份

**读写范围：** 生产 feature worktree 与其分支；不碰本 design sandbox。

- [ ] **Step 1：取得 implement TURN，检查 mailbox**

```bash
node "$FLYWHEEL_COMM_CLI" turn
node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"
```

预期：`yours phase=implement`。`not-yours` 时不碰工作树，park 当前 turn，等待 phase wake。

- [ ] **Step 2：确认 checkout 身份与干净状态**

```bash
test "$(git branch --show-current)" = "flywheel-FLY-2922"
test -z "$(git status --porcelain)"
git log --oneline -10
```

预期：三条退出 0；若有未知改动，停止并报告，不能 stash/drop 他人状态。

- [ ] **Step 3：拉取 refs 并冻结三方 SHA**

```bash
git fetch origin
HEAD_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/flywheel-FLY-2922)"
MAIN_SHA="$(git rev-parse origin/main)"
PR_SHA="$(gh pr view 1374 --repo xrliAnnie/flywheel --json headRefOid --jq .headRefOid)"
test "$HEAD_SHA" = "$REMOTE_SHA"
test "$HEAD_SHA" = "$PR_SHA"
printf 'HEAD=%s\nMAIN=%s\n' "$HEAD_SHA" "$MAIN_SHA"
```

预期：两个 identity 断言通过。若远端已由别的 TURN holder 推进，停止；不得把本地旧头强推回去。

## 3. Task 2 — 只在必要时合 latest main

- [ ] **Step 1：判定是否需要 merge**

```bash
if git merge-base --is-ancestor "$MAIN_SHA" HEAD; then
  printf 'MAIN_ALREADY_CONTAINED %s\n' "$MAIN_SHA"
else
  printf 'MERGE_REQUIRED %s\n' "$MAIN_SHA"
fi
```

设计时基线预期 `MAIN_ALREADY_CONTAINED b165d649…`。如果 main 已包含，不创建空 merge、不改文档来制造新 head，直接进入 Task 4。

- [ ] **Step 2：main 后移时执行 merge，不 rebase**

```bash
git merge --no-edit origin/main
```

若冲突，逐文件应用 §3.1 的语义表。无法证明两边都保留时 `git merge --abort`，报告具体冲突；不猜、不重写历史。

### 3.1 冲突语义表

| 冲突面 | 必须保留的 FLY-2922 语义 | 必须保留的 main 语义 | 正向检查 |
|---|---|---|---|
| `run-dispatcher.ts` / `run-infra.ts` | `initialStartObserver` 最后一个参数；恢复派发读取冻结 root/non-root start authority | `workflowPrefixLookup` 及其 `resolveExecutionWorkflowPrefixContext` 调用 | constructor 与唯一工厂调用参数同序；恢复仍经正常 `start()` |
| `workflow-node-recovery.ts` / StateStore | stage/apply CAS、真实 dispatch ledger/receipt、dead-only replacement、run 不因 carrier close 终结 | main 新增 lifecycle/rework/quota guard | parked body 交 coordinator；latched resume fail closed；dead 才铸替身 |
| `test-deploy.sh` | 独立 `elif QA_STUB_RUNNER`、只装 Claude QA shim、真实 Claude 评审透传 | `STUB_RUNNER` 的 room-local Codex guard record 与 main 新 flags | QA-only 分支不写 Codex shim/guard，不吞并 STUB_RUNNER 分支 |
| `qa-generalized.sh` | activation/StateStore 识别 QA，real Claude 防递归透传 | guard-record helper 与新 slot ownership helpers | 函数边界完整；无身份调用走 real Claude |
| driver probe | `probeRoomPaneAlive` 以 slotDir 设 `TMUX_TMPDIR` | main 的新增观测/生命周期字段 | Step 4 活 pane 只在 room server 判 alive |

## 4. Task 3 — merge 发生时做定点本地验证

如果 Task 2 无新 merge，这一 task 为 N/A，不重复已绿 head 的本地测试。若发生 merge，必须先发现选择，再执行。

- [ ] **Step 1：建立测试发现清单**

对每个冲突文件执行完整路径、文件名、父目录与冲突符号的 `git grep -lF`。示例：

```bash
git grep -lF -- 'packages/teamlead/src/bridge/run-dispatcher.ts'
git grep -lF -- 'run-dispatcher.ts'
git grep -lF -- 'initialStartObserver'
git grep -lF -- 'workflowPrefixLookup'
git grep -lF -- 'scripts/test-deploy.sh'
git grep -lF -- 'QA_STUB_RUNNER'
git grep -lF -- 'probeRoomPaneAlive'
```

把每个命中标为 retained/excluded 并写原因。禁止用目录、glob、`-t`、裸 `vitest`，也禁止枚举整包全部文件模拟 suite。

- [ ] **Step 2：逐个运行 retained concrete tests**

最低保留集合是一文件一次；若 Step 1 发现更多直接消费者，再逐个追加，不能用一个目录或 glob 代替：

```bash
pnpm --filter flywheel-teamlead exec vitest run packages/teamlead/src/bridge/__tests__/run-dispatcher-prefix.test.ts
pnpm --filter flywheel-teamlead exec vitest run packages/teamlead/src/bridge/__tests__/workflow-node-recovery.test.ts
pnpm --filter flywheel-teamlead exec vitest run packages/teamlead/src/__tests__/workflow-prefix-context.test.ts
node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs
node --test scripts/__tests__/qa-generalized-codex-stub.test.mjs
bash scripts/__tests__/test-deploy-generalized.test.sh
```

预期：每个命令 exit 0。

- [ ] **Step 3：changed TypeScript 的 owning related 检查**

```bash
pnpm --filter flywheel-teamlead exec vitest related packages/teamlead/src/bridge/run-dispatcher.ts packages/teamlead/src/bridge/run-infra.ts --run
```

若实际 merge 还改了其他 TypeScript 文件，把它们的精确路径追加到同一 owning-package related 命令。不得用目录、glob 或 package alias 替代 changed-file 列表。

- [ ] **Step 4：lint、affected build、typecheck 与 diff hygiene**

```bash
pnpm lint
pnpm --filter "flywheel-teamlead..." build
git diff --check origin/main...HEAD
```

若 exported API/type 变化，再运行实际依赖包的 typecheck。报告必须写“targeted local checks”，不能称 full suite。

- [ ] **Step 5：记录冲突取舍并提交**

只在 merge 产生实际新差异时更新 `engineering/doc/milestones/FLY-2922.md`，逐文件记录两边语义与测试选择；提交后工作树必须干净。

## 5. Task 4 — push、同头代码复审、精确头 CI

- [ ] **Step 1：push 并再次冻结 head**

```bash
git push origin HEAD:flywheel-FLY-2922
HEAD_SHA="$(git rev-parse HEAD)"
test "$(git ls-remote origin refs/heads/flywheel-FLY-2922 | awk '{print $1}')" = "$HEAD_SHA"
```

禁止 `--no-verify` 与 force push。push 后不再修改任何文件；若需修改，回到本 task 开头并形成新 head。

- [ ] **Step 2：为当前 head 注册代码复审**

```bash
node "$FLYWHEEL_COMM_CLI" stage set code_review
node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-test-2 --exec-id "$FLYWHEEL_EXEC_ID" --no-block "Code review requested for FLY-2922 exact head ${HEAD_SHA}"
```

捕获输出的 `questionId`，然后：

```bash
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id "$QUESTION_ID"
```

每个 turn 最多自然地执行一次 `check "$QUESTION_ID"`；不在同一 turn sleep/poll。`CHANGES_REQUESTED` 时只修 blocking finding，push 新 head，开启**新** gate/request；`APPROVED` 才继续。advisory 用 `ask --report` 转告 Lead，不伪称已修。

- [ ] **Step 3：核验 review 与 head 同一**

有效回执必须明确当前 `HEAD_SHA`、`reviewVerdict=APPROVED` 和 reviewer-model validation。旧 `9c5aef2d2` 或旧 question 的 APPROVED 不可复用。

- [ ] **Step 4：确保精确头 full CI**

```bash
node "$FLYWHEEL_COMM_CLI" ci-full ensure --pr 1374 --head "$HEAD_SHA" --json
gh pr checks 1374 --repo xrliAnnie/flywheel
```

预期：`CI OK` 与所需 job 在 `HEAD_SHA` 上成功。设计时 `6e21a123d` 已满足；若 Step 1 产生新 head，必须等新 run，不能引用 `36544821509`。

- [ ] **Step 5：交给 QA**

```bash
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr 1374
```

只有 §1 四条同时成立才执行。不请求 ship、不 merge PR。

## 6. Task 5 — QA@4 自己选择并占用双房

**所有权：** 这一 task 只由 QA 节点执行。QA 先取得自己的 TURN，并检查 inbox。

- [ ] **Step 1：查 service ledger，不做写入**

```bash
node "$FLYWHEEL_COMM_CLI" room list
```

从输出选择两个未在服务账中的显式槽位。再逐个检查 `/tmp/flywheel-test-slot-N`、`.lock` 与活进程；任一存在就换号。两个都找不到时，QA 用非阻塞 `ask` 向 Lead 要号并 park；禁止 `auto`、禁止借用、禁止拆陌生房。

- [ ] **Step 2：验证 source checkout 就是冻结 head**

```bash
QA_HEAD="$(gh pr view 1374 --repo xrliAnnie/flywheel --json headRefOid --jq .headRefOid)"
test "$(git rev-parse HEAD)" = "$QA_HEAD"
test "$(git rev-parse origin/flywheel-FLY-2922)" = "$QA_HEAD"
```

若 PR 在 implement handoff 后又推进，QA 不起房，退回新 head 的 review/CI gate。

- [ ] **Step 3：用两个明确空槽起房**

```bash
EXTRA_LABEL=flywheel-test-2-extra
test -n "$PRIMARY_SLOT"
test -n "$SECONDARY_SLOT"
test "$PRIMARY_SLOT" != "$SECONDARY_SLOT"
scripts/test-deploy.sh "$PRIMARY_SLOT" \
  --mode slot \
  --generalized \
  --codex-runner \
  --qa-stub-runner \
  --extra-lead "${SECONDARY_SLOT}:${EXTRA_LABEL}" \
  --expect-head "$QA_HEAD" \
  --from-branch main
```

`PRIMARY_SLOT` 与 `SECONDARY_SLOT` 必须由 QA 在 Step 1 根据实际 `room list` 与宿主空位审计设置；脚本输出的 room/campaign claim 与两个 slot 都要写入 QA evidence。

## 7. Task 6 — QA@4 跑完整 driver 并证明恢复确实铸体

- [ ] **Step 1：运行真实 driver**

```bash
node scripts/qa-529-generalized-e2e.mjs "$PRIMARY_SLOT" --issue FLY-2922 --real
```

唯一 PASS 是 exit 0 且 Steps 1–9 都有 evidence。exit 20/21 或其他非零都是 FAIL/诊断，不得降格成 PASS。

- [ ] **Step 2：验证真实 Claude design review**

从 slot `teamlead.db` / Bridge log 保存 `review_model_routed`、review request/verdict 与 reviewer execution 证据，证明 reviewer family/vendor 为 Claude。任何 `codex_quota_fallback` 把 eng_design producer 从 Codex 改成 Claude 的记录都使本轮拓扑无效；QA-only stub 日志只能属于 QA execution。

- [ ] **Step 3：保存统一恢复的 strength-two 证据**

至少保存：

- run/node/attempt 的旧 execution 与 Step 7 当前 execution；
- Step 6 精确 rework request、delivery state、`rework_delivery_wake_delivered` receipt；
- run 在故障恢复期间仍为 `active`，没有 generic held/dead-run 级联；
- 新当前 execution 的 launch ordinal、dispatch ledger/receipt 与被 driver 消费后的状态；
- attempt 1/2 PR head 发生预期推进；
- Step 9 park cleared、terminal timestamp 和 actor dead。

同一个摘要事件不能同时充当两层证据；至少一层来自原始 StateStore/CommDB 行，另一层来自 driver step artifact/Bridge log。

- [ ] **Step 4：完整性负控**

确认 Step 4 的 pane probe 证据带房间 `TMUX_TMPDIR=/tmp/flywheel-test-slot-${PRIMARY_SLOT}`；宿主 namespace 不得被当作活 pane。确认 `dangerousReworkRows` 为空，且没有 `returned_to_lead`/generic held 偷换“新派发”。

## 8. Task 7 — 先快照证据，再拆自己房

- [ ] **Step 1：保存 evidence**

在 teardown 前保存 driver Steps 1–9、Bridge log、room-info/owner claim、相关 SQLite snapshot 与 exact head/review/CI receipts。实时 `teamlead.db`/`comm.db` 必须通过 runner snapshot control 或 room service 的受控 snapshot，禁止直接 `cp`。

- [ ] **Step 2：owner teardown**

优先使用 room receipt 给出的 room id：

```bash
node "$FLYWHEEL_COMM_CLI" room teardown --room "$ROOM_ID"
```

若本轮确实由 raw `test-deploy.sh` 创建且有当前 claim/token，则按脚本回执使用 `scripts/test-teardown.sh "$PRIMARY_SLOT"`；先确认它会连同 campaign 的 extra slot 一起按 service claim 清理。snapshot 失败时保留房位并报告，不能用 `--skip-snapshot` 隐藏证据缺口。

- [ ] **Step 3：最终 QA 报告**

报告列出冻结 SHA、review gate、CI run、两个 slot/room claim、driver exit/9 个 step、old→new dispatch tuple、证据目录与 teardown receipts。没有这组闭环，就不是 QA PASS。

## 9. 拒绝的替代方案

- 再次固定合 `23a1d80e8` 或 `b165d6490`，而不先查 ancestor：拒绝，状态会继续前进。
- 复用祖先 head 的 APPROVED/CI：拒绝，review 与 full CI 都是 head-bound。
- 让 design/implement 代 QA 起房：拒绝，破坏 room owner 与证据归属。
- 使用 `auto` 找槽或 raw teardown 清陌生目录：拒绝，可能破坏别人的房。
- 把 Codex producer fallback 成 Claude 后继续：拒绝，目标拓扑已改变。
- 只看 `node_dispatched` 或 run status：拒绝，不能证明真实 ledger/ordinal/consumer。
- 关掉旧执行体时顺带终结 run：拒绝，直接违反本 issue 的核心不变量。

## 10. 本设计节点的交付边界

design 节点只提交 `exploration.md`、`research.md`、本计划、progress 与 founder HTML；取得有效 design-review APPROVED 后发布/报告 HTML，并以 `phase_design_complete` 交还 DAG。它不运行以上 implement/QA 步骤，也不以当前外部 CI 绿冒充后继节点已经完成。
