# FLY-2922 三域隔离收口与 QA@4 — 实施计划
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-29
基于: research.md

> **执行边界：** 当前 `test-slot-2` 的 design/implement/QA 都是房内受测 actor，只能写 QA sandbox 产物。本计划中的生产收口由生产 Bridge 绑定的生产 DAG 执行；QA@4 由生产 Bridge 派发的房外 QA exec 执行。身份以 StateStore 对当前 execution 的持久化登记为准，不以 cwd 推断；任何不匹配都 fail closed，`cd` 不能改变授权域。

**目标：** 先由生产 DAG 把 PR #1374 收敛到 latest-main ancestor、同头复审 APPROVED、精确头 `CI OK` 的冻结 SHA；再由房外 QA 从隔离 source clone 启动双房，用安全 fixture issue 跑完整九步 recovery driver，并独立核验“统一恢复后真有新派发”。

**架构：** 三个权限域只共享不可变的生产源码 SHA，不共享 cwd、repo 写权限、issue 或 verdict。生产 DAG 是 PR writer；房外 QA 是 room/evidence owner；房内 DAG 是 QA sandbox test subject。

---

## 1. actor 与 repo authority 矩阵

| Actor | 必须绑定 | 可写 | 输出 | 禁止 |
|---|---|---|---|---|
| Production Implement | 生产 Bridge exec + `xrliAnnie/flywheel` feature worktree | `flywheel-FLY-2922`、PR #1374 | final head、review、CI、`needs_review` receipt | 接受 slot stub verdict；让房内 runner 进入生产 checkout |
| Host QA Controller | 生产 Bridge 的 `qa` exec + 自己 claim 的两个 slot | 隔离 source clone、slot、evidence | QA verdict、snapshot、teardown receipts | 写生产 branch/PR；把 inner PASS 当最终 PASS |
| Inner Design/Implement | `test-slot-N` + `flywheel-qa-sandbox` worktree | sandbox fixture branch/PR | Steps 1–7 受测产物 | `cd` 生产 checkout；引用 PR #1374 |
| Inner QA Stub | slot-local stub control | 仅 stub result/receipt | 预定 FAIL→PASS 信号 | 起房、拆房、给生产头裁决 |

### 1.1 通用 fail-closed preflight

每个生产/房外执行者必须同时验证两类事实：

1. **cwd 事实**：`git rev-parse --show-toplevel`、branch、repo、HEAD；
2. **cwd 无关的可信身份**：`FLYWHEEL_PROJECT_NAME`、按 Bridge 同序解析出的 StateStore 路径，以及 `sessions` 表中以参数化查询读取的当前 `FLYWHEEL_EXEC_ID` 行。路径优先级为 `FLYWHEEL_STATE_DB_PATH`、`TEAMLEAD_DB_PATH`、`$HOME/.flywheel/teamlead.db`；生产 runner 没有注入第一个变量时仍能命中 Bridge 的默认库。

生产/房外执行者都必须拒绝 `project_name=test-slot-*`、任何 realpath 位于 `/tmp/flywheel-test-slot-*` 或 `/private/tmp/flywheel-test-slot-*` 的 StateStore，以及当前 git root 不等于该 exec 登记 `worktree_path` 的情况。生产 implement 还要求 `session_role=implement`；房外 QA 要求 `session_role=qa`。检查失败时只报告并停止，禁止换 cwd 重试。

当前 `test-slot-2` 明确属于 inner 域。因此它的后继 implement/QA 不执行 Task A–F 的 host/production 命令，也不对 PR #1374 调用 review、CI、approve 或 land。后继 implement 的唯一合法动作是保存身份拒绝证据，向当前 Lead 报告，然后执行 `complete --route no_code --summary "FLY-2922 recursive sandbox run refused production/host tasks"`；不得创建 PR。inner QA stub 不签发生产 verdict。

### 1.2 当前递归 run 的处置（房外 owner 专属）

只读审计确认宿主正在运行 `qa-529-generalized-e2e.mjs 2 --issue FLY-2922 --real --timeout-ms 3600000`，campaign owner slot 2 借用 slot 3。这一轮是错误 fixture，不能继续，也不能被未来 QA@4 复用。

生产 QA owner 在选择新房前必须：

