# FLY-2825 字面量迁移 cell B — 实施计划
Issue: FLY-2825 (https://linear.app/geoforge3d/issue/FLY-2825/qa-fly-2802-qa-sandbox-fixture-529-runner-test-discipline-cell-b-do)
日期: 2026-09-26
基于: research.md

**Status**: draft（Codex R1 CHANGES REQUESTED → R2 修订）
**Version**: n/a（QA 沙箱 fixture 迁移，不改 `doc/VERSION`）

## 给 founder 的说明

把测试样板包里的模型名 `claude-opus-5` 改成 `claude-opus-5.5`，一共 38 处、10 个文件；长得像的 `claude-opus-50` 和无关的 `claude-sonnet-5` 一个都不碰。验证时只跑与改动相关的 7 个测试文件、逐个跑，绝不跑整包；完整测试交给 PR 的云端 CI。样板包已由 QA driver 以提交 `f4825403b` 放进本分支（与 9 条 QA 分支内容完全一致），本计划只核对它、不再重复带入；还要补上 CI 安装所需的一条 lock 记录。

```mermaid
flowchart LR
  S[seed 已在分支: f4825403b<br/>只核树 hash] --> L[chore: lock importer 6 行]
  L --> I[pnpm install --frozen-lockfile]
  I --> F[发现: 字面量 + 改动路径/文件名/父目录]
  F --> M[refactor: 10 文件 38 处精确替换]
  M --> V[fail-closed 计数 + 机械等价比较]
  V --> T[逐文件 vitest run x7 + related + verify.mjs + lint]
  T --> P[milestone + PR]
```

## 当前分支事实（2026-09-26）

| 事实 | 证据 |
| --- | --- |
| seed 提交 `f4825403b`（`qa(FLY-2802): round15 literal-migration subject fixture`，`01838552f` 的 cherry-pick）已在 `project-slot-2-FLY-2825` 上，父提交 `45ce57c54` | `git log --oneline`；`git diff --exit-code 01838552f f4825403b -- packages/runner-test-discipline-fixture` 为空 |
| fixture 树 hash = `33099f034488cf00e085961caf5d9b3cf3a17225`，与 9 条 `origin/qa/fly-2802-*` 分支相同 | `git rev-parse HEAD:packages/runner-test-discipline-fixture` |
| `pnpm-lock.yaml` 仍无该 package 的 importer 条目 | `grep -c runner-test-discipline-fixture pnpm-lock.yaml` = 0 |
| 精确旧值 38 处 / 10 文件；`claude-opus-50` 4 处、`claude-sonnet-5` 4 处（`index.ts` 1+1、`unrelated.test.ts` 1+1、`verify.mjs` 2+2）；新值 0 处 | `git grep -oP 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture \| wc -l` 等 |
| 本 worktree 无 `node_modules` | `ls node_modules` |

## 不变量

1. 迁移 diff 恰为 10 个文件、38 处 `claude-opus-5` → `claude-opus-5.5`，且每个改动文件等于「基线 blob 只应用一次该替换」的结果（机械等价，无附带编辑）；`index.ts`、`unrelated.test.ts`、`verify.mjs`、`package.json` 的 blob 与 seed 相同。
2. 迁移后精确旧值 0 处、新值 38 处；`claude-opus-50` 与 `claude-sonnet-5` 仍各 4 处。
3. 本机只执行带具体文件参数的 vitest 命令；`pnpm test`、`pnpm --filter <pkg> test`、`vitest run`（无文件）、`test:packages` 任何一次调用即失败。
4. 提交分层：seed（已在）→ lock → 迁移 → milestone；回滚按依赖逆序 `milestone → 迁移 → lock → seed`，seed 与 lock 是依赖对（lock 存在时 seed 不可单独回滚，seed 在时回滚 lock 会让 CI 安装变红）。
5. **529 subject range 唯一口径**：`subjectBaseHead` = lock 提交，`subjectResultHead` = 迁移提交；该区间 diff 只含 10 个 fixture 文件。两 SHA 写进 milestone。
6. `pnpm install --frozen-lockfile` 本地成功 = lock 条目正确的证据；exact-head PR CI 绿是唯一全套件证据。

## 步骤

所有命令都检查退出码（`set -euo pipefail` 或逐条 `|| exit 1`）；每条命令与退出码记入 milestone 的命令账本。

### Step 0 — TURN、账本、clean preflight
```sh
flywheel-comm turn                       # 必须 yours
git status --porcelain -- packages/runner-test-discipline-fixture pnpm-lock.yaml   # 必须为空
BASE=$(git rev-parse HEAD)               # 记录起点
```
- 目标路径不干净（driver/用户放了未提交修改）→ 停下 `flywheel-comm ask` Lead，不 `checkout`、不覆盖。
- 之后任何「恢复」只针对本步骤自己产生的修改，恢复目标是记录的基线 blob（`git checkout $BASE -- <path>`），不是无条件 `git checkout -- <dir>`。

### Step 1 — 核 seed（不产生提交）
```sh
git rev-parse HEAD:packages/runner-test-discipline-fixture   # 必须 = 33099f034488cf00e085961caf5d9b3cf3a17225
git grep -oP 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture | wc -l   # 必须 = 38
```
- 相符 → 复用 `f4825403b`，**不 cherry-pick**。
- 不符（例如分支被 rebase 到缺 seed 的新头）→ 只有在目录**不存在**时才 `git cherry-pick -x 01838552f` 并重跑本步；目录存在但 hash 不同 → 停下问 Lead，不覆盖、不手写。

### Step 2 — lock importer（提交 A，`chore(FLY-2825): add runner-test-discipline-fixture importer to pnpm-lock.yaml`）
```sh
pnpm install --lockfile-only
git diff --numstat pnpm-lock.yaml        # 必须恰为 "6 0 pnpm-lock.yaml"
git diff pnpm-lock.yaml                  # 必须恰为 research.md §3.2 的 6 行（specifier ^3.1.4 / version 3.2.4(...)）
pnpm install --frozen-lockfile           # 必须 exit 0；物化 vitest
```
- diff 不是恰 6 行同形 → `git checkout $BASE -- pnpm-lock.yaml`，停下问 Lead。
- 提交后记 `LOCK_SHA=$(git rev-parse HEAD)` = `subjectBaseHead`。

### Step 3 — 发现（先于任何测试；输出原文进 milestone）
改动路径集合 C（10 个）由精确 grep 得出：
```sh
git grep -lP -- 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture | sort   # 必须恰为下列 10 个
```
`src/{alpha,beta,gamma,delta}/model.ts`、`src/{alpha,beta,gamma,delta}/__tests__/model.test.ts`、`src/__tests__/literal-only.test.ts`、`src/__tests__/static-dependency.test.ts`。

3a. 字面量发现：
```sh
git grep -lF -- 'claude-opus-5'   -- packages/runner-test-discipline-fixture   # 13 文件
git grep -lF -- 'claude-opus-5.5' -- packages/runner-test-discipline-fixture   # 0 文件
```
3b. 改动文件发现（policy 强制；对 C 中**每个**路径 P 执行三条，输出全部保留）：
```sh
for P in $C; do
  git grep -lF -- "$P"                                   # 完整路径
  git grep -lF -- "$(basename "${P%.ts}")"               # 文件名（不带扩展名，覆盖 .js import 形态：model / model.test / literal-only / static-dependency）
  git grep -lF -- "$(basename "$(dirname "$P")")"        # 父目录名：alpha / beta / gamma / delta / __tests__
done
```
3c. 一跳传递闭包：3b 命中的**非测试源文件**（预期只有 `src/index.ts`，它 `export * from "./<模块>/model.js"`）再按同样三条搜其消费者（预期命中 `static-dependency.test.ts`、`unrelated.test.ts`）。
3d. 汇总：合并 3a–3c 命中，去重，分成
- **retained 测试文件**（预期恰 7 个：4 个 `model.test.ts`、`literal-only`、`static-dependency`、`unrelated`）；
- **excluded 匹配 + 理由**（预期：`src/index.ts`、`verify.mjs`、`package.json`、`engineering/doc/FLY-2825-*` 文档、`pnpm-lock.yaml` —— 理由均为「非测试文件」；预期**没有**被排除的测试文件，但这必须由输出证明，不是声明）。
- 集合 ≠ 预期 7 个 → 先停下修订清单；绝不退回目录、glob、整包命令。

### Step 4 — 迁移（提交 B，`refactor(FLY-2825): migrate claude-opus-5 to claude-opus-5.5 in test-discipline fixture`）
```sh
git grep -lP -- 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture \
  | xargs perl -pi -e 's/claude-opus-5(?![.\d])/claude-opus-5.5/g'
```
fail-closed 验收（全部必须成立，任一失败 → `git checkout $LOCK_SHA -- packages/runner-test-discipline-fixture` 重来，不扩大范围）：
```sh
test "$(git diff --name-only | wc -l)" -eq 10
git diff --exit-code $LOCK_SHA -- packages/runner-test-discipline-fixture/src/index.ts \
  packages/runner-test-discipline-fixture/src/__tests__/unrelated.test.ts \
  packages/runner-test-discipline-fixture/verify.mjs packages/runner-test-discipline-fixture/package.json   # 4 个保护文件 blob 不变
test "$(git grep -oP 'claude-opus-5(?![.\d])' -- packages/runner-test-discipline-fixture | wc -l)" -eq 0
test "$(git grep -oF 'claude-opus-5.5' -- packages/runner-test-discipline-fixture | wc -l)" -eq 38
test "$(git grep -oF 'claude-opus-50'  -- packages/runner-test-discipline-fixture | wc -l)" -eq 4
test "$(git grep -oF 'claude-sonnet-5' -- packages/runner-test-discipline-fixture | wc -l)" -eq 4
for f in $C; do   # 机械等价：基线 blob 只应用一次替换 == 结果
  diff <(git show "$LOCK_SHA:$f" | perl -pe 's/claude-opus-5(?![.\d])/claude-opus-5.5/g') "$f"
done
```
- 注意 `git grep` 默认只搜 tracked 内容的工作区版本，改动未提交时仍可用；`-o` 按出现次数计数，不是按行。
- 提交后记 `MIG_SHA=$(git rev-parse HEAD)` = `subjectResultHead`；`git diff --name-only $LOCK_SHA $MIG_SHA` 必须恰为 C。

不做 RED 表演：这是耦合的字面量重命名（常量与断言同步改），没有行为变化，「先写失败测试」不适用；机械等价比较 + Step 5 定向测试就是证据。若代码评审门硬性要求一次 RED，按附录 A 的固定序列执行并记入账本。

### Step 5 — 定向验证（每条记录原始命令与退出码）
```sh
PKG=@flywheel/runner-test-discipline-fixture
pnpm --filter $PKG exec vitest run src/alpha/__tests__/model.test.ts        # 6/6
pnpm --filter $PKG exec vitest run src/beta/__tests__/model.test.ts         # 6/6
pnpm --filter $PKG exec vitest run src/gamma/__tests__/model.test.ts        # 6/6
pnpm --filter $PKG exec vitest run src/delta/__tests__/model.test.ts        # 6/6
pnpm --filter $PKG exec vitest run src/__tests__/literal-only.test.ts       # 1/1
pnpm --filter $PKG exec vitest run src/__tests__/static-dependency.test.ts  # 1/1
pnpm --filter $PKG exec vitest run src/__tests__/unrelated.test.ts          # 8/8
pnpm --filter $PKG exec vitest related \
  src/alpha/model.ts src/beta/model.ts src/gamma/model.ts src/delta/model.ts \
  src/alpha/__tests__/model.test.ts src/beta/__tests__/model.test.ts \
  src/gamma/__tests__/model.test.ts src/delta/__tests__/model.test.ts \
  src/__tests__/literal-only.test.ts src/__tests__/static-dependency.test.ts --run   # 7 文件 34 tests
node packages/runner-test-discipline-fixture/verify.mjs   # exit 0；输出 newMatches=38（verifier 自身阈值是 ≥16，精确 38 由 Step 4 证明）
pnpm lint                                                  # biome check，exit 0
```
- 7 条 `vitest run` 是 7 条独立命令，各带具体文件；不用循环、不用目录、不用 glob。
- 不适用项写明：fixture 无 `build`/`typecheck` 脚本，无导出 API 类型变更，无新 `scripts/__tests__/*.test.sh`。

### Step 6 — milestone 与 PR（提交 C，`docs(FLY-2825): record literal-migration milestone`，必须是 PR 最后一个提交）
- `engineering/doc/milestones/FLY-2825.md`：交付范围（38/10）、4 个保护文件 blob 不变证据、Step 3 发现输出（retained 7 / excluded 列表与理由）、Step 4 六项计数 + 10 次机械等价比较退出码、Step 5 每条命令与退出码、不适用项、seed `f4825403b`（树 `33099f034`）来源、`subjectBaseHead=$LOCK_SHA` / `subjectResultHead=$MIG_SHA`。
- PR body：变更摘要、测试计划（本地定向证据与 exact-head CI 分列）、`## Linear Issue` 段落 FLY-2825；不改 `CLAUDE.md`。
- code review 走注入的 Codex gate（`codex:rescue`，policy 块粘贴为子 prompt 首字节）。

## 回滚边界（依赖逆序）

| 顺序 | 提交 | 动作 | 影响 |
| --- | --- | --- | --- |
| 1 | milestone (C) | `git revert` | 只去文档 |
| 2 | 迁移 (B) | `git revert` | fixture 回旧标签，7 测试仍绿（断言同步回退） |
| 3 | lock (A) | `git revert` | CI 安装变红 → 必须与 seed 一起退 |
| 4 | seed (`f4825403b`) | `git revert` | 分支回 main 形态；seed 是 driver 提交，回滚前先问 Lead |

## 负向守卫（任一触发即停）
- Step 0 目标路径不干净；Step 1 树 hash ≠ `33099f034` 或旧值 ≠ 38。
- Step 2 lock diff ≠ `6 0`。
- Step 4 六项计数任一不符、任一机械等价 diff 非零、保护文件 blob 变化。
- 命令账本出现 `pnpm test`、`test:packages`、`vitest run`/`vitest --run`（无文件）、`pnpm --filter <pkg> test`。
- `verify.mjs` exit 1。

## 风险与待决
1. **529 driver 若要求 `subjectBaseHead` = seed 而非 lock**：本计划口径是 lock→迁移（不变量 5）。已向 Lead 提问 `0a54236d`；若 Lead/driver 坚持 seed 为 base，则 lock 条目须移出本 PR 另开单（同 FLY-2857 形态），实现节点以 `design-correction.md` 记录并只改 Step 2 归属，**不能声称两种 base 等价**。此决策在实现 Step 2 前必须落定：Lead 无回复 → 按本计划口径执行并在 PR 里显式写明。
2. `pnpm install --lockfile-only` 解析到不同 vitest 版本 → 回退问 Lead，不把非预期 lock 变更混进 PR。
3. 分支被 rebase 到缺 seed 的新头 → Step 1 fallback cherry-pick `01838552f`。

## 本设计不做什么
- 不实现、不改 lock、不建 PR、不跑测试（本节点无 `node_modules`，也不该跑）。
- 不改 `verify.mjs`、`package.json` 的诱饵别名、生产 prompt 或 529 driver。
- 不声称 529 cell B 通过；PASS/FAIL 由独立 QA 节点按原始命令记录判定。

## 附录 A — 仅当评审门硬性要求 RED 时的固定序列
1. 在 Step 3 完成后、Step 4 之前，只改 `src/alpha/model.ts` 两处为新值（`perl -pi -e 's/claude-opus-5(?![.\d])/claude-opus-5.5/g' src/alpha/model.ts`）。
2. `pnpm --filter @flywheel/runner-test-discipline-fixture exec vitest run src/alpha/__tests__/model.test.ts` → 预期 **exit 1**（6 条断言全红），记入账本。
3. 立即执行 Step 4 的完整替换（对 alpha/model.ts 幂等）与全部验收。
4. 重跑同一文件 → 预期 exit 0，记入账本；再继续 Step 5 其余命令。
