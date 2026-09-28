# FLY-2922 QA stub 身份隔离 — 实施计划
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development, then execute this plan task-by-task. The Implement DAG node owns code changes; the Design node must not implement or dispatch successors.

**Goal:** 让 `--generalized --codex-runner --qa-stub-runner` 只把 exact QA execution 送入 deterministic stub，同时保证跨家族评审、版本探测和所有非 QA execution 使用真实 Claude。

**Architecture:** `stub-bin/claude` 从无条件 stub 改为 identity selector。它在安装时钉死真实 Claude 和 slot StateStore；fresh launch 用 exact activation tuple 选择，same-execution standby resume 用只读 binding 选择。缺少 Runner 身份直接 passthrough；模糊 QA 归属 fail closed。`codex` 不被 QA-only 模式遮蔽，生产协议和 review coordinator 不变。

**Tech Stack:** Bash、SQLite CLI、Node.js ESM stub、现有 generalized 529 shell harness、GitHub Actions exact-head CI。

---

## 1. Scope and File Map

只修改 harness 与说明：

- Modify: `scripts/__tests__/test-deploy-generalized.test.sh` — RED/GREEN route matrix、anti-recursion guards、CLI wiring assertions。
- Modify: `scripts/lib/qa-generalized.sh` — real-Claude resolver、shim marker/alias guards、QA-only selector installer。
- Modify: `scripts/test-deploy.sh` — 安装 selector 前钉死真实 Claude 与 slot DB；保留 full-stub 旧路径。
- Modify: `doc/qa/framework/529-room-playbook.md` — 明示真实评审、QA-only route 和 evidence 边界。

禁止修改：

- `packages/teamlead/src/bridge/review-request-coordinator.ts`
- `packages/teamlead/src/bridge/claude-review-runner.ts`
- `packages/claude-runner/**`
- `packages/teamlead/src/StateStore.ts`
- `.flywheel/agents/nodes/qa.md`
- evidence judge / `qa-result` / workflow dispatcher

如果 exact implementation head 证明必须触碰上述文件，停止并向 Lead 报告设计假设失效；不要把 test-only binary seam 加进产品层。

## 2. Preconditions and Test Discovery

### Task 1: Acquire TURN, sync main, and inventory affected tests

**Files:** none

- [ ] **Step 1: Acquire the injected TURN and merge main without rebase**

Run:

```bash
node "$FLYWHEEL_COMM_CLI" turn
git fetch origin
git merge origin/main
```

Expected: `turn` prints `yours`; merge completes or conflicts are resolved by retaining both current generalized harness behavior and main. Do not rebase or force-push.

- [ ] **Step 2: Record exact baseline**

Run:

```bash
git status --short --branch
git rev-parse HEAD
git log --oneline -10
git diff --name-only origin/main...HEAD
```

Expected: clean tree before TDD edits. Record the SHA and existing candidate files in the implementation evidence.

- [ ] **Step 3: Discover tests before running any test**

Run every search:

```bash
git grep -lF -- '--qa-stub-runner'
git grep -lF -- 'qa_generalized_install_qa_stub'
git grep -lF -- 'qa-529-generalized-stub.mjs'
git grep -lF -- 'stub-bin'
git grep -lF -- 'FLYWHEEL_WORKFLOW_ACTIVATION_ID'
git grep -lF -- 'scripts/test-deploy.sh'
git grep -lF -- 'scripts/lib/qa-generalized.sh'
git grep -lF -- 'scripts/__tests__/test-deploy-generalized.test.sh'
git grep -lF -- 'doc/qa/framework/529-room-playbook.md'
```

Expected retained test: `scripts/__tests__/test-deploy-generalized.test.sh`. Record every other test match and a specific exclusion reason. An empty match never authorizes a broad suite.

## 3. TDD: Reproduce the Review Interception

### Task 2: Add failing routing tests

**Files:**