1. 记录精确 driver PID/argv、campaign manifest、slots 2/3 claims 与 Bridge log；
2. 用 `node scripts/flywheel-snapshot-control.mjs runner --source /tmp/flywheel-test-slot-2/teamlead.db --kind teamlead` 与 `node scripts/flywheel-snapshot-control.mjs runner --source /tmp/flywheel-test-slot-2/state/comm/test-slot-2/comm.db --kind comm --project test-slot-2` 创建受控快照；
3. 仅在 PID/argv 仍逐字匹配后向该 driver 发 `TERM`，保存 exit receipt；
4. 从生产冻结源码执行 `scripts/test-teardown.sh 2`，确认 slots 2/3、campaign manifest、锁与相关进程均消失；
5. 将该轮标记为 infrastructure-invalid / recursive-fixture，不得转写为 FLY-2922 产品 FAIL/PASS。

当前 design/inner actor 不杀 driver、不拆房；处置权只属于房外 owner。

## 2. Task A — 生产 DAG 收口 PR #1374

**Owner：** 由生产 Bridge 派发、worktree binding 指向生产 feature worktree 的 implement exec。当前 sandbox exec 不可代办。

- [ ] **A1：取得 TURN 并确认生产身份**

```bash
set -euo pipefail
fail() { printf 'FLY-2922 preflight failed: %s\n' "$1" >&2; exit "$2"; }

TURN_RECEIPT="$(node "$FLYWHEEL_COMM_CLI" turn)"
case "$TURN_RECEIPT" in
  "yours phase=implement "*) ;;
  *) fail "implement TURN not held" 40 ;;
esac
ROOT="$(git rev-parse --show-toplevel)" || fail "cannot resolve git root" 41
test "${FLYWHEEL_PROJECT_NAME:-}" = "flywheel" || fail "project is not production flywheel" 42
test -z "${FLYWHEEL_ISOLATION_ROOT:-}" || fail "isolation root is present" 43
STATE_DB="${FLYWHEEL_STATE_DB_PATH:-${TEAMLEAD_DB_PATH:-${HOME:?HOME is required}/.flywheel/teamlead.db}}"
test -f "$STATE_DB" || fail "StateStore is missing" 44
STATE_DB_REAL="$(realpath "$STATE_DB")" || fail "cannot resolve StateStore" 45
case "$STATE_DB_REAL" in
  /tmp/flywheel-test-slot-*|/private/tmp/flywheel-test-slot-*) fail "slot StateStore refused" 46 ;;
esac
[[ "${FLYWHEEL_EXEC_ID:-}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || \
  fail "execution id is not a UUID" 47
IDENTITY_ROW="$(sqlite3 -readonly -noheader -separator '|' "$STATE_DB_REAL" \
  -cmd '.parameter init' \
  -cmd ".parameter set @exec '$FLYWHEEL_EXEC_ID'" \
  'SELECT project_name, issue_identifier, session_role, worktree_path
   FROM sessions WHERE execution_id = @exec;')" || fail "StateStore query failed" 48
test "$IDENTITY_ROW" = "flywheel|FLY-2922|implement|$ROOT" || fail "StateStore identity mismatch" 49
test "$(gh repo view --json nameWithOwner --jq .nameWithOwner)" = "xrliAnnie/flywheel" || fail "repository mismatch" 50
test "$(git branch --show-current)" = "flywheel-FLY-2922" || fail "branch mismatch" 51
test -z "$(git status --porcelain)" || fail "worktree is dirty" 52
git log --oneline -10
```

预期：`yours phase=implement`、可信 session 行绑定当前 production root、生产 repo/branch、净树。任一不符都会带诊断非零退出；不得 stash/drop/切 cwd。StateStore 只读查询先验证 execution id 的 UUID 形态，再用 sqlite 参数 `@exec` 绑定，不能把未验证输入拼进 SQL。

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
PRODUCTION_LEAD_ID="${FLYWHEEL_LEAD_ID:?missing production Lead identity}"
CODE_REVIEW_GATE="$(node "$FLYWHEEL_COMM_CLI" gate review_code \
  --lead "$PRODUCTION_LEAD_ID" \
  --exec-id "$FLYWHEEL_EXEC_ID" \
  --no-block "Code review requested for FLY-2922 exact head $FINAL_HEAD")"
