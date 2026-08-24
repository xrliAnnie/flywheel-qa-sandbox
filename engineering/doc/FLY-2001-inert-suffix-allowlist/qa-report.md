# FLY-2001 惰性后缀白名单补齐 — 独立 QA 报告

Issue: FLY-2001 (https://linear.app/geoforge3d/issue/FLY-2001/ci省钱-classify-惰性后缀白名单补齐纯数据媒体后缀不触发全量fly-1987-p0-族founder-立单一行改动可回滚)
日期: 2026-08-23
基于: plan.md

## 0. 判决

**PASS** — 被验 head `a600aec26b3f623879695f32e91e3181cf0d0590`（PR #936，非 draft，MERGEABLE；
本地 HEAD = `origin/flywheel-FLY-2001` = `gh pr view` headRefOid，三源一致，验证开始与结束各核一次）。

## 1. 被验对象与用户

- 产品代码改动**只有** `scripts/ci-classify.sh`（+13 个后缀字面量，+17 条 exact non-inert 路径围栏），
  其余为两个 shell 测试文件与文档。零 `packages/` 改动。
- 真实用户 = 每一个开 PR 的人 + 付账单的 founder。产品问题不是「脚本返回值对不对」，而是：
  **该走快车道的走了没有；不该走的有没有被误放行、把本该跑的验证悄悄跳掉。**
- 快车道 = `no_code=true` 时被 `if:` 跳过的四个 job：`unit-tests`（5 个 shard）、
  `script-tests` 1/2、`script-tests-2` 2/2、`payload-distribution`。
  `classify`、`quick-gate`、`ci-ok` 永远运行（实测见 §5）。

## 2. 我自己的验证台架（不复用实现方的 harness）

`scratchpad/qa-harness.sh`：每个用例现造一个真 git 仓库、真提交、真调用被测脚本、
读真 `GITHUB_OUTPUT` 文件。与实现方的 `ci-classify.test.sh` 无共享代码。

### 2.1 阳性对照（该走快车道的走了）

4 个 doc 前缀 × 13 个新后缀 = **52/52 `no_code=true`**。
再加 13 个新后缀同提交混改 = `true`；新后缀 + 旧后缀混改 = `true`。

### 2.2 阴性对照（白名单外零影响）

| 组 | 用例数 | 结果 |
|---|---|---|
| 13 个新后缀落在 doc 前缀**外**（`packages/`、`docs/`、`mydoc/`） | 39 | 全 `false` |
| doc 前缀内的**未获批**后缀（`.json .yaml .yml .tsv .sh .ts .js .mjs .py .xml .toml .env .sql .patch .diff .bin .zip`） | 17 | 全 `false` |
| 无扩展名 / 目录名伪装 / 双扩展名（`Makefile`、`README`、`.txt/inner.sh`、`a.txt.sh`） | 4 | 全 `false` |
| 原有 13 个后缀回归 + 根文件 + workflow 文件 | 15 | 与改前逐项一致 |
| 边界（大小写 `.MP4/.TXT/.Log`、`documentation/`、`docs/`、`.github/doc/`） | 6 | 全 `false`（大小写敏感 ⇒ 向 fail-closed 方向） |

合计 **131/131 通过**（另 12 项边界单跑 12/12）。

### 2.3 改前 / 改后铁证（同一把尺子，只换被测脚本）

同一套用例分别喂给 `origin/main:scripts/ci-classify.sh` 与本分支脚本：

- **改前**：`FAIL=55`（52 个新后缀阳性 + `a.sh.txt` + 2 个混改全部被 fail-closed）
- **改后**：`FAIL=0`
- **两次完全相同的 76 个阴性/回归用例在改前改后逐项一致** ⇒ 「白名单外零影响」是实测出来的，不是推断。

## 3. 真正的产品风险：新后缀会不会让「本该跑的验证」被跳过

新后缀让 326 个已跟踪 doc 文件第一次具备走快车道的资格。若其中任何一个被某个
**位于被跳过 lane 的测试**读取，改它就等于静默丢掉验证。实现方用 17 条 exact 路径围栏挡这条洞；
我独立复核了围栏的**有效性**与**完整性**。

### 3.1 围栏有效性（改前 / 改后）

17 条围栏路径逐条单改：

- **改前**：16/16 被判 `no_code=true`（第 17 条因我的取数少了行尾换行漏跑，补跑后同样 `true`）
  ⇒ 这是 FLY-1877 遗留的**真实既有洞**，本 PR 顺手补上了。
- **改后**：17/17 `no_code=false`；「围栏路径 + 惰性 `.txt`」混改也 `false`。

### 3.2 围栏完整性（我自己的三模态 sweep）

1. **新后缀清单**：`git ls-files` 四前缀 + 13 后缀 = **326 个**已跟踪文件
   （txt 226 / log 45 / jsonl 34 / wav 8 / csv 8 / mp3 5）。
2. **全路径字面量**：这 326 条路径在 `packages/ scripts/ .github/` 全文检索 → **0 命中**。
3. **CI 实际调用的脚本**：从 `ci.yml` 提取 180 个被 `bash/node/node --test` 调用的脚本，
   整体检索 doc 前缀 + 26 个白名单后缀 → 41 条路径字面量，其中 30 条对应真实已跟踪文件。
   逐条定性后**没有一条是漏网消费者**：
   - 17 条 = 围栏本身；
   - 9 条 `product/doc/FLY-1846-.../*` = `ci-classify.test.sh` 内的 PR #874 合成 fixture；
   - 4 条（`w4a-tmux-hook-empirical-test.md`、`FLY-1323 ci-activation-design.md`、
     `FLY-1870 plan.md`、`FLY-259 runbook.md` 等）= 注释里的出处引用，非读取。
4. **变量拼接形**：对 180 个 CI 脚本检索「变量赋值里含 doc 目录」→ 7 处，全部有解释：
   `derive-lib.mjs`（`.mjs`，永不进白名单）、`doc/VERSION`（无扩展名，永不进白名单）、
   `design_compare.py`（`.py`）、3 条已在围栏内、1 条是 `test-restart-services.sh` 里的合成字符串
   （引用的文件根本没被跟踪）。
5. **TS/JS 动态拼接**：`docRoot` / 相对回溯 (`../../../../../engineering/doc/...`) 检索命中
   `review-governance-docs.test.ts`（9 个 artifact：8 个 `.md` 全在围栏内，第 9 个是 `.json`，
   非白名单后缀 ⇒ 本来就走全量，正确地不入围栏）、`review-request-coordinator.test.ts` /
   `review-verdict-policy.test.ts`（同一 `.json`）、`target7-pane-identity.test.ts`
   （import 一个 `.mjs`）。**无遗漏**。

**结论**：在我能静态到达的三个模态里，围栏没有缺口；新增的 13 个后缀没有引入任何新的
「验证被静默跳过」路径。诚实边界见 §6。

## 4. 检查器本身是不是真检查器（我自己出的一轮突变）

在 scratchpad 的独立 clone（同 head）里做 11 个突变，每个都声明「该红哪一项」，跑完立刻还原并核 `git status` 为空：

| # | 突变 | 期望 | 实测 |
|---|---|---|---|
| M1 | 生产 tuple 删掉 `.srt` | always-on guard 红 | ✅ `missing=[b'.srt']` |
| M2 | 篡改一条围栏路径 | always-on guard 红 | ✅ 精确 missing/unexpected |
| M3 | 生产 tuple 混进未获批的 `.tsv` | always-on guard 红 | ✅ `unexpected=[b'.tsv']` |
| M4 | 删掉一条围栏 | always-on guard 红 | ✅ 精确 missing |
| M5 | FLY-1987 台账 `SUFFIX_P0_ADDS` 掉 `.vtt` | 三方 parity 红 | ✅ |
| M6 | `review-governance-docs.test.ts` 多一个 artifact | consumer/fence parity 红 | ✅ |
| M7 | `fly1135-doc-sentinel.test.ts` 数组多一项 | consumer/fence parity 红 | ✅ |
| M8 | `git mv` 一个围栏文件 | Git-index liveness 红 | ✅ `must remain tracked` |
| M9 | 改掉 FLY-1135 consumer 的**代码形状** | fail-loud 提示重新推导 | ✅ 报 `consumer list shape changed` |
| M10 | 生产只回退 13 个后缀（保留围栏） | 行为 suite 红 | ✅ 14 失败（含 PR #874 回放） |
| M11 | 生产只删围栏（保留后缀） | 行为 suite 红 | ✅ 18 失败（17 围栏 + 混改） |

11/11 按预期变红，报错都点名具体差异 ⇒ 这两个 suite 不是空过绿。

**观察（非缺陷）**：M10 只让实现方的行为 suite 出 14 个失败，而我的矩阵出 55 个 ——
他们每个新后缀只测一个前缀，我测 4×13 全矩阵。覆盖差异不影响判决，仅供 follow-up 参考。

## 5. 真机 / 真 CI 证据

- **exact head `a600aec26` 的生产 GitHub Actions 全绿 11/11**：
  `Classify CI scope` pass 14s、`Quick Gate (build+typecheck+lint)` pass 3m4s、
  `Unit (teamlead 1..3 / heavy / light)` 全 pass、`Script Tests 1/2` pass 16m22s、
  `Script Tests 2/2` pass 13m13s、`NPM payload distribution` pass 53s、`CI OK` pass。
  → 这同时是**真 CI 上的阴性对照**：本 PR 自己改了 `scripts/`，classify 正确判 `no_code=false`，
  四个重 lane 一个没跳。
- **本地 focused suite（被验 head）**：`ci-classify.test.sh` **123 passed / 0 failed**（45s）；
  `ci-structure.test.sh` **PASS**。
- **lane 归属实测**（解析 `ci.yml` job 图）：`ci-structure.test.sh` 在 `quick-gate` = **always-on**
  ⇒ 白名单/围栏/parity/liveness 漂移在任何 PR（含快车道 PR）都会被抓；
  `ci-classify.test.sh` 在 `script-tests-2` = 被门控，但改 classifier 必然触发全量，无缺口。
- **零污染**：全部台架在 scratchpad 的一次性 clone 与 `mktemp` 仓库里跑；生产 worktree 未被改动
  （每轮突变后 `git status --porcelain` 实测为 0 行）。

## 6. 诚实边界（未测 / 测不到的部分）

1. **529 房真 Discord N-to-N：不适用。** 本 PR diff 完全不触碰 Discord send/relay/render/
   founder 交互/roundtable/跨 Lead 协作的任何代码面（改动只在 `scripts/ci-classify.sh` 与
   两个 shell 测试）。**无 N-to-N surface — 已用真 GitHub Actions（生产 CI，11/11）+ 独立
   真 git 仓库台架（131 + 12 + 17 用例）+ 11 个突变对照替代验证**，不是跳过。
2. **快车道在真 GitHub Actions 上的端到端阳性对照没跑。** 要跑就得推一个牺牲性的
   docs-only PR。本 PR **未改动** `ci.yml` 的 job 图 / `if:` / `CI OK` 聚合逻辑，
   `no_code=true` 那条腿是 FLY-1877 已在生产跑了几个月的既有路径；风险因此评为低，
   但「新后缀在真 Actions 上确实让四个 lane 变 skipped 且 `CI OK` 仍绿」这句话，
   我只能靠逻辑推断，不能靠实测背书。建议合入后第一个碰到新后缀的 docs-only PR 顺手确认一次。
3. **围栏完整性只覆盖静态可解析的三个模态。** 目录与文件名**两端都是变量**的完全动态拼接
   （`"$dir/$name.$ext"`）我静态查不到，实现方也查不到。缓解：两组 consumer parity +
   Git-index liveness 是 always-on 的活体 tripwire，且这条残余风险**在本 PR 之前就存在**
   （FLY-1877 的 `.md` 面），本 PR 反而净减少了 16 个已知洞。
4. **省钱额度：0，如实标注。** FLY-1987 现行观测窗口的 P0 样本为 0，本报告不从本 PR 推算任何金额。
5. **全仓 `pnpm lint` / `pnpm -r build` / `pnpm test:packages:run` 我没有在本机重跑。**
   理由是 diff 零 `packages/` 改动，且 exact head 的**无沙箱生产 CI 已经把这三样跑绿**
   （Quick Gate + 5 个 Unit shard + 2 个 Script shard）。本机跑反而会引入已知的
   Terminal.app / npm-cache 宿主噪声。这是取证选择，不是漏跑。
6. **可回滚性**：删掉 13 个后缀字面量 + 17 条围栏即回到改前行为；无 schema、无状态、无部署动作。
   我未执行任何部署、重启、生产 DB 写入或 merge。

## 7. 证据文件

- 台架与用例：`scratchpad/qa-harness.sh`、`run-controls.sh`、`run-fence.sh`、`run-edge.sh`
- 突变 clone：`scratchpad/mutrepo`（同 head `a600aec26`，每轮突变后已还原至干净）
- 真 CI：`gh pr checks 936` → https://github.com/xrliAnnie/flywheel/actions/runs/32672695373
