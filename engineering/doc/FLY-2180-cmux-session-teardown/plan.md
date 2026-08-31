# FLY-2180 cmux/session teardown CI 偶发红 — 实施计划
Issue: FLY-2180 (https://linear.app/geoforge3d/issue/FLY-2180/ci红-main-script-tests-挂在-cmuxsession-testfly-1759-reap-first-worktree)
日期: 2026-08-30
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. This DAG implement node executes inline and must not dispatch successor nodes.

**目标：** 消除 FLY-1759 真实 shell/sleep teardown case 的 pre-exec fixture race，同时保持生产 reaper 的 fail-closed identity 栅栏逐字不变。

**架构：** 测试 fixture 先用显式 `exec` 固定 `$!` 的跨 shell 含义，再在调用 reaper 前增加有界、可注入的 command-readiness seam。hermetic mock 校验 ps argv、command transition 与 fail-closed timeout，Linux exact-head CI 再证明真实 child/descendant 的 teardown 仍然收敛。

**技术栈：** Bash 3.2-compatible shell、`ps -p … -o command=`、现有 FLY-1759 shell suite、GitHub Actions Ubuntu runner。

---

## 1. 锁定范围与文件职责

| 文件 | 职责 | 允许的变更 |
| --- | --- | --- |
| `scripts/__tests__/test-reap-worktree-lib.test.sh` | shell reaper 的 mock + 真实进程回归 | readiness helper、hermetic regression、真实 fixture gate、诊断 |
| `.claude/orchestrator/lib/reap-worktree.sh` | 生产 shell reaper | **禁止修改** |
| `.github/workflows/ci.yml` | 显式运行 shell suite | **禁止修改**；现有 step 已足够 |
| `engineering/doc/FLY-2180-cmux-session-teardown/` | full doc-flow 与 durable progress | 随实现更新 progress，不改 approved plan blob |
| `engineering/doc/milestones/FLY-2180.md` | 单 issue 里程碑 | 所有实现/review 后，作为 literal last commit 新建 |

## 2. 明确假设与不变量

1. child 改为 `(cd / && exec /bin/sleep 300) &`；显式 exec 保证 dash 与 macOS bash 3.2 的 `$!` 都是最终被 sleep 替换的 PID。exec 完成后 `ps -o command=` 返回精确 `/bin/sleep 300`；helper trim 两端空白，不做 substring/进程类型枚举。
2. handshake 只证明 PID 已分配，不证明 exec 完成；readiness gate 必须位于读取 handshake 之后、调用 `reap_worktree_processes` 之前。
3. readiness timeout 是 fixture setup failure，不能继续调用 reaper，否则仍会把 setup race 伪装成 teardown regression。helper 最多 100 次 probe；总时长包含每次 ps 成本与 sleep 间隔，不宣称严格等于 5 秒。
4. `pid+lstart+command` identity 匹配、unsafe-root guard、TERM→KILL、有界终验和 fail-open audit 均不变。
5. 本机 sandbox 的真实 case skip 不是验收证据；Ubuntu PR exact-head CI 必须实际输出 real case PASS。

## 3. TDD 执行任务

- [ ] **Step 0：设计评审 APPROVED 后，先进入 implement stage**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js stage set implement
```

该命令必须先于任何测试/实现编辑，确保后续 `progress --phase implement` 与权威 stage 一致。

### Task 1：RED — hermetic readiness regression

**文件：**

- 修改：`scripts/__tests__/test-reap-worktree-lib.test.sh`
- 测试：`scripts/__tests__/test-reap-worktree-lib.test.sh`

- [ ] **Step 1.1：在现有 mock binaries 旁新增 command-transition ps fixture**

加入一个独立 mock。它先严格校验 argv，再用计数文件让前两次查询返回 `fixture-pre-exec`，第三次及以后返回目标 command：

```bash
cat > "$BIN_DIR/readiness-ps" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_READY_ARGS"
[[ "$*" == "-p 201 -o command=" ]] || exit 64
count=$(cat "$MOCK_READY_CALLS")
count=$((count + 1))
printf '%s\n' "$count" > "$MOCK_READY_CALLS"
case "${MOCK_READY_MODE:-transition}" in
  transition)
    if [[ "$count" -lt 3 ]]; then
      printf 'fixture-pre-exec\n'
    else
      printf '/bin/sleep 300\n'
    fi
    ;;
  never) printf 'fixture-pre-exec\n' ;;
  *) exit 65 ;;
