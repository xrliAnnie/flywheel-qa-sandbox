# FLY-2922 三域隔离收口与 QA@4 — 实施计划
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-29
基于: research.md

> **执行边界：** 当前 `test-slot-2` 的 design/implement/QA 都是房内受测 actor，只能写 QA sandbox 产物。本计划中的生产收口由生产 Bridge 绑定的生产 DAG 执行；QA@4 由房外 QA controller/Lead 执行。任何 actor 身份不匹配都 fail closed，不用 `cd` 绕过。

**目标：** 先由生产 DAG 把 PR #1374 收敛到 latest-main ancestor、同头复审 APPROVED、精确头 `CI OK` 的冻结 SHA；再由房外 QA 从隔离 source clone 启动双房，用安全 fixture issue 跑完整九步 recovery driver，并独立核验“统一恢复后真有新派发”。

**架构：** 三个权限域只共享不可变的生产源码 SHA，不共享 cwd、repo 写权限、issue 或 verdict。生产 DAG 是 PR writer；房外 QA 是 room/evidence owner；房内 DAG 是 QA sandbox test subject。

---

## 1. actor 与 repo authority 矩阵

| Actor | 必须绑定 | 可写 | 输出 | 禁止 |
|---|---|---|---|---|
| Production Implement | 生产 Bridge exec + `xrliAnnie/flywheel` feature worktree | `flywheel-FLY-2922`、PR #1374 | final head、review、CI、`needs_review` receipt | 接受 slot stub verdict；让房内 runner 进入生产 checkout |
| Host QA Controller | 房外宿主 session + 自己 claim 的两个 slot | 隔离 source clone、slot、evidence | QA verdict、snapshot、teardown receipts | 写生产 branch/PR；把 inner PASS 当最终 PASS |
| Inner Design/Implement | `test-slot-N` + `flywheel-qa-sandbox` worktree | sandbox fixture branch/PR | Steps 1–7 受测产物 | `cd` 生产 checkout；引用 PR #1374 |
| Inner QA Stub | slot-local stub control | 仅 stub result/receipt | 预定 FAIL→PASS 信号 | 起房、拆房、给生产头裁决 |

### 1.1 通用 fail-closed preflight

每个执行者先输出并保存：`FLYWHEEL_EXEC_ID`、phase、`git rev-parse --show-toplevel`、`git branch --show-current`、`gh repo view --json nameWithOwner`、`git rev-parse HEAD`。与表中身份不符时停止并报告；不能切换到另一个域的路径继续。

当前 `test-slot-2` 明确属于 inner 域。因此它的后继 implement/QA 不执行 Task A–F 的 host/production 命令，也不对 PR #1374 调用 review、CI、complete、approve 或 land。

## 2. Task A — 生产 DAG 收口 PR #1374

**Owner：** 由生产 Bridge 派发、worktree binding 指向生产 feature worktree 的 implement exec。当前 sandbox exec 不可代办。

- [ ] **A1：取得 TURN 并确认生产身份**

```bash
node "$FLYWHEEL_COMM_CLI" turn
test "$(gh repo view --json nameWithOwner --jq .nameWithOwner)" = "xrliAnnie/flywheel"
test "$(git branch --show-current)" = "flywheel-FLY-2922"
test -z "$(git status --porcelain)"
git log --oneline -10
```

预期：`yours phase=implement`、生产 repo/branch、净树。任一不符就停；不得 stash/drop/切 cwd。

- [ ] **A2：冻结三方 head 与 latest main**

```bash
git fetch origin
HEAD_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/flywheel-FLY-2922)"
MAIN_SHA="$(git rev-parse origin/main)"
PR_SHA="$(gh pr view 1374 --repo xrliAnnie/flywheel --json headRefOid --jq .headRefOid)"
test "$HEAD_SHA" = "$REMOTE_SHA"
test "$HEAD_SHA" = "$PR_SHA"
```

设计快照是 head `6e21a123d34bb53ee29b8536503133d714f46435`、main `b165d649013d6b52899f395865e68d948c2f4831`。它们不是执行常量；以 A2 实测为准。

- [ ] **A3：只在 latest main 尚未包含时 merge**

```bash
if ! git merge-base --is-ancestor "$MAIN_SHA" HEAD; then
  git merge --no-edit origin/main
fi
```

只 merge，不 rebase、不 force push。冲突按下表做加法合并：

