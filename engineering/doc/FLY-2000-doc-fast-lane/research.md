# FLY-2000 文档快车道 — 调研(识别判据可行性验证,P1-a spike)

Issue: FLY-2000 (https://linear.app/geoforge3d/issue/FLY-2000/ci省钱-文档提交走快车道纯文档提交只跑快速检查fly-1987-p1founder-立单先做识别判据可行性验证)
日期: 2026-08-23
基于: exploration.md

---

## 0. 本文回答什么

Issue 的硬性前置:「先做一轮可行性验证:识别判据必须有阳性/阴性对照」。FLY-1987 plan 把它具体化为 **P1-a spike**:定死标记的「何时写 / 写什么 / 写在哪 / 怎么认证 / 保留与过期 / 怎么读」六项,任何一项定不下来 → P1 放弃。

**结论先行:六项规格全部在纸面定死(§4),纸面可行;但「可行」的最终裁定悬于一段实弹残段** —— artifact 在本仓库设置下的真实写入 / 跨 run 读取 / retention,只能在真实 run 里验。它被折为实现节点的 **N0 producer spike 硬门**(§5,plan §5 展开):N0 不过 → lane 2 不实现,整案走「放弃」出口(上游 FLY-1987 plan 明文的合法产出之二)。本文**不**声称 P1-a 已完成;它完成的是 P1-a 里所有只读可证的部分,并把剩余部分变成了带判据、带失败出口的实验步骤。

所有探针均为**只读**(`gh api` GET),未向生产仓库写入任何东西。探针执行时刻:2026-08-23,仓库 `xrliAnnie/flywheel`,本地 head = origin/main `f2eecf495`。

## 1. 现状审计(实读代码,不是转述)

### 1.1 现行分类器(`scripts/ci-classify.sh`,84 行,FLY-1877 形态)

- 输入仅 `HEAD_SHA`/`BASE_SHA`;判据 = merge-base 全量 diff 惰性(四前缀 × 13 后缀,拒 symlink/gitlink,`--no-renames`);merge-base 必须唯一;一切失败分支 `fail_closed <reason>` → `no_code=false` + exit 0。
- **ci.yml 已经在给它传 `GH_TOKEN`/`GITHUB_REPOSITORY`/`PR_NUMBER`**(ci.yml:42-47)—— FLY-1877 plan §4 第 4 项本要删掉这些 env,实际 merge 的 #883 只改了脚本没改 ci.yml 的 env(实读确认)。对本单是顺风:通道二需要的 env **已经在位,ci.yml 的 classify job 一行都不用为 env 改**。
- classify job 权限 = `{contents: read, actions: read}` **精确相等**被 `ci-structure.test.sh:106-109` 钉死。`actions: read` 是 FLY-1877 后的无害残留 —— 恰好是通道二读 runs API / artifact 所需的权限,**不需要任何扩权**。
- checkout `fetch-depth: 0`(守卫钉死)→ 消费端做祖先检查、读 `HEAD^1`(当前被测 base)全部本地可得,零 API 成本。

### 1.2 结构守卫与测试合同(改动必须台面化的清单)

| 守卫 | 钉了什么 | P1 是否必改 |
|---|---|---|
| `ci-structure.test.sh`(880 行,跑在常开 Quick Gate) | job 集合、四个重 job `needs==["classify"]` + `if: no_code != 'true'`、classify 权限/fetch-depth/step 形状、ci-ok needs 精确集合 + aggregate jq 逐字 | **必改**:ci-ok 新增标记 step(§4 位点);job 集合与重 job 语义不动 |
| `ci-classify.test.sh:241-263` | **「classify 零 runs API、零 gh/jq 调用」**的 grep 断言(+ 阳性对照)—— FLY-1877 v2 简化时加的 | **必改并反转**:这是 FLY-1987 plan 点名的合同变更(「这些断言必须更新」),PR 里显式说明,不许静默 |
| `ci-shell-suite-enumeration.test.sh` | 每个 shell suite 必须被 CI 枚举 | 不改(不新增 suite 文件名的情况下) |

### 1.3 ci-ok 的真实形状(写入位点的宿主)

单 step job:jq 聚合断言(quick-gate+classify 必 success;四重 job success 或 `no_code=true` 时 skipped),`if: always() && !cancelled()`,无 checkout(ci.yml:944-967)。全量 run 的 job 总数 = **11**(5 Unit 矩阵 + 2 Script Tests + 1 payload + classify + quick-gate + ci-ok),与探针 P2 实测一致(§3.2)。

### 1.4 FLY-1861 v1 的病根代码证据

`git show d839a92fa:scripts/ci-classify.sh` L78:baseline 校验读的是 runs API 返回的 `.baseSha` —— 正是 FLY-1987 §4.5 实测**事后会漂移成 PR 当前值**的活指针字段。v1 的「base 未漂移」检查建立在一个不可信来源上;这坐实了 exploration §2 的病根归因,也是本设计「标记只记写入时刻本地事实、消费端从权威 API 重验」的直接依据。

## 2. 上游已入库的实测(引用,不重做)

- **run 顶层 `head_sha` 是历史值**(每 run 不同,可信);**run 内嵌 PR 对象是活指针**(历史 run 的 `pull_requests[0].head/base.sha` 全部已变成 PR 当前值);check-suite `before/after` 返回 null。— FLY-1987 research §4.5,对 PR #922 逐 run 实测,数据经 R5–R11 七轮外部评审未被推翻。
- **P1 净省上限 $116/月**(R6 口径;issue 文本的 $135 是 R5 中间值)。上限成立的前提里有两个未验证的收窄条件(增量真惰性、base/ci.yml 未变),真实值必然更低。— FLY-1987 research §4.2。
- **快车道 run 的 CI OK 也是 success**(`ci-ok` 显式接受 `no_code=true` 时重 job skipped)⇒「CI OK 成功」**不能**单独当合格基线判据(自举漏洞)。— FLY-1987 plan §P1-b,R1 finding。

## 3. 本单新增探针(全部只读,2026-08-23 实测)

### 3.1 P1:artifact API 面

```
GET repos/xrliAnnie/flywheel/actions/artifacts?per_page=3      → 200, total_count=0
GET repos/xrliAnnie/flywheel/actions/artifacts?name=ci-baseline-pr933 → 200, total_count=0
```

端点与 name 精确过滤查询形状可用;仓库当前**没有任何 artifact**(没有 workflow 在上传,亦无残留)——即标记命名空间干净,不存在与既有 artifact 撞名的问题。**注意 total_count=0 只说明「现在没有」,不证明「传得上去」**;上传路径(`actions/upload-artifact@v4`,用 runtime token,不走 GITHUB_TOKEN 权限)与跨 run 下载(`actions: read`)的官方语义明确,但本仓库/org 设置下的实跑留给 §5 的带判据验证。

### 3.2 P2:按尝试的 jobs 端点(消费端重验的权威来源)

真实多-attempt run `32639302310`(head `2a4ac0ee`,event=pull_request,最新 attempt=2):

```
GET .../actions/runs/32639302310/attempts/1/jobs?per_page=100
→ total_count=11;jobs[].run_attempt=1(attempt 维度正确,不是 run 级);首 job "Classify CI scope" conclusion=success
```

attempt 维度的 job 结论可精确取回,全量 run 恰 11 个 job 与 §1.3 推导一致。「恰好 5+2+1 无 skipped + CI OK success」的合格全绿判定在这个端点上可实现。

### 3.3 P3:test-merge commit 的父指针(「被测 base」的可靠读法)

开着的 PR #901:

```
GET pulls/901 → base.sha = e318f24a…, head.sha = 1da66065…, merge_commit_sha = 4ca34d10…
GET commits/4ca34d10… → parents = [320fd3358…, 1da66065…]
```

- parents[1] == PR head ✅(次父 = head);
- **parents[0] = 320fd3358 ≠ PR 对象的 `.base.sha` e318f24a** —— PR 对象字段连「当前被测 base」都不可靠(有自己的懒更新语义),**merge commit 首父才是被测 base 的权威**。

⇒ 写入侧记「被测 base」的正确来源 = `GET commits/{github.sha}` 的 parents[0](1 次 API 调用,`contents: read` 即可,本探针即用该 scope 成功);消费侧的「当前被测 base」= classify checkout 里的 `git rev-parse HEAD^1`(classify 检出的就是 merge commit,fetch-depth 0,零 API)。两侧同源同义,可直接比较。

另:PR #933(冲突态,mergeable=false)的 `merge_commit_sha` 持续为 null —— 写入侧对「拿不到父指针」也要 fail-closed(不写标记),已入 §4 规格。

### 3.4 P4:生产先例 —— classify token 调 runs API 曾在生产真跑过

FLY-1861 v1 的分类器(`git show d839a92fa:scripts/ci-classify.sh` L30)就在 classify job 里用同一个 GITHUB_TOKEN + `{contents: read, actions: read}` 权限调 `gh api …/workflows/ci.yml/runs` 12 页翻页,生产运行且真实跳过了 64 轮(FLY-1877 plan §1 记录)。**「classify 里用这个 token 读 Actions API」不是假设,是有生产历史的**。

## 4. Spike 裁定:六项规格(全部定死)

| 项 | 规格 | 依据 |
|---|---|---|
| **何时写** | ci-ok 聚合断言 step 成功之后的后续 step;`if: needs.classify.outputs.no_code != 'true'`(**快车道 run 绝不写**);任何字段取不到(如父指针 API 失败)→ 不写,不失败 job | §1.3、§2 自举漏洞、§3.3 null 形态 |
| **写什么** | schema v1 JSON:`{schema:1, run_id, run_attempt, pr_number, head_sha(PR head), base_parent_sha(=commits API parents[0],且父指针必须恰 2 个、parents[1]==head 自检), ci_yml_blob(=contents API 在 merge_sha 下 .github/workflows/ci.yml 的 git blob sha)}` + 两个**仅取证不消费**的字段 `merge_sha`/`written_at`(文档显式标注)。**不含 job 结论** —— 消费端从权威 API 重验,标记自述不可信 | §3.3、§1.4 教训 |
| **写在哪** | Actions artifact,name = `ci-baseline-pr<PR_NUMBER>`,`overwrite: true`(同 run 重跑 attempt 覆盖旧标记,保证一 run 一标记且指向最新 attempt);跨 run 同名共存,消费端取最新 | §3.1 |
| **怎么认证** | 结构绑定:artifact 隶属的 `workflow_run.id` 必须 == 标记自述 `run_id`,`workflow_run.head_sha` == marker.head_sha(artifact 归属是 GitHub 维护的,不是内容自证);**workflow 身份绑定**:run.workflow_id == ci.yml 的 workflow id(**载重检查**;否则 PR 可自带第二个 workflow 复刻 11 个同名 success job 铸假标记 —— design review R1 反例);run.path 作规范化副检 —— 接受裸 ".github/workflows/ci.yml" 或 ".github/workflows/ci.yml@<非空 ref>"(官方 workflow-run 返回带 @ref 后缀、workflow 对象返回裸路径,两种形状都进 mock;b6 身份检查还须在 N0-b 对真实 run 实证 —— R2-#1);`marker.run_attempt` 必须 == 该 run **当前** `run_attempt`(拒绝「attempt 1 绿、attempt 2 红」的旧标记);该 attempt 的 jobs 从 `/runs/{id}/attempts/{n}/jobs` 重验:恰 5 Unit + 2 Script + 1 payload 全 success 无 skipped、`CI OK` success、`Classify CI scope` success;`marker.pr_number == PR_NUMBER` 且 run 的 `head_sha == marker.head_sha` | §3.2,R1-#3 |
| **保留/过期** | 随仓库 artifact retention(默认 90 天;**本仓库实际值 API 读不到、且当前无 artifact 可测 expires_at,留 §5 实跑读取**)。过期/缺失 = 全跑 —— 只伤命中率,不伤安全 | §3.1 |
| **怎么读** | `GET /actions/artifacts?name=ci-baseline-pr<N>`(精确过滤)取**最新一个**候选;分页有界、读不全 = 全跑;**每个网络调用带 timeout、下载带字节上限**;zip 恰含一个普通成员 marker.json(尺寸有界),JSON 拒重复键、schema 键集合严格相等、字段全类型校验;任何 HTTP 错误 / 超时 / 超限 / 形状不符 / 解析失败 → 全跑 | §3.1,R1-#5 |

上游 plan 的裁定语:「任何一项:缺失 / 过期 / 格式错 / 对不上 → 跑全量」—— 全表继承。

**为什么「只取最新一个候选」是完备的**:标记的 base 只会随时间前进(main 不回退);若最新标记的 base 已不等于当前 base,更旧的标记只会更旧,同样不等 → 逐个回溯没有收益,只有 API 成本与复杂度。唯一例外是 force-push 改写历史让最新标记的 head 不再是祖先 —— 此时 fail-closed 全跑,正确且符合上游验收场景 7。

## 5. 留给实现节点的带判据验证(spike 的 live-fire 残段,R1 后收紧为 N0 硬门)

实现 PR 自己就是天然试验台(它改 `scripts/ci-classify.sh` + `ci.yml` → 全量 diff 非惰性 → 每次推送都全跑)。设计评审 R1-#1 正确地指出:上传路径未实证前不得实现消费端。故实现节点**证据有序**:

- **N0(producer-only spike,硬门)**:先只落 producer + 临时只读探针 —— 真·全绿写出标记(schema/retention 实读)→ 下一 run 用 run 内 GITHUB_TOKEN 跨 run 下载并验正/负绑定(含 b6 workflow 身份对真实 run 的实证)→ 对指定 run_id re-run 验 overwrite/当前-attempt 合同(run-scoped 端点断言)→ 实测 ci-ok 计费分钟。**N0 任一条不可修复地失败 = 「本平台做不出可信标记,P1 放弃」**(上游 spike 两种合格产出之二),revert producer 关单。N0 可在 FLY-1996 落地前推进(producer 永不跳过任何 job)。
- **N1(消费端)**:N0 过后才实现通道二;**且必须在含 FLY-1996 landing commit 的 base 上开工**(先 rebase 并跑绿其守卫)。
- **N2(实弹对照,合入门)**:V2 阳性(doc-only 提交走通道二,且快车道 run 自身零新 artifact)+ V3 阴性(**含代码提交必全跑,未演示不得合入** —— issue 红线);证据必须产生于含 FLY-1996 的 base,**N2 之后再 rebase 则 V2/V3 在最终 head 重放**。撞不上「main 未动」窗口时按 FLY-1861 同款 sacrificial docs PR 补撞。

逐步骤判据表见 plan §5。

## 6. 诚实边界(本文证明不了什么)

- **证明不了命中率**:base-未漂移条件的真实命中率取决于「全绿 → 文档推送」窗口内 main 的移动频率,只有 issue 验收 3 的上线后一周对账才能量出。$116/月 是上限,不是预期。
- **证明不了本仓库 artifact 写路径**(§5 N0 承接,失败出口明确)。
- **前置依赖**:FLY-1996(doc-被-CI-消费的安全洞)在 base `f2eecf495` 尚未落地(`launchd-units-manifest.test.sh:836` 仍消费白名单内 runbook);通道二会放大该洞暴露面。时序合同(plan §0.1):N0 可先行;**N1 激活与 N2 证据必须基于含 FLY-1996 landing commit 的 base**;N2 证据之后的任何 rebase 都要求 V2/V3 在最终 head 重放。
- **不新增信任边界,但也不缩小**:同仓 PR 可改 ci.yml/quick-gate 自证清白是既有信任类(今天就存在,由 founder-gated ship + review 管理);标记里唯二「说了就算」的字段(base 首父、blob hash)由 run 时的 workflow 写入,伪造它们需要的能力(改 workflow 文件)与今天直接把 CI 改成空转所需的能力完全相同,不构成新增攻击面。
- **探针时效**:§3 的 API 行为是 2026-08-23 的实测;GitHub API 语义漂移(如 artifact 归属字段变化)会让判据失效 —— 消费端 schema 校验 + fail-closed 保证「失效 = 退回全跑」而非误放行。