esac
SH
chmod +x "$BIN_DIR/readiness-ps"
```

- [ ] **Step 1.2：新增单行为断言，先调用尚不存在的 readiness seam**

```bash
echo "Test: FLY-2180 fixture readiness waits for the child exec command"
MOCK_READY_CALLS="$TMP_ROOT/ready-calls"
MOCK_READY_ARGS="$TMP_ROOT/ready-args"
printf '0\n' > "$MOCK_READY_CALLS"
> "$MOCK_READY_ARGS"
export MOCK_READY_CALLS MOCK_READY_ARGS
export MOCK_READY_MODE=transition
if wait_for_process_command "$BIN_DIR/readiness-ps" 201 "/bin/sleep 300" 5 0 /usr/bin/true \
    && [[ "$(cat "$MOCK_READY_CALLS")" -eq 3 ]] \
    && [[ "$(sort -u "$MOCK_READY_ARGS")" == "-p 201 -o command=" ]]; then
  pass "readiness ignores pre-exec identities and accepts the intended command"
else
  fail "readiness did not wait for the intended exec identity"
fi
```

- [ ] **Step 1.3：运行并确认 RED 原因正确**

运行：

```bash
bash scripts/__tests__/test-reap-worktree-lib.test.sh
```

预期：exit 1；新 case 报 `wait_for_process_command: command not found` 和 readiness failure；既有三个 hermetic FLY-1759 case 仍 PASS。Codex sandbox 的真实 case可因全局 ps 能力守卫 SKIP。

- [ ] **Step 1.4：确认 diff 只有测试尺子，没有生产变更**

```bash
git diff -- scripts/__tests__/test-reap-worktree-lib.test.sh
git diff --exit-code -- .claude/orchestrator/lib/reap-worktree.sh
```

第二条预期 exit 0。

### Task 2：GREEN — 最小 command-readiness helper

**文件：**

- 修改：`scripts/__tests__/test-reap-worktree-lib.test.sh`
- 测试：`scripts/__tests__/test-reap-worktree-lib.test.sh`

- [ ] **Step 2.1：在 pass/fail helper 后加入最小实现**

```bash
wait_for_process_command() {
  local ps_bin="$1" pid="$2" expected="$3"
  local attempts="${4:-100}" interval="${5:-0.05}" sleep_bin="${6:-sleep}"
  local command
  for _ in $(seq 1 "$attempts"); do
    command="$(TZ=UTC LC_ALL=C "$ps_bin" -p "$pid" -o command= 2>/dev/null \
      | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" || command=""
    [[ "$command" == "$expected" ]] && return 0
    "$sleep_bin" "$interval"
  done
  return 1
}
```

- [ ] **Step 2.2：运行并确认 GREEN**

```bash
bash scripts/__tests__/test-reap-worktree-lib.test.sh
```

预期：exit 0；新增 readiness case PASS，`MOCK_READY_CALLS=3`，且所有记录 argv 精确等于
`-p 201 -o command=`；既有 hermetic cases 全绿。

- [ ] **Step 2.3：RED — 新增永不到达目标的 fail-closed/diagnostic case**

在 helper 已能通过 transition case 后加入：

```bash
echo "Test: FLY-2180 fixture readiness fails closed with the last identity"
printf '0\n' > "$MOCK_READY_CALLS"
> "$MOCK_READY_ARGS"
export MOCK_READY_MODE=never
WAIT_FOR_PROCESS_COMMAND_LAST=""
mock_reaper_called=0
if wait_for_process_command "$BIN_DIR/readiness-ps" 201 "/bin/sleep 300" 2 0 /usr/bin/true; then
  mock_reaper_called=1
