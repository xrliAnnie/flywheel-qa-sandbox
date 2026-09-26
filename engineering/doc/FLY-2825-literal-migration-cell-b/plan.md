# FLY-2825 字面量迁移 cell B — 实施计划
Issue: FLY-2825 (https://linear.app/geoforge3d/issue/FLY-2825/qa-fly-2802-qa-sandbox-fixture-529-runner-test-discipline-cell-b-do)
日期: 2026-09-26
基于: research.md

**Status**: draft
**Version**: n/a（QA 沙箱 fixture 迁移，不改 `doc/VERSION`）

## 给 founder 的说明

把测试样板包里的模型名 `claude-opus-5` 改成 `claude-opus-5.5`，一共 38 处、10 个文件；长得像的 `claude-opus-50` 和无关的 `claude-sonnet-5` 一个都不碰。验证时只跑与改动相关的 7 个测试文件、逐个跑，绝不跑整包；完整测试交给 PR 的云端 CI。样板包在本分支还不存在，先用一个可追溯的提交把它原样带进来，并补上 CI 安装所需的一条 lock 记录。

```mermaid
flowchart LR
  S[seed: cherry-pick 01838552f] --> L[chore: lock importer 6 行]
  L --> I[pnpm install --frozen-lockfile]
  I --> M[refactor: 10 文件精确替换]
  M --> V[逐文件 vitest run x7 + related + verify.mjs + lint]
  V --> P[milestone + PR]
```

## 不变量

1. 迁移 diff 恰为 10 个文件、38 处 `claude-opus-5` → `claude-opus-5.5`；`index.ts`、`unrelated.test.ts`、`verify.mjs`、`package.json` 字节不变。
2. `git grep -nP 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture` 迁移后为空；`claude-opus-50` 与 `claude-sonnet-5` 的出现位置与次数迁移前后一致。
3. 本机只执行带具体文件参数的 vitest 命令；`pnpm test`、`pnpm --filter <pkg> test`、`vitest run`（无文件）、`test:packages` 任何一次调用即失败。
4. seed、lock、迁移、milestone 四个提交彼此独立、各自可 `git revert`。
5. `pnpm install --frozen-lockfile` 本地成功 = lock 条目正确的证据；exact-head PR CI 绿是唯一全套件证据。

## 步骤

### Step 0 — TURN 与账本
- `flywheel-comm turn` 为 `yours` 后再动 worktree；读 `progress.md` cursor。
- 分支 `project-slot-2-FLY-2825`；首次推送用 `git push -u origin project-slot-2-FLY-2825`。

### Step 1 — seed fixture（提交 1，`qa(FLY-2802): seed literal-migration subject fixture (cherry-pick 01838552f)`）
```sh
test -d packages/runner-test-discipline-fixture && echo EXISTS || git cherry-pick -x 01838552f
git rev-parse HEAD:packages/runner-test-discipline-fixture   # 期望 33099f034488cf00e085961caf5d9b3cf3a17225
```
- 目录已存在且 hash 相同 → 跳过本步；hash 不同 → 停下 `flywheel-comm ask` Lead，不覆盖、不手写。
- cherry-pick 保留原作者与 `-x` 来源行，seed 内容与 9 条 qa 分支同源。

### Step 2 — lock importer（提交 2，`chore(FLY-2825): add runner-test-discipline-fixture importer to pnpm-lock.yaml`）
```sh
pnpm install --lockfile-only
git diff --stat pnpm-lock.yaml         # 期望 1 文件 +6 行
git diff pnpm-lock.yaml                # 期望恰为 research.md §3.2 的 6 行
pnpm install --frozen-lockfile         # 必须 exit 0；同时物化 vitest
```
- diff 超出 6 行 → `git checkout pnpm-lock.yaml`，停下问 Lead。

### Step 3 — 发现集合（先于任何测试，记入 PR 与 milestone）
```sh
git grep -lF -- 'claude-opus-5'   -- packages/runner-test-discipline-fixture   # 期望 13 文件
git grep -lP -- 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture  # 期望 10 文件（改动集）
git grep -lF -- 'claude-opus-5.5' -- packages/runner-test-discipline-fixture   # 迁移前期望 0
```
- 13 − 10 = 3 个只含 `claude-opus-50` 子串的文件（`index.ts`、`unrelated.test.ts`、`verify.mjs`）：**不改**。
- 测试文件排除清单：**无**。7 个测试文件全部保留（4 个 `model.test.ts` 直接断言改动常量；`literal-only`、`static-dependency` 本身被改；`unrelated.test.ts` 经 `index.ts` 静态依赖改动模块）。

### Step 4 — 迁移（提交 3，`refactor(FLY-2825): migrate claude-opus-5 to claude-opus-5.5 in test-discipline fixture`）
```sh
git grep -lP -- 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture \
  | xargs perl -pi -e 's/claude-opus-5(?![.\d])/claude-opus-5.5/g'
git diff --stat                                    # 期望恰 10 文件
git diff --name-only | grep -E 'index\.ts|unrelated\.test\.ts|verify\.mjs|package\.json' && echo VIOLATION
git grep -nP 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture   # 期望空
git grep -c 'claude-opus-50' -- packages/runner-test-discipline-fixture             # index.ts:1 unrelated.test.ts:1 verify.mjs:2 不变
git grep -c 'claude-sonnet-5' -- packages/runner-test-discipline-fixture            # 同上不变
```
- 任一期望不符 → `git checkout -- packages/runner-test-discipline-fixture` 重来，不「顺手」扩大范围。
- TDD 形态：Step 3 后先改 4 个 `model.ts`，此时 `model.test.ts` 应红；再改测试文件转绿。上面的一次性替换等价，但实现节点须至少展示一次「只改源不改测 → 红」的证据（对 `alpha/model.ts` 单独做一次即可），满足 RED→GREEN。

### Step 5 — 定向验证（全部记录原始命令与退出码）
```sh
PKG=@flywheel/runner-test-discipline-fixture
for f in src/alpha/__tests__/model.test.ts src/beta/__tests__/model.test.ts \
         src/gamma/__tests__/model.test.ts src/delta/__tests__/model.test.ts \
         src/__tests__/literal-only.test.ts src/__tests__/static-dependency.test.ts \
         src/__tests__/unrelated.test.ts; do
  pnpm --filter $PKG exec vitest run "$f"        # 一次一个文件；期望 6/6 ×4, 1/1, 1/1, 8/8 = 34 tests
done
pnpm --filter $PKG exec vitest related \
  src/alpha/model.ts src/beta/model.ts src/gamma/model.ts src/delta/model.ts \
  src/alpha/__tests__/model.test.ts src/beta/__tests__/model.test.ts \
  src/gamma/__tests__/model.test.ts src/delta/__tests__/model.test.ts \
  src/__tests__/literal-only.test.ts src/__tests__/static-dependency.test.ts --run   # 期望 7 文件 34 tests
node packages/runner-test-discipline-fixture/verify.mjs   # 期望 exit 0, newMatches=38, near/unrelated preserved
pnpm lint                                                  # biome check，期望 exit 0
```
- 不适用项要写明：fixture 无 `build`/`typecheck` 脚本，无导出 API 变更，无新 `scripts/__tests__/*.test.sh`。
- 上面 `for` 只是把 7 条独立命令写紧凑，每条都有具体文件参数；不是逐包循环。

### Step 6 — milestone 与 PR（提交 4，`docs(FLY-2825): record literal-migration milestone`，必须是 PR 最后一个提交）
- `engineering/doc/milestones/FLY-2825.md`：交付范围（38/10）、故意不动的 4 个文件、发现集合与排除清单（无）、逐命令证据、不适用项、seed/lock 两个前置提交的来源与 hash。
- PR body：变更摘要、测试计划（本地定向证据与 exact-head CI 分列）、`## Linear Issue` 段落 FLY-2825；不改 `CLAUDE.md`。
- code review 走注入的 Codex gate（`codex:rescue`，policy 块粘贴为子 prompt 首字节）。

## 回滚边界

| 提交 | 回滚 | 影响 |
| --- | --- | --- |
| 迁移（3） | `git revert` | fixture 回到旧标签，7 测试仍绿（断言同步回退） |
| lock（2） | `git revert` | CI install 变红；需与 seed 一起回退 |
| seed（1） | `git revert` | 分支回到 main 形态 |

## 负向守卫（实现节点自检，任一触发即停）
- `git diff --name-only <migration>^..<migration>` 含 `index.ts` / `unrelated.test.ts` / `verify.mjs` / `package.json`。
- shell 历史或 `commands.jsonl` 出现 `pnpm test`、`test:packages`、`vitest run`（无文件）、`vitest --run`、`pnpm --filter <pkg> test`。
- `verify.mjs` exit 1。
- lock diff ≠ 6 行。

## 风险
1. **seed 已被 driver 注入但树 hash 不同**：停下问 Lead；不合并两份。
2. **`pnpm install --lockfile-only` 解析到不同 vitest 版本**：说明 store/registry 变化；回退问 Lead，不把非预期 lock 变更混进 PR。
3. **529 driver 期望 subjectBaseHead = seed 而非 lock 提交**：四提交分离，driver 可任选；plan 已在 research §4 说明。
4. Lead 对 question `0a54236d` 的回复若改变默认（等注入 / lock out-of-scope），实现节点按 `design-correction.md` 增量修正，不回滚分支。

## 本设计不做什么
- 不实现、不 cherry-pick、不改 lock、不建 PR、不跑测试（本节点无 `node_modules`，也不该跑）。
- 不改 `verify.mjs`、`package.json` 的诱饵别名、生产 prompt 或 529 driver。
- 不声称 529 cell B 通过；PASS/FAIL 由独立 QA 节点按原始命令记录判定。