| 冲突面 | FLY-2922 必须保留 | main 必须保留 | 正向检查 |
|---|---|---|---|
| `run-dispatcher.ts` / `run-infra.ts` | `initialStartObserver`；恢复读冻结 start authority | `workflowPrefixLookup` 与 prefix resolver | constructor 与唯一工厂调用参数同序；恢复仍经正常 `start()` |
| recovery / StateStore | stage/apply CAS、真实 dispatch ledger、dead-only replacement、run 不因 carrier close 终结 | lifecycle/rework/quota guards | parked 交 coordinator；latched resume fail closed；dead 才铸替身 |
| `test-deploy.sh` / `qa-generalized.sh` | QA-only Claude shim；activation/StateStore 身份判断 | Codex guard record、新 slot ownership helper | QA stub 不截获真实 review；STUB/QA_STUB 分支互不吞并 |
| driver probe | slot `TMUX_TMPDIR`；清 `TMUX/TMUX_PANE` | 新观测字段 | Step 4 只在 room server 判 pane alive |

无法证明两边都保留时 `git merge --abort` 并报告具体冲突。

## 3. Task B — merge 后定点本地验证

**条件：** A3 没产生新 merge 时 N/A，不为制造证据重复跑测试。发生 merge 时先发现、再选择。

- [ ] **B1：发现受影响测试**

对每个实际冲突文件搜索完整路径、文件名、父目录与关键符号，并记录 retained/excluded 理由。例如：

```bash
git grep -lF -- 'packages/teamlead/src/bridge/run-dispatcher.ts'
git grep -lF -- 'run-dispatcher.ts'
git grep -lF -- 'initialStartObserver'
git grep -lF -- 'workflowPrefixLookup'
git grep -lF -- 'scripts/test-deploy.sh'
git grep -lF -- 'QA_STUB_RUNNER'
git grep -lF -- 'probeRoomPaneAlive'
```

禁止目录/glob/`-t`/裸 Vitest，也禁止枚举全包文件模拟 suite。

- [ ] **B2：逐个运行 concrete tests**

```bash
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-node-recovery.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-engine-dispatcher.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/StateStore.land-carryover.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/workflow-carrier-close-recovery.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/run-dispatcher-prefix.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/workflow-prefix-context.test.ts
node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs
bash scripts/__tests__/test-deploy-generalized.test.sh
```

若 B1 发现更多直接 consumer，逐文件追加。不存在的文件不能静默跳过。

- [ ] **B3：changed TypeScript related + lint/build**

```bash
pnpm --filter flywheel-teamlead exec vitest related src/bridge/run-dispatcher.ts src/bridge/run-infra.ts --run
pnpm lint
pnpm --filter "flywheel-teamlead..." build
git diff --check origin/main...HEAD
```

related 参数以 package cwd 为基准，只放实际 changed TypeScript。导出 API/type 变化时追加实际依赖包 typecheck。本地报告只能写 targeted checks；full suite 只认 CI。

## 4. Task C — 生产同头 review、CI 与 handoff

- [ ] **C1：push 并冻结最终 head**

```bash
git push origin HEAD:flywheel-FLY-2922
FINAL_HEAD="$(git rev-parse HEAD)"
test "$(git ls-remote origin refs/heads/flywheel-FLY-2922 | awk '{print $1}')" = "$FINAL_HEAD"
test "$(gh pr view 1374 --repo xrliAnnie/flywheel --json headRefOid --jq .headRefOid)" = "$FINAL_HEAD"
```

不用 `--no-verify` 或 force push。任何后续写入都生成新 head，并使 review/CI 重新绑定。

- [ ] **C2：在生产 exec 注册代码复审**

```bash
node "$FLYWHEEL_COMM_CLI" stage set code_review
node "$FLYWHEEL_COMM_CLI" gate review_code \
  --lead "$PRODUCTION_LEAD_ID" \
  --exec-id "$FLYWHEEL_EXEC_ID" \
  --no-block "Code review requested for FLY-2922 exact head $FINAL_HEAD"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id "$QUESTION_ID"
```

`PRODUCTION_LEAD_ID` 来自生产执行上下文，不硬编码成测试 Lead。每 turn 最多自然地 `check` 一次；CHANGES 后修复并开新 question。只有 `reviewVerdict=APPROVED` 且 receipt 明确绑定 `FINAL_HEAD` 才通过。

