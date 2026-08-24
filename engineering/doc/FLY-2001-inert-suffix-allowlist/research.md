# FLY-2001 惰性后缀白名单补齐 — 调研
Issue: FLY-2001 (https://linear.app/geoforge3d/issue/FLY-2001/ci省钱-classify-惰性后缀白名单补齐纯数据媒体后缀不触发全量fly-1987-p0-族founder-立单一行改动可回滚)
日期: 2026-08-23
基于: exploration.md

## 1. 权威规则核对

当前 `scripts/ci-classify.sh` 对 merge-base 到 PR head 的整个 raw diff 做判定。普通文件必须
同时满足四个 doc 前缀之一与现有后缀之一；rename 以 `--no-renames` 展开，symlink
(`120000`)和 gitlink (`160000`)显式拒绝，解析或 git 不确定性都输出 `no_code=false`。

FLY-1987 的 `data/derive-lib.mjs` `SUFFIX_P0_ADDS` 与 `plan.md` P0 implementation list
逐项一致，权威新增集合为：

```text
.txt .csv .log .out .jsonl .wav .mp3 .m4a .ogg .mp4 .webm .vtt .srt
```

`.json` 没有出现在清单中；它可承载构建、配置或合同输入。`.tsv`、`.yaml` 与可执行类型
同样不凭“像数据”自行放宽，测试会把前三者钉成 doc 前缀内阴性对照。

## 2. 新后缀 consumer sweep

### 2.1 tracked 文件清单与数量

初稿使用 `rg --files`，它遵循 `.gitignore`，从而错误漏掉了 `.gitignore:20` 的 `*.log`。
R1 后改用 Git index 作为唯一盘点源：

```bash
git ls-files -- doc product/doc engineering/doc content/doc |
  awk 'BEGIN{split("txt csv log out jsonl wav mp3 m4a ogg mp4 webm vtt srt",s," ")}
       {for(i in s) if($0 ~ "\\." s[i] "$") c[s[i]]++}
       END{for(i=1;i<=13;i++) printf "%s %d\n",s[i],c[s[i]]+0}'
```

| 后缀 | tracked 文件数 | 主要形态 |
|---|---:|---|
| `.txt` | 226 | QA/事故取证、pane/log 摘录、来源说明 |
| `.csv` | 8 | FLY-1986 负载探针数据、FLY-1987 台账 |
| `.log` | 45 | 已 force-add 的取证日志；repo-wide `*.log` ignore 仍保持 |
| `.out` | 0 | 当前无样本 |
| `.jsonl` | 34 | 对话、probe、attempt/job/run 原始证据 |
| `.wav` | 8 | 语音 QA 输入/输出证据 |
| `.mp3` | 5 | 语音合成样本 |
| `.m4a` | 0 | 当前无样本 |
| `.ogg` | 0 | 当前无样本 |
| `.mp4` | 0 | 当前无样本 |
| `.webm` | 0 | 当前无样本 |
| `.vtt` | 0 | 当前无样本 |
| `.srt` | 0 | 当前无样本 |

合计 326 个 tracked 文件。允许 `.log` 是有意行为，但 `.gitignore` 不变；以后新增 `.log`
仍需显式 `git add -f`。零样本不等于未来天然安全，13 项仍全部进入 behavioral matrix。

### 2.2 现存路径的字面消费者

把 Git index 中 326 条完整路径作为 fixed-string pattern，在 CI workflow、scripts 与
packages 中查询：

```bash
rg -nF -f <(git ls-files -- doc product/doc engineering/doc content/doc |
  rg '\.(txt|csv|log|out|jsonl|wav|mp3|m4a|ogg|mp4|webm|vtt|srt)$') \
  .github scripts packages package.json pnpm-workspace.yaml
```

结果为 **0 条字面引用**。盘点尺子的阳性对照改用 index 中已知存在的 tracked `.log` 验证
pattern set 非空，再用已知 doc `.py` consumer
`engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/scripts/design_compare.py` 验证查询根会命中
`scripts/__tests__/test-fly1609-design-compare.test.sh:6`。这两个对照分别防止 inventory 与 consumer
root 退化为空，但不能代替动态路径审阅。

### 2.3 动态路径与调用图审阅

额外检索四个 doc 前缀、13 个扩展名以及 `readFile`、`cat`、`grep`、`find`、`import`、
`python`、`node` 等读取/执行形状，并检查命中是否位于 `.github/workflows/ci.yml` 调用图。

| 命中 | 判定 |
|---|---|
| `scripts/fly-1586-capture-evidence.sh` 的 `engineering/doc/.../evidence/$STAMP` | 只写新的 `.txt` 证据，不读取 tracked doc 输入；不在 `ci.yml` 调用图中 |
| `packages/voice-bridge/e2e/fly1065-staged-discord.mjs` 的 `.jsonl` | 读写 `/tmp` 或显式 state dir 的本次运行 transcript，不读取 committed doc `.jsonl`；是真机手动 E2E |
| `packages/voice-bridge/e2e/qa-codec-chain.mjs` / `pr1-loop.mjs` 的 `.mp3` | 从 CLI 参数读取手工 QA 音频，不指向 doc 前缀，也不在 CI workflow 中 |
| `scripts/__tests__/test-fly1609-design-compare.test.sh` | 执行 doc 前缀内 `.py`；`.py` 不在新增清单并继续 fail-closed |
| package 测试对 `engineering/doc/.../*.json` / `*.mjs` 的 import | 类型不在新增清单并继续 fail-closed |
| scaffold、QA framework 与 EdgeWorker 中的 doc/证据文字 | 写入或操作说明，不是 CI 对这 13 类 committed 文件的读取 |

结论是当前没有新增后缀对应的 tracked 文件被 CI 消费，13 项无需剔除。这个结论只回答
“新类型本身是否惰性”，不能单独证明 classifier 的**整个 diff**仍安全。

## 3. whole-diff 风险与 current-suffix consumer sweep

设计评审 R1 给出反例：若 diff 同时修改“现有白名单内、且被 skippable lane 消费的 `.md`”
和新增 `.txt`，改动前 `.txt` 迫使全量，改动后两者都会命中白名单，旧 `.md` 守卫会被跳过。
因此初稿“新增类型无 consumer 即足够”的结论不成立。

为避免把 reviewer 偶然列出的路径误当完整集合，另对**当前** 13 个 allowlisted suffix 做三模态盘点。

### 3.1 模态 A：full-path literal

```bash
tracked=$(mktemp)
git ls-files -- doc product/doc engineering/doc content/doc |
  rg '\.(md|markdown|mmd|html|htm|svg|png|jpg|jpeg|gif|webp|avif|pdf)$' >"$tracked"
wc -l "$tracked"  # 3933
rg -nF -f "$tracked" .github scripts packages package.json pnpm-workspace.yaml
rg -lF -f "$tracked" .github scripts packages package.json pnpm-workspace.yaml |
  rg '(__tests__|\.github/workflows|\.test\.|test\.sh$)'
```

最后一条查询命中 17 个 test/workflow 文件。逐条按“是否读取目标文件内容”与“consumer 是否进入
`no_code != true` gated lane”审阅；结果为以下六条：

| non-inert doc 路径 | CI consumer | lane |
|---|---|---|
| `doc/engineer/implementation/FLY-222-a0-a10-runbook.md` | `scripts/__tests__/launchd-units-manifest.test.sh` 与 fail-closed companion 会 grep/copy 它 | `script-tests`，受 `no_code != true` 控制 |
| `doc/qa/framework/529-room-playbook.md` | `scripts/__tests__/test-deploy-generalized.test.sh` 硬断言其计数与文本 | `script-tests-2`，受 `no_code != true` 控制 |
| `engineering/doc/FLY-1775-529-generalized-dag-room/plan.md` | 同一 generalized deploy test 硬断言其中三个 contract | `script-tests-2`，受 `no_code != true` 控制 |
| `engineering/doc/FLY-1062-npm-distribution/packaged-path-audit.md` | `scripts/__tests__/package-onboard.test.sh` 读取 audit table 并要求每个 default script 有 row | `script-tests-2`，受 `no_code != true` 控制 |
| `engineering/doc/FLY-1648-hot-loop-closeout/runbook.md` | `packages/teamlead/.../fly-1648-hot-loop-closeout.test.ts` 读取并断言六条 operator contracts | teamlead `unit-tests` shard，受 `no_code != true` 控制 |
| `doc/engineer/implementation/flag-authoring-runbook.md` | `packages/config/.../fly1981-final-ledgers.test.ts` 读取并断言 supported authoring route | light `unit-tests` shard，受 `no_code != true` 控制 |

其余 11 个 test/workflow 文件只含注释、fixture/provenance、path-value contract，或读取 doc 的
test 本身不在 CI（如 `host-path-allowlist.test.sh`）；它们不读取 gated lane 所依赖的目标内容。

### 3.2 模态 B：directory-base / shell-variable composition

模态 A 无法命中 `new URL(relativePath, docRoot)` 或 `"$DOC_DIR/plan.md"`。因此再扫描 JS/TS
directory literal 和 shell doc-root variable，并人工审阅读写方向与 workflow reachability：

```bash
rg -n -U --glob '*.{ts,mjs,js}' \
  'new URL\([\s\S]{0,180}(doc/|product/doc/|engineering/doc/|content/doc/)' \
  scripts packages
rg -n --glob '*.sh' \
  '^[A-Z][A-Z0-9_]*=.*(doc/|product/doc/|engineering/doc/|content/doc/)' \
  scripts packages
```

| composed-path 命中 | read/write 与 CI 判定 |
|---|---|
| `review-governance-docs.test.ts` 的 FLY-1278 `docRoot + artifactPaths` | 读取 9 个 tracked artifacts 并做 control-byte/哈希断言；teamlead unit shard 可达。1 个 `.json` 继续天然 fail-closed，以下 8 个 `.md` 必须 fence |
| 同目录两个 test 对 FLY-1278 `.json` 的完整 `new URL` | 内容被读取但 `.json` 不在 allowlist，无需 fence |
| `fly1272-doc-contract.test.sh` 的 `DOC_DIR + plan/research` | 读取内容，但该 test 未被 workflow 调用 |
| `host-path-allowlist.test.sh` 的 `DOC` | 读取内容，但该 test 未被 workflow 调用；模态 A 也已命中其完整 path |
| `qa-fly-60-driver.sh` 的 `EVIDENCE_BASE`、`fly-1586-capture-evidence.sh` 的 `OUT_DIR` | 输出目录，不读取 committed doc 输入；相关路径也不在 CI consumer 调用图 |

FLY-1278 的 8 条新增 fence 是：

```text
engineering/doc/FLY-1278-review-gate-convergence/exploration.md
engineering/doc/FLY-1278-review-gate-convergence/research.md
engineering/doc/FLY-1278-review-gate-convergence/plan.md
engineering/doc/FLY-1278-review-gate-convergence/progress.md
engineering/doc/FLY-1278-review-gate-convergence/fixtures/README.md
engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round1.md
engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round2.md
engineering/doc/FLY-1278-review-gate-convergence/codex-design-review/codex-rescue-design-feedback-flywheel-FLY-1278-plan-round3.md
```

### 3.3 模态 C：segment-joined path

模态 A/B 仍看不见 `join(root, "engineering", "doc", folder)`，因为 source 中没有连续的
`engineering/doc/`。扫描 JS/TS standalone `"doc"` join segment、doc-root-shaped variables，
并放宽 shell assignment 的大小写与缩进：

```bash
rg -n -U --glob '*.{ts,mjs,js}' \
  'join\([\s\S]{0,220}["'"']engineering["'"'][\s\S]{0,80}["'"']doc["'"']' \
  scripts packages
rg -n --glob '*.sh' \
  '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=.*(doc/|product/doc/|engineering/doc/|content/doc/)' \
  scripts packages
```

| segment/shell 命中 | read/write 与 CI 判定 |
|---|---|
| `fly1135-doc-sentinel.test.ts` 的 `DOC_DIR = join(REPO_ROOT, "engineering", "doc", ...)` | gated teamlead unit test 读取并检查 `exploration.md`、`research.md`、`plan.md`；三条加入 fence，并与 test 内静态 filename list 做 parity |
| `progress.realgit.test.ts` 的 temp repo `join(repo, "engineering", "doc", ...)` | 测试自身临时 fixture，不读取 committed doc |
| shell 命中 | 已由 A/B triage；另有 `doc/VERSION`，但无 allowlisted suffix，天然 fail-closed |

因此再加入：

```text
engineering/doc/FLY-1135-layer1-dag-templates/exploration.md
engineering/doc/FLY-1135-layer1-dag-templates/research.md
engineering/doc/FLY-1135-layer1-dag-templates/plan.md
```

Lead 裁定本单只为三种模态核实的 17 条路径加入 exact-path 排除，不扩展成完整 FLY-1996
治理。实现先检查 `path in known_ci_consumed_doc_paths`，命中即 fail-closed；behavioral tests
覆盖每条单改与 mixed diff，always-on guard 逐条验证 tracked liveness，并分别验证 FLY-1278
静态 `artifactPaths` 的 8 个 `.md` 与 FLY-1135 静态 filename list 的 3 个 `.md` 和 fence 完全一致。

三种静态模态仍不能看见完全动态生成的路径；因此结论是“围住当前已证实 consumers”，不是
证明未来或任意程序都没有其它 consumer。Lead 已选择 exact-17 + 两组 parity；目录 prefix 会
误围未证实文件，generic discovery guard 属另一个 CI 机制，均不进入本单。

### 3.4 Primary recheck：form-independent basename sweep

前三种查询依赖 path composition 形状。日后重核应先用 basename 做 form-independent 粗筛，再用
A/B/C 处理 `plan.md`、`research.md`、`README.md` 等重复 basename 与目录关系：

```bash
basenames=$(mktemp)
git ls-files -- doc product/doc engineering/doc content/doc |
  rg '\.(md|markdown|mmd|html|htm|svg|png|jpg|jpeg|gif|webp|avif|pdf)$' |
  awk -F/ '{print $NF}' | sort -u >"$basenames"
wc -l "$basenames"  # 1838 at this HEAD
rg -nF -f "$basenames" .github scripts packages package.json pnpm-workspace.yaml
```

它不替代 A/B/C：通用 basename 无法区分具体目录；但它不关心 path 如何拼装，能优先暴露有辨识度
的文件名。R5 reviewer 另以 template literal、readdir/glob/find、Python hooks、vitest config 和
全量未过滤 literal 命中独立复核，未发现第 18 个 statically-resolvable consumer。

## 4. PR #874 真实文件清单回放

FLY-1987 的冻结 `data/raw/prfiles.tsv` 给出 `docs/FLY-1846-global-chief-of-staff` 共 9 个文件：

```text
product/doc/FLY-1846-global-chief-of-staff/assets/raya-avatar-square.png
product/doc/FLY-1846-global-chief-of-staff/assets/raya-avatar.SOURCE.txt
product/doc/FLY-1846-global-chief-of-staff/assets/raya-avatar.png
product/doc/FLY-1846-global-chief-of-staff/exploration.md
product/doc/FLY-1846-global-chief-of-staff/plan.md
product/doc/FLY-1846-global-chief-of-staff/prd-review.html
product/doc/FLY-1846-global-chief-of-staff/prd.md
product/doc/FLY-1846-global-chief-of-staff/progress.md
product/doc/FLY-1846-global-chief-of-staff/research.md
```

其中只有 `raya-avatar.SOURCE.txt` 使用新增类型。测试会用这 9 条路径创建同一个提交，证明补齐
前它因 `.txt` 走全量、补齐后整个真实形状走快车道；不冒充重跑历史 GitHub Actions 账单。

## 5. 测试与实现影响面

production 有两项最小改动：向 `allowed_suffixes` 追加 13 个 bytes literal；新增 17 条 exact
`known_ci_consumed_doc_paths` 并在循环中拒绝命中。目录、mode、merge-base 与错误处理不变。

behavioral suite 将：

- 分开表达 existing/new suffix 集合；逐项验证 prefix 内阳性与 prefix 外阴性；
- 对 `.json`、`.tsv`、`.yaml` 增加 doc-prefix 内阴性；
- 17 条 known-consumed path 分别断言 `false`，另加一条与新 `.txt` 的 mixed-diff 断言；
- 回放 PR #874 九路径。

always-on `ci-structure.test.sh` 将从 classifier embedded Python 中提取并精确断言
`allowed_prefixes`、`allowed_suffixes` 与 `known_ci_consumed_doc_paths`，逐条执行 Git-index
liveness check，并检查 FLY-1278/FLY-1135 consumer/fence parity。behavioral suite 仍提供 Git 语义证据；
structure guard 则防止 docs-only PR 因跳过 script lane 而无法发现 allowlist、consumer 或 fence
漂移。

## 6. 会过期的结论

| 结论 | 截止时间 | 失效条件 | 重核方法 |
|---|---|---|---|
| 13 类 tracked 文件数量为表中数值 | 2026-08-23 | 任一 doc 前缀文件变化 | 重跑 §2.1 `git ls-files` inventory |
| 13 类 tracked 文件无字面 CI consumer | 2026-08-23 | scripts/packages/workflow 或证据路径变化 | 重跑 §2.2 fixed-string sweep |
| 动态路径审阅未发现 13 类 CI consumer | 2026-08-23 | CI 调用图、glob、读取逻辑变化 | 重跑 §2.3 检索并人工审阅命中 |
| 17 条围栏覆盖静态可解析的 sweep-verified consumer | 2026-08-23 | consumer 新增、迁移或 Lead 裁定变化 | 先跑 §3.4 basename，再跑 §3.1–3.3 三种 composition sweep |
| PR #874 冻结清单为 9 条 | FLY-1987 快照时间 | raw snapshot 被更正 | 从 `data/raw/prfiles.tsv` 重新提取该 branch |
| FLY-1987 现行窗口 P0 样本为 0 | 2026-08-22 | 测量窗口或推导器变化 | 重跑 derive + aggregate；不可从本 PR CI 推算金额 |
