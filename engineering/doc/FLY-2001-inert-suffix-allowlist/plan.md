# FLY-2001 惰性后缀白名单补齐 — 实施计划
Issue: FLY-2001 (https://linear.app/geoforge3d/issue/FLY-2001/ci省钱-classify-惰性后缀白名单补齐纯数据媒体后缀不触发全量fly-1987-p0-族founder-立单一行改动可回滚)
日期: 2026-08-23
基于: research.md

## 1. 目标、非目标与安全边界

目标是让四个 doc 前缀中的 13 类惰性纯数据/媒体文件进入既有快车道，同时用 17 条精确
non-inert 路径围栏防止新后缀放大已核实的 mixed-diff 漏洞。

非目标：

- 不改 `.github/workflows/ci.yml` 的 job 图、`needs`、`if` 或 `CI OK` 聚合；
- 不复活 FLY-1996，不做预测性的 doc consumer 治理；17 条 sweep-verified 围栏是本单自身正确性范围；
- 不加入 FLY-1987 清单外的 `.json`、`.tsv`、`.yaml` 或可执行类型；
- 不量化或承诺省钱额，FLY-1987 现行窗口的 P0 样本为 0；
- 不部署、不重启服务、不请求 ship 或 merge。

R1 已纠正初稿两点：inventory 必须用 `git ls-files` 才不会漏掉 45 个 tracked `.log`；新后缀
consumer sweep 干净仍不能证明 whole-diff 安全。R2/R3/R4 分别补齐 full-path、directory-base /
shell-variable 与 segment-joined forms，将 current-suffix consumer 集合补齐到 17 条；Lead 已
选择并授权 exact-17 + 两组 parity。实现须通过新的 request-driven design review。

## 2. 变更文件

| 文件 | 变更 |
|---|---|
| `scripts/__tests__/ci-classify.test.sh` | 新增逐后缀矩阵、excluded suffix 阴性、17 条围栏 RED、mixed diff 与 PR #874 回放 |
| `scripts/__tests__/ci-structure.test.sh` | always-on 精确断言 prefix/suffix/non-inert tuple |
| `scripts/ci-classify.sh` | 追加 13 个后缀；新增 17 条 exact non-inert paths 与拒绝条件 |
| `engineering/doc/FLY-1987-actions-cost-audit/plan.md` | 加 dated ledger note，说明本单落地后的 baseline 语义，避免重复计省 |
| `engineering/doc/FLY-2001-inert-suffix-allowlist/` | exploration/research/plan/progress 与验证证据 |

FLY-1987 的 `SUFFIX_P0_ADDS` 保持不变，它是本单权威历史清单；dated note 只解释本单落地后
`SUFFIX_CURRENT` 仍代表 pre-FLY-2001 historical baseline。

## 3. TDD 实施步骤

### 3.1 RED — 先扩 behavioral 与 always-on contracts

在 `ci-classify.test.sh`：

1. `existing_allowed_suffixes` 保留当前 13 项；`new_allowed_suffixes` 精确列出新增 13 项；
2. 全部新增项分别做 doc-prefix 内 `true` 与 prefix 外 `false`；
3. `.json`、`.tsv`、`.yaml` 分别位于 doc prefix 内，断言 `false diff_not_inert`；
4. 以下 17 条路径分别单改并断言 `false diff_not_inert`：
   - `doc/engineer/implementation/FLY-222-a0-a10-runbook.md`
   - `doc/qa/framework/529-room-playbook.md`
   - `engineering/doc/FLY-1775-529-generalized-dag-room/plan.md`
   - `engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md`
   - `engineering/doc/FLY-1648-hot-loop-closeout/runbook.md`
   - `doc/engineer/implementation/flag-authoring-runbook.md`
   - `engineering/doc/FLY-1278-review-gate-convergence/exploration.md`
   - `engineering/doc/FLY-1278-review-gate-convergence/research.md`
   - `engineering/doc/FLY-1278-review-gate-convergence/plan.md`
   - `engineering/doc/FLY-1278-review-gate-convergence/progress.md`
   - `engineering/doc/FLY-1278-review-gate-convergence/fixtures/README.md`
   - `engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round1.md`
   - `engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round2.md`
   - `engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round3.md`
   - `engineering/doc/FLY-1135-layer1-dag-templates/exploration.md`
   - `engineering/doc/FLY-1135-layer1-dag-templates/research.md`
   - `engineering/doc/FLY-1135-layer1-dag-templates/plan.md`
5. 创建“第一条 known-consumed `.md` + `engineering/doc/evidence.txt`”的 mixed diff，断言 `false`；
6. 用 research.md §4 的 PR #874 九路径创建单一提交，断言 `true`。

在 `ci-structure.test.sh`：

1. 从 `<<'PY'` heredoc 提取 embedded Python，用 `ast.parse` 找到且只找到三个 named assignment，
   再以 `ast.literal_eval` 求值；marker 缺失、parse 失败、assignment 缺失/重复或非 literal tuple
   都以 `could not extract <name>: <reason>` fail-loud；
2. 精确断言四个前缀、现有加新增的 26 个后缀和 17 条 non-inert path；
3. 对 17 条 path 逐项执行 `git ls-files --error-unmatch -- <path>`，rename/delete 当次 PR 即失败；
4. fail-loud 提取 `review-governance-docs.test.ts` module-scope named `artifactPaths` array，把 docRoot 前缀与
   allowlisted relative paths 组合后，精确断言等于 17 条 fence 中的 FLY-1278 八项；consumer
   增删/改名会在同一 PR 的 always-on lane 失败；
5. 以不同的稳定形状提取 FLY-1135：锚定 `for (const doc of ["exploration.md", ...])` 的 inline
   array literal，精确断言等于 17 条 fence 中的 FLY-1135 三项；找不到 source shape 时 fail-loud
   提示 `consumer list shape changed — re-derive FLY-1278/FLY-1135 fence entries and update
   known_ci_consumed_doc_paths`。两组 source-shape coupling 是有意 tripwire；合法 consumer refactor
   也必须重新推导 fence；
6. 以删一个 suffix、改一个 fence path 的 mutated source 作为 positive control，断言比较器分别
   报出 exact missing/unexpected delta，防止 extraction ruler 自身退化。

它属于 always-on quick-gate，防止 behavior suite 被 classifier 自己跳过后失去 allowlist 或
fence 漂移报警。

运行：

```bash
bash scripts/__tests__/ci-classify.test.sh
bash scripts/__tests__/ci-structure.test.sh
```

预期 RED：behavioral suite 中 13 个新后缀阳性、PR #874 回放及 17 条 direct-path 围栏共 31 项
失败；mixed diff 在实现前由 `.txt` 继续 fail-closed，excluded suffix 阴性也保持通过。
structure suite 因 production 尚无新 suffix/path tuple 而失败。保存精确汇总与失败名。

### 3.2 GREEN-A — 先只加 suffix，证明 mixed ruler 会变红

在 `scripts/ci-classify.sh`：

1. 向 `allowed_suffixes` 追加：

   ```text
   .txt .csv .log .out .jsonl .wav .mp3 .m4a .ogg .mp4 .webm .vtt .srt
   ```

暂不加 fence，单独运行 behavioral suite。预期：13 个 suffix 与 PR #874 转绿；17 条 direct
path 仍红；原先由 `.txt` fail-closed 的 mixed test 也转红。这一步是 mixed ruler 的正向对照，
证明最终绿色来自 fence，而不是测试真空通过。保存汇总与失败名，不提交这个不安全中间态。

### 3.3 GREEN-B — 加 17 条 exact fence

1. 定义 exact bytes tuple `known_ci_consumed_doc_paths`，只含 §3.1 17 条；
2. raw diff 的每个 path 若命中该 tuple，和 prefix/suffix/mode 违规一样退出非零，由外层
   `fail_closed "diff_not_inert"` 输出 `no_code=false`。

不改 `allowed_prefixes`、raw diff 解析、mode guard、merge-base guard 或错误语义。

再次运行：

```bash
bash -n scripts/ci-classify.sh scripts/__tests__/ci-classify.test.sh scripts/__tests__/ci-structure.test.sh
bash scripts/__tests__/ci-classify.test.sh
bash scripts/__tests__/ci-structure.test.sh
```

期望全部通过。

### 3.4 REFACTOR — 只做可读性收口

确认三组 tuple 命名清楚，新增集合与 FLY-1987 清单严格一致，17 条围栏只出现授权路径；不引入
classifier 配置抽象、glob 排除或 CI workflow 重排。

## 4. 全仓验证与评审

Focused suite 通过后运行：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

若 aggregate gate 出现环境或既有失败，保留原始结果，再以失败签名、变更归属和隔离复跑取证；
不得把隔离通过冒充原门全绿。shell focused suite 结果单列进 PR。

实现、文档与验证提交后：

1. 推送 exact head；
2. `stage set code_review`；
3. 新建 `review_code` gate 并 `request-review --type code`；
4. poll 到 `reviewVerdict=APPROVED`；CHANGES 后修复并以新 question 重开；
5. 创建 base=`main` 的 PR；PR body 明写 17 条是 FLY-2001 自身安全围栏而非复活 FLY-1996；
6. 附 tracked inventory、consumer sweep、RED/GREEN、PR #874 回放和“P0 样本为 0”边界；
7. `complete --route needs_review --pr <number>`，不请求 ship、不 merge。

## 5. 验收与证据映射

| 验收 | 权威证据 |
|---|---|
| 只改新增白名单后缀走快车道 | 13 个 prefix 内 behavioral tests 全部 `no_code=true` |
| 白名单外零影响 | 13 个 prefix 外 tests、`.json/.tsv/.yaml` doc-prefix tests 与原阴性矩阵全绿 |
| mixed diff 不扩大已知洞 | 17 条 direct-path RED→GREEN 为主证据；GREEN-A mixed red、GREEN-B mixed green 为交叉证据 |
| allowlist 在 always-on lane 被钉死 | `ci-structure.test.sh` 精确断言 prefixes/suffixes/non-inert paths |
| fence 不会静默指向旧路径 | always-on guard 对 17 条逐项执行 Git-index liveness，并钉死两组 consumer/fence parity |
| 后缀以 FLY-1987 台账为准 | new test array、production tuple 与 `SUFFIX_P0_ADDS` 三方精确集合比对 |
| 真实历史形状可被救 | PR #874 九路径同提交回放 `no_code=true` |
| 省钱额诚实 | 文档与 PR 明写现行窗口 P0 样本 0，不从本 PR 推算金额 |
| 改动可回滚 | 删除 13 suffix 与 17 条围栏即可恢复原行为；无 schema、状态或部署变化 |

## 6. 风险与回滚

17 条 exact path 是由 current 3,933-path inventory 的 full-path literal、directory-base /
shell-variable 与 segment-joined 三模态 triage 得出的有界集合。它不声称看见完全动态路径或
预测未来 consumer；新增 consumer 或 lane 变化需要重跑三种 sweep，path rename/delete 由
Git-index liveness 拦截，两组静态 consumer set 漂移由 parity 拦截。

`.log` 的 45 个 tracked 样本因 `*.log` ignore 曾被初稿漏计；改用 `git ls-files` 已修正。
本单不改 ignore，未来新增 `.log` 仍需 force-add，不能因工作树 glob 无结果而宣称零样本。

若评审或 CI 发现某新增类型不是惰性，先从 production 与 new test array 同时删除该后缀并记录
原因。整体回滚时删除 13 个 suffix literal 与 17 条 exact path guard；旧 classifier 行为恢复。

## 7. 会过期的结论

| 结论 | 截止时间 | 失效条件 | 重核方法 |
|---|---|---|---|
| consumer sweep 支持 13 项全部进入 | 2026-08-23 | doc 文件或 CI 调用图变化 | 重跑 research.md §2 全部查询并人工审阅 |
| 17 条 path 是静态可解析、已证实并获授权的围栏 | 2026-08-23 | consumer 或 Lead 裁定变化 | 先跑 research §3.4 basename，再跑 §3.1–3.3；查询 gates 819a…/7273…/6ed3…/2def… |
| RED 应新增 31 个 behavioral failures | 当前 test harness | harness 或原白名单/围栏先被其它 PR 修改 | 先跑 baseline，再核对失败名与汇总 |
| production 只需 suffix tuple + exact path guard | 当前 classifier 结构 | classifier 结构变化 | 重读脚本与 focused suite |
| 全仓命令为当前 required gates | 2026-08-23 | root scripts/CI 合同变化 | 查看 root `package.json`、role prompt 与 workflow |
| PR #874 清单为九路径 | FLY-1987 快照时间 | raw snapshot 更正 | 重新提取 `data/raw/prfiles.tsv` exact branch |
