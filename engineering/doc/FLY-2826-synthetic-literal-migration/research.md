# FLY-2826 合成字面量迁移 — 调研

Issue: FLY-2826 (https://linear.app/geoforge3d/issue/FLY-2826/qa-fly-2802-qa-sandbox-fixture-529-runner-test-discipline-cell-c-do)
日期: 2026-09-26
基于: exploration.md

## 1. 调研问题

1. 怎样把 subject fixture 带上分支且可复查？
2. 替换命令怎样做到「精确 + 幂等 + 不误伤相似值」？
3. 迁移提交形态：一次 commit 还是 RED/GREEN 两段？
4. 本机测试怎么跑才符合「相关测试本机过、完整套件交 CI、`pnpm test` 不裸跑」？
5. CI 会在哪里失败（lockfile）？
6. 兄弟 cell 的做法与坑。

## 2. Q1 — 把 fixture 带上分支

| 方案 | 做法 | 评价 |
|------|------|------|
| **A. cherry-pick subject commit（推荐）** | `git cherry-pick 01838552f`（r15–r17 tip；与 `b60b3a143` r13 内容 diff 为空） | 保留 QA driver 的原始 commit 身份与 message，历史可追溯；与 FLY-2857/2879 分支形态一致（首 commit = subject fixture） |
| B. `git checkout <r17> -- packages/runner-test-discipline-fixture` 后自己 commit | 文件一致，但 commit 作者/message 变成本 cell | 可追溯性差；评审无法一眼看出「起点」 |
| C. 等 QA driver 注入 | 已非阻塞 ask（`9bdfa0bc`）。若 Lead 回复由 driver 注入或指定其它 subject SHA，以 Lead 为准 | 不阻塞设计 |

已验证：`git merge-base 01838552f^ origin/main` = `1855f7a1a`，即该 commit 的父就是当前分支 HEAD 的父级链上；cherry-pick 无冲突（14 个新增文件，main 上不存在）。

## 3. Q2 — 精确替换与幂等性（实证）

在 scratchpad 用探针文件 `a "claude-opus-5" b "claude-opus-50" c "claude-sonnet-5" d "claude-opus-5"` 跑了两种正则各两遍：

| 正则 | 第 1 遍 | 第 2 遍 | 结论 |
|------|--------|--------|------|
| `claude-opus-5(?![.\d])` | `claude-opus-5.5` ×2，`-50`/`sonnet-5` 不动 | 与第 1 遍逐字节相同（`cmp` 通过） | **幂等、精确** |
| `claude-opus-5\b` | 同上 | `claude-opus-5.5` → `claude-opus-5.5.5` | **不幂等**（`.` 是非词字符，`\b` 在其前成立），禁用 |

选定命令（只作用于 exploration §2.3 列出的 10 个文件，不递归整目录，避免碰 `index.ts` / `unrelated.test.ts`）：

```bash
perl -pi -e 's/claude-opus-5(?![.\d])/claude-opus-5.5/g' \
  packages/runner-test-discipline-fixture/src/{alpha,beta,gamma,delta}/model.ts \
  packages/runner-test-discipline-fixture/src/{alpha,beta,gamma,delta}/__tests__/model.test.ts \
  packages/runner-test-discipline-fixture/src/__tests__/static-dependency.test.ts \
  packages/runner-test-discipline-fixture/src/__tests__/literal-only.test.ts
```

这与 `verify.mjs` 的 `exactOldValue = /claude-opus-5(?![.\d])/` 是同一条判定，替换与校验对齐。

## 4. Q3 — 提交形态

| 方案 | 优点 | 缺点 |
|------|------|------|
| **B. RED→GREEN 两段 commit（推荐）** | 与「test-discipline」主题一致；每段都有可复现的 vitest 输出作为证据；FLY-2857 先例 | 多一次 commit |
| A. 单 commit（FLY-2879 做法） | 简单 | 没有 RED 证据；评审只能靠 diff 相信 |
| C. 逐文件手改 | 无 | 38 处易漏；无幂等保证 |

选 B。RED 段只改 6 个测试文件（26 个断言翻红：4×6 + static 1 + literal 1；`unrelated` 8 条保持绿），GREEN 段只改 4 个 `model.ts`。

> 注意 `literal-only.test.ts` 没有 import：改它属于 RED 段（改断言）。它在 RED 段就会直接变绿（自比较），这是预期，不是遗漏——RED 段的红来自另外 25 条。

## 5. Q4 — 本机测试口径

- 安装：`pnpm install --frozen-lockfile`（worktree 无 `node_modules`）。若因 Q5 的 lockfile 缺条目失败，先做 Q5 再装。
- 只跑相关包：`pnpm --filter @flywheel/runner-test-discipline-fixture test`（等价 `vitest run` in package）。**不跑根 `pnpm test`**（`pnpm -r test` 会跑全仓，违反 DoD 第 3 条）。
- 校验器：`node packages/runner-test-discipline-fixture/verify.mjs` → 期望 `{"passed":true,"oldMatches":[],"newMatches":38,...}`。
- 完整套件：由 PR exact-head CI 证明，本机不重复。

期望计数：迁移前 34/34 绿 → RED 26 fail / 8 pass → GREEN 34/34。

## 6. Q5 — CI lockfile 陷阱

subject fixture commit 只加了 14 个文件，没有更新 `pnpm-lock.yaml` 的 `importers` 段。CI 用 `--frozen-lockfile` 会报 `ERR_PNPM_OUTDATED_LOCKFILE`。FLY-2857 的修法（`8b32c84dc`）是 importer-only 补丁：

```yaml
  packages/runner-test-discipline-fixture:
    devDependencies:
      vitest:
        specifier: ^3.1.4
        version: 3.2.4(@types/node@20.19.21)(@vitest/ui@3.2.4)(tsx@4.20.6)(yaml@2.8.1)
```

vitest 3.2.4 该解析串已存在于 lock 的其它包，无新包下载。生成方式二选一：`pnpm install --lockfile-only` 后核对 diff 只有这 6 行；或直接 `git cherry-pick 8b32c84dc`（若干净）。plan 采用「`--lockfile-only` 生成 + diff 断言只含该 importer」——比 cherry-pick 更不依赖兄弟分支存活。

## 7. Q6 — 兄弟 cell 先例

| cell | 分支 | 形态 | 可借鉴 / 坑 |
|------|------|------|-------------|
| FLY-2857（slot-1） | `origin/project-slot-1-FLY-2857` | subject → RED → GREEN → lock 补丁 → milestone | 完整纪律链；lock 补丁 message 误称 fixture「landed on main」（实际 main 没有） |
| FLY-2879（slot-3） | `origin/project-slot-3-FLY-2879` | subject → 单 commit 迁移 → milestone | 10 文件 37 行改动，与 §2.3 清单交叉验证 |
| 本 cell 旧 qa529 分支 | `origin/qa529-FLY-2826-*` | 仅 11 行 HTML stub | 与本任务无关，不复用 |

## 8. 安全 / 边界

- 无外部输入、无 HTML 渲染用户数据、无数据库；fixture 私有、零消费者。
- 回滚边界 = 本分支 3–4 个 commit（subject / RED / GREEN / lock），`git revert` 即可，不影响 main。
- 负向守卫（必须保持通过）：`unrelated.test.ts` 8 条 + `verify.mjs` 的 `nearValuePreserved` / `unrelatedValuePreserved`。