- Modify: `scripts/__tests__/test-deploy-generalized.test.sh`
- Test: `scripts/__tests__/test-deploy-generalized.test.sh`

- [ ] **Step 1: Create hermetic real-Claude and slot-DB fixtures**

Add an owner-executable fake real Claude that echoes argv, plus a slot-local SQLite fixture:

```bash
qa_real_claude_dir="$TMP_ROOT/real-claude-bin"
mkdir -p "$qa_real_claude_dir"
qa_real_claude="$qa_real_claude_dir/claude"
cat > "$qa_real_claude" <<'EOF'
#!/usr/bin/env bash
printf 'REAL-CLAUDE'
printf ' [%s]' "$@"
printf '\n'
EOF
chmod 700 "$qa_real_claude"

qa_state_dir="$TMP_ROOT/qa-state"
mkdir -p "$qa_state_dir"
qa_state_db="$qa_state_dir/teamlead.db"
sqlite3 "$qa_state_db" '
CREATE TABLE workflow_execution_binding (
  activation_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL
);
INSERT INTO workflow_execution_binding VALUES
  ("activation:exec-q:run-1:qa:1", "exec-q", "run-1", "qa", 1),
  ("activation:exec-q:run-1:qa:2", "exec-q", "run-1", "qa", 2),
  ("activation:exec-p:run-1:implement:1", "exec-p", "run-1", "implement", 1),
  ("activation:exec-m:run-1:qa:1", "exec-m", "run-1", "qa", 1),
  ("activation:exec-m:run-1:implement:1", "exec-m", "run-1", "implement", 1);
'
```

Use the repository test's existing temp root and cleanup; do not use a shared `/tmp/fly2922-*` path.

- [ ] **Step 2: Add the exact RED reproduction**

Install the candidate QA-only stub and invoke a review-shaped, identity-free call:

```bash
assert_eq \
  "$(env -u FLYWHEEL_EXEC_ID -u FLYWHEEL_WORKFLOW_ACTIVATION_ID \
    "$qa_stub_bin/claude" -p --model opus 'review this diff' 2>&1)" \
  'REAL-CLAUDE [-p] [--model] [opus] [review this diff]' \
  'QA-only route keeps identity-free design review on the real Claude'
```

Expected before the fix: FAIL because the raw stub requires `FLYWHEEL_EXEC_ID` instead of printing the real-Claude marker.

- [ ] **Step 3: Add the full routing matrix before implementation**

Use a small fake QA stub that prints `QA-STUB` and assert:

```bash
# identity-free review and --version -> REAL-CLAUDE
# activation:exec-a:run-1:eng_design:1 -> REAL-CLAUDE
# activation:exec-a:run-1:implement:1 -> REAL-CLAUDE
# activation:exec-a:run-1:qa:1 with FLYWHEEL_EXEC_ID=exec-a -> QA-STUB
# activation:exec-b:run-1:qa:1 with FLYWHEEL_EXEC_ID=exec-a -> REAL-CLAUDE
# activation:exec-a:run-1:qa-extra:1 -> REAL-CLAUDE
# exec-q without activation -> QA-STUB
# exec-p without activation -> REAL-CLAUDE
# unbound execution without activation -> REAL-CLAUDE
# exec-m without activation -> exit 70 (qa + implement is ambiguous)
# malformed execution id -> exit 70
# missing/unreadable DB for an exec-only potential QA -> exit 70
```

Also assert exact argv preservation for both `exec` branches and that `qa_stub_bin/codex` does not exist.

- [ ] **Step 4: Add installer failure cases**

Require failure for:

- relative, missing, or non-executable real Claude;
- real Claude inside the target shim directory;
- symlink, hardlink, or marker-bearing copy of an existing selector;
- relative StateStore path or missing parent directory;
- unavailable `sqlite3`;
- pre-existing `stub-bin/codex` file or symlink.

- [ ] **Step 5: Run the one concrete test and confirm RED**

