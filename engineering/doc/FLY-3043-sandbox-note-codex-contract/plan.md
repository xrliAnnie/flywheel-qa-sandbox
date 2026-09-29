# FLY-3043 Codex 契约文件加沙箱注释 — 实施计划

Issue: FLY-3043 (https://linear.app/geoforge3d/issue/FLY-3043/qa-sbx-fly-3024-b535a6f9-per-issue-529-without-a-d)
日期: 2026-09-28
基于: research.md

## 0. 一句话

在 `packages/claude-runner/agents/codex-runner-contract.md` 末尾**恰好追加一行** `- Sandbox note: runners run only the tests related to their change.`，并在既有单测里加一条"这一行确实物化到 AGENTS.md 末尾"的断言；单 commit、开 PR、常规评审、complete。零行为改动。

## 1. 范围与不变量

### 1.1 改动清单（只此两处）

| # | 文件 | 改动 | 硬约束 |
|---|---|---|---|
| 1 | `packages/claude-runner/agents/codex-runner-contract.md` | 文件末尾追加一行（见 §3 Task 2 的逐字内容） | `git diff --numstat` 对该文件必须是 `1	0`；追加后 `tail -n1` 逐字等于目标行；文件仍以 `\n` 结尾 |
| 2 | `packages/claude-runner/test/codex-home.test.ts` | 在 `describe("FLY-1188 AGENTS.md contract materialization")` 第一个 `it` 的末尾（现第 238 行 `expect(agents).toContain("Environment Translation");` 之后）加一条 `endsWith` 断言 | 不改动其他用例；biome 通过 |

### 1.2 负面守卫（实施节点必须遵守）

- **不**改 `Contract-Version: 2`、不加空行、不新开小节、不改文件其他任何字节。
- **不**改 `codex-home.ts`、`package-onboard-smoke.test.sh` 或任何第三个文件；progress.md 由 `progress` 命令自动提交，不算在内。
- **不**裸跑 `pnpm test`（DoD 第 3 条）；本机只跑 §4 列出的相关测试。
- **不**改 `core.hooksPath`、**不**用 `git push --no-verify`、**不**强推（FORCE-PUSH GUARD）。
- 若 `git status` 出现计划外文件（如 `.flywheel/runs/` 之外的残留），停下 `ask` Lead，不自删。

### 1.3 为什么要加断言（以及可退回的开关）

issue 只要求改一行文档，但 DoD 第 2 条要"相关测试"。断言让"这一行进了每个 Codex runner 的 `AGENTS.md` 且在末尾"变成机器可复核的证据（`provisionCodexHome` 把契约逐字接在一行管理头之后，见 `codex-home.ts:467`，所以契约末行 = AGENTS.md 末行）。**若 Lead 明确要求只改一个文件**，删掉 Task 1 的两行即可，其余步骤不变——这是本 plan 唯一的可选项，默认执行。

## 2. 前置（Task 0）

在仓库根、TURN 为 `yours` 的前提下：

```bash
cd /private/tmp/flywheel-test-slot-2/project-slot-2-FLY-3043
node "$FLYWHEEL_COMM_CLI" turn                       # 期望首词 yours
git status --short                                   # 期望为空（或仅 ?? 计划内文件）
git fetch -q origin main && echo "ahead=$(git rev-list --count origin/main..HEAD) behind=$(git rev-list --count HEAD..origin/main)"
pnpm install --frozen-lockfile --prefer-offline      # 实测 7s;teamlead 的 flywheel-comm bin 告警可忽略
pnpm --filter flywheel-claude-runner exec vitest run test/codex-home.test.ts   # 基线:37 passed
```

`behind` 若非 0：`git merge origin/main`（技术同步不需要 ship 批准）；有冲突则 `git merge --abort` + `ask` Lead，不预设取舍。

## 3. 任务（TDD：先 RED 再 GREEN）

### Task 1 — RED：加断言（`packages/claude-runner/test/codex-home.test.ts`）

在第 238 行 `expect(agents).toContain("Environment Translation");` 之后、该 `it` 的 `});` 之前插入两行（缩进与相邻行一致，3 个 tab）：

```ts
			// FLY-3043: the sandbox note is the contract's LAST line — and AGENTS.md is header + contract verbatim
			expect(agents.trimEnd()).toMatch(/- Sandbox note: runners run only the tests related to their change\.$/);
```

验证（必须先红）：

```bash
pnpm --filter flywheel-claude-runner exec vitest run test/codex-home.test.ts
# 期望:Tests  1 failed | 36 passed (37) —— 失败的正是 "writes AGENTS.md (0600) …" 这条
```

### Task 2 — GREEN：追加契约行

```bash
F=packages/claude-runner/agents/codex-runner-contract.md
tail -c1 "$F" | xxd -p          # 期望 0a(已有尾随换行;实测如此)
printf '%s\n' '- Sandbox note: runners run only the tests related to their change.' >> "$F"
```

验证（四项全过才算 GREEN）：

```bash
git diff --numstat -- "$F"                                   # 期望:1	0	packages/claude-runner/agents/codex-runner-contract.md
tail -n1 "$F"                                                # 期望逐字:- Sandbox note: runners run only the tests related to their change.
grep -c '^- Sandbox note: runners run only the tests related to their change\.$' "$F"   # 期望 1
pnpm --filter flywheel-claude-runner exec vitest run test/codex-home.test.ts             # 期望 37 passed
```

（断言加在既有 `it` 内，所以用例数仍是 37，由 RED→GREEN 的翻转证明断言生效。）

### Task 3 — Lint + 单 commit

```bash
pnpm exec biome check packages/claude-runner/test/codex-home.test.ts      # 期望 0 error
git add packages/claude-runner/agents/codex-runner-contract.md packages/claude-runner/test/codex-home.test.ts
git status --short                                                        # 期望仅这两个 M
git commit -F "$FLYWHEEL_RUNNER_STATE_DIR/fly-3043-commit-msg.txt"
```

commit message 文件内容（`$FLYWHEEL_RUNNER_STATE_DIR/fly-3043-commit-msg.txt`，先用 heredoc 写好）：

```
docs(FLY-3043): add sandbox note to codex runner contract

Append exactly one line to packages/claude-runner/agents/codex-runner-contract.md
("- Sandbox note: runners run only the tests related to their change.")
and assert in codex-home.test.ts that the materialized AGENTS.md ends with it.
Zero behavior change: no consumer parses the file's length or tail.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

### Task 4 — 账本 → push → PR → 等 CI（顺序不可调换：mutation freeze）

```bash
# 4a 账本终值必须在 push 之前(progress 会真实 commit)
node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" \
  --file engineering/doc/FLY-3043-sandbox-note-codex-contract/progress.md \
  --phase implement --cursor 5/5 --set-chunk implement=done --next "PR CI + review gate"
# 4b 首次 push
git push -u origin project-slot-2-FLY-3043
# 4c PR body 写到绝对路径再引用
cat > "$FLYWHEEL_RUNNER_STATE_DIR/fly-3043-pr-body.md" <<'BODY'
## Summary
- Append exactly one line to `packages/claude-runner/agents/codex-runner-contract.md`: `- Sandbox note: runners run only the tests related to their change.`
- Add one assertion in `packages/claude-runner/test/codex-home.test.ts` that the materialized `AGENTS.md` ends with that line.
- Zero behavior change (no consumer parses the file's length/tail). Design docs under `engineering/doc/FLY-3043-sandbox-note-codex-contract/`.

## Test plan
- [x] `git diff --numstat` on the contract file = `1 0`
- [x] `pnpm --filter flywheel-claude-runner exec vitest run test/codex-home.test.ts` — RED (1 failed/36 passed) before the line, GREEN (37 passed) after
- [x] `pnpm exec biome check packages/claude-runner/test/codex-home.test.ts` clean
- [ ] PR CI green (full `test:packages:run` + `package-onboard-smoke.test.sh` ③b contract-shipped check)

## Linear Issue
FLY-3043: QA-SBX FLY-3024 b535a6f9 per-issue 529 without A–D
https://linear.app/geoforge3d/issue/FLY-3043/qa-sbx-fly-3024-b535a6f9-per-issue-529-without-a-d

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
gh pr create --base main --head project-slot-2-FLY-3043 \
  --title "docs(FLY-3043): add sandbox note to codex runner contract" \
  --body-file "$FLYWHEEL_RUNNER_STATE_DIR/fly-3043-pr-body.md"
# 4d push 之后只读:核 head、等 rollup 非空再 watch(空 rollup 时 --watch 会立刻 exit 1)
PR=$(gh pr view --json number -q .number); echo "PR=$PR"
test "$(git rev-parse HEAD)" = "$(gh pr view "$PR" --json headRefOid -q .headRefOid)" && echo HEAD_OK
for i in $(seq 1 20); do n=$(gh pr view "$PR" --json statusCheckRollup -q '.statusCheckRollup|length'); [ "$n" -gt 0 ] && break; sleep 15; done; echo "rollup=$n"
gh pr checks "$PR" --watch --interval 30
```

push 之后**不再产生任何 commit**；若 CI 红且原因在本改动，修复后重跑 4a→4d 整段（账本先于 push）；若 CI 红与本改动无关（历史 flaky / infra），`ask` Lead 并附 job 名与日志链接，不自行重试循环。

### Task 5 — 评审门与收口（以 implement 节点 dispatch 合同为准）

研究 §4.5 的既往走法仅作提醒：`gate review_code --no-block` → `request-review --type code` 若 409 属预期分流 → `codex:rescue` 评审到 APPROVED → `codex-review-result --exec-id "$FLYWHEEL_EXEC_ID" --pr-head "$(git rev-parse HEAD)"` → `complete --route needs_review --pr "$PR"`；complete 后若 Bridge 补发 FLY-827 指令，写 `.flywheel/runs/$FLYWHEEL_EXEC_ID/codex/code-review.json` 再 `await-codex-gate code`，并用 `ask --report "DONE: [lead-instruction <id>] …"` 回执。**不申请 ship、不 merge。**

## 4. 测试证据（QA 节点可逐条机器复核）

| 证据 | 命令 | 期望 |
|---|---|---|
| 恰好一行 | `git diff --numstat origin/main...HEAD -- packages/claude-runner/agents/codex-runner-contract.md` | `1	0	…` |
| 内容逐字 | `tail -n1 packages/claude-runner/agents/codex-runner-contract.md` | `- Sandbox note: runners run only the tests related to their change.` |
| 唯一出现 | `grep -c '^- Sandbox note:' packages/claude-runner/agents/codex-runner-contract.md` | `1` |
| 物化到 AGENTS.md 末尾 | `pnpm --filter flywheel-claude-runner exec vitest run test/codex-home.test.ts` | `37 passed`（含新断言） |
| 完整套件 + 打包存在性 | PR CI `Build & Test` 绿（`test:packages:run` + `package-onboard-smoke.test.sh` ③b） | ✓ |
| 文件集合 | `git diff --name-only origin/main...HEAD` | 契约、单测、`engineering/doc/FLY-3043-sandbox-note-codex-contract/*`，无其他 |

## 5. 回滚与迁移

- 无迁移、无持久化、无配置变化。
- 回滚 = `git revert <该 commit>`（或 PR 不 merge）。回滚后契约回到 Contract-Version 2 原文，单测回到 37 条原断言。
- 已 provision 的 Codex runner home 不需要处理：`provisionCodexHome` 每次重新物化 AGENTS.md（"re-provisioning overwrites AGENTS.md in place" 用例已覆盖）。

## 6. 风险

| 风险 | 概率 | 处置 |
|---|---|---|
| 断言被视为越界（issue 字面只改一个文件） | 低 | §1.3 开关：Lead 一句话即可退回单文件方案，不影响其他任务 |
| 追加时误加空行 / 编辑器自动格式化 | 低 | 用 `printf >>` 而非编辑器；`numstat` 必为 `1 0` |
| CI flaky（hermetic shell 测试段） | 中 | 与本改动无关的红先 `ask` Lead，只重跑失败 job，不追加 commit |
| `progress` 提交在 push 后触发二次 CI | 低 | Task 4 顺序固定：账本 → push → 只读 |

## 7. 完成定义（对照 issue DoD）

1. 验收标准：契约末尾恰好一行目标文本 ✓（§4 前三行证据）
2. 相关测试：新断言 RED→GREEN ✓
3. 本机只跑相关测试、完整套件由 exact-head PR CI 证明 ✓（不裸跑 `pnpm test`）
4. 已 commit 到 feature branch `project-slot-2-FLY-3043` ✓
5. PR 已创建并关联 FLY-3043 ✓（body 含 `## Linear Issue`）
6. PR description 含变更摘要 + 测试计划 ✓
7. 第 7 条（独立生产仓上线）不适用：本仓即沙箱仓，无部署环节。