CODE_REVIEW_QUESTION_ID="$(printf '%s' "$CODE_REVIEW_GATE" | jq -er .questionId)"
node "$FLYWHEEL_COMM_CLI" request-review --type code \
  --question-id "$CODE_REVIEW_QUESTION_ID"
```

`PRODUCTION_LEAD_ID` 来自生产执行上下文，不硬编码成测试 Lead。`CODE_REVIEW_QUESTION_ID` 只取上一步 gate JSON。每 turn 最多自然地 `check` 一次；CHANGES 后修复并开新 question。只有 `reviewVerdict=APPROVED` 且 receipt 明确绑定 `FINAL_HEAD` 才通过。

- [ ] **C3：精确头 full CI**

```bash
node "$FLYWHEEL_COMM_CLI" ci-full ensure --pr 1374 --head "$FINAL_HEAD" --json
gh pr checks 1374 --repo xrliAnnie/flywheel
```

必须是 `FINAL_HEAD` 的 `CI OK`；祖先绿不算。

- [ ] **C4：生产 DAG 交给 QA**

```bash
APPROVE_GATE="$(node "$FLYWHEEL_COMM_CLI" gate approve_to_ship \
  --lead "$PRODUCTION_LEAD_ID" \
  --exec-id "$FLYWHEEL_EXEC_ID" \
  --no-block "PR #1374 exact head $FINAL_HEAD is ready for founder review")"
APPROVE_QUESTION_ID="$(printf '%s' "$APPROVE_GATE" | jq -er .questionId)"
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr 1374 \
  --question-id "$APPROVE_QUESTION_ID"
node "$FLYWHEEL_COMM_CLI" ask --lead "$PRODUCTION_LEAD_ID" \
  --exec-id "$FLYWHEEL_EXEC_ID" --report \
  "DONE: FLY-2922 production handoff | HANDOFF_EXEC_ID=$FLYWHEEL_EXEC_ID | HANDOFF_HEAD=$FINAL_HEAD | PR: https://github.com/xrliAnnie/flywheel/pull/1374"
```

仅当 latest-main ancestor、remote/PR head、review、CI 四项同头才执行。不 ship、不 merge main。若 production Blueprint 下发的 completion 合同不同，以运行时合同为准；不可省略它要求的 gate 或 question binding。

## 5. Task D — 房外 QA 准备安全 source 与 fixture

**Owner：** 生产 Bridge 派发的 `qa` phase exec。Lead 只授权 fixture/房号，不代替 QA 执行 host commands；inner QA stub 也不执行。

进入 D1 前，先按 §1.1 的 StateStore 参数化查询验证：`project_name=flywheel`、`issue_identifier=FLY-2922`、`session_role=qa`，并确认 StateStore realpath 不位于任何 test slot。随后完成 §1.2 对旧递归 slots 2/3 的取证和 teardown；未完成时不得选新房。

```bash
set -euo pipefail
fail() { printf 'FLY-2922 QA preflight failed: %s\n' "$1" >&2; exit "$2"; }

TURN_RECEIPT="$(node "$FLYWHEEL_COMM_CLI" turn)"
case "$TURN_RECEIPT" in
  "yours phase=qa "*) ;;
  *) fail "QA TURN not held" 60 ;;
esac
QA_OWNER_ROOT="$(git rev-parse --show-toplevel)" || fail "cannot resolve git root" 61
test "${FLYWHEEL_PROJECT_NAME:-}" = "flywheel" || fail "project is not production flywheel" 62
test -z "${FLYWHEEL_ISOLATION_ROOT:-}" || fail "isolation root is present" 63
STATE_DB="${FLYWHEEL_STATE_DB_PATH:-${TEAMLEAD_DB_PATH:-${HOME:?HOME is required}/.flywheel/teamlead.db}}"
test -f "$STATE_DB" || fail "StateStore is missing" 64
STATE_DB_REAL="$(realpath "$STATE_DB")" || fail "cannot resolve StateStore" 65
case "$STATE_DB_REAL" in
  /tmp/flywheel-test-slot-*|/private/tmp/flywheel-test-slot-*) fail "slot StateStore refused" 66 ;;