fi
if [[ "$(cat "$MOCK_READY_CALLS")" -eq 2 \
    && "$WAIT_FOR_PROCESS_COMMAND_LAST" == "fixture-pre-exec" \
    && "$mock_reaper_called" -eq 0 ]]; then
  pass "readiness timeout preserves diagnostics and does not enter teardown"
else
  fail "readiness timeout lost diagnostics or entered teardown"
fi
```

运行 focused suite。预期 exit 1：当前 helper 确实有界返回非零、mock reaper 未调用，但
`WAIT_FOR_PROCESS_COMMAND_LAST` 仍为空，使新 diagnostic 断言红。

- [ ] **Step 2.4：GREEN — 记录最后观测 command**

在 helper 的 probe 前初始化、每轮采样后赋值：

```bash
WAIT_FOR_PROCESS_COMMAND_LAST=""
for _ in $(seq 1 "$attempts"); do
  command="$(TZ=UTC LC_ALL=C "$ps_bin" -p "$pid" -o command= 2>/dev/null \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" || command=""
  WAIT_FOR_PROCESS_COMMAND_LAST="$command"
  [[ "$command" == "$expected" ]] && return 0
  "$sleep_bin" "$interval"
done
```

重跑 focused suite。预期 transition 与 timeout 两个 FLY-2180 case 都 PASS。

- [ ] **Step 2.5：refactor check**

确认 helper 只有观测/等待，无 kill、无 lsof、无生产路径依赖；保留 Bash 3.2 语法。无需抽新文件。

### Task 3：把 readiness 接入跨平台真实 fixture

**文件：**

- 修改：`scripts/__tests__/test-reap-worktree-lib.test.sh`
- 测试：同文件 + `scripts/__tests__/test-worktree-removal-contract.test.sh`

- [ ] **Step 3.1：显式 exec，固定 `$!` 的跨 shell PID 语义**

把真实 fixture child 改成：

```bash
(cd / && exec /bin/sleep 300) &
```

显式 exec 保留被测拓扑：parent cwd 命中 worktree，sleep child 已 chdir `/`，必须靠 ppid descendant
closure 进入 reaper target；同时 cleanup 中已记录的 `real_child` 就是最终 sleep PID。

- [ ] **Step 3.2：在读取 handshake PID 后验证完整性、exec-ready command并输出失败诊断**

用显式 flag 避免 setup 失败后调用 reaper：

```bash
real_fixture_ready=0
if [[ -n "$real_parent" && -n "$real_child" ]] \
    && wait_for_process_command ps "$real_child" "/bin/sleep 300"; then
  real_fixture_ready=1
else
  printf '  observed child command: %s\n' "${WAIT_FOR_PROCESS_COMMAND_LAST:-<unreadable>}" >&2
  TZ=UTC LC_ALL=C ps -axo pid=,ppid=,command= 2>/dev/null \
    | awk -v parent="$real_child" '$2 == parent { print "  child row: " $0 }' >&2 || true
  fail "real fixture did not reach the /bin/sleep 300 identity"
fi
```

- [ ] **Step 3.3：只在 ready 时执行现有 teardown 断言**

```bash
if [[ "$real_fixture_ready" -eq 1 ]]; then
  if reap_worktree_processes "$REAL_PROJECT" "$REAL_WORKTREE" \
      && ! /bin/kill -0 "$real_parent" 2>/dev/null \
      && ! /bin/kill -0 "$real_child" 2>/dev/null; then
    pass "real non-Node child and descendant both exit"
  else
    fail "real process closure did not converge"
  fi
fi
```

- [ ] **Step 3.4：运行本机 focused gates**

```bash
bash scripts/__tests__/test-reap-worktree-lib.test.sh
bash scripts/__tests__/test-worktree-removal-contract.test.sh
```

预期：两条 exit 0；readiness transition/timeout mock 必跑并 PASS；removal contract `PASS=7 FAIL=0`。
在有全局 ps/lsof 权限的 macOS host，显式 exec 后真实 case必须 PASS；Codex sandbox若拒全局 ps，可明确
SKIP，但它不是 Linux 验收证据。

- [ ] **Step 3.5：证明 production/workflow 没有漂移**

```bash
git diff --exit-code origin/main -- .claude/orchestrator/lib/reap-worktree.sh .github/workflows/ci.yml
```

预期 exit 0。

- [ ] **Step 3.6：提交实现 batch 并更新 durable progress**

```bash
git add scripts/__tests__/test-reap-worktree-lib.test.sh \
  engineering/doc/FLY-2180-cmux-session-teardown
