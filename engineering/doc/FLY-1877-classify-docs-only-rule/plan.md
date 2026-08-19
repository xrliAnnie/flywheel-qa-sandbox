# FLY-1877 classify 单规则化 — 实施计划

Issue: FLY-1877 (https://linear.app/geoforge3d/issue/FLY-1877/ci简化-classify-判定换成一条不看历史的规则纯文档-pr-跳过一切其余全跑替换-baseline-机制净删除)
日期: 2026-08-18
基于: 无

## 0. 一句话

把 `scripts/ci-classify.sh` 的判定从「查 CI 历史找最新 green baseline」整套机制,**替换**为一条不看历史的规则:**PR 相对 merge-base 只动文档目录 → 跳过全部重 job;其余任何改动 → 全跑**。方向是净删除(~145 行 → ~70 行,runs API 调用整个消失)。

## 1. 背景与裁决(已定,不再讨论)

- **Annie 直令(2026-08-18 19:11,经 HL recite)**:「就把这个东西简单化,不要把东西复杂化。」规则一条、不看历史。
- **替换而非叠加**:FLY-1861 落地的 baseline/CI-历史机制(latest-completed-run + success 校验 + base 未漂移 + 祖先校验 + 12 页翻页)全删。她已否掉「两条并存」;删 baseline 机制是该决定的直接结果(HL 已确认,无需再回,19:21)。
- **收益口径(HL 补刀 19:14,汇报照此)**:这不是省钱单,是简化单。**净省约 +$6/月**(现机制跳 64 轮≈$53 → 新规则跳 101 轮≈$59;禁止把 $59 写成增量,禁止引用「两条并存 $107」)。真正的收益:
  1. 不再依赖 CI 历史 ⇒ 不会因「舱队老打断自己」(cancel-in-progress 顶掉旧轮)而退化 — 现机制会;
  2. C0/新鲜度/rerun 排序/base 漂移整族问题消失;
  3. 后来人不用再绕 2026-08-18 夜那套诊断。

## 2. 现状事实(2026-08-18 对 `flywheel-FLY-1877` 分支审计)

### 2.1 被替换的机制(`scripts/ci-classify.sh`,145 行)

现脚本 = 输入校验 + **五件套 baseline 机制** + inert-diff 检查:

| 段落 | 行号 | 去留 |
|---|---|---|
| 输入校验(PR_NUMBER/HEAD_SHA/BASE_SHA/GITHUB_REPOSITORY) | L14-19 | 收窄为 HEAD_SHA/BASE_SHA(其余两个不再被逻辑消费) |
| `gh api …/workflows/ci.yml/runs` 12 页翻页 + jq 过滤聚合 | L24-67 | **整段删除** |
| baseline 选取(sort_by createdAt,id → last) | L69-75 | **删除** |
| baseline 校验(success / head 合法 / base 未漂移 / 是祖先) | L77-89 | **删除** |
| Python inert-diff 检查(`git diff --raw -z --no-renames green..head`) | L91-143 | **保留**,diff 起点从 baseline head 换成 merge-base |
| 输出 `no_code=true/false` 到 `GITHUB_OUTPUT` + stderr 诊断行 | 全文 | 保留(格式不变) |

### 2.2 三处守卫(**一条不碰**,founder 已拍)

`scripts/__tests__/ci-structure.test.sh`(735 行)钉死:

- 重 job 集合(unit-tests / script-tests / script-tests-2 / payload-distribution)`needs == ["classify"]` + `if: needs.classify.outputs.no_code != 'true'`;
- ci-ok 汇总门 jq 表达式(quick-gate+classify 必 success;四个重 job success 或 no_code=true 时 skipped);
- classify job:`permissions == {contents: read, actions: read}` **精确相等**、checkout `fetch-depth: 0`、`bash scripts/ci-classify.sh` 恰一次、step id `classify`。

推论:
- **ci.yml 的 job 图、needs、if、permissions 全部不动**。`actions: read` 在新脚本下已无用,但守卫精确相等钉死了它 → **接受为已知无害残留**(收窄它需要改守卫,超出本单授权;留给未来某次合法守卫修订顺手做)。
- 守卫**没有**钉 classify step 的 `env` 与 step `name`(已逐行核对 L106-127:只按 `run` 内容与 `id` 选步)。

### 2.3 `scripts/ci-status-vectors.json` 的三个消费方(已逐个验读)

| 消费方 | 读取字段 | 删 `baseline` 列影响 |
|---|---|---|
| `scripts/__tests__/ci-classify.test.sh` L284-294 | `.baseline`(驱动 baseline 向量循环) | 本单重写该测试,循环整段删除 |
| `scripts/__tests__/ship-await-ci.test.sh` L186 | jq 只取 `.status/.conclusion/.await` | 无影响 |
| `packages/teamlead/src/bridge/__tests__/land-merge-driver.test.ts` L7-18 | TS cast 只声明 `status/conclusion/receiver` | 无影响(纯 cast,无 schema 校验) |

### 2.4 其他锚点

- CI 在 `script-tests-2` 的「FLY-1861 CI cancellation and classification contracts」步骤跑 `ship-await-ci.test.sh + ship-report-failure.test.sh + ci-classify.test.sh` — 路径不变,前两者不碰。
- push-to-main 事件下 `github.event.pull_request.*` 为空 → 现脚本 `invalid_input` fail-closed → 全跑。新脚本同样(HEAD_SHA/BASE_SHA 为空 → `invalid_input`)。**行为不变**。
- ci.yml classify job 的注释块(L24-26)与 step name(L40)仍在描述 baseline 机制 — 机制删除后变成误导性文档。

## 3. 新规则与完整分支语义

```
输入:HEAD_SHA(PR head)、BASE_SHA(base 分支 tip)
规则:git merge-base(BASE_SHA, HEAD_SHA) 到 HEAD_SHA 的全量 diff
      只含「文档目录白名单 × 后缀白名单」内的普通文件变更 → no_code=true(跳过全部重 job)
      其余一切情况(含判不出)                              → no_code=false(全跑)
```

fail-closed 分支表(stderr 诊断行格式保留 `ci-classify: fail-closed: <reason>`):

| reason | 触发条件 | 输出 |
|---|---|---|
| `invalid_input` | HEAD_SHA/BASE_SHA 非 40-hex(含 push-to-main 空值) | false |
| `head_commit_missing` | HEAD_SHA 在 clone 中不存在 | false |
| `base_commit_missing` | BASE_SHA 在 clone 中不存在 | false |
| `merge_base_unresolvable` | `git merge-base --all` 失败或零输出(如 unrelated histories) | false |
| `merge_base_ambiguous` | `git merge-base --all` 输出多于一行(criss-cross 历史存在多个同等 merge base;单值调用会任取其一,可能只看到 docs diff 而漏掉另一 base 视角下的 code diff — **fail-open**,Codex R1 用 criss-cross fixture 实证) | false |
| `diff_not_inert` | diff 中任一路径出白名单 / 后缀不符 / symlink(120000) / gitlink(160000) / diff 输出畸形 | false |
| (无) | diff 全部 inert(含空 diff) | **true** |

merge-base 必须**唯一**:用 `git merge-base --all`,只接受恰好一行 40-hex;零行或多行都 fail-closed。这不是新机制,是让「一条规则」在 Git 语义下确定化(不带 `--all` 时返回哪个 base 是 unspecified)。

白名单**逐字沿用**现行(FLY-1861 已钉,不动):
- 前缀:`doc/`、`product/doc/`、`engineering/doc/`、`content/doc/`
- 后缀:`.md .markdown .mmd .html .htm .svg .png .jpg .jpeg .gif .webp .avif .pdf`
- 机器消费文件天然被排除:`doc/VERSION` 无后缀、`doc/**/*.mjs` 后缀不在表 → 触碰即全跑。
- `--no-renames`:code→doc 改名呈现为 delete(code 路径)+ add → 出白名单 → 全跑。

### 3.1 与旧机制的行为差(预期内,即「跳 64→101 轮」的来源)

| 场景 | 旧机制 | 新规则 |
|---|---|---|
| docs-only PR,但该 PR 从未有过 green run(如首推) | 全跑(`no_completed_pr_baseline`) | **跳过** |
| docs-only PR,base 已漂移(main 前进了) | 全跑(`baseline_base_sha_mismatch`) | **跳过**(main 自己的 push CI 会跑 main 的改动) |
| docs-only PR,最新 completed run 是 cancelled/failure | 全跑(`latest_completed_run_not_success`) | **跳过** |
| PR 里先有 code commit 后全是 docs commit | 可能跳过(增量 diff 对 green baseline) | 只要**累计** diff 相对 merge-base 含 code → **全跑**(更保守的一侧) |

安全性论证:重 job 验的是 PR 自己带来的变更。docs-only PR 的合并不引入任何可执行字节;merge preview 中的非文档内容全部来自 main,由 main 的 push CI 覆盖;quick-gate(build/typecheck/lint/守卫族)任何情况都全量跑,不受 classify 影响。

## 4. 变更清单(文件级)

| # | 文件 | 改动 | 性质 |
|---|---|---|---|
| 1 | `scripts/ci-classify.sh` | 重写:删五件套,merge-base + inert-diff,~145→~70 行 | 核心 |
| 2 | `scripts/__tests__/ci-classify.test.sh` | 重写测试向量(§6),删 gh mock/翻页 fixture/vectors 循环 | 核心 |
| 3 | `scripts/ci-status-vectors.json` | 删 16 条记录的 `baseline` 键(死列;§2.3 已验另两消费方安全) | 净删除 |
| 4 | `.github/workflows/ci.yml` | **仅**:classify job 注释块改述新规则;step name 改 `Classify docs-only diff from merge base`;step env 删 `GH_TOKEN/GITHUB_REPOSITORY/PR_NUMBER`(脚本不再消费)。job 图/needs/if/permissions/steps 结构零变化,改后本地跑 `ci-structure.test.sh` 必须绿 | 防误导清理 |
| 5 | 三守卫(`ci-structure.test.sh` / `ci-matrix-coverage.test.sh` / `ci-shell-suite-enumeration.test.sh`) | **0 改动** | 边界 |

不改:`ship-await-ci.test.sh`、`ship-report-failure.test.sh`、runner-ship/land 侧一切(它们的 gh 调用属 ship 工作流,与 classify 无关)。

## 5. 新脚本形态(实现基准)

```bash
#!/usr/bin/env bash
# FLY-1877: single history-free rule. A PR whose entire diff against its
# merge base touches only inert documentation skips the heavy CI jobs;
# anything else — or anything unprovable — runs the full suite.
set -uo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

fail_closed() {
  printf 'ci-classify: fail-closed: %s\n' "$1" >&2
  printf 'no_code=false\n' >>"$GITHUB_OUTPUT"
  exit 0
}

[[ "${HEAD_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]] || fail_closed "invalid_input"
[[ "${BASE_SHA:-}" =~ ^[0-9a-fA-F]{40}$ ]] || fail_closed "invalid_input"
head_sha="$(printf '%s' "$HEAD_SHA" | tr '[:upper:]' '[:lower:]')"
base_sha="$(printf '%s' "$BASE_SHA" | tr '[:upper:]' '[:lower:]')"

git cat-file -e "$head_sha^{commit}" 2>/dev/null || fail_closed "head_commit_missing"
git cat-file -e "$base_sha^{commit}" 2>/dev/null || fail_closed "base_commit_missing"

merge_bases="$(git merge-base --all "$base_sha" "$head_sha" 2>/dev/null)" ||
  fail_closed "merge_base_unresolvable"
merge_base_count="$(printf '%s\n' "$merge_bases" | grep -cE '^[0-9a-f]{40}$')"
[[ "$merge_base_count" -ge 1 ]] || fail_closed "merge_base_unresolvable"
[[ "$merge_base_count" -eq 1 ]] || fail_closed "merge_base_ambiguous"
merge_base="$(printf '%s\n' "$merge_bases" | grep -E '^[0-9a-f]{40}$' | head -1)"

python3 - "$merge_base" "$head_sha" <<'PY' || fail_closed "diff_not_inert"
# —— 逐字保留现 L91-143 的 Python 检查器,仅 green→merge_base 语名变化 ——
# git diff --raw -z --no-renames <merge_base>..<head>
# 前缀白名单 × 后缀白名单;120000/160000 mode 拒绝;畸形输出 exit 2
PY

printf 'no_code=true\n' >>"$GITHUB_OUTPUT"
```

要点:
- **`set -uo pipefail` 里 `-e` 是刻意缺席的,不许「加固」**:merge_base_count 为 0 时 `grep -c` 返回 rc=1,无 `-e` 时赋值行继续、下一行 fail-closed;加 `-e` 会让脚本在该路径直接 rc=1 退出且不写 no_code 行,破坏「永远 exit 0 + 恰好一行输出」契约(交叉评审 R2 用 mutation control 实证)。
- `merge_base` 提取先过 `grep -E '^[0-9a-f]{40}$'` 再 `head -1`,让「恰好一行 40-hex」的接受条件字面成立(R2 建议折入)。
- `gh`/`jq` 依赖整个消失;脚本只依赖 git + python3(与现状相同,python3 是现有依赖)。
- Python 检查器**逐字搬运**(白名单、mode 拒绝、`--no-renames`、畸形 diff exit 2 全保留)——这是 FLY-1861 已 review 过的部分,不重写。
- `fail_closed` helper 与诊断行格式逐字保留(exit 0 + `no_code=false`,不 fail job)。

## 6. 测试向量(重写 `ci-classify.test.sh`)

沿用现 harness 骨架(临时 git repo fixture + `preview_checkout` merge-preview 模拟 + `GITHUB_OUTPUT` 断言 + `assert_reason` stderr 断言),删除 gh mock、`MOCK_RUNS_*`、翻页 fixture、vectors 循环。

**skip 侧(no_code=true)**:
1. **白名单全集正例矩阵**(table-driven):四个前缀(`doc/`、`product/doc/`、`engineering/doc/`、`content/doc/`)各至少一次 × 13 个后缀各至少一次(拉链式配对,无需笛卡尔积;后缀数以 §3 枚举集为权威 —— R1 文本写 14 是 off-by-one,交叉评审 R2 纠正)→ 全 true。防「实现悄悄删掉 `content/doc/` 或某冷门后缀而套件仍绿」的合同回归;
2. 空 diff(head == merge-base tree)→ true;
3. docs-only 且 **base 已漂移**(BASE_SHA 指向 main 新 commit,merge-base 仍是分叉点)→ true —— 这是与旧机制的行为差的阳性锚点(旧机制此处 false);
3a. **uppercase HEAD_SHA/BASE_SHA** 的 docs-only → true(脚本归一化分支从未有向量);
3b. **删除**一个白名单内普通文件(如删掉一个 `.md`)→ true(证明「touches」不只覆盖新增);

**全跑侧(no_code=false + reason)**:
4. 纯 code diff → `diff_not_inert`;
5. docs+code 混合 → `diff_not_inert`;
6. 非 inert 路径矩阵(沿用现 6 条:`packages/x/progress.md`、`.github/workflows/extra.yml`、`scripts/ci-classify.sh`、`packages/teamlead/prompts/runtime.md`、`doc/VERSION`、`product/doc/example/evidence/admit.mjs`)→ 全 false;
7. code→doc rename(`--no-renames` 语义)→ `diff_not_inert`;
8. 白名单路径下的 symlink(120000)→ `diff_not_inert`;
9. 白名单路径下的 gitlink(160000,`git update-index --cacheinfo` 构造)→ `diff_not_inert`(新增:现套件只测了 symlink,mode 拒绝的另一半从未有向量);
10. HEAD_SHA 非法 → `invalid_input`;BASE_SHA 非法 → `invalid_input`(覆盖 push-to-main 空值形态);
11. HEAD_SHA 指向不存在 commit → `head_commit_missing`;BASE_SHA 同 → `base_commit_missing`;
12. unrelated-history base(orphan 分支 commit 作 BASE_SHA)→ `merge_base_unresolvable`;
12a. **criss-cross 多 merge-base**(构造:两分支互相 merge 后再分别推进,`git merge-base --all` 出两行;其中一个 base 视角是 docs-only、另一个含 code)→ `merge_base_ambiguous`(R1 blocker 的负向锚点);

**守卫型断言**:
13. **runs-API-zero**(验收 #3):`grep -E 'gh api|workflows/ci\.yml/runs'` 对脚本零命中;并带**阳性对照**——同一 pattern 对内嵌 fixture 字符串(含 `gh api …/runs` 字样)必须命中,证明尺子本身能响(此 grep 属「必须不在」型守卫,阳性对照防空过绿);
14. 沿用「every fail_closed call supplies a diagnostic reason」grep 守卫;
15. 脚本零 `gh`/`jq` 调用(可并入 13 的 pattern)。

## 7. 验收映射(issue 四条 → 本计划)

| 验收 | 落点 |
|---|---|
| 1. 构造纯 docs PR → skip 全链路、CI OK 绿、~3 min | implement 节点合入后用 sacrificial docs PR 真机验(FLY-1861 同款验法);design/plan 阶段不做 |
| 2. 任一非文档文件混入 → 全跑(含 doc/VERSION、doc/*.mjs) | §6 向量 4-6 |
| 3. runs API 零调用 grep 断言 | §6 向量 13(含阳性对照) |
| 4. 三守卫不变且仍绿;ci-classify.test.sh 覆盖两侧 + 阳性对照 | §4 行 5(0 改动)+ 本地跑三守卫绿;§6 全表 |

实现节点自验(全仓门,executor 常规):
- `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`;
- `bash scripts/__tests__/ci-classify.test.sh`(新向量全绿);
- 三守卫**全部**本地跑绿:`bash scripts/__tests__/ci-structure.test.sh` + `bash scripts/__tests__/ci-matrix-coverage.test.sh` + `bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`;
- 三守卫文件 **diff-zero** 检查:`git diff --stat main -- scripts/__tests__/ci-structure.test.sh scripts/__tests__/ci-matrix-coverage.test.sh scripts/__tests__/ci-shell-suite-enumeration.test.sh` 输出为空(跑绿≠没改,两个都要);
- vectors 删列无伤证明:`bash scripts/__tests__/ship-await-ci.test.sh` + `pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/land-merge-driver.test.ts`。

## 8. 风险与边界(诚实清单)

1. **跳过面变宽是本单目的,不是回归**:§3.1 的四类行为差全部来自 founder 拍板的规则;写卡/汇报按 §1 收益口径。
2. **`actions: read` 残留**:守卫精确相等钉死,本单不碰守卫 → 留着。无安全增量(该 token 本就是只读)。
3. **push-to-main 行为不变**:空输入 → invalid_input → 全跑(§2.4)。
4. **空 diff = skip**:与现行为一致(现套件「empty cumulative diff is no-code」),保留。
5. **ci.yml 第 4 项改动的越界申辩**:issue 说「全部改动活在 ci-classify.sh + 测试」;但注释/step name/env 在机制删除后描述的是不存在的东西(误导下一个诊断者 —— 恰是本单要消灭的成本)。改动严格限于非结构字节,守卫本地复跑为证。若 design review 判定超界,该项可整体撤下不影响其余。
6. **vectors 删列(第 3 项)同理**:死列留着会让后来人找「baseline 的消费方」而找不到。三消费方逐个验读过(§2.3),且两侧测试在 CI 常跑。

## 9. 设计评审记录

- **R1(Codex,gpt-5.6-sol xhigh,2026-08-18)**:CHANGES REQUESTED,3 项 —— ①criss-cross 多 merge-base fail-open(用真 fixture 实证)②正例矩阵钉白名单全集 + uppercase SHA + 删除正例 ③自验清单口径对齐。三项全采纳折入(§3/§5/§6/§7)。反馈存档:`cross-review/codex-r1.md`。
- **R2(独立上下文 Claude 交叉评审,2026-08-18,轮级政策替身)**:Codex 全号额度打满至 08-19 23:24Z、Gemini 免费层停服;Tadashi 预写 sanctioned skip.json 并裁决(问题 4241a505):以独立上下文 Claude 交叉评审为 R2 权威,PASS 即收口不记 pending。**结果 PASS,零 blocking**:三项折入逐字忠实;§5 脚本块被评审者在真 git fixture 上六场景实测(criss-cross / unrelated / 单 base / base==head / grep 零命中 / `set -e` mutation control)全部符合契约。折入其必改 1 项(后缀数 14→13 off-by-one)+ 可选 2 项(`-e` 刻意缺席注记、merge_base 提取 grep 过滤)。报告存档:`cross-review/claude-r2.md`。

## 10. 不做什么

- 不碰 ship 侧(ship-await-ci / runner-ship merge probe / FLY-1624 quota 机制)——它们的 gh 调用与 classify 无关;
- 不碰 quick-gate 永跑语义、job 图、汇总门;
- 不新增任何 config/env 开关(规则无条件生效,fail-closed 兜底);
- 不做「聪明的」耦合分析/路径→job 映射(Annie 明令禁止复杂化);
- 不迁移/重写 FLY-1861 的历史文档(保留为历史)。