esac
[[ "${FLYWHEEL_EXEC_ID:-}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || \
  fail "execution id is not a UUID" 67
IDENTITY_ROW="$(sqlite3 -readonly -noheader -separator '|' "$STATE_DB_REAL" \
  -cmd '.parameter init' \
  -cmd ".parameter set @exec '$FLYWHEEL_EXEC_ID'" \
  'SELECT project_name, issue_identifier, session_role, worktree_path
   FROM sessions WHERE execution_id = @exec;')" || fail "StateStore query failed" 68
test "$IDENTITY_ROW" = "flywheel|FLY-2922|qa|$QA_OWNER_ROOT" || fail "StateStore identity mismatch" 69
```

- [ ] **D1：冻结生产头和 QA fixture**

```bash
QA_HEAD="$(gh pr view 1374 --repo xrliAnnie/flywheel --json headRefOid --jq .headRefOid)"
test "$QA_HEAD" = "$HANDOFF_HEAD"
test "$QA_FIXTURE_ISSUE" != "FLY-2922"
test -n "$QA_FIXTURE_ISSUE"
```

`HANDOFF_HEAD` 取自上一 production implement 的 `needs_review` completion receipt，并与 StateStore `pr_head_sha`、PR `headRefOid` 三方比对；禁止手填。`QA_FIXTURE_ISSUE` 必须由 Lead 明确授权，正文只描述 sandbox fixture 行为并明确：repo 仅 `xrliAnnie/flywheel-qa-sandbox`、禁止生产路径/PR、禁止 ship。保存 identifier、Linear object id、description digest 与授权 receipt。无 fixture 时 ask Lead 要 fixture 并 park；不能退回 FLY-2922。

- [ ] **D2：创建隔离、detached source clone**

不用 implement 的可写 worktree。创建 QA owner 专属临时 clone：`origin` 指向 QA sandbox，用 `production` remote 只读 fetch `QA_HEAD`，然后 detached checkout 该对象。

```bash
QA_SRC_PARENT="$(mktemp -d /tmp/fly2922-qa-src.XXXXXX)"
QA_SRC="$QA_SRC_PARENT/source"
git clone --no-checkout https://github.com/xrliAnnie/flywheel-qa-sandbox.git "$QA_SRC"
git -C "$QA_SRC" remote add production https://github.com/xrliAnnie/flywheel.git
git -C "$QA_SRC" remote set-url --push production DISABLED
git -C "$QA_SRC" fetch production "$QA_HEAD"
git -C "$QA_SRC" checkout --detach "$QA_HEAD"
test "$(git -C "$QA_SRC" rev-parse HEAD)" = "$QA_HEAD"
test "$(git -C "$QA_SRC" status --porcelain)" = ""
(cd "$QA_SRC" && gh repo set-default xrliAnnie/flywheel-qa-sandbox)
test "$(git -C "$QA_SRC" remote get-url --push production)" = "DISABLED"
test "$(cd "$QA_SRC" && gh repo view --json nameWithOwner --jq .nameWithOwner)" = "xrliAnnie/flywheel-qa-sandbox"
LOCK_SHA="$(shasum -a 256 "$QA_SRC/pnpm-lock.yaml" | awk '{print $1}')"
(cd "$QA_SRC" && pnpm install --frozen-lockfile)
(cd "$QA_SRC" && pnpm --filter "flywheel-teamlead..." build)
test "$(git -C "$QA_SRC" rev-parse HEAD)" = "$QA_HEAD"
git -C "$QA_SRC" diff --quiet
test -z "$(git -C "$QA_SRC" status --porcelain --untracked-files=no)"
test "$(shasum -a 256 "$QA_SRC/pnpm-lock.yaml" | awk '{print $1}')" = "$LOCK_SHA"
```

这个 remote 拓扑同时满足：运行字节来自生产冻结头，GitHub 默认仓显式固定为 sandbox，production remote 没有可用 push URL。install/build 只准备依赖与 ignored dist；完成后冻结 HEAD、tracked diff 与 lockfile digest 必须不变。

- [ ] **D3：选两个明确空槽**

```bash
node "$FLYWHEEL_COMM_CLI" room list
```

把选定值显式写入 `PRIMARY_SLOT=<N>`、`SECONDARY_SLOT=<M>`；`EXTRA_LABEL=qa4-peer`。只选服务账中不存在、宿主也没有 `/tmp/flywheel-test-slot-N`/活锁/活进程的两个显式槽。禁止 `auto`、禁止借房、禁止拆陌生房。不够就 ask Lead 要号并 park。

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
  --real \
  --timeout-ms 3600000
```

开跑前再次断言：

- driver cwd 的 `gh repo view` 是 `xrliAnnie/flywheel-qa-sandbox`；
- fixture body digest 等于 D1；
- 当前 outer execution 不是 room 内 run 的 execution；
- 没有任何 room actor worktree 指向 `/Users/xiaorongli/Dev/flywheel-FLY-2922`。
- 已保存生产基线：PR #1374 的 `headRefOid`/`updatedAt`、remote branch SHA、生产 checkout HEAD/status，以及生产 push-guard audit log digest/size（文件不存在时记录 `ABSENT`，不能临时创建）。remote branch SHA 与 PR `headRefOid` 是生产未写入的权威证据；push-guard audit 不记录所有 fast-forward push，因此只作辅助异常信号。

`3600000` 是每个 wait 的一小时基础设施预算，覆盖真实 design、跨族 review 与 implement；任一 wait 超时单列为 infrastructure-inconclusive，保存证据并 teardown，不冒充产品行为 FAIL。任一身份/authority 不符即 teardown 自己房并判 FAIL，不尝试用生产 issue/repo“让流程继续”。

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

E3 还必须在 driver 结束后扫描所有 room `sessions.worktree_path`，证明没有生产 checkout；重新读取 PR `headRefOid`/`updatedAt`、remote branch SHA、生产 checkout HEAD/status、push-guard audit log digest/size。除允许的只读 GitHub `updatedAt` 漂移解释外，权威的 remote branch SHA、PR `headRefOid` 与 production checkout 必须与 E2 基线一致；push-guard audit delta 只作辅助诊断，不能替代 SHA 对照。任何生产写入迹象都使 QA@4 FAIL 并保留房间取证。

## 7. Task F — 先快照，再由 owner 拆房

- [ ] **F1：受控快照**

teardown 前保存 Steps 1–9、Bridge log、room/campaign claims、fixture digest、source SHA、E2/E3 生产不变前后对照、全量 room worktree scan 与相关 SQLite snapshot。实时 `teamlead.db`/`comm.db` 通过 `scripts/flywheel-snapshot-control.mjs runner ...` 或等价受控接口，禁止直接 `cp`。

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
- E2/E3 的生产 PR/remote/checkout/push-guard 前后对照，以及 room `sessions.worktree_path` 全量扫描。

房内 stub 的 `qaPassResult`、生产 PR 的 CI 绿或单个 `node_dispatched` 都不能单独构成 QA PASS。

## 9. 回滚与负控

- 生产 merge 出错：在尚未提交时 `git merge --abort`；已 push 的新 head 不强推回滚，按新 commit 修正并重新 review/CI。
- QA source/repo 不匹配：不起 driver，拆 owner 房；不改生产 remote 配置。
- fixture 指向 FLY-2922 或带生产写入指令：拒绝运行，向 Lead 要安全 fixture。
- inner actor 触达生产 cwd/PR：立即 FAIL，保存证据并终止 fixture run；不把已产生的 stub verdict 用于生产。
- 旧递归 slots 2/3 未按 §1.2 取证并清空：不启动 QA@4；当前 inner 后继只走 `no_code` 安全退出。
- snapshot 不完整：保留房位等待取证，不清证据。

## 10. 本设计节点交付边界

design 节点提交 `exploration.md`、`research.md`、本计划、`progress.md`、`review-result.md`、`delivery-evidence.md`、Founder HTML 及其 Mermaid source/SVG；取得当前 plan blob 的有效 design-review APPROVED 后发布/报告 HTML，并以 `phase_design_complete` 交还 DAG。

本节点不执行 Task A–F，不调度后继，不请求 ship。当前 sandbox 的后继 actor 也不得把 Task A–F 当成跨域授权；生产/host owner 必须由 orchestrator 另行绑定。
