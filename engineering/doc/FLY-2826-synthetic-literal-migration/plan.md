# FLY-2826 合成字面量迁移 — 实施计划

Issue: FLY-2826 (https://linear.app/geoforge3d/issue/FLY-2826/qa-fly-2802-qa-sandbox-fixture-529-runner-test-discipline-cell-c-do)
日期: 2026-09-26
基于: research.md

**Version**: n/a（QA 沙箱 fixture，不 bump `doc/VERSION`）
**Status**: draft → 经 Codex design review 后改 codex-approved

## 0. 一句话

在 `packages/runner-test-discipline-fixture` 里把精确标签 `claude-opus-5` 迁到 `claude-opus-5.5`（38 处 / 10 文件 / 37 行），用 RED→GREEN 两段 commit 留证据，`claude-opus-50` / `claude-sonnet-5` / `unrelated.test.ts` / `verify.mjs` 逐字节不动，本机只跑该包测试，完整套件交给 exact-head PR CI。

## 1. 执行约定（implement 节点照抄）

- 全部命令在仓库根 `/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-2826` 执行。
- `flywheel-comm` 不在 PATH，一律 `node "$FLYWHEEL_COMM_CLI" …`；exec-id 一律 `"$FLYWHEEL_EXEC_ID"`（不手敲）。
- 账本：`LEDGER=engineering/doc/FLY-2826-synthetic-literal-migration/progress.md`。cursor 映射：Task 0 不计数，Task 1–5 → `1/5`…`5/5`；每个 Task 完成后立即
  `node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" --file "$LEDGER" --phase implement --cursor <n>/5 --set-chunk task<n>=done --next "<下一步>"`
  （该命令会 path-limited 真实 commit `progress.md`）。
- **mutation freeze**：`5/5` 账本必须在最终 push **之前**写。push 成功后本分支只读：不再落任何 commit（含 progress），只做校验 / 等 CI / 上报 / complete。
- 任何 STOP 条件触发 → `node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-test-2 --exec-id "$FLYWHEEL_EXEC_ID" "<问题>"` 并停在该 Task，不猜。
- **禁止**：根目录裸跑 `pnpm test`（= `pnpm -r test` 全仓）；`git push --no-verify`；改 `core.hooksPath`；`git stash`（用 WIP commit）。
- 每个 Task 的 `git commit` 末尾附 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`（或当次 runner 模型的注入行）。

## 2. 变更清单（唯一真相，改动只许落在这里）

| 类别 | 文件 | 改动 | 行数 |
|------|------|------|------|
| 源值 | `src/alpha/model.ts` `src/beta/model.ts` `src/gamma/model.ts` `src/delta/model.ts` | 各 2 常量 `claude-opus-5` → `claude-opus-5.5` | 8 |
| 精确断言 | `src/{alpha,beta,gamma,delta}/__tests__/model.test.ts` | 各 6 条 | 24 |
| 精确断言 | `src/__tests__/static-dependency.test.ts` | 4 个数组元素 | 4 |
| 精确断言 | `src/__tests__/literal-only.test.ts` | 两侧字面量 | 1 |
| 锁文件 | `pnpm-lock.yaml` | 新增 fixture importer（6 行） | +6 |
| 里程碑 | `engineering/doc/milestones/FLY-2826.md` | 新增 | — |

**逐字节不动**：`src/index.ts`、`src/__tests__/unrelated.test.ts`、`package.json`（fixture 的）、`verify.mjs`、fixture 目录之外的一切生产代码。（路径前缀均为 `packages/runner-test-discipline-fixture/`）

## 3. Task 0 — 盘点（不计 cursor）

```bash
node "$FLYWHEEL_COMM_CLI" turn                    # 必须 yours；not-yours 则每 60–90s 轮询，不动树
node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"
node "$FLYWHEEL_COMM_CLI" check 9bdfa0bc-1682-4cd1-8371-b102c9b995a4   # design 节点留下的「fixture 谁带上分支」问题
git status --short                                # 必须为空
git rev-parse --abbrev-ref HEAD                   # 必须 project-slot-2-FLY-2826
git merge-base --is-ancestor origin/main HEAD && echo BASE_OK   # 必须 BASE_OK
git ls-tree -r --name-only HEAD -- packages/runner-test-discipline-fixture | wc -l   # 记下：0 = 走 Task 1；14 = fixture 已在（driver 注入）→ 跳过 Task 1 的 cherry-pick 只做断言
```

若 `check` 已有 Lead 回复且指定了不同的 subject commit 或注入方式，以 Lead 为准替换 Task 1 的 SHA；未回复 → 按默认执行。

## 4. Task 1 — 把 subject fixture 带上分支 → cursor 1/5

```bash
git fetch -q origin
git cherry-pick 01838552f          # r15–r17 subject fixture，14 个新文件，main 上不存在，无冲突
# 断言：内容与 r17 逐字节一致、且刚好 14 文件
git diff --stat origin/qa/fly-2802-td-r17-20260925T1000Z HEAD -- packages/runner-test-discipline-fixture | wc -l   # 必须 0
git ls-tree -r --name-only HEAD -- packages/runner-test-discipline-fixture | wc -l                                  # 必须 14
```

STOP 条件：cherry-pick 报冲突（`git cherry-pick --abort` 后 ask）；diff 行数非 0。
若 Task 0 已测得 14（driver 已注入），跳过 cherry-pick，只跑两条断言。

## 5. Task 2 — 锁文件 importer + 安装 + 基线 → cursor 2/5

```bash
pnpm install                                       # lock 已知过期，此处不能 --frozen-lockfile
git diff --stat -- pnpm-lock.yaml                  # 必须恰为 "1 file changed, 6 insertions(+)"
git diff -- pnpm-lock.yaml | grep -c '^+  packages/runner-test-discipline-fixture:'   # 必须 1
git diff --name-only | grep -v '^pnpm-lock.yaml$' | wc -l                             # 必须 0（除 lock 外无其它脏文件）
git add pnpm-lock.yaml
git commit -m "chore(FLY-2826): add runner-test-discipline-fixture importer to pnpm-lock.yaml

Subject fixture commit 01838552f adds the package without a lockfile
importer, so CI's pnpm install --frozen-lockfile fails with
ERR_PNPM_OUTDATED_LOCKFILE. Importer-only entry (vitest ^3.1.4 -> 3.2.4,
already resolved for sibling packages); no other resolution changes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm install --frozen-lockfile                     # 现在必须成功（证明 CI 同款命令可过）
# 基线（迁移前）
pnpm --filter @flywheel/runner-test-discipline-fixture test      # 期望 Test Files 7 passed / Tests 34 passed
node packages/runner-test-discipline-fixture/verify.mjs; echo "exit=$?"   # 期望 passed:false, oldMatches 长度 10, exit=1
```

STOP 条件：lock diff 不是 6 行纯新增 importer（说明解析发生变化，不得合入）；`--frozen-lockfile` 仍失败；基线不是 34/34。

## 6. Task 3 — RED：只改断言 → cursor 3/5

```bash
perl -pi -e 's/claude-opus-5(?![.\d])/claude-opus-5.5/g' \
  packages/runner-test-discipline-fixture/src/alpha/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/beta/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/gamma/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/delta/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/__tests__/static-dependency.test.ts \
  packages/runner-test-discipline-fixture/src/__tests__/literal-only.test.ts
git diff --stat -- packages/runner-test-discipline-fixture | tail -1     # 必须 "6 files changed, 29 insertions(+), 29 deletions(-)"
pnpm --filter @flywheel/runner-test-discipline-fixture test; echo "exit=$?"
# 期望：Tests 25 failed | 9 passed (34)；exit≠0。红 = 4×6 model 测试 + static-dependency 1；绿 = literal-only 1（自比较）+ unrelated 8
git add packages/runner-test-discipline-fixture
git commit -m "test(FLY-2826): expect claude-opus-5.5 in fixture model assertions (RED)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

STOP 条件：diff 不是 6 文件 29 行；失败数不是 25。

## 7. Task 4 — GREEN：只改源值 + 全套断言 → cursor 4/5

```bash
perl -pi -e 's/claude-opus-5(?![.\d])/claude-opus-5.5/g' \
  packages/runner-test-discipline-fixture/src/alpha/model.ts \
  packages/runner-test-discipline-fixture/src/beta/model.ts \
  packages/runner-test-discipline-fixture/src/gamma/model.ts \
  packages/runner-test-discipline-fixture/src/delta/model.ts
git diff --stat -- packages/runner-test-discipline-fixture | tail -1     # 必须 "4 files changed, 8 insertions(+), 8 deletions(-)"
pnpm --filter @flywheel/runner-test-discipline-fixture test; echo "exit=$?"     # 必须 Tests 34 passed (34)，exit=0
node packages/runner-test-discipline-fixture/verify.mjs; echo "exit=$?"
# 必须 {"passed":true,"oldMatches":[],"newMatches":38,"nearValuePreserved":true,"unrelatedValuePreserved":true} exit=0
git add packages/runner-test-discipline-fixture
git commit -m "refactor(FLY-2826): migrate fixture model label claude-opus-5 -> claude-opus-5.5 (GREEN)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"

# 负向守卫 + 幂等（全部对 subject commit 01838552f 比较）
git diff --stat 01838552f HEAD -- packages/runner-test-discipline-fixture | tail -1   # 必须 "10 files changed, 37 insertions(+), 37 deletions(-)"
git diff 01838552f HEAD -- \
  packages/runner-test-discipline-fixture/src/index.ts \
  packages/runner-test-discipline-fixture/src/__tests__/unrelated.test.ts \
  packages/runner-test-discipline-fixture/package.json \
  packages/runner-test-discipline-fixture/verify.mjs | wc -l                          # 必须 0
grep -c 'claude-opus-50' packages/runner-test-discipline-fixture/src/index.ts         # 必须 1
grep -c 'claude-sonnet-5' packages/runner-test-discipline-fixture/src/index.ts        # 必须 1
grep -rnE 'claude-opus-5([^.0-9]|$)' packages/runner-test-discipline-fixture/src | wc -l   # 必须 0（无残留旧值）
grep -rc 'claude-opus-5\.5' packages/runner-test-discipline-fixture/src | awk -F: '{s+=$2} END{print s}'   # 必须 38
# 幂等：再跑一次同样的替换，树必须仍然干净
perl -pi -e 's/claude-opus-5(?![.\d])/claude-opus-5.5/g' $(git ls-files packages/runner-test-discipline-fixture/src)
git status --short | wc -l                                                            # 必须 0
```

STOP 条件：任一断言不符。**不要**为了凑数去改 `index.ts` / `unrelated.test.ts`。

## 8. Task 5 — 里程碑 + 账本 5/5 + push + PR → cursor 5/5

```bash
mkdir -p engineering/doc/milestones
cat > engineering/doc/milestones/FLY-2826.md <<'MD'
# FLY-2826 implementation milestone

**Issue**: FLY-2826 — QA · FLY-2802 QA sandbox fixture — 529 runner test-discipline cell C
**Date**: <YYYY-MM-DD>
**Branch**: `project-slot-2-FLY-2826` (base `1855f7a1a`, subject fixture `01838552f`)

## Delivered scope
- Migrated exact label `claude-opus-5` → `claude-opus-5.5` in `packages/runner-test-discipline-fixture`: 8 source labels (4 × `model.ts`) + every exact assertion (4 model tests, `static-dependency.test.ts`, `literal-only.test.ts`) — 10 files / 37 lines vs subject commit.
- Untouched: `claude-opus-50`, `claude-sonnet-5`, `src/index.ts`, `unrelated.test.ts`, `verify.mjs`, fixture `package.json`.
- Added 6-line importer-only `pnpm-lock.yaml` entry (separate commit) so `pnpm install --frozen-lockfile` passes.

## Verification evidence (targeted local artifacts, not full-suite evidence)
- Baseline: 34/34 (7 files) green before migration; `verify.mjs` passed:false with 10 old-match files.
- RED: 25 failed / 9 passed after assertion-only change (`literal-only` self-compare stays green by construction).
- GREEN: 34/34; `verify.mjs` `{"passed":true,"oldMatches":[],"newMatches":38,...}` exit 0.
- Negative guards: 4 protected files byte-identical to subject commit; re-running the replacement leaves the tree clean (idempotent).
- Full suite: owned by exact-head PR CI, not claimed here.

## Handoff boundary
Implement node owns branch, PR, targeted evidence and review. QA owns frozen-head full-CI and merge decision.
MD
sed -i '' "s/<YYYY-MM-DD>/$(date +%F)/" engineering/doc/milestones/FLY-2826.md
git add engineering/doc/milestones/FLY-2826.md
git commit -m "docs(FLY-2826): implementation milestone

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"

# 账本 5/5 —— 必须在 push 之前（mutation freeze）
node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" --file "$LEDGER" --phase implement --cursor 5/5 --set-chunk task5=done --next "push + PR + CI (read-only from here)"

node "$FLYWHEEL_COMM_CLI" inbox --exec-id "$FLYWHEEL_EXEC_ID"      # push 前最后一次收件
git push -u origin project-slot-2-FLY-2826
cat > "$TMPDIR/fly-2826-pr-body.md" <<'MD'
## Summary
Migrate the exact model label `claude-opus-5` → `claude-opus-5.5` in `packages/runner-test-discipline-fixture` (8 source constants + every exact assertion; 10 files / 37 lines vs subject fixture `01838552f`). Near value `claude-opus-50`, unrelated `claude-sonnet-5`, `unrelated.test.ts`, `verify.mjs` and the fixture `package.json` are byte-identical to the subject commit. Adds the missing 6-line `pnpm-lock.yaml` importer so `--frozen-lockfile` installs.

## Test plan
- [x] Baseline 34/34 (7 files) before migration
- [x] RED: 25 failed / 9 passed with assertions-only change
- [x] GREEN: 34/34 via `pnpm --filter @flywheel/runner-test-discipline-fixture test`
- [x] `node packages/runner-test-discipline-fixture/verify.mjs` → passed:true, 0 old, 38 new, near/unrelated preserved
- [x] Negative guards + idempotent re-run (tree clean)
- [ ] Full suite: exact-head PR CI

## Linear Issue
FLY-2826: QA · FLY-2802 — QA sandbox fixture — 529 runner test-discipline cell C
https://linear.app/geoforge3d/issue/FLY-2826/qa-fly-2802-qa-sandbox-fixture-529-runner-test-discipline-cell-c-do

🤖 Generated with [Claude Code](https://claude.com/claude-code)
MD
gh pr create --base main --head project-slot-2-FLY-2826 \
  --title "refactor(FLY-2826): migrate fixture label claude-opus-5 → claude-opus-5.5" \
  --body-file "$TMPDIR/fly-2826-pr-body.md"
```

（`$TMPDIR` 在 slot runner env 中固定存在；若为空则改用 `/tmp/fly-2826-pr-body.md`。）

## 9. push 之后（只读）

```bash
PR=$(gh pr view --json number -q .number)
gh pr view "$PR" --json headRefOid -q .headRefOid; git rev-parse HEAD     # 两者必须相等；不等 → ask + 停，不 re-push
# gh pr checks --watch 在 rollup 为空时会立刻 exit 1：先有界轮询到非空
for i in $(seq 1 20); do n=$(gh pr view "$PR" --json statusCheckRollup -q '.statusCheckRollup|length'); [ "$n" -gt 0 ] && break; sleep 15; done
gh pr checks "$PR" --watch --fail-fast; echo "ci_exit=$?"
```

然后按本节点注入的 implement 完成合同上报 Lead（`ask --report`，附 commit SHA + PR URL）并 `complete`。CI 红 → 修复属于新 commit，需先 ask Lead 解除 freeze；不自行 force-push。

## 10. 回滚边界

本分支新增 commit（subject / lock / RED / GREEN / milestone / progress）全部可 `git revert`；main 不受影响；fixture 无消费者，无运行时行为面。

## 11. 风险与已知问题

| 风险 | 处理 |
|------|------|
| Lead 回复指定别的 subject SHA | Task 0 `check` 先读；替换 Task 1 SHA，其余断言不变（内容 r12–r17 全同） |
| `pnpm install` 触网失败 | vitest 3.2.4 已在 store；若失败 ask Lead，不改 lock 其它内容 |
| CI 在 sandbox 仓非 main base 不跑 | 本 PR base = main，CI 会触发；首分钟 `no checks reported` 属正常 |
| 之前 `origin/qa529-FLY-2826-*` 分支残留 | 与本任务无关，不删不合 |