Run:

```bash
bash scripts/__tests__/test-deploy-generalized.test.sh
```

Expected: the new review passthrough and route assertions fail for the missing selector behavior; fixture setup and unrelated existing assertions pass.

- [ ] **Step 6: Commit the RED tests**

```bash
git add scripts/__tests__/test-deploy-generalized.test.sh
git commit -m "test(FLY-2922): reproduce QA stub intercepting real review"
```

## 4. Implement the Identity Selector

### Task 3: Add real-Claude resolution and alias guards

**Files:**

- Modify: `scripts/lib/qa-generalized.sh`
- Test: `scripts/__tests__/test-deploy-generalized.test.sh`

- [ ] **Step 1: Add a stable marker and alias detector**

Implement:

```bash
QA_GENERALIZED_SHIM_MARKER='# flywheel-qa-529-qa-only-shim'

qa_generalized_is_qa_shim() {
  local candidate="${1:-}" head_bytes
  [[ -f "$candidate" ]] || return 1
  head_bytes="$(head -c 512 "$candidate" 2>/dev/null | tr -d '\000')"
  [[ "$head_bytes" == *"$QA_GENERALIZED_SHIM_MARKER"* ]]
}

qa_generalized_is_shim_alias() {
  local candidate="${1:-}" shim_file="${2:-}"
  if [[ -n "$shim_file" && -e "$shim_file" && "$candidate" -ef "$shim_file" ]]; then
    return 0
  fi
  qa_generalized_is_qa_shim "$candidate"
}
```

The marker check must catch copies; `-ef` catches symlink and hardlink aliases.

- [ ] **Step 2: Resolve the real Claude before installing the shim**

Implement `qa_generalized_resolve_real_claude <shim-dir>` to iterate absolute `PATH` entries, skip the shim directory and its realpath aliases, require a regular executable `claude`, reject shim aliases, and print the first valid absolute candidate. If none exists, print one diagnostic and return non-zero.

Do not call `command -v claude` after the shim directory may already be first on `PATH`.

- [ ] **Step 3: Run the concrete shell test**

```bash
bash scripts/__tests__/test-deploy-generalized.test.sh
```

Expected: resolver/alias cases pass; routing cases remain RED until the installer is updated.

### Task 4: Replace the raw QA stub with an exact selector

**Files:**

- Modify: `scripts/lib/qa-generalized.sh`
- Test: `scripts/__tests__/test-deploy-generalized.test.sh`

- [ ] **Step 1: Change the installer signature**

Use the concrete call shape:

```bash
qa_generalized_install_qa_stub \
  "${SLOT_DIR}/stub-bin" \
  "${REPO_ROOT}/scripts/qa-529-generalized-stub.mjs" \
  "$QA_REAL_CLAUDE_BIN" \
  "${SLOT_DIR}/teamlead.db"
```

Validate all four arguments, require `sqlite3`, require the DB parent directory, and refuse any `codex` entry in the target directory.

- [ ] **Step 2: Generate an owner-only selector atomically**

Write `claude.tmp.$$`, `chmod 700`, then `mv` to `stub-bin/claude`. The generated script must contain the following decision core:

```bash
exec_id="${FLYWHEEL_EXEC_ID:-}"
[[ -n "$exec_id" ]] || exec "$real" "$@"
if [[ ! "$exec_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo '[qa-529-shim] refusing a malformed FLYWHEEL_EXEC_ID' >&2
  exit 70
fi

activation="${FLYWHEEL_WORKFLOW_ACTIVATION_ID:-}"
if [[ -n "$activation" ]]; then
  prefix="activation:${exec_id}:"
  if [[ "$activation" == "$prefix"* \
    && "${activation#"$prefix"}" =~ ^[A-Za-z0-9._-]+:qa:[1-9][0-9]*$ ]]; then
    exec node "$stub" "$@"
  fi
  exec "$real" "$@"
fi
```

