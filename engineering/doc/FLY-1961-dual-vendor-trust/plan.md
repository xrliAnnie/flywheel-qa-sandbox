# FLY-1961 双 vendor 工作区信任 — 实施计划
Issue: FLY-1961 (https://linear.app/geoforge3d/issue/FLY-1961/spawn信任-双-vendor-信任预置新-worktree-的-codex-体出生即卡信任目录提示生产-22-实证)
日期: 2026-08-21
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:test-driven-development` and execute inline in the current bounded implement node. Do not dispatch successor/review nodes; the Flywheel DAG owns advancement.

**Goal:** 新 worktree 的 Claude/Codex runner 在 CLI 启动前写入各自实际读取的目录信任状态，且 529 real 治具同步双写并可安全清理。

**Architecture:** `Blueprint` 只在拿到本次真实 worktree 时声明 pretrust；backend adapter 决定写哪个状态库。Claude adapter 原子 merge 机器级 JSON，Codex adapter 在 `provisionCodexHome()` 中给 execution-scoped TOML 增受管 project trust。529 shell helper 在 run POST 前双写 host 状态，teardown 只清 helper 自己的 Codex marker block。Antigravity/Kimi 不消费 Claude/Codex 信任库，本 issue 不给它们发送该 signal。

**Tech Stack:** TypeScript、Node `fs`、`smol-toml`、Vitest、bash 3.2-compatible shell、Python 3 `tomllib`、jq。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `packages/core/src/adapter-types.ts` | 给 adapter execution 增加 optional `pretrustWorkspace` 明示信号 |
| `packages/claude-runner/src/workspace-trust.ts` | Claude JSON 原子/并发安全 writer |
| `packages/claude-runner/src/codex-home.ts` | Codex TOML managed project trust render + per-runner provision |
| `packages/claude-runner/src/TmuxAdapter.ts` | Claude CLI 启动前执行 writer |
| `packages/claude-runner/src/CodexTmuxAdapter.ts` | 把 canonical cwd 交给 per-runner home provision |
| `packages/claude-runner/src/index.ts` | 导出 writer/testable seam |
| `packages/claude-runner/test/workspace-trust.test.ts` | Claude writer RED/GREEN |
| `packages/claude-runner/test/codex-home.test.ts` | TOML merge/provision RED/GREEN |
| `packages/claude-runner/test/TmuxAdapter.test.ts` | Claude pre-launch ordering与 opt-in |
| `packages/claude-runner/test/CodexTmuxAdapter.test.ts` | Codex execution home 落 trusted path |
| `packages/edge-worker/src/Blueprint.ts` | 给 Claude/Codex backend 传 pretrust signal |
| `packages/edge-worker/src/__tests__/Blueprint.fly1961-workspace-trust.test.ts` | backend wiring integration |
| `scripts/lib/runner-workspace-trust.sh` | 529 dual pretrust + managed Codex prune CLI |
| `scripts/inject-linear-issue.sh` | legacy injector 改用 dual helper |
| `scripts/qa-529-generalized-e2e.mjs` | `--real` POST 前按共享 branch-B path 调 dual helper |
| `scripts/test-teardown.sh` | 清 slot prefix 下 helper-owned Codex entries |
| `scripts/__tests__/test-runner-workspace-trust.sh` | scratch HOME 双写/失败/清理 shell harness |
| `scripts/__tests__/test-deploy-qa-room.test.sh` | 固定 generalized real driver/teardown 接线合同 |

## Task 1: Claude workspace trust writer

**Files:**
- Create: `packages/claude-runner/src/workspace-trust.ts`
- Create: `packages/claude-runner/test/workspace-trust.test.ts`
- Modify: `packages/claude-runner/src/index.ts`

- [ ] **Step 1: 写 missing/idempotent/preserve 的 failing tests**

测试用 scratch `FLYWHEEL_CLAUDE_JSON` 与 lock，调用 wished-for API：

```ts
const env = {
  FLYWHEEL_CLAUDE_JSON: join(tmp, ".claude.json"),
  FLYWHEEL_CLAUDE_JSON_LOCK: join(tmp, ".claude.json.lock"),
};
await pretrustClaudeWorkspace("/private/tmp/flywheel-test-slot-2/project-FLY-1961", env);
const state = JSON.parse(readFileSync(env.FLYWHEEL_CLAUDE_JSON, "utf8"));
expect(state.projects["/private/tmp/flywheel-test-slot-2/project-FLY-1961"])
  .toMatchObject({ hasTrustDialogAccepted: true });
expect(state.keep).toEqual({ nested: 1 });
```

并行用例：

```ts
await Promise.all([
  pretrustClaudeWorkspace("/tmp/a", env),
  pretrustClaudeWorkspace("/tmp/b", env),
]);
expect(Object.keys(readState().projects).sort()).toEqual(["/tmp/a", "/tmp/b"]);
```

- [ ] **Step 2: 运行 RED 并确认缺 API**

Run: `pnpm --filter flywheel-claude-runner exec vitest run test/workspace-trust.test.ts`

Expected: FAIL，原因是 `../src/workspace-trust.js`/`pretrustClaudeWorkspace` 不存在，而不是 fixture 错误。

- [ ] **Step 3: 实现最小原子 writer**

公开合同：

```ts
export async function pretrustClaudeWorkspace(
  workspacePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<"written" | "already_trusted">;
```

实现必须：

```ts
const claudeJson = env.FLYWHEEL_CLAUDE_JSON?.trim() || join(homedir(), ".claude.json");
const lock = env.FLYWHEEL_CLAUDE_JSON_LOCK?.trim() || `${claudeJson}.lock`;
if (!isAbsolute(workspacePath) || workspacePath.includes("\0")) {
  throw new Error("pretrustClaudeWorkspace: workspacePath must be absolute and NUL-free");
}
```

在 `mkdir(lock)` 成功后才 read→parse→merge→same-directory temp→保留原 mode（新文件默认 0600）→rename；`finally` 只释放本调用拿到的 lock。锁协议必须与现有 shell peers byte-compatible：同时尊重独立的 `FLYWHEEL_CLAUDE_JSON_LOCK`、`CLAUDE_LOCK_WAIT_S`（默认 30）与 `CLAUDE_LOCK_STALE_S`（默认 60），用 BSD/GNU `stat` 等价的 directory `mtime` 语义识别并抢占 stale bare lock。`claude-runner` 不能反向依赖 `teamlead`，因此在 `workspace-trust.ts` 内实现一个最小 private bare-lock helper，并明确注释它复制的是 `inject-linear-issue.sh` / `test-teardown.sh` / `withMkdirLock(...,{bare:true,staleMs:60_000})` 的跨语言协议，而不是新建第四套语义。

invalid JSON、root/projects/entry 非 plain object 均 throw，原文件不变。已有 `true` 返回 `already_trusted` 且不 rewrite；这是降低与不遵守 Flywheel mutex 的 Claude CLI 自身写入发生 lost-update 的主要手段：每个新 worktree 最多一次 RMW。rename 后立即重新 read/parse，只把 exact target 不再为 `true` 视作 hard failure；不能用 byte-size/mtime identity 拒绝 spawn，因为外部 Claude CLI 可能在 rename 后合法写入并保留目标 key。该验证不能消除外部 writer 竞态，但能让目标 trust 被覆盖/截断在 launch 前可见。

- [ ] **Step 4: 增加 fail-loud 测试并跑 GREEN**

覆盖 invalid JSON、`projects=[]`、entry scalar、relative/NUL path、lock timeout；每项都断言原 bytes unchanged。另测 aged lockdir 会被恢复、fresh lock 不会被误抢、`FLYWHEEL_CLAUDE_JSON_LOCK` 与 JSON 路径独立设置时 writer 只竞争显式 lock、已有 0644 文件写后 mode 不变、post-write semantic re-read 中 target 丢失会拒绝返回，而保留 target 的额外并发字段不会误报。

Run: `pnpm --filter flywheel-claude-runner exec vitest run test/workspace-trust.test.ts`

Expected: PASS，所有 writer 测试 green。

- [ ] **Step 5: 导出并 commit Task 1**

```bash
git add packages/claude-runner/src/workspace-trust.ts \
  packages/claude-runner/src/index.ts \
  packages/claude-runner/test/workspace-trust.test.ts
git commit -m "fix(FLY-1961): add atomic Claude workspace trust writer"
```

## Task 2: Codex TOML trust merge 与 per-runner home

**Files:**
- Modify: `packages/claude-runner/src/codex-home.ts`
- Modify: `packages/claude-runner/test/codex-home.test.ts`

- [ ] **Step 1: 写 renderer/provision failing tests**

```ts
it("FLY-1961 adds a trusted project to the rendered runner config", () => {
  const out = renderCodexHomeConfig(GLOBAL_CONFIG, TOKEN, {
    trustedProjectPath: "/Users/x/Dev/flywheel-FLY-1961",
  });
  const parsed = parseToml(out) as any;
  expect(parsed.projects["/Users/x/Dev/flywheel-FLY-1961"].trust_level)
    .toBe("trusted");
  expect(parsed.projects["/Users/x/Dev/flywheel"].trust_level).toBe("trusted");
  expect(parsed.shell_environment_policy.set.GH_TOKEN).toBe(TOKEN);
});

it("FLY-1961 provisions trust into the execution-scoped CODEX_HOME", () => {
  const home = provisionCodexHome({
    executionId: "exec-trust",
    trustedProjectPath: "/tmp/new-worktree",
    env,
  });
  const cfg = parseToml(readFileSync(join(home, "config.toml"), "utf8")) as any;
  expect(cfg.projects["/tmp/new-worktree"].trust_level).toBe("trusted");
});
```

另测：render twice byte-identical；exact target already trusted；existing untrusted、empty table、non-table `projects` fail；notify/skills/GH coexist。

- [ ] **Step 2: 运行 RED**

Run: `pnpm --filter flywheel-claude-runner exec vitest run test/codex-home.test.ts`

Expected: FAIL，TypeScript/runtime 表明 `trustedProjectPath` 尚未参与 render/provision。

- [ ] **Step 3: 加受管 trust block 与语义守卫**

新增：

```ts
const MANAGED_TRUST_BEGIN =
  "# >>> flywheel-managed workspace trust (FLY-1961) — do not edit >>>";
const MANAGED_TRUST_END =
  "# <<< flywheel-managed workspace trust (FLY-1961) <<<";

export interface RenderCodexHomeConfigOptions {
  skillDisableNames?: string[];
  notifyProgramPath?: string;
  trustedProjectPath?: string;
}

export interface ProvisionCodexHomeOptions {
  // existing fields unchanged
  trustedProjectPath?: string;
}
```

`renderCodexHomeConfig()` 对 option 做 absolute/NUL validation；parsed `projects` 必须 undefined/plain table。现有 pure-passthrough early return 必须同时判断 `trustedProjectPath === undefined`，不能在无 token/notify/skills 时吞掉 trust option。目标 absent 才把下面由 `stringifyToml` 生成的 table 放进 managed block：

```toml
[projects."/absolute/worktree"]
trust_level = "trusted"
```

目标 existing trusted 不重复；existing entry non-table、无 `trust_level` 或值非 `trusted` 都 throw。candidate parse 后断言目标 trusted，并把目标 key 删除后比较 base/out 的其余 `projects` deep-equal。notify 的 unrelated-config 比较要恢复 `projects`，避免把合法新增误判为 drift。

- [ ] **Step 4: provision 透传并跑 GREEN**

```ts
renderCodexHomeConfig(baseToml, opts.ghToken, {
  skillDisableNames: opts.codexSkillDisableNames,
  notifyProgramPath: opts.notifyProgramPath,
  trustedProjectPath: opts.trustedProjectPath,
});
```

Run: `pnpm --filter flywheel-claude-runner exec vitest run test/codex-home.test.ts`

Expected: PASS；旧 FLY-123/1395/1571/1604 cases 全 green。

- [ ] **Step 5: commit Task 2**

```bash
git add packages/claude-runner/src/codex-home.ts \
  packages/claude-runner/test/codex-home.test.ts
git commit -m "fix(FLY-1961): trust Codex runner worktrees in per-runner homes"
```

## Task 3: Blueprint → vendor adapter pre-launch wiring

**Files:**
- Modify: `packages/core/src/adapter-types.ts`
- Modify: `packages/edge-worker/src/Blueprint.ts`
- Create: `packages/edge-worker/src/__tests__/Blueprint.fly1961-workspace-trust.test.ts`
- Modify: `packages/claude-runner/src/TmuxAdapter.ts`
- Modify: `packages/claude-runner/src/CodexTmuxAdapter.ts`
- Modify: `packages/claude-runner/test/TmuxAdapter.test.ts`
- Modify: `packages/claude-runner/test/CodexTmuxAdapter.test.ts`

- [ ] **Step 1: 写 Blueprint wiring RED**

构造一对 capture adapter，分别令 `runnerBackend="claude-tmux"` 与 `"codex-tmux"`，worktree manager 返回真实 scratch git worktree；断言：

```ts
expect(captured.pretrustWorkspace).toBe(true);
expect(captured.cwd).toBe(worktreePath);
```

no-worktree/codex 既有 fail-closed 测试保持不变；新增 no-worktree/Claude 断言 payload 不含 `pretrustWorkspace`，且 cwd 仍是 project root。Antigravity/Kimi capture case 同样断言 payload 不含该字段。

Run: `pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.fly1961-workspace-trust.test.ts`

Expected: FAIL，captured field 为 undefined。

- [ ] **Step 2: 添加 optional context signal 与 Blueprint 透传**

```ts
/** FLY-1961: pre-seed this run's cwd in the selected backend trust store before CLI launch. */
pretrustWorkspace?: boolean;
```

`Blueprint` 的 `adapter.execute()` payload 只在真实 worktree 与目标 backend 同时成立时 conditional spread：

```ts
...(worktreeInfo &&
  ((ctx.runnerBackend ?? "claude-tmux") === "claude-tmux" || isCodexRunner)
    ? { pretrustWorkspace: true }
    : {}),
```

只传 `true`，不传 `false`、config path 或 vendor state；adapter 保持归属。这样 no-worktree Claude 不会写 founder main repo，也不会被新的 JSON health gate 改变既有行为，其他 backend payload 保持 byte-compatible。

- [ ] **Step 3: 写 Claude adapter ordering RED**

测试设置 scratch `FLYWHEEL_CLAUDE_JSON`，`cwd` 用真实临时目录，调用 `pretrustWorkspace:true`；fake exec 在第一次 `tmux new-window` 时读取 JSON 并断言 target 已为 `true`。另一个无 signal 调用断言 scratch JSON 不存在。

Run: `pnpm --filter flywheel-claude-runner exec vitest run test/TmuxAdapter.test.ts -t FLY-1961`

Expected: RED，launch 时 trust 仍 missing。

- [ ] **Step 4: Claude adapter 在任何 tmux launch 前调用 writer**

```ts
if (this.type === "claude-tmux" && ctx.pretrustWorkspace === true) {
  await pretrustClaudeWorkspace(realpathSync(ctx.cwd));
}
```

位置在 lazy preflight 后、`ensureSession()`/`new-window` 前。writer throw 直接拒 spawn。

- [ ] **Step 5: 写 Codex adapter per-home RED 并接线**

现有 Codex adapter fixture 已给 scratch `FLYWHEEL_CODEX_SOURCE_HOME/HOMES_ROOT`。调用 `pretrustWorkspace:true` 后在 fake runtime 运行前解析 `${homesRoot}/${executionId}/config.toml`，断言 realpath(cwd)=trusted；无 signal case 不新增 path。

最小实现：

```ts
const codexHome = provisionCodexHome({
  executionId: ctx.executionId,
  ghToken,
  ...(ctx.pretrustWorkspace === true && { trustedProjectPath: sandboxCwd }),
  // existing notify/skill fields unchanged
});
```

- [ ] **Step 6: 跑三组 GREEN + commit**

```bash
pnpm --filter flywheel-claude-runner exec vitest run \
  test/workspace-trust.test.ts test/codex-home.test.ts \
  test/TmuxAdapter.test.ts test/CodexTmuxAdapter.test.ts
pnpm --filter flywheel-edge-worker exec vitest run \
  src/__tests__/Blueprint.fly1961-workspace-trust.test.ts
git add packages/core/src/adapter-types.ts packages/edge-worker/src/Blueprint.ts \
  packages/edge-worker/src/__tests__/Blueprint.fly1961-workspace-trust.test.ts \
  packages/claude-runner/src/TmuxAdapter.ts \
  packages/claude-runner/src/CodexTmuxAdapter.ts \
  packages/claude-runner/test/TmuxAdapter.test.ts \
  packages/claude-runner/test/CodexTmuxAdapter.test.ts
git commit -m "fix(FLY-1961): pretrust worktrees before vendor runner launch"
```

Expected: all targeted tests PASS，输出无未处理 rejection/warning。

## Task 4: 529 dual-vendor trust helper 与 lifecycle

**Files:**
- Create: `scripts/lib/runner-workspace-trust.sh`
- Modify: `scripts/inject-linear-issue.sh`
- Modify: `scripts/qa-529-generalized-e2e.mjs`
- Modify: `scripts/test-teardown.sh`
- Create: `scripts/__tests__/test-runner-workspace-trust.sh`
- Modify: `scripts/__tests__/test-deploy-qa-room.test.sh`

- [ ] **Step 1: 写 shell RED harness**

在 `mktemp -d` 下创建 fake HOME、future worktree parent、Claude JSON 与 Codex TOML，执行：

```bash
HOME="$T/home" FLYWHEEL_CLAUDE_JSON="$T/home/.claude.json" \
FLYWHEEL_CODEX_SOURCE_HOME="$T/home/.codex" \
  bash scripts/lib/runner-workspace-trust.sh pretrust-dual "$T/slot/project-FLY-1961"
```

断言：

```bash
jq -e --arg p "$CANON" '.projects[$p].hasTrustDialogAccepted == true' "$CLAUDE_JSON"
python3 - "$CODEX_CONFIG" "$CANON" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as f: cfg = tomllib.load(f)
assert cfg["projects"][sys.argv[2]]["trust_level"] == "trusted"
PY
```

并测二次调用、invalid JSON/TOML 原 bytes 不变、Codex untrusted fail、两个 target 并发都保留、stale lock 可恢复、显式 lock env 被使用、`prune-codex-prefix` 只删 marker-owned slot entry。prune 用一个 symlink/raw prefix 调用，而 marker 中保存 `pwd -P` 后路径，以确定性复现 macOS `/tmp`→`/private/tmp` 形状；还要断言 prefix 末尾 slash 隔离 slot 1/slot 10。

- [ ] **Step 2: 运行 RED**

Run: `bash scripts/__tests__/test-runner-workspace-trust.sh`

Expected: FAIL，helper 文件/命令不存在。

- [ ] **Step 3: 实现 bash 3.2-compatible helper**

CLI：

```text
runner-workspace-trust.sh pretrust-dual <future-worktree>  # stdout: canonical path
runner-workspace-trust.sh prune-codex-prefix <canonical-prefix>
```

要求：

- 先用已存在 parent 的 `pwd -P` canonicalize future path。
- Claude 侧优先用 `${FLYWHEEL_CLAUDE_JSON_LOCK}`，否则 `${FLYWHEEL_CLAUDE_JSON:-$HOME/.claude.json}.lock`；保留现有 60s stale-steal/30s wait 语义，原子 rename 并保留旧 mode。
- Codex host/source 侧复用已登记的 `${FLYWHEEL_CODEX_SOURCE_HOME:-$HOME/.codex}/config.toml`，不读取当前 runner 的 execution-scoped `CODEX_HOME`，避免从某个 body 调治具时写错层级；lock 固定为 sibling `.lock`，使用同样 stale-steal 协议。这样不新增未经 FLY-1455 census 的 `FLYWHEEL_*` seam。
- Python `tomllib` 判 semantic state；absent 时用 Python `json.dumps(path)` 生成 TOML-compatible basic-string key（不用 shell 直接插值），组成 candidate，再用 `tomllib` 验证 exact target 与 unrelated config 后写 same-directory temp、保留旧 mode（新文件默认 0600）、atomic rename：

```toml
# >>> flywheel-managed QA workspace trust (FLY-1961) <urlsafe-base64-path> >>>
[projects."/canonical/path"]
trust_level = "trusted"
# <<< flywheel-managed QA workspace trust (FLY-1961) <<<
```

- prune 只解析/删除上述 marker；传入 prefix 必须像现有 Claude prune 一样通过已存在 parent `pwd -P` canonicalize，再加 trailing slash 避免 slot 1 命中 slot 10。删前后用 `tomllib` deep compare，预期差异仅是 selected `projects` keys；prune 也必须 same-directory temp + atomic rename + mode preservation。
- 任一侧失败，`pretrust-dual` non-zero；调用方不得 POST run。

保留 host Codex 写入是 issue 的明确 529 “双侧写”验收，也使 legacy injector 或房间意外运行 stale Bridge build 时不依赖 Task 3 adapter 已生效。它不替代 production per-runner home 写入；上述受管 marker、原子性与 teardown 把 host 污染边界缩到可审计/可清理。

- [ ] **Step 4: 接 legacy injector**

`scripts/inject-linear-issue.sh` source helper，删除本文件私有的 Claude lock/writer，改成：

```bash
pretrust_workspace_dual "$RUNNER_WORKTREE" \
  || { echo "[inject] FATAL: dual-vendor trust write failed — refusing to POST /api/runs/start" >&2; exit 7; }
```

更新头部 SIDE EFFECTS，明确两侧状态与 teardown。

- [ ] **Step 5: 接 generalized `--real` driver**

在 `runDrill()` 收敛 prior run 后、POST 前：

```js
if (context.runnerMode === "real") {
  const worktree = `${room.hostRepo}-${issue}`;
  command("bash", [
    resolve(room.flywheelRepo, "scripts/lib/runner-workspace-trust.sh"),
    "pretrust-dual",
    worktree,
  ]);
}
```

`stub` 不调用，不污染 host。worktree path 与当前 generalized phase 的 `shareParentBranch=true` / `resolveWorktreeKey(issue,"main")` 一致。POST 后在等待业务 stage 前，用 start response `executionId` 轮询 `sessions.worktree_path`，将其 `realpath` 与 pretrusted canonical path 比较；不一致立即 fail drill 并把 expected/actual 写进 evidence，防止 baseDir、repo case 或 branch-sharing 策略 drift 变成无声 trust miss。

driver 用 `const canonical = command("bash", [...])` 捕获 helper 的唯一 stdout 行，作为上述 expected/evidence authority；helper 的诊断只能写 stderr。

- [ ] **Step 6: teardown 接 managed Codex prune**

先把 `test-teardown.sh` 的现有 Claude acquire/release/prune resolver 改成与 helper 一致：优先 `FLYWHEEL_CLAUDE_JSON` / `FLYWHEEL_CLAUDE_JSON_LOCK`，否则回退 `$HOME/.claude.json[.lock]`，避免 harness 只改 config path 时两个 writer 使用不同 mutex 或误碰真实 HOME。然后在现有 `prune_trust_entries "/tmp/flywheel-test-slot-${SLOT}"` 后追加：

```bash
bash "${SCRIPT_DIR}/lib/runner-workspace-trust.sh" \
  prune-codex-prefix "/tmp/flywheel-test-slot-${SLOT}" \
  || log "WARN: Codex trust prune failed; managed entries retained for inspection"
```

不把 cleanup failure 静默包装成成功：shell harness 必须直接 fail；teardown 保持现有 cleanup best-effort 合同但输出具名 WARN。

- [ ] **Step 7: 跑 GREEN 与现有 529 contract tests**

```bash
bash scripts/__tests__/test-runner-workspace-trust.sh
bash scripts/__tests__/test-deploy-qa-room.test.sh
bash scripts/__tests__/test-qa-executor-529-nton-contract.sh
```

Expected: 三个脚本 exit 0；scratch HOME 无未预期文件，真实 `$HOME` 未触碰。

- [ ] **Step 8: commit Task 4**

```bash
git add scripts/lib/runner-workspace-trust.sh \
  scripts/inject-linear-issue.sh scripts/qa-529-generalized-e2e.mjs \
  scripts/test-teardown.sh scripts/__tests__/test-runner-workspace-trust.sh \
  scripts/__tests__/test-deploy-qa-room.test.sh
git commit -m "fix(FLY-1961): pretrust both vendors in 529 real rooms"
```

## Task 5: 回归、验收证据与 PR

**Files:**
- Modify: `engineering/doc/FLY-1961-dual-vendor-trust/progress.md`
- No production file changes unless a test proves a defect.

- [ ] **Step 1: 定向回归**

```bash
pnpm --filter flywheel-claude-runner test:run
pnpm --filter flywheel-edge-worker test:run
bash scripts/__tests__/test-runner-workspace-trust.sh
bash scripts/__tests__/test-deploy-qa-room.test.sh
```

Expected: 全 PASS；若发现失败，按 systematic-debugging 回到单一根因，不叠加猜测修复。

- [ ] **Step 2: full-repo gates**

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

Expected: exit 0。若 host-dependent 既有失败，保留完整输出、对 main 基线做同命令对照并逐项归因；不能把未跑/超时写成 green。

- [ ] **Step 3: 实际配置证据（不启动生产/不重启）**

用 scratch source/home 调 `provisionCodexHome()`，解析 output 证明 exact worktree `trusted`；用 scratch Claude state 调 writer 证明 `true`。529 真房与新生产 spawn 属后续独立 QA/部署窗口，不在 implement 节点擅自启动或重启生产。

- [ ] **Step 4: Codex code review gate**

```bash
node "$FLYWHEEL_COMM_CLI" stage set code_review
node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead \
  --exec-id c7f7f428-fa43-4fb3-864b-0f505b820e28 --no-block \
  "Code review requested for FLY-1961 dual-vendor workspace trust"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id <questionId>
```

轮询 `check <questionId>`；`CHANGES_REQUESTED` 修 blocker 后以新 questionId 重开，直到 `reviewVerdict=APPROVED`。advisories 用 `ask --report` 转 Lead。

- [ ] **Step 5: 最终 commit/push/PR**

```bash
git status --short
git log --oneline origin/main..HEAD
git push -u origin flywheel-FLY-1961
gh pr create --base main --head flywheel-FLY-1961 \
  --title "fix(FLY-1961): pretrust new worktrees for Claude and Codex" \
  --body-file /tmp/fly1961-pr-body.md
```

PR body 必含变更摘要、测试计划/实际结果、FLY-1961 链接、未在 implement 节点执行生产 restart/merge 的明确说明。

- [ ] **Step 6: completion route**

```bash
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <NUMBER>
```

不请求 ship approval，不 merge，不运行 `request-restart.sh` 或 `restart-services.sh`。

## Plan 自审

- **需求覆盖**：production Claude、production per-runner Codex、legacy inject、generalized 529 real、teardown、双 vendor 回归均有 task 与证据。
- **placeholder scan**：无未决占位、延后实现或省略式空指令；`<questionId>`/`<NUMBER>` 是运行时命令返回值，不是设计缺口。
- **类型一致**：统一字段名 `pretrustWorkspace`、renderer/provision option `trustedProjectPath`、public API `pretrustClaudeWorkspace`。
- **范围**：不改 WorktreeManager、account rotation、sandbox、部署/重启或 merge。`TrustPromptHandler` 保留为已导出且有测试覆盖的 pane-detection fallback，但不接入 production；本 issue 的 pre-launch state write 是主路。Antigravity/Kimi 使用自己的 permission-skip 启动参数，未有同类 trust-store 证据，本次不改。