- [ ] **C3：精确头 full CI**

```bash
node "$FLYWHEEL_COMM_CLI" ci-full ensure --pr 1374 --head "$FINAL_HEAD" --json
gh pr checks 1374 --repo xrliAnnie/flywheel
```

必须是 `FINAL_HEAD` 的 `CI OK`；祖先绿不算。

- [ ] **C4：生产 DAG 交给 QA**

```bash
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr 1374
```

仅当 latest-main ancestor、remote/PR head、review、CI 四项同头才执行。不 ship、不 merge main。

## 5. Task D — 房外 QA 准备安全 source 与 fixture

**Owner：** 生产 QA phase 或 Lead 的房外 host controller。inner QA stub 不执行。

- [ ] **D1：冻结生产头和 QA fixture**

```bash
QA_HEAD="$(gh pr view 1374 --repo xrliAnnie/flywheel --json headRefOid --jq .headRefOid)"
test "$QA_HEAD" = "$HANDOFF_HEAD"
test "$QA_FIXTURE_ISSUE" != "FLY-2922"
test -n "$QA_FIXTURE_ISSUE"
```

`QA_FIXTURE_ISSUE` 必须由 Lead 明确授权，正文只描述 sandbox fixture 行为并明确：repo 仅 `xrliAnnie/flywheel-qa-sandbox`、禁止生产路径/PR、禁止 ship。保存 identifier、Linear object id、description digest 与授权 receipt。无 fixture 时 ask Lead 要 fixture 并 park；不能退回 FLY-2922。

- [ ] **D2：创建隔离、detached source clone**

不用 implement 的可写 worktree。创建 QA owner 专属临时 clone：`origin` 指向 QA sandbox，用 `production` remote 只读 fetch `QA_HEAD`，然后 detached checkout 该对象。

```bash
QA_SRC_PARENT="$(mktemp -d /tmp/fly2922-qa-src.XXXXXX)"
QA_SRC="$QA_SRC_PARENT/source"
git clone --no-checkout git@github.com:xrliAnnie/flywheel-qa-sandbox.git "$QA_SRC"
git -C "$QA_SRC" remote add production git@github.com:xrliAnnie/flywheel.git
git -C "$QA_SRC" fetch production "$QA_HEAD"
git -C "$QA_SRC" checkout --detach "$QA_HEAD"
test "$(git -C "$QA_SRC" rev-parse HEAD)" = "$QA_HEAD"
test "$(git -C "$QA_SRC" status --porcelain)" = ""
test "$(cd "$QA_SRC" && gh repo view --json nameWithOwner --jq .nameWithOwner)" = "xrliAnnie/flywheel-qa-sandbox"
```

这个 remote 拓扑同时满足：运行字节来自生产冻结头，driver 的 PR authority 从 `room.flywheelRepo` 解析时只能落到 QA sandbox。

- [ ] **D3：选两个明确空槽**

```bash
node "$FLYWHEEL_COMM_CLI" room list
```

只选服务账中不存在、宿主也没有 `/tmp/flywheel-test-slot-N`/活锁/活进程的两个显式槽。禁止 `auto`、禁止借房、禁止拆陌生房。不够就 ask Lead 要号并 park。

## 6. Task E — 房外 QA 起房并运行安全 driver

- [ ] **E1：从隔离 source clone 起双房**

```bash
cd "$QA_SRC"
scripts/test-deploy.sh "$PRIMARY_SLOT" \
  --mode slot \
  --generalized \
  --codex-runner \
  --qa-stub-runner \
  --extra-lead "$SECONDARY_SLOT:$EXTRA_LABEL" \
  --expect-head "$QA_HEAD" \
  --from-branch main
```

记录 `room-info.json`、`campaign-manifest.json`、两个 slot claim；断言 `room.flywheelRepo=$QA_SRC`、`buildSha=$QA_HEAD`、host repo remote 是 QA sandbox。

- [ ] **E2：运行 fixture driver，绝不使用 FLY-2922**

```bash
cd "$QA_SRC"
node scripts/qa-529-generalized-e2e.mjs "$PRIMARY_SLOT" \
  --issue "$QA_FIXTURE_ISSUE" \
  --real
```

开跑前再次断言：