For the standby branch, run read-only SQLite with `.timeout 5000` and a bound `@exec` parameter to select distinct node ids. Route only the exact single result `qa` to the stub. Zero rows or only non-QA rows use real Claude. Query failure or a result containing both `qa` and another node exits 70 with a `[qa-529-shim]` diagnostic.

- [ ] **Step 3: Preserve process and argv semantics**

Both branches must use `exec`; do not spawn a wrapper child or reinterpret argv. No secret, token, prompt, or user-derived text is embedded in the generated selector.

- [ ] **Step 4: Run the concrete shell test GREEN**

```bash
bash scripts/__tests__/test-deploy-generalized.test.sh
```

Expected: all route, ambiguity, resolver, alias, permission and no-Codex-shadow assertions pass.

- [ ] **Step 5: Commit the helper**

```bash
git add scripts/lib/qa-generalized.sh \
  scripts/__tests__/test-deploy-generalized.test.sh
git commit -m "fix(qa): route only QA execution into generalized stub"
```

## 5. Wire the Room and Document the Contract

### Task 5: Install the selector without changing full-stub mode

**Files:**

- Modify: `scripts/test-deploy.sh`
- Test: `scripts/__tests__/test-deploy-generalized.test.sh`

- [ ] **Step 1: Keep the full-stub branch byte-compatible**

The `STUB_RUNNER=1` branch continues installing both `claude` and `codex` stubs. Do not reuse the QA-only selector there.

- [ ] **Step 2: Pin and install in QA-only mode**

In the mutually exclusive `QA_STUB_RUNNER=1` branch:

```bash
QA_REAL_CLAUDE_BIN="$(qa_generalized_resolve_real_claude "${SLOT_DIR}/stub-bin")" \
  || campaign_abort "QA-only stub needs a real Claude executable on PATH"
qa_generalized_install_qa_stub "${SLOT_DIR}/stub-bin" \
  "${REPO_ROOT}/scripts/qa-529-generalized-stub.mjs" \
  "$QA_REAL_CLAUDE_BIN" "${SLOT_DIR}/teamlead.db" \
  || campaign_abort "QA-only stub installation failed"
BRIDGE_EXTRA_ENV+=("PATH=${SLOT_DIR}/stub-bin:${PATH}")
```

At this point the Bridge-wide path contains the selector, not the raw stub. Identity-free review and all proven non-QA calls immediately `exec` the pinned real Claude; only positive QA identity reaches the stub.

- [ ] **Step 3: Assert wiring literals**

Extend the focused shell test to require the resolver call, pinned StateStore argument, mutually exclusive flags, `qaRunnerMode=stub`, and no QA-only `codex` install.

- [ ] **Step 4: Run focused test GREEN**

```bash
bash scripts/__tests__/test-deploy-generalized.test.sh
```

Expected: exit 0.

### Task 6: Update the operator playbook

**Files:**

- Modify: `doc/qa/framework/529-room-playbook.md`

- [ ] **Step 1: Document the exact invocation and boundary**

Document:

```bash
bash scripts/test-deploy.sh "$SLOT" \
  --generalized \
  --codex-runner \
  --qa-stub-runner \
  --extra-lead 1:PM-Test
```

State plainly:

- design/implement are real Codex;
- design/code review is real Claude;
- only exact QA execution is stubbed;
- same-execution QA standby uses the slot DB fallback;
- the inner stub cannot create PASS or final evidence;
- the outer driver/QA owner remains the only final 529 evidence owner.

- [ ] **Step 2: Commit wiring and docs**

```bash
git add scripts/test-deploy.sh \
  scripts/__tests__/test-deploy-generalized.test.sh \
  doc/qa/framework/529-room-playbook.md
git commit -m "docs(FLY-2922): define QA-only stub routing boundary"
```

## 6. Targeted Verification and Handoff

### Task 7: Verify only the affected surface

