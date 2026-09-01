# FLY-2174 QA 房环境尾账 — 实施计划
Issue: FLY-2174 (https://linear.app/geoforge3d/issue/FLY-2174/fly-2165-尾账-3-条缺终态戳裁决-slot-membership-conflict-test-deploy-alerts-env)
日期: 2026-08-31
基于: research.md

> **执行合同：** 在当前 implement DAG 节点内逐任务执行；每个行为修改严格使用 RED → GREEN → REFACTOR，并在完成前通过 verification 与 code-review gate。节点边界禁止分派 successor、merge 或 deploy。

**Goal:** 修复 529 房 alerts carrier identity 冲突，并给 generalized Bridge/Runner 链路提供独立 ingest credential，使真实 Codex DAG 能通过 design gate 并铸出 implement worker。

**Architecture:** wrapper-v2 继续是 Lead identity 的唯一权威；alerts 只修改 canonical projects 数据和非 identity isolation env，不再复制 projects path/token。所有 Bridge launch 分支先移除 ambient `TEAMLEAD_INGEST_TOKEN`；generalized 分支再通过 sourceable helper 把独立的 slot-local ingest credential 放进真实 child environment。现有 Blueprint 与 tmux adapters 负责把该值投影为 Runner 的 `FLYWHEEL_INGEST_TOKEN`。

**Tech Stack:** Bash 3.2-compatible shell、jq、launchd-v2 QA carrier、Node/TypeScript monorepo、shell hermetic tests、pnpm/Vitest。

---

## 文件职责

| 文件 | 责任 | 计划动作 |
|---|---|---|
| `scripts/test-deploy.sh` | 529 slot 组装、Lead/Bridge launch env、generalized token mint | 删除 alerts identity duplicate；所有 Bridge 分支 scrub ambient ingest；generalized 分支注入独立 ingest token |
| `scripts/lib/qa-generalized.sh` | generalized 纯/sourceable helper | 新增 normalized ingest resolver 与 scrub-then-inject child exec helper |
| `scripts/__tests__/test-deploy-fly1389.test.sh` | 真 test-deploy + stub carrier/launchd/Bridge 的 hermetic E2E | 新增 `--alerts` carrier 回归；把 stub 判据对齐真实 wrapper |
| `scripts/__tests__/test-deploy-qa-room.test.sh` | alerts/roundtable env composition 合同 | 把旧 duplicate 期望改为 canonical-source 期望 |
| `scripts/__tests__/test-deploy-generalized.test.sh` | generalized helper 与 wiring 合同 | 覆盖 ingest generate/override/collision/redaction/Bridge wiring |
| `engineering/doc/FLY-2174-qa-room-env-debt/progress.md` | restart cursor | 每批更新 |
| `engineering/doc/milestones/FLY-2174.md` | PR 里程碑 | PR 前作为 literal last commit 新建 |

## Task 1：RED — 让 tests 复现 alerts carrier identity 冲突

**Files:**

- Modify: `scripts/__tests__/test-deploy-fly1389.test.sh`
- Modify: `scripts/__tests__/test-deploy-qa-room.test.sh`

- [ ] **Step 1: 把 hermetic wrapper 判据对齐 production wrapper**

在 fly1389 stub carrier 读取 canonical projects path，并拒绝 drift；保留 bot token manifest 拒绝：

```bash
CANONICAL_PROJECTS_FILE=$(jq -r '.projectsFile' "$MANIFEST")
MANIFEST_PROJECTS_FILE=$(jq -r '.launchEnvironment.FLYWHEEL_PROJECTS_FILE // empty' "$MANIFEST")
if [[ "$MANIFEST_PROJECTS_FILE" != "$CANONICAL_PROJECTS_FILE" ]]; then
  echo "identity_launch_env_conflict FLYWHEEL_PROJECTS_FILE expected '$CANONICAL_PROJECTS_FILE', got '$MANIFEST_PROJECTS_FILE'" >&2
  exit 86
fi
if jq -e --arg name "$TOKEN_ENV" '.launchEnvironment | has($name)' "$MANIFEST" >/dev/null; then
  echo "identity_launch_env_conflict $TOKEN_ENV may not be supplied by the manifest" >&2
  exit 86
fi
```

- [ ] **Step 2: 给 fixture 增加 isolated alert channel 与 Discord curl stub**

在 `make_slots_json` 顶层加入：

```jq
alertChannel: {
  channelId: "alert-fixture",
  repairBotTokenEnv: "TEST_BOT_TOKEN_31"
}
```

`STUB_BIN/curl` 只拦截 Discord URL 并返回 alerts visibility 所需的 `200`；localhost health 与其他请求 `exec` 测试启动前捕获的真实 curl。stub 不记录 Authorization bytes，避免遮蔽真实 Lead/Bridge readiness。

- [ ] **Step 3: 新增真实 composition 的 A 用例**

执行：

```bash
run_deploy "$FH1" "$LEAD_SLOT" "$A_OUT" "$A_ERR" --alerts
```

成功后断言 manifest 顶层 `projectsFile` 与 `launchEnvironment.FLYWHEEL_PROJECTS_FILE` 都是 `/tmp/flywheel-test-slot-31/q/31/projects.json`，`launchEnvironment` 不含 `TEST_BOT_TOKEN_31`；`lead-env.txt` 含 canonical projects path、generic `DISCORD_BOT_TOKEN=tok-31` 与 slot-local claims DB，但不含 named token。

- [ ] **Step 4: 修正 qa-room composition test 的期望**

不再向 `LEAD_EXTRA_ENV` 追加 projects/token。这个 mirror suite 只验证 composition/coupling，不作为 RED 主证据；runtime identity/token 行为由 fly1389 subject execution 证明。

```bash
CANONICAL_LEAD_IDENTITY_ENV=(
  "FLYWHEEL_PROJECTS_FILE=${SLOT_DIR}/q/1/projects.json"
  "DISCORD_BOT_TOKEN=${TEST_BOT_TOKEN}"
)
RUNTIME_LEAD_ENV=$(printf '%s\n' "${LEAD_EXTRA_ENV[@]}" "${CANONICAL_LEAD_IDENTITY_ENV[@]}")
```

断言 extra env 不含 identity key，而 runtime combined env 同时具备 canonical identity 与 alert isolation。

- [ ] **Step 5: 运行 RED**

```bash
bash scripts/__tests__/test-deploy-qa-room.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
```

Expected: fly1389 的真实 subject execution 在当前生产代码上因 `identity_launch_env_conflict` 失败；qa-room mirror 可保持绿色或因 composition 断言失败，但不冒充独立 RED 证据。失败不得来自 curl 假 health 或 fixture 配置错误。

## Task 2：GREEN — 删除 alerts 的第二 identity source

**Files:**

- Modify: `scripts/test-deploy.sh`

- [ ] **Step 1: 删除两条 alerts identity append**

删除：

```bash
LEAD_EXTRA_ENV+=("FLYWHEEL_PROJECTS_FILE=${SLOT_DIR}/flywheel-projects.json")
LEAD_EXTRA_ENV+=("${BOT_TOKEN_ENV}=${TEST_BOT_TOKEN}")
```

把 alerts block 与后续 projects injection block 的陈旧注释一起改为：shell alert 从 `qa_slot_start_lead` 的 canonical projects file 与 mode-0600 wrapper env file 取得 identity；本分支只负责 projects alert fields 与非 identity isolation vars。删除 host token 也避免 extra Lead 继承非 canonical named token。

- [ ] **Step 2: 运行 GREEN**

```bash
bash scripts/__tests__/test-deploy-qa-room.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
```

Expected: 两套全绿，A 用例证明 Lead runtime 仍能看到 canonical projects/generic token，manifest 不携带 named token。本批不提前声明 ingest scrub；该行为在 Task 3/4 独立 RED/GREEN。

- [ ] **Step 3: 提交第一批**

```bash
git add scripts/test-deploy.sh scripts/__tests__/test-deploy-fly1389.test.sh scripts/__tests__/test-deploy-qa-room.test.sh
git commit -m "fix(FLY-2174): preserve canonical alert Lead identity"
```

## Task 3：RED — 锁住 generalized master/ingest 分权

**Files:**

- Modify: `scripts/__tests__/test-deploy-fly1389.test.sh`
- Modify: `scripts/__tests__/test-deploy-generalized.test.sh`

- [ ] **Step 1: 修复 ambient control，并让 default/reply live env 先 RED**

在 `run_deploy` 的 `env -i` allowlist 显式加入：

```bash
TEAMLEAD_INGEST_TOKEN="${TEAMLEAD_INGEST_TOKEN:-}"
```

然后让既有 default E 和 reply-by-issue I 两个真实 subject runs 都从 `TEAMLEAD_INGEST_TOKEN=fixture-production-ingest` 父环境启动，并分别断言 live `bridge-env.txt` 不含该值。修改 production 前先证明两条断言都失败，确认 control 的 production bearer 确实到达被测 exec boundary；不得接受父层 `env -i` 已丢值的 null control。

- [ ] **Step 2: 新增 fail-closed bearer resolver 行为测试**

在 source `qa-generalized.sh` 后覆盖：

```bash
assert_eq "$(qa_generalized_resolve_ingest_token fixture-ingest fixture-master)" \
  "fixture-ingest" "explicit ingest token is preserved"
if qa_generalized_resolve_ingest_token fixture-master fixture-master >/dev/null 2>&1; then
  echo 'FAIL: generalized ingest token accepted the master credential' >&2
  failures=$((failures + 1))
else
  echo 'PASS: generalized ingest token rejects master-token reuse'
fi
uuidgen() { printf '01234567-89AB-CDEF-0123-456789ABCDEF\n'; }
assert_eq "$(qa_generalized_resolve_ingest_token '' fixture-master)" \
  "fly-2174-ingest-0123456789AB" "generated ingest token uses independent namespace"
unset -f uuidgen
```

另测 configured/master 的 leading/trailing space、tab、newline，whitespace-only、empty master、trim-equivalent collision，以及允许 internal whitespace。实现不靠 command substitution trim：用 Bash 3.2-compatible `[[:space:]]` 首尾 predicate 拒绝任何 outer whitespace；因此所有被接受 token 已经是 normalized bytes，可直接比较，internal bytes 完整保留。empty configured 触发生成，empty master fail closed。捕获 stderr，断言 diagnostics 不含 master/ingest token bytes。

- [ ] **Step 3: 新增真实 child-env 与 PID identity helper 测试**

新增 sourceable helper：

```bash
qa_generalized_exec_with_ingest_token() {
  local token="$1"
  shift
  # validate, scrub ambient production value, then inject the validated slot token
  exec env -u TEAMLEAD_INGEST_TOKEN TEAMLEAD_INGEST_TOKEN="$token" "$@"
}
```

测试从 `TEAMLEAD_INGEST_TOKEN=fixture-production-ingest` 的父进程后台执行同一 helper，让 child dump `$$` 与 env 后保持存活。断言 child 只有 `TEAMLEAD_INGEST_TOKEN=fixture-slot-ingest`、production bytes 不存在、dump 的 child PID 等于调用 helper 后的 `$!`；随后按该 PID terminate/wait，证明没有 orphan。invalid token/empty command 显式失败。`exec` 是锁/teardown identity 合同，不能省略。

- [ ] **Step 4: 新增 subject wiring 合同**

断言 `scripts/test-deploy.sh`：

- 在 generalized master token block 后立刻调用 resolver；
- generalized Bridge branch 调用 `qa_generalized_exec_with_ingest_token`，不直接依赖 ambient token；
- default/reply Bridge launch 都包含 `env -u TEAMLEAD_INGEST_TOKEN`；
- ingest assignment 不进入 `LEAD_EXTRA_ENV`、manifest 或 room-info。

不把 `TEAMLEAD_INGEST_TOKEN` 加入 `qa_generalized_ambient_scrub_env_names`：该名单是 wrapper entry 时必须为空的 invariant，而 generalized branch 此时已安全重注入 slot token；加入会让 wrapper 拒绝合法值。live helper test 与三分支 launch assertions覆盖同一安全边界。

- [ ] **Step 5: 运行 RED**

```bash
bash scripts/__tests__/test-deploy-fly1389.test.sh
bash scripts/__tests__/test-deploy-generalized.test.sh
```

Expected: default/reply live env 都暴露 fake production token；resolver/helper 未定义、Bridge scrub/wiring 缺失导致新增断言失败。已恢复 lockfile dependencies，suite 不得再用缺 `ws` 掩盖功能 RED。

## Task 4：GREEN — 生成并投影 slot-local ingest token

**Files:**

- Modify: `scripts/lib/qa-generalized.sh`
- Modify: `scripts/test-deploy.sh`

- [ ] **Step 1: 实现 fail-closed outer-whitespace predicate 与 resolver**

```bash
qa_generalized_bearer_has_outer_whitespace() {
  local value="${1-}"
  [[ -n "$value" ]] || return 1
  [[ "$value" == [[:space:]]* || "$value" == *[[:space:]] ]]
}

qa_generalized_resolve_ingest_token() {
  local configured="${1:-}" master="${2:-}" token
  [[ -n "$master" ]] || {
    echo '[qa-generalized] master token must be non-empty' >&2
    return 1
  }
  if qa_generalized_bearer_has_outer_whitespace "$master"; then
    echo '[qa-generalized] master token must contain no outer whitespace' >&2
    return 1
  fi
  if [[ -n "$configured" ]]; then
    ! qa_generalized_bearer_has_outer_whitespace "$configured" || {
      echo '[qa-generalized] configured ingest token must be non-empty and contain no outer whitespace' >&2
      return 1
    }
    token="$configured"
  elif command -v uuidgen >/dev/null 2>&1; then
    token="fly-2174-ingest-$(uuidgen | tr -d '-' | head -c 12)"
  else
    token="fly-2174-ingest-$(date +%s)-$$"
  fi
  [[ -n "$token" ]] || {
    echo '[qa-generalized] ingest token generation returned empty' >&2
    return 1
  }
  [[ "$token" != "$master" ]] || {
    echo '[qa-generalized] ingest token must differ from master token' >&2
    return 1
  }
  printf '%s\n' "$token"
}
```

`[[:space:]]*`/`*[[:space:]]` 在 quoted `[[ ]]` operands 上只检查首尾字符，不展开 glob，也不经过 command substitution，因此可观察并拒绝 trailing newline/tab；internal whitespace 与其他 bearer bytes 不变。测试矩阵固定这个 Bash 3.2 行为。

- [ ] **Step 2: 实现 scrub-then-inject exec helper**

helper 校验 token/command 后使用 `exec env -u TEAMLEAD_INGEST_TOKEN TEAMLEAD_INGEST_TOKEN="$token" "$@"` 替换后台 function subshell；不得打印 bearer bytes。`exec` 保证 `BRIDGE_PID=$!`、bridge.pid、slot lock、room-info、failure cleanup 与 teardown 始终指向真实 Bridge，而非提前退出的 shell。该 helper 既是测试 subject，也是 production generalized Bridge branch 的唯一注入入口。

- [ ] **Step 3: 紧接 generalized master block 生成 token**

```bash
TEST_TEAMLEAD_INGEST_TOKEN=""
if [[ "$GENERALIZED" == "1" ]]; then
  TEST_TEAMLEAD_INGEST_TOKEN=$(qa_generalized_resolve_ingest_token \
    "${TEST_INGEST_TOKEN:-}" "$TEST_TEAMLEAD_API_TOKEN") || exit 1
  log "generalized ingest auth enabled with TEAMLEAD_INGEST_TOKEN=<redacted len=${#TEST_TEAMLEAD_INGEST_TOKEN}>"
fi
```

初始化位置必须满足 `set -u`，并紧接当前 generalized master token creation block，避免后续代码在 ingest 尚未建立时使用。普通分支不得读取未定义值。

- [ ] **Step 4: scrub 所有 Bridge branches，generalized 再安全投影**

default/reply 两条 Bridge launch 的 `env` 都加：

```bash
-u TEAMLEAD_INGEST_TOKEN
```

generalized branch 用 `qa_generalized_exec_with_ingest_token "$TEST_TEAMLEAD_INGEST_TOKEN" env ...` 包住原命令，在显式 scrub 后重注入 slot token。不写 Lead manifest、不写 room-info、不打印 token bytes。

- [ ] **Step 5: 运行 GREEN 与 runtime tests**

```bash
bash scripts/__tests__/test-deploy-generalized.test.sh
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.test.ts
pnpm --filter flywheel-claude-runner exec vitest run test/TmuxAdapter.test.ts test/CodexTmuxAdapter.test.ts
```

Expected: shell suite 全绿；default/reply live env 证明 production value 被 scrub；helper 的 live child env 证明 production value被替换且 `$!` 等于真实 child PID；Blueprint/adapters 继续证明 `TEAMLEAD_INGEST_TOKEN → bridgeIngestToken → FLYWHEEL_INGEST_TOKEN`。

- [ ] **Step 6: 提交第二批**

```bash
git add scripts/lib/qa-generalized.sh scripts/test-deploy.sh scripts/__tests__/test-deploy-fly1389.test.sh scripts/__tests__/test-deploy-generalized.test.sh
git commit -m "fix(FLY-2174): provision generalized runner ingest auth"
```

## Task 5：聚焦回归、真实 529 验收与边界记录

- [ ] **Step 1: 依赖就绪后重跑相关 suites**

```bash
pnpm install --frozen-lockfile
bash scripts/__tests__/test-deploy-qa-room.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
bash scripts/__tests__/test-deploy-generalized.test.sh
bash scripts/__tests__/qa-room-env.test.sh
bash scripts/__tests__/fly1726-lead-identity-wrapper.test.sh
```

Expected: 全部 PASS；不得把修改前的 `ws` 缺失当功能失败或跳过。

- [ ] **Step 2: 用 Lead 指定的 slot 4 / FLY-108 运行真实房**

```bash
scripts/test-deploy.sh 4 --generalized --alerts --expect-head "$(git rev-parse HEAD)"
node scripts/qa-529-generalized-e2e.mjs 4 --issue FLY-108 --real
```

`test-deploy.sh` 当前没有 `--codex-runner` CLI flag；`--generalized` 通过 blueprint backend 选择与 E2E receipt 证明 Codex runner。必须核对：launchd-v2 Lead lease ready；manifest projects path canonical；Bridge child 启动成功且日志无 token bytes；design 的 `await-codex-gate` 通过（证明 Runner ingest credential 可用）；DAG 到 implement 并创建 backend=`codex-tmux` worker；alerts 状态只写 slot tree。完成后 teardown 并验证 Bridge/Lead/runner processes 退出。

- [ ] **Step 3: 记录权限边界**

最终报告/milestone 明确：三条 `missingTerminalAt` 待 founder 裁决；生产 63,911 条修复等待 19 分钟维护窗；本 PR 不执行生产写入。membership_conflict/TMPDIR 若未被新证据证明仍阻塞，则不夹带代码。

## Task 6：全仓 verification、code review、PR

**Files:**

- Create last: `engineering/doc/milestones/FLY-2174.md`

- [ ] **Step 1: 全仓硬门**

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/test-deploy-qa-room.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
bash scripts/__tests__/test-deploy-generalized.test.sh
```

任何失败先按 systematic debugging 归因，不得靠重跑掩盖。

- [ ] **Step 2: code review gate**

```bash
node "$FLYWHEEL_COMM_CLI" stage set code_review
node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead --exec-id e91a20e4-f716-4850-a431-d92163ce9464 --no-block "Code review requested for FLY-2174"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id <questionId>
node "$FLYWHEEL_COMM_CLI" check <questionId>
```

只以 `reviewVerdict` 为门。CHANGES：修 blocking finding、push 新 head、开新 gate/request。APPROVED with advisories：门通过并用 `ask --report` relay advisories。

- [ ] **Step 3: milestone 必须是 literal last commit**

按 `engineering/doc/milestones/README.md` 新建 `engineering/doc/milestones/FLY-2174.md`，单独 commit，之后不再产生 ledger/docs/code commit：

```bash
git add engineering/doc/milestones/FLY-2174.md
git commit -m "docs(FLY-2174): record delivery milestone"
```

- [ ] **Step 4: push 与 PR**

```bash
git push -u origin flywheel-FLY-2174
gh pr create --base main --head flywheel-FLY-2174 --title "FLY-2174: repair 529 QA room env contracts" --body-file <prepared-pr-body>
```

PR body 包含 scope、TDD red/green evidence、full gates、真实房或明确未完成 gate，不触碰 `CLAUDE.md`。

- [ ] **Step 5: Lead receipt 与 bounded completion**

```bash
node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-eng-lead --exec-id e91a20e4-f716-4850-a431-d92163ce9464 --report 'DONE: [lead-instruction d20d0761-196e-4edf-ba25-343d33e5eae6] repaired alerts carrier identity and generalized ingest auth; boundaries recorded | commits: <sha(s)> | PR: <url>'
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <NUMBER>
```

不请求 ship approval，不 dispatch QA，不 merge，不 deploy。

## Self-review

- Spec coverage：Lead 优先 #3 与 ingest token 各有独立 RED/GREEN/real-room 证据；founder terminal 裁决与生产窗口明确留在权限外；membership/TMPDIR 不被静默假称完成。
- Placeholder scan：`<questionId>`、`<NUMBER>` 是运行时 authority 返回值，获取方式已写明，不是实现代码占位；真实 fixture 已由 Lead 固定为 slot 4 / FLY-108。
- Type/name consistency：internal 为 `TEST_TEAMLEAD_INGEST_TOKEN`，deterministic override 为 `TEST_INGEST_TOKEN`，Bridge runtime 为 `TEAMLEAD_INGEST_TOKEN`，Runner runtime 沿用 `FLYWHEEL_INGEST_TOKEN`。