- driver cwd 的 `gh repo view` 是 `xrliAnnie/flywheel-qa-sandbox`；
- fixture body digest 等于 D1；
- 当前 outer execution 不是 room 内 run 的 execution；
- 没有任何 room actor worktree 指向 `/Users/xiaorongli/Dev/flywheel-FLY-2922`。

任一不符即 teardown 自己房并判 FAIL，不尝试用生产 issue/repo“让流程继续”。

- [ ] **E3：外层 owner 核验 Steps 1–9**

driver exit 0 只是必要条件。外层 owner 还要保存并核验：

1. Step 1 manifest/entry authority；
2. Step 2 真实 Claude design review，不是 QA shim；
3. Step 3 implement attempt 1 与 sandbox PR authority；
4. Step 4 `ship_parked + park_opened`，pane 由 slot `TMUX_TMPDIR` 判活；
5. Step 5 QA attempt 1 dispatch；
6. Step 6 精确 rework request、durable wake receipt、run 仍 active、无 dangerous hold；
7. Step 7 新 implement execution、launch ordinal、dispatch ledger/receipt，sandbox PR head 推进；
8. Step 8 stub PASS 只推进 fixture run，不触达生产 PR；
9. Step 9 park cleared、terminal timestamp、旧 actor dead。

至少一层来自 StateStore/CommDB 原始行，另一层来自 driver artifact/Bridge log。摘要事件不能一份充两层。

## 7. Task F — 先快照，再由 owner 拆房

- [ ] **F1：受控快照**

teardown 前保存 Steps 1–9、Bridge log、room/campaign claims、fixture digest、source SHA、相关 SQLite snapshot。实时 `teamlead.db`/`comm.db` 通过 `scripts/flywheel-snapshot-control.mjs runner ...` 或等价受控接口，禁止直接 `cp`。

- [ ] **F2：raw deploy 的唯一 teardown 路径**

```bash
cd "$QA_SRC"
scripts/test-teardown.sh "$PRIMARY_SLOT"
```

本拓扑由 raw `test-deploy.sh --qa-stub-runner` 创建，没有 room service `ROOM_ID`，所以不写 `room teardown --room` 分支。`test-teardown.sh` 根据 owner slot 的 campaign manifest 清 extra Lead 和 borrowed lock。snapshot 失败时保留房并报告，不用 `--skip-snapshot`。

- [ ] **F3：清理隔离 source**

确认两个 slot 已释放、evidence 已移出临时 clone、`QA_SRC_PARENT` 是本轮 owner 创建且匹配 `/tmp/fly2922-qa-src.*` 后，才删除该临时 clone。不得删除生产 checkout 或共享 worktree。

## 8. 最终 QA PASS 合同

房外 QA/Lead 的报告必须列出：

- 生产冻结 SHA、同头 review question/verdict、精确头 CI run；
- fixture issue id/digest 与 sandbox repo；
- 两个 slot 与 campaign owner claim；
- driver exit 和 Steps 1–9 artifact；
- old/new execution tuple、launch ordinal、dispatch ledger/receipt；
- run 在恢复期间保持 active；
- snapshot 路径与 raw teardown receipts。

房内 stub 的 `qaPassResult`、生产 PR 的 CI 绿或单个 `node_dispatched` 都不能单独构成 QA PASS。

## 9. 回滚与负控

- 生产 merge 出错：在尚未提交时 `git merge --abort`；已 push 的新 head 不强推回滚，按新 commit 修正并重新 review/CI。
- QA source/repo 不匹配：不起 driver，拆 owner 房；不改生产 remote 配置。
- fixture 指向 FLY-2922 或带生产写入指令：拒绝运行，向 Lead 要安全 fixture。
- inner actor 触达生产 cwd/PR：立即 FAIL，保存证据并终止 fixture run；不把已产生的 stub verdict 用于生产。
- snapshot 不完整：保留房位等待取证，不清证据。

## 10. 本设计节点交付边界

design 节点提交 `exploration.md`、`research.md`、本计划、`progress.md`、`review-result.md`、`delivery-evidence.md`、Founder HTML 及其 Mermaid source/SVG；取得当前 plan blob 的有效 design-review APPROVED 后发布/报告 HTML，并以 `phase_design_complete` 交还 DAG。

本节点不执行 Task A–F，不调度后继，不请求 ship。当前 sandbox 的后继 actor 也不得把 Task A–F 当成跨域授权；生产/host owner 必须由 orchestrator 另行绑定。