git commit -m "test(FLY-2180): wait for teardown fixture exec readiness"
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js progress \
  --exec-id c4355b77-bc7d-426b-b88d-95b99702a18f \
  --file engineering/doc/FLY-2180-cmux-session-teardown/progress.md \
  --phase implement --cursor 1/3 --set-chunk tdd_fix=completed \
  --next "Run full repository gates and exact-head code review"
```

## 4. 验证与评审

### Task 4：完整验证

- [ ] **Step 4.1：进入 test stage并重跑 focused shell suites**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js stage set test
bash scripts/__tests__/test-reap-worktree-lib.test.sh
bash scripts/__tests__/test-worktree-removal-contract.test.sh
```

- [ ] **Step 4.2：运行 exact full-repository gates**

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

三条都必须 exit 0；`test:packages:run` 必须确认 teamlead 与 edge-worker 等包实际出现，不能把提前 abort 的部分输出当全仓绿。

- [ ] **Step 4.3：运行全部新增 `scripts/__tests__/*.test.sh`**

本计划不新建 shell suite，因此该集合为空；仍以 `git diff --name-only origin/main...HEAD` 验证没有遗漏新文件。

- [ ] **Step 4.4：更新 progress 后冻结 review head**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js progress \
  --exec-id c4355b77-bc7d-426b-b88d-95b99702a18f \
  --file engineering/doc/FLY-2180-cmux-session-teardown/progress.md \
  --phase implement --cursor 2/3 --set-chunk full_gates=completed \
  --next "Request exact-head code review"
git status --short
git rev-parse HEAD
```

progress commit 后不再编辑实现或 progress；若评审要求修复，修复后重跑 owning gates并开新 review round。

### Task 5：通过 request-driven `codex:rescue` code review

- [ ] **Step 5.1：进入 code review stage并开新 gate**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js stage set code_review
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js gate review_code \
  --lead flywheel-eng-lead \
  --exec-id c4355b77-bc7d-426b-b88d-95b99702a18f \
  --no-block "Code review requested for FLY-2180 test-fixture readiness fix"
```

- [ ] **Step 5.2：捕获 questionId 并注册 review**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js request-review \
  --type code --question-id <questionId>
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js check <questionId>
```

`<questionId>` 是前一命令的运行时返回值，不是待补设计内容。该 request-driven lane 由 Bridge 走
`codex:rescue`，禁止 raw `codex exec`。

- [ ] **Step 5.3：处理 verdict**

`APPROVED` 才继续；`CHANGES_REQUESTED` 时按 findingKey 修复、push 新 head、重跑相关测试，并开**新的**
`review_code` gate + request。APPROVED 若含 advisories，用 `ask --report` 向 Lead 转述，但不把 advisory
当 blocker。

- [ ] **Step 5.4：在 milestone 之前完成最后一次 progress commit**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js progress \
  --exec-id c4355b77-bc7d-426b-b88d-95b99702a18f \
  --file engineering/doc/FLY-2180-cmux-session-teardown/progress.md \
  --phase implement --cursor 3/3 --set-chunk code_review=completed \
  --next "Open PR and add the literal-last milestone commit"
```

此后 progress 不再写 branch，避免把 verdict head 或 milestone-last 合同推后。

## 5. PR 与 bounded handoff

### Task 6：PR 编号、milestone literal last commit、exact-head CI

- [ ] **Step 6.1：在不可逆动作前重查 inbox 与工作树**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js inbox \
  --exec-id c4355b77-bc7d-426b-b88d-95b99702a18f
