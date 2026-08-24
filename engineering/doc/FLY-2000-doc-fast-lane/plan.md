# FLY-2000 文档快车道 — 实施计划

Issue: FLY-2000 (https://linear.app/geoforge3d/issue/FLY-2000/ci省钱-文档提交走快车道纯文档提交只跑快速检查fly-1987-p1founder-立单先做识别判据可行性验证)
日期: 2026-08-23
基于: research.md

---

> [!IMPORTANT]
> **设计状态（2026-08-23）：暂停，本文不再构成实施授权。** Founder 要求先回溯 FLY-1861 加入、FLY-1877 净删除历史基线 classifier 的全过程。回溯确认本文的 lane 2 与「替换而非叠加、规则一条、不看历史」存在实质冲突；N0 后续、N1、N2 及 classifier/probe 代码全部冻结。当前权威纠偏与待裁决 A/B 选项见 `design-correction.md`。只有 Founder 明确选择 B 后，本文才可恢复为实施输入。

## 0. 一句话

在现行「merge-base 全量 diff 惰性」通道之外,给 `scripts/ci-classify.sh` 加**第二条通道**:PR 曾有一次**真·全绿**(由 ci-ok 在全绿那一刻写下的 artifact 持久标记证明,消费端从权威 API 重验),且自那以后**只多了文档**、main 与 ci.yml 都没动 → 跳过重 job;其余一切(含任何不确定)→ 全跑。

识别判据的可行性验证(P1-a spike)分两段:**纸面六项规格已在 research.md 定死**(只读探针全绿);**最终可行裁定悬于实现节点的 N0 producer spike(实弹,§5)** —— N0 不过,lane 2 不许实现,整案走「放弃」出口(spike 的合法产出之一,上游 FLY-1987 plan 明文)。

净省上限 ≈ **$116/月**(FLY-1987 R6 口径;上限不是承诺,真实值待上线后一周对账)。

## 0.1 前置依赖(硬门,R1-#2)

**FLY-1996(堵 doc-被-CI-消费的快车道安全洞)必须先落地。** 实测于 base `f2eecf495`:`scripts/__tests__/launchd-units-manifest.test.sh:836` 仍把白名单内的 `doc/engineer/implementation/FLY-222-a0-a10-runbook.md` 当断言对象,由 Script Tests 2/2 执行;FLY-1996 无落地 commit。上游 FLY-1987 plan 的排序 **P-1(FLY-1996)→ … → P1** 是硬序:通道二把更多 run 送进快车道,会**放大**这个既有洞的暴露面。

落法(R2-#2 收紧到操作级):
- **N0(producer-only)可以在 FLY-1996 落地前推进** —— producer 永不跳过任何 job,不扩大洞的暴露面;
- **N1 消费端激活与 N2 实弹证据必须在含 FLY-1996 landing commit 的 base 上产生**:开工 N1 前先 rebase 并跑绿 FLY-1996 守卫;
- 若 N2 证据产生之后又发生任何 rebase,**V2/V3 必须在最终 head 上重放**(证据绑最终依赖态,不许 stale);
- PR 描述单列此依赖。**不把 FLY-1996 的活吸进本单**(scope 归 scope);若 FLY-1996 长期不落地,本单 held,上报 Lead 裁决,不许绕行。

## 1. 判据(完整分支语义)

```
输入:HEAD_SHA、BASE_SHA、PR_NUMBER、GH_TOKEN、GITHUB_REPOSITORY(ci.yml 现已全部传入,零改动)

通道一(现行,逐字保留):merge-base(BASE_SHA, HEAD_SHA)..HEAD_SHA 全量 diff 惰性 → no_code=true
通道一失败且 reason == diff_not_inert → 尝试通道二;
通道一的其它 fail_closed(invalid_input / *_commit_missing / merge_base_*)→ 直接全跑(输入都不可信,通道二无从谈起)

通道二(新增,按序校验,任一失败 → 全跑并打印具名 reason;
        所有网络/下载操作有界:单调用 timeout、下载字节上限,超界 → baseline_timeout / baseline_oversize):
  b1  PR_NUMBER =~ ^[1-9][0-9]*$                                    (baseline_no_pr)
  b2  GET /actions/artifacts?name=ci-baseline-pr<N>&per_page=100     (baseline_api_error)
      total_count == 0 → baseline_marker_missing
      total_count > 100 → baseline_too_many_markers(有界,拒绝翻页)
  b3  取 created_at 最新且 expired==false 的一个候选;无 → baseline_marker_missing
  b4  下载 zip(≤ 1 MiB);zip 必须恰含一个普通成员 marker.json(≤ 64 KiB),
      多成员/目录/symlink 成员 → baseline_zip_shape
      JSON 解析拒绝重复键(object_pairs_hook);schema v1 键集合严格相等;
      类型校验:run_id/run_attempt/pr_number 为正整数,head_sha/base_parent_sha/ci_yml_blob
      为小写 40-hex 精确匹配                                          (baseline_marker_malformed)
  b5  候选 artifact 的 workflow_run.id == marker.run_id               (baseline_binding_mismatch)
      候选 artifact 的 workflow_run.head_sha == marker.head_sha       (baseline_binding_mismatch)
      marker.pr_number == PR_NUMBER                                   (baseline_binding_mismatch)
  b6  GET /runs/{run_id}:
      run.workflow_id == (GET /actions/workflows/ci.yml 解析出的 id)   (baseline_wrong_workflow)
      —— workflow_id 是载重检查;run.path 作规范化副检:必须是
         ".github/workflows/ci.yml" 或 ".github/workflows/ci.yml@<非空 ref>"
         (官方 workflow-run 返回形状带 @ref 后缀,workflow 对象返回裸路径,
          两种 raw 形状都进 mock;R2-#1)                               (baseline_wrong_workflow)
      run.event == "pull_request"                                     (baseline_binding_mismatch)
      run.head_sha == marker.head_sha                                 (baseline_binding_mismatch)
      run.run_attempt == marker.run_attempt                           (baseline_attempt_stale)
  b7  GET /runs/{run_id}/attempts/{attempt}/jobs?per_page=100:
      分页完整(total_count<=100 且 jobs.length==total_count)          (baseline_jobs_pagination)
      job 名集合与钉死 census 严格相等(11 个,见 §1.1),无未知名、无缺席、无重复;
      8 个重 job + CI OK + Quick Gate + Classify 全部 conclusion==success,无一 skipped
                                                                      (baseline_not_full_green)
  b8  git cat-file 存在 marker.head_sha 且
      git merge-base --is-ancestor marker.head_sha HEAD_SHA           (baseline_not_ancestor)
  b9  当前 checkout 必须是恰好双亲的 merge commit:
      HEAD^2 存在、HEAD^3 不存在                                       (baseline_merge_shape)
      git rev-parse HEAD^2 == HEAD_SHA                                (baseline_merge_shape)
      git rev-parse HEAD^1 == marker.base_parent_sha                  (baseline_base_drift)
  b10 git rev-parse HEAD:.github/workflows/ci.yml == marker.ci_yml_blob (baseline_ci_drift)
  b11 marker.head_sha..HEAD_SHA 的 raw diff 通过现行 Python 惰性检查器(同一段代码,参数化 base)
                                                                      (baseline_increment_not_inert)
  全部通过 → no_code=true,打印 `ci-classify: lane: baseline run=<id> attempt=<n>`
```

不变量(继承现行合同):脚本**永远 exit 0**、恰好一行 `no_code=` 输出;通道二任何内部错误绝不 fail job;诊断行格式沿用 `ci-classify: fail-closed: <reason>`,通道二 reason 一律 `baseline_` 前缀;命中时的 lane 行是上线后对账的机器可读锚(§6)。

**为什么 b6 的 workflow 身份绑定不可省(R1-#3 的反例)**:artifact 查询是仓库全域的;一个 PR 可以自带第二个 `pull_request` workflow,复刻 11 个同名 success job 并上传同名标记 —— 只查 event/head/job 名会放行它,而真正的 ci.yml run 可能是红的。`run.workflow_id` + `run.path` 是 GitHub 维护的不可变归属,把候选钉死在 `.github/workflows/ci.yml` 本尊上。

### 1.1 钉死的 job census(11 个精确名)

`Unit (teamlead 1 of 3)` / `Unit (teamlead 2 of 3)` / `Unit (teamlead 3 of 3)` / `Unit (heavy)` / `Unit (light)` / `Script Tests 1/2 — cmux/session (shell suites)` / `Script Tests 2/2 — fleet/setup/packaging (shell suites)` / `NPM payload distribution (endpoint + release pipeline)`(以上 8 = 重 job)+ `Classify CI scope` / `Quick Gate (build + typecheck + lint)` / `CI OK`。

精确名整集相等,**禁止前缀/计数近似**(FLY-1987 R6-#6 的教训:`startsWith` + 计数被伪造名骗过)。矩阵改名 → 通道二失效并 fail-closed 全跑(安全方向),由 §4 的新守卫断言把「script census 与 ci.yml 漂移」直接变红提醒同步。

### 1.2 标记 schema v1

载重字段(消费端逐一使用):`schema`(=1)、`run_id`、`run_attempt`、`pr_number`、`head_sha`(PR head)、`base_parent_sha`(被测 merge commit 首父)、`ci_yml_blob`(被测树下 ci.yml 的 git blob sha)。
取证字段(**不参与 b1-b11,仅 forensics/日志**,文档与测试显式标注):`merge_sha`、`written_at`。

## 2. 标记写入(ci-ok job 的完整可执行形态,R1-#4 修订)

原则:**聚合断言 step 保持第一且是唯一权威**;其后所有 producer step 一律 `continue-on-error: true` —— 标记链路的任何失败(checkout / API / 上传传输)都只丢标记,**绝不影响 CI OK 的结论**。

```yaml
# step 1(现行,唯一权威,零改动): Verify all jobs passed
# —— 以下全部新增,失败不影响 job 结论 ——
- name: Checkout for baseline marker            # producer 需要仓库脚本;checkout 默认 ref 即被测 merge commit
  if: ${{ github.event_name == 'pull_request' && needs.classify.outputs.no_code != 'true' }}
  continue-on-error: true
  uses: actions/checkout@v4
- name: Write full-green baseline marker
  id: marker
  if: ${{ github.event_name == 'pull_request' && needs.classify.outputs.no_code != 'true' }}
  continue-on-error: true
  env:
    GH_TOKEN: ${{ github.token }}
    MERGE_SHA: ${{ github.sha }}
    PR_NUMBER: ${{ github.event.pull_request.number }}
    HEAD_SHA: ${{ github.event.pull_request.head.sha }}
  run: bash scripts/ci-baseline-marker.sh        # 成功写出 $RUNNER_TEMP/marker.json 时输出 written=true 到 $GITHUB_OUTPUT
- name: Upload baseline marker
  if: ${{ github.event_name == 'pull_request' && needs.classify.outputs.no_code != 'true' && steps.marker.outputs.written == 'true' }}
  continue-on-error: true
  uses: actions/upload-artifact@v4
  with:
    name: ci-baseline-pr${{ github.event.pull_request.number }}
    path: ${{ runner.temp }}/marker.json
    if-no-files-found: ignore
    overwrite: true
```

- `ci-baseline-marker.sh`:`gh api /commits/$MERGE_SHA` 取 parents —— **必须恰好 2 个**且 parents[1]==HEAD_SHA(否则不写);`gh api /contents/.github/workflows/ci.yml?ref=$MERGE_SHA` 取 blob sha;两个 GET 均 `contents: read`(ci-ok 顶层已有),均带 timeout;组装 §1.2 schema 写入 `$RUNNER_TEMP/marker.json` 并置 `written=true`;任何一步失败 → 不置 written,exit 0。
- **快车道 run 绝不写标记**(`no_code != 'true'` 条件);push:main 不写(event 条件)。
- 门控语义说明:`continue-on-error` 意味着 producer step 的 outcome 不影响 job conclusion,而 producer 的**执行**依赖 step 1 成功(前一 step 失败即终止后续非-always step)—— 聚合断言失败时 producer 不会跑。
- 成本:**预期**嵌在 ci-ok 已计费的 1 分钟内(checkout + 2 GET + 上传,预估 +15-25s);**是否真的零边际计费以 N0 实测为准**(§5),不预先声称。

## 3. 变更清单(文件级)

| # | 文件 | 改动 | 性质 |
|---|---|---|---|
| 1 | `scripts/ci-classify.sh` | 通道一逐字保留;追加通道二(§1);Python 检查器参数化复用 | 核心 |
| 2 | `scripts/ci-baseline-marker.sh` | 新增(写入侧,§2) | 核心 |
| 3 | `.github/workflows/ci.yml` | ① ci-ok 追加三个 producer step(§2);② **Script Tests 2/2 的「FLY-1861 CI cancellation and classification contracts」step 追加执行 `ci-baseline-marker.test.sh`**(满足 enumeration 守卫的字面调用要求,R1-#6);classify job 零改动(env 已在位) | 核心 |
| 4 | `scripts/__tests__/ci-classify.test.sh` | **台面化反转**「零 runs API / 零 gh/jq」断言(FLY-1877 v2 合同,FLY-1987 plan 已点名必须更新)→ 换成:mock-gh harness(可参考 `git show d839a92fa:` 的被删版本)+ §4 全部向量 + 「每个 fail_closed 带 reason」守卫保留 + 通道一现有向量全部保留;**preview-merge fixture 亲序修正为 `-p base -p head`**(与 GitHub 真实 merge commit 亲序一致,R1-#7) | 合同变更 |
| 5 | `scripts/__tests__/ci-structure.test.sh` | 同步 ci-ok steps 形状 pin:aggregate 仍是第一 step 且逐字不变;三个 producer step 的 if 条件、`continue-on-error: true`、upload 的 name/overwrite/if-no-files-found 逐字 pin;**新增**:从 ci.yml 解析 job 名全集与 `ci-classify.sh` 内钉死 census 比对,漂移即红 | 治理守卫同步(台面化) |
| 6 | `scripts/__tests__/ci-baseline-marker.test.sh` | 新增:写入侧单测(mock gh:双亲恰 2 / 单亲 / 三亲 / 亲序颠倒 / 父指针取不到 / blob 取不到 / JSON 形状 / written 输出语义) | 核心 |
| 7 | `engineering/doc/FLY-2000-doc-fast-lane/*` | 本设计文档族 + N0 spike 裁定书(`n0-spike.md`,§5)+ 对账附录(§6 落地后补) | 文档 |

不改:重 job 的 needs/if、quick-gate 永跑语义、ci-ok 聚合 jq、ship 侧一切、`ci-status-vectors.json`、`ci-shell-suite-enumeration.test.sh` 本体(新 suite 经 #3-② 的字面调用被枚举发现,无需改守卫文件;若实测枚举仍要求登记则按守卫指引登记并在 PR 里说明)。

**不新增任何 config/env 开关**(沿 FLY-1877 先例与 founder「不加新 flag」铁律):机制无条件生效,回滚 = git revert(已存在的标记变成无人消费的惰性文件,随 retention 自然过期,无需清理)。

## 4. 测试向量(全部红先行)

通道一现有向量**全部保留且必须继续绿**(通道一逐字未动的回归证明)。通道二新增:

| # | 场景 | 期望 |
|---|---|---|
| 1 | 快车道 run 当基线(mock:该 run 重 job skipped) | 拒,`baseline_not_full_green` |
| 2 | 真全绿 → 连续多个文档提交 | 全部 `no_code=true`,lane 行含 run/attempt |
| 3 | 真全绿 → 一个代码提交(未绿)→ 文档提交 | 累计增量含代码 → `baseline_increment_not_inert`,全跑 |
| 4 | 代码提交 failed/cancelled 后的文档提交(标记仍是旧全绿) | 同上,全跑 |
| 5 | 基线之后 base 漂移(HEAD^1 ≠ marker.base_parent_sha) | `baseline_base_drift`,全跑 |
| 6 | 基线之后 ci.yml blob 变化 | `baseline_ci_drift`,全跑 |
| 7 | force-push 改写历史(marker.head 不是祖先/不存在) | `baseline_not_ancestor`,全跑 |
| 8 | run 内嵌 PR 对象漂移(mock 返回漂移值) | 判定只用顶层 head_sha/标记字段,**不受影响**(阳性:仍命中) |
| 9 | re-run:marker.run_attempt=1 而 run.run_attempt=2 | `baseline_attempt_stale`,全跑 |
| 10 | **另一个 workflow 复刻 11 个同名 success job 并上传同名标记**(workflow_id ≠ ci.yml 的 id) | `baseline_wrong_workflow`,全跑(R1-#3 反例的负向锚点) |
| 10a | 正向 mock 用两种真实 API 形状各一:run.path 带 `@ref` 后缀 / workflow 对象裸路径 | 均命中(防 R2-#1 的「正向路径不可达」回归);path 畸形(如空 ref、前缀不符)→ `baseline_wrong_workflow` |
| 11 | API 报错 / 分页截断 / job 名不在 census / 未知 job 名混入 / artifact 归属 run ≠ marker.run_id / artifact head_sha ≠ marker.head_sha / pr_number 不符 / 过期标记 | 各自具名 reason,全跑 |
| 12 | 恶意/畸形载体:zip 多成员、成员是目录或 symlink、marker.json 超 64 KiB、zip 超 1 MiB、JSON 重复键、字段类型错(负数 run_id、大写/短 SHA)、schema 多键/缺键 | 各自具名 reason,全跑 |
| 13 | 网络挂起(mock gh sleep 超 timeout)/ 下载超限 | `baseline_timeout` / `baseline_oversize`,全跑;**classify 墙钟有界** |
| 14 | 当前 checkout 非双亲 merge(单亲 / 三亲 octopus / 亲序颠倒 fixture) | `baseline_merge_shape`,全跑 |
| 15 | 阳性对照的阳性对照:census 突变(mock 少一条 `Unit (light)`)| harness 自身必须能红(防空过绿) |
| 16 | 通道一仍先行:纯 docs PR 不触任何 API(mock gh 若被调用即 fail) | 通道一命中,零 API |

## 5. 实现节点的实弹验证(N0 硬门在前,R1-#1 修订)

实现 PR 内**证据有序**推进(它改 classifier + ci.yml → 自身每次推送全跑,恰好是 producer 试验台):

**N0 — producer-only spike(过不了 = 整案放弃,不实现 lane 2):**

| # | 步骤 | 通过判据 |
|---|---|---|
| N0-a | 只提交 producer(§2 三 step + marker 脚本)+ classify job 里一个**临时只读探针 step**(不影响 no_code 输出);推真实提交拿到一次真·全绿 | ci-ok 绿;`gh api …/artifacts?name=ci-baseline-pr<N>` 见标记;schema 逐字段合规;`expires_at - created_at` 读出真实 retention ≥ 7 天 |
| N0-b | 再推一个提交(任意),让**下一个 run** 的探针 step 用 **run 内的 GITHUB_TOKEN**(classify 同权限)跨 run 下载标记 | 探针日志:下载成功、artifact.workflow_run.id/head_sha 与标记一致(正向绑定);**b6 身份检查对真实 run 实证通过**(workflow_id 相等 + run.path 的真实返回形状落档,R2-#1);probe 用 `?name=ci-baseline-pr<不存在号>` 得 0(负向);wrong-workflow / wrong-attempt / malformed 负向由 §4 mock 向量覆盖(live 无法伪造他人 run,如实标注) |
| N0-c | 对**指定的那一个 run**(记下 run_id)触发 re-run(attempt 2)全绿 | **run-scoped** 端点 `/runs/{run_id}/artifacts` 恰一个标记且 payload 的 run_attempt == 2(overwrite + 当前-attempt 合同);**repo-scoped** name 查询另行落档:跨 run 同名共存数量与 created_at 排序实录(b2/b3 的「取最新」依赖它)——若实测跨 run 同名**不**共存,先改 b2/b3 与 research §4 再进 N1(R2-#3) |
| N0-d | 实测 ci-ok 计费分钟(producer 加入前后) | 记入 `n0-spike.md`;若 +1 计费分钟,如实入账并重估净省 |

N0 全过 → 在 `n0-spike.md` 落**可行裁定书**;任何一条不可修复地失败 → 裁定「本平台做不出可信标记,P1 放弃」,revert producer,关单(上游明文的合法出口)。

**N1 — 消费端(N0 过后)**:实现通道二 + 全部 §4 向量;移除临时探针 step。

**N2 — 实弹对照(合入门):**
- V2 阳性:全绿后推 doc-only 提交 → 通道二命中、重 job skipped、CI OK 绿,**且该快车道 run 自身未产生任何新 artifact**(API 断言,防 producer 门控回归);
- V3 阴性:全绿后推含代码提交 → 全量套件跑(**未演示不得合入** —— issue 红线);
- 撞不上「main 未动」窗口时按 FLY-1861 同款 sacrificial docs PR 补撞。

## 6. 上线后一周对账(issue 验收 3)

- 窗口:合入后第 7 天,取完整 7×24h 半开区间,复用 FLY-1987 附录 A.2 的采集命令 + `derive-lib.mjs` 口径产出台账(`fast_path` 按 (run, attempt) 维度)。
- **通道归因**:对每个 fast_path 尝试,拉 classify job log(`/jobs/{id}/logs`,actions:read),grep `ci-classify: lane: baseline` 行区分「通道一命中 / 通道二命中」;通道二未命中样本统计 `baseline_*` reason 分布(哪条件最常拦)。
- 交付:`engineering/doc/FLY-2000-doc-fast-lane/week1-ledger.md` —— 命中率、省下的计费分钟、与 $116 上限的差距及归因;数字口径与 FLY-1987 台账一致(毛额/净省分列,不许把上限当实收)。
- 责任:对账是**独立后续节点**(Lead 排期),本 PR 只交口径与命令;不为对账加任何生产代码。

## 7. 风险与边界(诚实清单)

1. **最高风险 = 误放行**(动了代码没测)。防线:消费端从权威 API 重验全绿(标记自述不可信)、workflow 身份绑定(b6)、增量 diff 走与通道一同一个检查器、11 项精确 census、载体形状与类型全校验、全部不确定分支 fail-closed、V3 实弹阴性对照做合入门。
2. **FLY-1996 是硬前置**(§0.1):不落地不 merge。
3. **命中率未知**:base-未漂移条件对高频 merge 的 main 可能很苛刻;$116 是上限。一周对账(§6)给真数;若命中率≈0,candidly 报给 founder,后续放宽是**她的**另一个决定,不在本单。
4. **producer 是 best-effort**:checkout/API/上传的偶发失败只丢标记(命中率损失),CI OK 结论不受影响 —— 这是刻意取舍,反向(为标记失败而红掉全绿 CI)不可接受。
5. **信任边界不扩大**:同仓 PR 改 ci.yml 自证清白是既有信任类(research §6);b6 把「用别的 workflow 造标记」从「既有信任类内的新捷径」收回到「必须直接改 ci.yml 本尊」——与今天改空 CI 的能力完全同类。
6. **API 语义漂移**:schema 校验 + fail-closed → 退回全跑,不会误放行。
7. **FLY-1861 覆辙对照**:v1 三病(易碎「最新 completed」指针 / base 漂移即全废且无持久性 / 信活指针字段)逐条被(持久标记 / 标记长存 retention 窗 / 只记本地事实+API 重验)对症;纯 docs PR 走通道一不退化。
8. **ci-ok 形状变化**:结构守卫同步是显式交付物(§3 #5),PR 描述单列「治理守卫改了什么、为什么」。

## 8. 验收映射(issue 三条)

| Issue 验收 | 落点 |
|---|---|
| 1. 阳性对照:纯文档提交走快车道 | §4 向量 2 + §5 N2-V2 实弹 |
| 2. 阴性对照:掺代码必走全量 | §4 向量 3/4 + §5 N2-V3 实弹(合入门) |
| 3. 一周对账入台账(derive-lib 口径) | §6(独立后续节点,口径与命令随本 PR 交付) |

## 9. 实现节点自验(全仓门,executor 常规)

`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`;`bash scripts/__tests__/ci-classify.test.sh`(新旧向量全绿);`ci-structure.test.sh` / `ci-matrix-coverage.test.sh` / `ci-shell-suite-enumeration.test.sh` 本地全绿(结构守卫 diff 台面化);`ci-baseline-marker.test.sh` 全绿;shellcheck 两个新脚本;FLY-1996 落地后的守卫在 rebase 后复跑。

## 10. 不做什么

- 不放宽 base 漂移(纯 docs PR 的漂移容忍是通道一既有语义,不外溢到含代码 PR);
- 不做跨 PR 基线、不做标记 GC(retention 兜)、不加开关、不动 P0(后缀白名单)/P3(artifact 构建复用)——各自独立单;
- 不把 FLY-1996 吸进本单(只做依赖门);
- 不碰 quick-gate 永跑语义与重 job 图;
- 不在本单做对账自动化(§6 只交口径)。