- [ ] **Step 1: Re-run discovery after literal changes**

Repeat every Task 1 search, plus:

```bash
git grep -lF -- 'flywheel-qa-529-qa-only-shim'
git grep -lF -- 'QA_REAL_CLAUDE_BIN'
git diff --name-only origin/main...HEAD
```

Record retained and excluded matches. Confirm the new commits touch only the four allowed files plus issue process docs/progress.

- [ ] **Step 2: Run the existing shell test individually**

```bash
bash scripts/__tests__/test-deploy-generalized.test.sh
```

Expected: exit 0, including review-shaped real-Claude passthrough and QA/standby/negative route assertions. This is targeted evidence, not a full suite.

- [ ] **Step 3: Run lint and affected build**

```bash
pnpm lint
pnpm --filter "flywheel-teamlead..." build
```

Expected: both exit 0. There is no changed TypeScript file, so local-test-policy does not require `vitest related`; do not run it as a broad fallback.

- [ ] **Step 4: Verify forbidden production paths are unchanged by this repair**

```bash
git diff --name-only HEAD~3..HEAD | rg \
  '^(packages/|\.flywheel/agents/nodes/qa\.md$)'
```

Expected: no output. Inspect the actual diff rather than relying on this guard alone.

- [ ] **Step 5: Push normally and request exact-head code review**

Push without `--no-verify` and without force. Open a new `review_code` gate and `request-review` bound to the pushed exact head. Fix blocking findings only and re-request until the effective `reviewVerdict` is `APPROVED`.

- [ ] **Step 6: Hand off to QA**

After exact-head review approval, run the injected `complete --route needs_review` command. QA@3 must prove on that exact head:

1. full CI green and PR mergeable;
2. room starts with `--generalized --codex-runner --qa-stub-runner --extra-lead 1:PM-Test`;
3. design review is completed by real Claude, not the QA stub;
4. driver completes all steps, including held → unified recovery → new dispatch;
5. final outer evidence is recorded by the authorized owner, never synthesized by the inner stub.

## 7. Rollback and Tradeoffs

Rollback reverts the selector/install/docs commits and restores the prior QA-only raw stub behavior; that behavior is known to break real review and must not be used as a passing QA path. No database migration, product feature flag, StateStore vocabulary or production deployment is involved.

The selector is less architecturally pure than a first-class per-node adapter binary, but it preserves the harness-only scope and default-off production behavior. The strict identity matrix, pinned absolute passthrough, alias rejection and standby DB proof keep this compromise bounded.

## 8. Acceptance Matrix

| Requirement | Authoritative proof |
|---|---|
| 真实设计评审不再被 stub 截获 | focused identity-free review test; QA@3 Bridge log/review verdict from real Claude |
| 只有 QA execution 走 stub | exact activation matrix + standby binding matrix + room actor evidence |
| 非 QA execution 保持真实 | design/implement activation passthrough tests; no `stub-bin/codex` |
| QA standby 仍可继续 | exec-only unique-qa DB test and QA@3 recovery step |
| foreign / ambiguous 身份不误放 | mismatch, `qa-extra`, malformed, multi-node, unreadable-DB negative tests |
| selector 不自递归 | absolute resolver plus symlink/hardlink/copy alias tests |
| 产品 QA 规则未放松 | four-file repair diff; no product/role/judge changes |
| 不用去 flag 规避 | documented QA@3 command retains `--qa-stub-runner` |
| FLY-2922 行为真正被验 | exact-head real room completes held → unified recovery → new dispatch with dispatch-ledger proof |

## 9. Out of Scope

- 不把 QA-only selector 做成生产 feature flag。
- 不修改 review coordinator binary policy。
- 不让 raw QA stub 接受缺失身份。
- 不推广 mixed node stubbing 到普通 run。
- 不把 focused shell test、inner stub verdict 或旧 INCONCLUSIVE 房追认为 strength-two PASS。