git status --short
git log -5 --oneline
```

- [ ] **Step 6.2：先 push 已评审实现 head 并创建 PR，取得权威编号**

```bash
git push -u origin flywheel-FLY-2180
gh pr create --base main --head flywheel-FLY-2180 \
  --title "test(FLY-2180): stabilize reap-first teardown CI" \
  --body "Fixes the FLY-1759 real-process fixture race by waiting for the child exec identity before invoking the fail-closed reaper. Production teardown code is unchanged."
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js stage set pr_created
```

把 `gh pr create` 返回的 number 保存为运行时 `PR_NUMBER`；PR 此时尚未 handoff，也没有 ship 权限。

- [ ] **Step 6.3：用实际 PR number 新建 milestone 并作为最后一 commit**

新建 `engineering/doc/milestones/FLY-2180.md`，格式：

```markdown
# FLY-2180 — 稳定 cmux/session teardown CI

**Status**: ⏳ Pending ship
**PR**: #NNN
**Date**: 2026-08-30

修复 FLY-1759 真实 shell/sleep fixture 的 pre-exec identity race；生产 reaper 安全栅栏保持不变。
```

```bash
git add engineering/doc/milestones/FLY-2180.md
git commit -m "docs(FLY-2180): record teardown CI milestone"
```

`#NNN` 必须替换成 Step 6.2 的真实整数。此后禁止 progress commit；`CLAUDE.md` 不得修改。

- [ ] **Step 6.4：对 milestone last head 跑结构守卫与新的 exact-head code review**

```bash
bash scripts/__tests__/fly2045-milestone-layout.test.sh
grep -Eq '^\*\*PR\*\*: #[0-9]+$' engineering/doc/milestones/FLY-2180.md
git log -1 --name-only --format='%H %s'
```

确认 last commit 只新增 `engineering/doc/milestones/FLY-2180.md`，随后按 Task 5 的命令开一个**新的**
`review_code` gate并注册 request-review。APPROVED 必须绑定当前 milestone head；若需修改，所有改动
amend 到这个尚未 push 的 last commit，重跑守卫并开新 review round，直到最新 head APPROVED。

- [ ] **Step 6.5：push literal-last milestone head并等待 PR exact-head CI**

```bash
git push
gh pr checks <PR_NUMBER> --watch
```

除整体 checks 全绿外，打开 `Script Tests 1/2 — cmux/session` 日志并确认：

```text
Test: FLY-2180 fixture readiness waits for the child exec command
PASS: readiness ignores pre-exec identities and accepts the intended command
PASS: real non-Node child and descendant both exit
```

若 CI 红，回到 systematic debugging；任何 fix 都会产生新 head，必须重跑 full gates、开新 code review
round，并重新保证 milestone 是最后一 commit。

- [ ] **Step 6.6：Lead 报告与 bounded completion**

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js ask \
  --lead flywheel-eng-lead \
  --exec-id c4355b77-bc7d-426b-b88d-95b99702a18f \
  --report 'DONE: FLY-2180 implementation complete; fixture readiness race fixed; production reaper unchanged; full gates, code review, and exact-head CI passed; PR: <URL>'
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js complete \
  --route needs_review --pr <PR_NUMBER>
```

不请求 ship approval、不 merge、不部署、不 dispatch QA。

## 6. 验收矩阵

| 要求 | 权威证据 |
| --- | --- |
| fixture race 是首要假设且生产 reaper 未回归 | 红/绿 run 同字节 diff + hermetic transition/timeout tests + timeout observed-command 诊断；不把聚合 pre-TERM 错误冒充直接 command 观测 |
| production identity safety 不降级 | `git diff --exit-code origin/main -- .claude/orchestrator/lib/reap-worktree.sh` |
| mock/negative 合同保留 | focused shell suite PASS summaries |
| Ubuntu 真实 child/descendant 收敛 | PR exact-head Script Tests 1/2 日志中的两个明确 PASS 行 |
| 全仓无回归 | fresh `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run` exit 0 |
| 独立 code review | 最新 review question 的 `reviewVerdict=APPROVED` |
| bounded implement handoff | 非 draft PR + `complete --route needs_review --pr <number>` 回执 |
