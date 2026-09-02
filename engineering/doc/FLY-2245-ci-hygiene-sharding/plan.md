# FLY-2245 CI 卫生与脚本分片 — 实施计划
Issue: FLY-2245 (https://linear.app/geoforge3d/issue/FLY-2245/ci卫生-doc-目录整体-inert-分类-script-tests-22-拆-shard9-1-容量-tripwire)
日期: 2026-09-01
基于: research.md

## 0. 一句话方案

把 `engineering/doc/**` 的非机器消费普通文件改为目录级 inert（不再看扩展名），先将 sweep 找出的 5 个重车道机器输入补入精确 fence；再把现有两条 Script Tests 拆成四条 required shard：原 shard 1 移出 FLY-1364、原 shard 2 按 FLY-1330/FLY-2139 边界连续二分、FLY-1364 独占第四片；保留 20min cap 与 FLY-1870 85% tripwire，最终用 PR CI 证明四片各自 elapsed ≤714s。

## 1. 锁定范围与不变量

### 1.1 必须实现

1. `engineering/doc/**` 下的普通文件（含 100755、无扩展名、`.sh/.py/.js/.json` 等）不再仅因扩展名触发重 job。
2. 现有 `known_ci_consumed_doc_paths` 精确例外和 consumer sweep 找出的 5 条新增路径继续触发重 job；`doc/`、`product/doc/`、`content/doc/` 继续使用现有扩展名白名单。
3. Script Tests 变为四片，当前 HEAD 的 76 个测试 step 命令内容不变且恰好归属一片。
4. 四片都保留相同 setup、20min timeout、首步计时和末步 85% tripwire。
5. `ci-ok` 必须等待四片；只有 classifier 明确输出 `no_code=true` 时才允许四片 skipped。
6. PR CI 四片每片 ≤714s（1020s tripwire 预算的 70%）。

### 1.2 明确不做

- 不提高 timeout 或 tripwire 阈值，不改 `ci-job-elapsed-tripwire.sh` 行为/文案；
- 不删、缩短、条件化任何现有 suite，不给 step 加 `if`/`continue-on-error`；
- 不把 FLY-2045 或其他 always-on 轻检查移出 `quick-gate`；
- 不改变 unit-test matrix、payload-distribution 或 classifier 的 merge-base/Git fail-closed 语义；
- 不改 `CLAUDE.md`，不 dispatch QA，不 merge/deploy。

## 2. 测试 seam 确认

本计划的设计评审即以下 seam 的确认门；评审 APPROVED 前不写行为测试：

1. **Classifier public seam**：在真实临时 Git repo 中，以 `HEAD_SHA`、`BASE_SHA`、`GITHUB_OUTPUT` 调 `scripts/ci-classify.sh`，只观察 exit code、`no_code` 和 fail-closed reason。
2. **Workflow public seam**：`ci-structure.test.sh` 与 `fly-889-ci-workflow-timeout-guard.test.ts` 解析真实 `.github/workflows/ci.yml`，观察 job graph、inventory、setup、tripwire、timeout 与 aggregate contract；不测 YAML 私有行号。
3. **Capacity public seam**：GitHub Actions 四个 job 的真实 started/completed timestamps 与 tripwire elapsed；静态投影不是验收证据。

## 3. 文件级变更

### 3.1 `scripts/__tests__/ci-classify.test.sh`（先 RED）

将现有 `engineering/doc/excluded-*.{json,tsv,yaml}` 负例替换为目录级 inert 正例矩阵：

- `engineering/doc/.../measure.sh`
- `engineering/doc/.../reqstats.py`
- `engineering/doc/.../tools-list.js`
- `engineering/doc/.../cfg/config.json`
- `engineering/doc/.../config.yaml`
- `engineering/doc/.../snapshot`（无扩展名）
- 至少一个通过 `chmod +x` + Git mode 100755 的脚本

每个向量必须得到 `no_code=true`。同轮保留/新增负向控制：

- 相同扩展名放在 `scripts/` 或 `evidence/` → `diff_not_inert`；
- `product/doc/**/*.js` 与 `doc/VERSION` → `diff_not_inert`；
- 现有 `known_ci_consumed_doc_paths` 全部 → `no_code=false`；
- 新增 5 条机器消费路径逐条 → `no_code=false`：FLY-1458 `design_compare.py`、FLY-1278 fixture JSON、FLY-2030 assignment JSON、FLY-2054 `capture.mjs`、FLY-1269 pane identity MJS；
- `engineering/doc/**` symlink/gitlink → `diff_not_inert`；
- code→doc rename、混合 diff、Git 输入异常等现有向量不动。

RED 命令：

```bash
bash scripts/__tests__/ci-classify.test.sh
```

预期只在新目录级 inert 正例上失败，证明尺子会响。

### 3.2 `scripts/ci-classify.sh`（classifier GREEN）

最小修改 embedded Python 的路径判定：

```python
is_engineering_doc = path.startswith(b"engineering/doc/")
is_suffix_allowlisted_doc = (
    path.startswith(allowed_prefixes) and path.endswith(allowed_suffixes)
)
if (
    not header.startswith(b":")
    or path in known_ci_consumed_doc_paths
    or not (is_engineering_doc or is_suffix_allowlisted_doc)
):
    raise SystemExit(1)
```

mode 解析与 120000/160000 拒绝保持原位，所以“任意扩展名”只扩普通文件，不扩 symlink/gitlink。`allowed_prefixes`、`allowed_suffixes` 不删，其他三个文档前缀行为不变。`known_ci_consumed_doc_paths` 在现有 tuple 后追加以下 5 条，不改为目录前缀：

```text
engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/scripts/design_compare.py
engineering/doc/FLY-1278-review-gate-convergence/fixtures/fly-1251-rounds-6-9.json
engineering/doc/FLY-2030-raya-brain-inquiry/summary-role-assignments.json
engineering/doc/FLY-2054-dashboard-visual-alignment/evidence/capture.mjs
engineering/doc/FLY-1269-codex-phase-keepalive/qa/target7-pane-identity.mjs
```

GREEN 后追加：

```bash
bash scripts/__tests__/ci-classify.test.sh
bash scripts/__tests__/ci-structure.test.sh
```

### 3.3 `scripts/__tests__/ci-structure.test.sh`（先 RED）

先把结构守卫改成目标态：

- job ids/order 增 `script-tests-3`、`script-tests-4`，位置在 `script-tests-2` 后、`payload-distribution` 前；
- 四片都只 `needs: [classify]` 且沿用同一 `if`；
- `ci-ok.needs` 和 aggregate jq 的 heavy-job list 纳入四片；
- timeout floor、setup prefix、helper、record-start、tripwire、bash path、无条件/无 swallow 检查遍历四片；
- `fly2074_in_shards`、`fly2045_in_shards`、ci-structure 自身归属和 required-command exactly-once 扫描覆盖四片 union；
- exact inventory 改为四片，当前 76 个 test step name union 无缺失/重复。
- `expected_known_ci_consumed_doc_paths` 同步新增上面 5 条；FLY-1278 `artifactPaths` parity 推导移除 suffix 过滤，使 fixture JSON 也进入 exact consumer/fence parity；保留 tracked-path 和 tuple mutation controls。
- checkout 形状钉死：只允许含 FLY-2007 的 `script-tests` 使用 `fetch-depth: 0`；`script-tests-2/3/4` 必须为默认 shallow checkout。

精确 inventory 边界：

| job id | name | tests |
|---|---|---:|
| `script-tests` | `Script Tests 1/4 — session/lifecycle (shell suites)` | 原 1/2 除 `Test — FLY-1364 cmux sync repair` 外的 19 个，原相对顺序不变 |
| `script-tests-2` | `Script Tests 2/4 — fleet/setup/packaging A (shell suites)` | 原 2/2 从 `Test — FLY-1905 CI apt-install helper` 到 `Test — FLY-1330 log janitor`（含），25 个 |
| `script-tests-3` | `Script Tests 3/4 — fleet/setup/packaging B (shell suites)` | 原 2/2 从 `Test — FLY-2139 database maintenance` 到 `Test — FLY-1870 job elapsed tripwire contract`（含），31 个 |
| `script-tests-4` | `Script Tests 4/4 — cmux repair (shell suites)` | 仅 `Test — FLY-1364 cmux sync repair`，1 个，保留原 env 与 run 全文 |

现有对 FLY-1364、FLY-1715、FLY-1814、FLY-1830 等特定 step 的内容级守卫改为从四片 union 定位，并继续要求 exactly-once；不得因搬家删除断言。

### 3.4 `packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts`（同一 RED）

- `scriptShardIds` 扩为四个 job id；
- timeout floor 覆盖四片且保持 20；
- helper contract 自动遍历四片；
- `CI OK requires all script shards` 断言覆盖四片。

RED 命令（workflow 尚未改）：

```bash
bash scripts/__tests__/ci-structure.test.sh
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts
```

两个守卫都必须因缺 `script-tests-3/4` 或 inventory 不符而失败。

### 3.5 `.github/workflows/ci.yml`（shards GREEN）

1. 把前两片显示名改为 1/4、2/4，并更新容量注释为 2026-09-01 六轮数据与 research/plan 指针。
2. 从 `script-tests` 整体剪切 FLY-1364 step（含注释/env/run）到新 `script-tests-4`。
3. 在原 `script-tests-2` 的 FLY-1330 step 后切断；后续从 FLY-2139 起的完整 step 整体剪切到 `script-tests-3`。
4. `script-tests-3/4` 复制既有 setup prefix 和末尾 tripwire；只有仍含 FLY-2007 历史 freeze commit 检查的 `script-tests` 保留 `fetch-depth: 0`，`script-tests-2/3/4` 使用默认 shallow checkout。
5. 四片 `timeout-minutes: 20`、首步 start-file、helper timeout/packages、末步 tripwire argv 完全一致。
6. `ci-ok.needs` 与 jq heavy list 加新两片。

GREEN 命令：

```bash
bash scripts/__tests__/ci-structure.test.sh
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts
```

## 4. 回归验证

聚焦 CI 契约：

```bash
bash scripts/__tests__/ci-classify.test.sh
bash scripts/__tests__/ci-structure.test.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
bash scripts/__tests__/ci-job-elapsed-tripwire.test.sh
bash scripts/__tests__/ci-matrix-coverage.test.sh
bash scripts/__tests__/test-worktree-removal-contract.test.sh
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts
```

全仓 exact gates：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

本单不新增 `scripts/__tests__/*.test.sh`，所以没有额外的新 shell 文件；修改的两个 shell 套件必须如上单独实跑。不得在作者机上串行跑所有已登记 Script Tests，它们包含真实 tmux/process 等重套件；完整 76-step 回归由 PR CI 四片执行。

## 5. 容量验收与重平衡规则

PR CI 首个完整 run 后，通过 GitHub Actions jobs API 记录四片 started/completed timestamps 和每片 tripwire elapsed：

- 通过条件：四片分别 `≤714s`；
- 普通多-step 片超线：从该片向最低片移动**完整 named step**，同步 structure inventory 后开新 CI run；
- FLY-1364 独占片超线：不得假装它可“移动一个完整 step”解决；新增 `script-tests-5`，把其 22 条命令在第一条 `tmux-server-rescue.test.sh` 前切成两个 named step。前 11 条（`test-cmux-sync.sh` 到 `fly1884-node-presence.test.sh`）留在 4/5，后 11 条（`tmux-server-rescue.test.sh` 到 `restart-cmux-watcher.test.sh`）进 5/5；两片保留同一 env、默认 shallow checkout、setup/cap/tripwire。structure guard 改为断言两个有序命令组拼接后与原 22 条完全相等且每条只出现一次。六轮里完整 22 条最大 484s，因此任一真子集加 149s 公共开销的保守上界仍 ≤633s；
- 禁止提高 20min cap、85% 阈值，禁止修改 suite 内等待或用条件跳过；
- classifier 验收另看同一 PR 的 changed-files：本 PR 含 CI 代码所以会跑重 job；分类行为由 hermetic Git fixture 证明，后续可由纯 `engineering/doc` 工件 PR 观察四片 skipped。

容量投影（仅规划依据）：四片 624/605/626/633s，均低于 714s；真机结果才是完成证据。

## 6. 提交、评审与 PR 顺序

1. classifier RED 测试提交 → minimal GREEN 提交；
2. shard RED 守卫提交 → workflow GREEN 提交；
3. 完成聚焦回归和三条全仓 gate；
4. 新建 `engineering/doc/milestones/FLY-2245.md`，使其成为当时 literal last commit；不改 `CLAUDE.md`；
5. push feature branch、开 PR；
6. 通过 `codex:rescue` 做独立只读 code review，并按 runner contract 注册新的 `review_code` gate/request；CHANGES_REQUESTED 每轮修复、复测、重新提交 milestone 为最后 commit、push，再开新 gate；
7. APPROVED 后不再改 head，等待/读取该 exact head 的 PR CI，记录四片 ≤714s；advisories 通过 `ask --report` 转给 Lead；
8. 用 `ask --report` 汇报 commits、PR、测试和容量证据，执行 `complete --route needs_review --pr <NUMBER>`；不请求 ship、不 merge。

## 7. 验收映射

| issue 验收 | 权威证据 |
|---|---|
| 纯文档形 PR（含 doc 内脚本工件）不触发重 shell 套件 | `ci-classify.test.sh` 真实 Git fixture 的 `.sh/.py/.js/.json/extensionless/100755` 正例；known consumer/目录外/symlink/gitlink 负例；`ci-structure` 证明 heavy jobs 只由 `no_code` 控制、quick-gate 仍 always-on |
| Script Tests 各 shard ≤70% 预算 | Lead 确认 1020s 分母；exact PR head 的四个 GitHub Actions job/tripwire elapsed 均 ≤714s |
| FLY-1870 tripwire 保护语义不变 | 四片 structure + teamlead guard：20min timeout、首步计时、末步 always、85%、无 now override/continue-on-error；原 tripwire contract 套件全绿 |
| 测试覆盖不丢失 | structure exact inventory 76=19+25+31+1、union 无重复、required commands exactly-once、CI 四片全部完成 |

## 8. 风险与回滚

- **公共 setup 增量**：两片变四片会多付两份 checkout/install/build，增加 runner-minutes；这是达到严格 714s 的必要成本，墙钟和 tripwire 风险下降。回滚为 revert shard commit，但会恢复已知容量故障。
- **目录规则过宽**：仅对 `engineering/doc/**` 普通文件放宽；402 条非白名单 tracked path 的完整路径 + 唯一尾部路径反搜已找出 5 个重车道机器输入并补入精确 fence，always-on 的 FLY-1987/2074 不需 fence；其他 doc 前缀后缀表和 mode/Git fail-closed 保留，负例钉死。
- **GitHub VM 方差**：模型已用六轮逐 step 最大值 + 149s 最大公共开销，仍以 PR 真机为准；若失败只重平衡完整 step。
- **workflow 手工搬家漏项**：RED 守卫先钉四片 exact inventory，shell enumeration 和 teamlead guard 形成独立冗余；不靠目测。
