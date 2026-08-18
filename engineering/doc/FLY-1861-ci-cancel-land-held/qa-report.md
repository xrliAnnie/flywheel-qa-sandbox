# FLY-1861 落地期 CI 掐断 + land held 死角 — QA 验证报告

Issue: FLY-1861 (https://linear.app/geoforge3d/issue/FLY-1861/infraci-落地期间-runner-推台账-commit-掐掉在跑的-cicancel-in-progress-ship-merge)
日期: 2026-08-18
基于: plan.md

被验 PR: #881(非 draft)。被审代码 head: `ac92780fa5680f45073c9dab71dcf59488c468e5`;
QA 期间我自己的台账 / 报告 commit 把 head 推到了 `b487220e0` 及之后 —— **产品代码零变化,
只多了 `engineering/doc/FLY-1861-*/` 下的 `.md`**。每条证据都标了它跑在哪个 head 上。

---

## 0. 结论

**PASS。** 三条验收在真机 / 真数据上都拿到了正面证据,没有正确性或安全缺陷。
4 条 advisory 见 §5,都不影响本单要解决的问题,但其中「省钱这半不是每次都命中」值得把金额口径修一下。

一句话:事故那条链的两个断点都真的接上了 ——
ship 不再在固定时刻撞一次 branch protection(会等 exact head 的真结论,还会把被顶掉的那轮催熟一次),
held 也真的有出口(我用生产快照把本单症状的 #868 / #871 两张单捞回来并让它们继续跑起来了)。

---

## 1. 覆盖矩阵

| 轨 | 面 | 方式 | 结果 |
|---|---|---|---|
| A | 等 exact-head CI 结论 | 单测 11 + **真机对 PR #881 实跑(等到转绿)** | PASS |
| A | 被 cancel 的轮次催熟一次 | **真机实跑:真 cancelled 轮 → 恰 rerun 一次 → 转绿 → exit 0** | PASS |
| A | receipt v2 / merge 失败分类 | 单测 12 类 + **3 处变异全变红** | PASS |
| A | 「砍掉 ship 自跑测试」的安全前提 | **真生产 branch protection 实查** | PASS |
| B | held → resume 收敛出口 | 单测 132 + **生产快照 18 张真单逐张实跑** | PASS |
| B | resume 之后真的还能跑 | **生产真单 + 真引擎鉴权(GitHub I/O 打桩)** | PASS |
| B | legacy held → Discord 告警 | **真 Discord 投递(隔离频道)+ 生产目录零污染** | PASS |
| C | 无代码推送跳重格子 | 单测 18 + **真机实测:重 job 全 skipped、CI OK 绿、整轮 3m22s** | PASS |
| C | `cancel-in-progress` 原样保留 | `ci-structure.test.sh` + **4 处变异全变红** | PASS |
| C | symlink/submodule mode 闸 | 直测闸本身 + 变异检验 | 闸有效,**测试空过绿**(advisory) |

代码本体的常规硬门(build / typecheck / lint / 全量单测 / script-tests / payload)
由 PR 自己的 CI 在被审 head `ac92780fa` 上全绿覆盖(run `32128074538`,9/9 success)。
我没有在生产宿主上重跑全量套件(会把负载顶到影响生产 Bridge),CI 那份是更权威的证据。

---

## 2. Track A — 等 exact-head CI(PASS)

### 2.1 真机 · 等到转绿

用真 `gh` 对真 PR #881 跑 `scripts/ship-await-ci.sh`(预算 1500s / 轮询 30s):
起跑时 head `ac92780fa` 的 CI 正在跑,脚本一路等、不误判、不乱 rerun;
该轮 `CI OK` 转 success 后 `exit 0`,`$GITHUB_OUTPUT` 写 `outcome=success`。

### 2.2 真机 · 被顶掉/超时的轮次被催熟一次(本单最核心的一发)

这一发是**真现场**,不是构造的:

1. 我推了一个纯 docs commit(head `b487220e0`),第一轮 CI 回退成全跑,
   `Unit (heavy)` 跑了 **15m17s** 撞上 `timeout-minutes: 15` → 该 job cancelled →
   整轮 `completed / cancelled`,`CI OK` = **failure**。
   **旧行为下,这一刻发 `:cool:` 就是 405 + `ship_workflow_failed` + held —— 正是本单的事故形态。**
2. 拿这个真 cancelled 现场跑 `ship-await-ci.sh`(`HEAD_SHA=b487220e0`):
   - 脚本判定 exact head 上最新一轮 conclusion=cancelled;
   - **恰好发一次** `gh run rerun`(run 32129849710 转 queued);
   - 继续等,rerun attempt 的 `CI OK` 转 success;
   - `exit 0` / `outcome=success`。

一次 rerun 上限、真红零 rerun、head 漂移 fail-closed 三条由单测 + 变异守住(见 2.4)。

### 2.3 前提核实:branch protection 真的要 `CI OK`

砍掉 ship 里的 `pnpm test` 是否安全,取决于合并那一刻 GitHub 自己拦不拦。实查生产:

```
required_status_checks.contexts = ["CI OK"]
enforce_admins = true
required_pull_request_reviews = true
```

`enforce_admins=true` ⇒ 管理员也绕不过 `CI OK`。前提成立。

### 2.4 判据本身会不会失败(变异检验)

`ship-await-ci.test.sh` 11 项基线绿;注入 3 个真缺陷全部被抓:

| 注入 | 结果 |
|---|---|
| 允许无限次 rerun | RED — one ship attempt never reruns CI more than once |
| 把真 CI failure 当可 rerun | RED — true CI failure is terminal and never rerun |
| 去掉 head 漂移闸 | RED — head drift fails closed before merge |

`ship-report-failure.test.sh` 同样 3 处变异(405 required-check 归并 / 去掉 await 映射 /
receipt 去掉 `failed_step`)全变红 ⇒ 不是空过绿。`ship-merge-token.test.sh` T1–T3 仍绿(SHIP_PAT 合同没动)。

### 2.5 没验到的(诚实边界)

真机没有走到 **merge 那一步**(走到就是真把这个 PR 合了);merge 分支只由 receipt 生产者合同测试覆盖。

---

## 3. Track B — held 有出口(PASS,用的是真数据)

### 3.1 生产现状普查(只读)

对生产 `~/.flywheel/teamlead.db` 做 `sqlite3 -readonly … VACUUM INTO` 快照(生产库字节未变),
`land_operation` 53 行,其中 **held 18 行**:

| last_error | 张数 |
|---|---|
| `ship_workflow_failed:failure` | 12 |
| `pr_head_mismatch` | 5 |
| `linear_lookup_failed_retryable` | 1 |

**18 张全部是 engine-owned(`run_id` 非空)** ⇒ 本单新加的 legacy `land_alert_outbox`
目前在生产里**一个主体都没有**。
另:那 12 张的 `last_error` 恰好都是 `ship_workflow_failed:failure`(旧 receipt 没有 `failed_step`),
新分类表把它判 terminal = 与现状字节兼容,与计划一致。

### 3.2 拿真代码在快照上逐张 resume

用本分支 built dist 的 `StateStore.resumeHeldLandOperation` + `land-executor` 前置校验,
对 18 张逐张实跑(PR 状态取自真 GitHub):

| 结果 | 张数 | 明细 |
|---|---|---|
| **RESUMED** | 5 | FLY-1751/#835、FLY-1827/#867、FLY-1844/#865(PR 已 MERGED ⇒ 只补 finalization,`ship_attempt` 不动 = 零重发 `:cool:`);**FLY-1828/#868、FLY-1808/#871**(PR 仍 OPEN 且 head 逐字相同 ⇒ `ship_attempt` 0→1 = 会重发一次 `:cool:`) |
| REFUSED | 13 | 10 张 `resume_refused:pr_head_mismatch`(PR 已在**更新的 head** 上合掉,approved_head 过期);3 张 `resume_refused:engine_run_not_held`(`workflow_run.status` 已是 `terminated`) |

**本单症状那两张(#868 FLY-1828 / #871 FLY-1808)都在 RESUMED 里。**
5 张 resume 后 `land_operation.state=partial` **且** `workflow_run.status=active`(双表一个事务);
`resume_authorized:1` 审计 receipt 带 actor / reason / 旧 last_error / 旧 retry_count / 旧 epoch key。

13 张拒绝每条都站得住,且**都没有丢工作**(那些 PR 全部已 MERGED)。

### 3.3 resume 之后真的还能跑(不是只翻个状态位)

对 #868 / #871 两张**真生产行**跑真 `executeLandOperation`(真引擎鉴权,只把 GitHub I/O 打桩):

```
FLY-1828 #868  before=partial/attempt=1  result=partial:ship_workflow_pending  cool_posts=1
FLY-1808 #871  before=partial/attempt=1  result=partial:ship_workflow_pending  cool_posts=1
steps=[…, cool_triggered, cool_triggered:attempt=1, …, resume_authorized:1]
```

- 鉴权过了(不是 `land_target_not_current` —— 这正是单表 CAS 修不掉的那个坑);
- 恰好发**一次**新 `:cool:`,落在新 receipt 键 `cool_triggered:attempt=1`;旧 attempt-0 的 `cool_triggered` 自然作废;
- 同一行再跑一遍(模拟 crash/replay):`cool_posts=0` —— receipt 复用,零重复发。

### 3.4 真 Discord E2E(本 diff 唯一的新 Discord 发送面)

新增的 Discord 发送路径只有一条:legacy held → `land_alert_outbox` →
`WorkflowEngineDispatcher.reconcileLegacyLandAlerts` → `LeadAlertNotifier` → Discord。
用真编译产物 + 真 bot token 投到 **FLY-529 隔离频道 `#test-flywheel-alerts`**(生产频道零触碰):

- 真 `releaseLandOperationWithRetryAccounting` 把 legacy 单判 held,**同事务**入 outbox(`pending/attempt=0`);
- 真 dispatcher 抽干 → 真 Discord POST 200 → outbox 变 `sent/attempt=1`;
- 从 Discord **读回**渲染结果确认到货,正文带可执行恢复指引 `POST /api/lifecycle/land/<id>/resume`;
- 失败路径也真跑到了:首次投递因 bot 无权返 403,outbox 正确停在
  `pending/attempt=1/last_error=alert_not_delivered`(租约重投语义成立)。

**隔离守卫**:生产 `~/.flywheel/alerts/claims.db` md5 前后逐字相同(`aa093861…`),
`alert-deadletter` 4109→4109、`alert-queue` 0→0;两条失败投递全落在隔离目录。

### 3.5 没验到的(诚实边界)

- **没有真的 resume 生产库** —— 那是计划 §6 的运维步骤(Tadashi / founder),不归 QA;以上全部在只读快照上做。
- 没有让 #868 / #871 真发出 `:cool:` 去合并(会真动生产 PR)。
- legacy `land_alert_outbox` 在生产里**目前没有任何住户**(18 张全 engine-owned)⇒ 机制已验,暂无真实主体。

---

## 4. Track C — CI classify(PASS)

### 4.1 真机 · 无代码推送真的跳过了重格子

同一个 commit `b487220e0`(累计 diff 逐字只有两行,都在白名单前缀 + `.md` 后缀、mode 100644):

```
:100644 100644 M  engineering/doc/FLY-1861-ci-cancel-land-held/progress.md
:000000 100644 A  engineering/doc/FLY-1861-ci-cancel-land-held/qa-report.md
```

| 轮次 | classify | 重 job | CI OK | 墙钟 |
|---|---|---|---|---|
| `b487220e0` attempt 1(11:03) | 未输出 true → 回退全跑 | 全跑;`Unit (heavy)` 15m17s 撞 15 分钟 timeout → cancelled | **failure** | ~20 分钟 |
| `b487220e0` attempt 2(11:24) | **true** | `Script Tests` / `Unit` 矩阵 / `NPM payload` **全 skipped** | **success** | **3m22s** |
| `6ff8b3011`(11:31,另一个纯 docs 推送) | **true** | 同上全 skipped | **success** | **3m15s** |

后两轮就是 FLY-1866-A 的省钱现场:整轮 3 分出头、`CI OK` 照常绿。
聚合门在「重 job skipped ∧ no_code=true」时正确判绿,这条是合并路径能不能用的关键,已实测两次。

### 4.2 但它对同一个 commit 不是每次都命中(advisory,见 §5.1)

同一个 commit 两次 attempt 的 git 输入逐字相同、base 相同,结论却不同。唯一变化的是 GitHub 侧的 run 历史可见性:
attempt 1 跑在 11:03:57,而作绿基线的那轮 `32128074538` 是 11:01:50 才刚完成(只早 2 分 07 秒);
attempt 2 跑在 11:24:32,那轮已完成 22 分钟。第三轮(`6ff8b3011`,基线已完成 7 分钟)也正常命中。
领先解释(**假设,未证实**):runs 列表接口尚未反映刚完成的绿轮,于是「时序最新的已完成轮」
落到更早那条 cancelled 上 → 按设计 fail_closed。3 次观测里 1 次没命中,且那 1 次的基线是最新鲜的那次。

我排除了这些:输入 env 逐字相同(取自 CI 日志)、`jq` 版本相同(两边 1.7.1)、
`gh` 参数退化(去掉 `event`/`per_page` 也照样解析得出基线)、git 对象缺失
(`ac92780fa` 是 `b487220e0` 的祖先、后者是 merge ref 的父,`fetch-depth: 0` 必然带到)。

**它是 fail-closed 的** —— 所有不确定都走全跑,`ci-ok` 只在 `no_code=='true'` 时才接受 skipped
⇒ 不影响合并安全,只影响省钱命中率。

### 4.3 验收 3(`cancel-in-progress` 保留)—— 是会失败的检查

`ci-structure.test.sh` 基线绿;注入 4 个真改动全部被抓:

| 注入 | 结果 |
|---|---|
| `cancel-in-progress: false` | RED — cancel-in-progress must remain true |
| 去掉 unit-tests 的 `if` 闸 | RED — unit-tests must run unless classify proves no_code=true |
| 聚合门退回旧 `all(.result=="success")` | RED — ci-ok aggregate must accept heavy-job skips only when no_code=true |
| 把 ci-structure 守卫挪回 script-tests | RED — must run exactly once in the always-on quick-gate |

守卫更新本身已按 Lead 要求在计划 §5.1 台面化理由 ⇒ 合规路径走对了。

### 4.4 classify job 自身的成本

实测 17 秒(checkout 7s + 脚本 5s)。三个重 job 现在 `needs: [classify]`,
每轮多约 20 秒串行 + 一个 runner job —— 命中时省 17 分钟,不命中时净亏这 20 秒。

---

## 5. Advisory(都不阻塞 ship)

### 5.1 [MEDIUM · 只影响省钱] 命中率会低于 FLY-1866 的估算

除了 §4.2 那条可见性窗口,还有一条结构性的:计划 §5.2 要求「时序最新的已完成轮 conclusion=success」。
而本单描述的那个场景 —— **轮次还在飞时推台账 commit** —— 里,在飞那轮会被 `cancel-in-progress`
掐成 `completed/cancelled`,它就成了最新已完成轮 ⇒ 这类推送基本拿不到 skip。
真正稳定吃到省钱的是「PR 已经全绿之后再推 docs」。
所以 FLY-1866 数据里那 41–42% 的无代码推送,实际能命中的是其中一个子集,
**建议把 $207/月 按这个口径重新给一个区间,别按 41–42% 全量记账。**(不是缺陷,是口径。)

### 5.2 [LOW] `ci-classify.sh` 对 fail_closed 零输出

8 条 `fail_closed` 分支全部静默退出 0,CI 侧完全读不出是哪一条把它拦下的。
我第一次就是因此只能靠猜,并且猜错了(先报了一个「权限」假设,被复验推翻)。
建议每条 `fail_closed` 往 stdout 打一行原因 —— 一行的成本,换回可诊断性。

### 5.3 [LOW] 一条空过绿的测试

`ci-classify.test.sh` 的 `allowlisted symlinks fail closed` **没有测到 symlink 闸**:
fixture 路径是 `engineering/doc/symlink/link`,没有白名单后缀,先被后缀闸拦下了。
证据:把 `ci-classify.sh` 里 `old_mode/new_mode in {120000,160000}` 两行整个删掉,**18 项仍全绿**。
闸本身是好的 —— 我用带后缀的 symlink(`engineering/doc/a/link.md`,raw diff 里 mode 真是 `120000`)
直测,python 段返回 1(正确拒绝)。修法:把 fixture 换成带 `.md` 后缀的 symlink。
(它变空过绿是因为后来的 `b21597dff` 加了后缀白名单,把这条 case 遮住了。)

### 5.4 [INFO] 运维 runbook 的张数要改

计划 §6.4 写「12 张 `ship_workflow_failed` 逐张 resume」。真数据:这 12 张里只有 4 张过得了闸
(1827 / 1844 / 1828 / 1808),加上 FLY-1751 共 **5 张可捞**;其余 13 张会被安全拒绝
(10 张 approved_head 已过期且 PR 已在新 head 合掉,3 张 run 已 terminated)。
拒绝都正确、也没丢工作,**但这 13 张仍会永远停在 held**。
所以「held 有出口」准确的说法是:**对还活着、head 还对得上的操作有出口**;
对已经被现实绕过去的陈旧行没有出口(要不要清账是另一件事)。

### 5.5 [LOW] 其它

- `reconcileWorkflowEngineAlerts` 先把 `max` 预算给 legacy land 告警,再轮到 workflow 告警;
  legacy 积压足够多时同一 tick 内会饿死后者。今天生产 18 张全 engine-owned ⇒ 潜伏项。
- 计划 §4.5 有几项 TDD 没落地(连续两次「post 成功后 crash」的至少一次投递测试、
  9 处既有 UPDATE 对 held 全 no-op 的穷举 sentinel、MERGED finalization-held 的两代链)。
  对应行为我已用真数据验过,记为补测项。
- `classifyLandRetryReason` 改用 `unwrapped` 判 `ship_workflow_failed:` 前缀(旧代码用原串),
  于是 `land_execution_error:ship_workflow_failed:x` 从 retryable 变 terminal。
  该组合由 `release()` 路径产生不出来,记一笔备查。
- `ship-on-comment.yml` 的 Report-failure 传了 `PR_INFO_OUTCOME` / `CHECKOUT_OUTCOME` 两个 env 但没用到
  (两种情况都落在默认 `preflight`,行为正确)。死变量,可清可留。

---

## 6. 复现命令

```bash
# Track A 真机(等到转绿 / 从 cancelled 催熟一次,取决于当时 head 的轮次状态)
GITHUB_OUTPUT=/tmp/o GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=xrliAnnie/flywheel \
  PR_NUMBER=881 HEAD_SHA=<exact head> AWAIT_BUDGET_SECONDS=1500 POLL_SECONDS=30 \
  bash scripts/ship-await-ci.sh

# Track C 真数据(与 CI 日志里逐字相同的输入)
GITHUB_OUTPUT=/tmp/o GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=xrliAnnie/flywheel \
  PR_NUMBER=881 HEAD_SHA=b487220e043f73475c4b457867ee7dddbc0f496c \
  BASE_SHA=ca2eb8546306b6269abb54e098289b87fba3bdb4 bash scripts/ci-classify.sh

# Track B 生产快照(只读取样,绝不动生产库)
sqlite3 -readonly ~/.flywheel/teamlead.db "VACUUM INTO '/tmp/snap.db';"
```

---

## 7. Implement 回补(等待同一 QA 轨复验)

QA §5.1–5.3 的三条 classifier advisory 已在 implement attempt 2 收口:

- Actions runs 查询按 100 条/页顺序读取,**最多 12 页**;单测把唯一可用绿基线放在 page 12、把更新的失败轮放在 page 13,断言结果为 `true` 且调用页严格等于 1–12。上界依据与收益订正在 research §10。
- 所有 `fail_closed` 调用都带稳定原因并写 stderr,包括动态页码(`runs_api_failed:page=N` / `runs_page_invalid:page=N`);不确定性仍只输出 `no_code=false`,没有 fail-open。
- symlink fixture 改为真正命中 allowlist 的 `engineering/doc/symlink/link.md`;删除 mode 120000/160000 闸后测试从 40/40 变成 38/40,恢复后回到 40/40,不再空过绿。

收益口径同步订正:分页找回 11/328≈3.4% 的 fail-closed,约 $8/月;不是 23.5%,也不把 `$207/月`
的全候选机会收益上限记成实收。此节是 implement 回补记录,最终 PASS/FAIL 仍由同一 QA 节点复验后裁定。

---

## 8. QA retest(attempt 2,head `888fad247a326729e4c42b99e260196fc41cec23`)

### 8.1 改动面确认(先验再信)

`136752764..888fad247` 只动了 `scripts/ci-classify.sh` + `scripts/__tests__/ci-classify.test.sh` + 文档。
**Track A / B 的产品文件一个没碰** —— 所以 §2 / §3 的证据可直接携带;我另外在新 head 上把它们全跑了一遍复核:
定向 TS 132/132、`ci-structure` / `ship-await-ci` 11/11 / `ship-report-failure` / `ship-merge-token` 3/3 全绿。

### 8.2 三条 advisory 逐条变异检验(不是看代码里有没有那行)

| 检验 | 结果 |
|---|---|
| 基线 | `ci-classify.test.sh` **40/40** |
| 删掉 `120000/160000` mode 闸 | **38/40**,`allowlisted symlinks fail closed` 真的变红 ⇒ advisory③ **做实了**(修前删闸是 18/18 全绿) |
| 把 `MAX_RUN_PAGES` 从 12 改成 1 | **38/40**,两条 page-12 断言变红 ⇒ 分页上界是真被钉住的 |

诊断行拿真数据逐条跑出来(不是 grep):`invalid_input`、`runs_api_failed:page=1`(带动态页码)、
`head_commit_missing`、`baseline_base_sha_mismatch` 都如实打到 stderr,且都仍然只输出 `no_code=false`,没有 fail-open。

### 8.3 新问题:新脚本在**真 CI 里**没找到基线,而且慢了 9 倍

来自真机不是推理 —— run `32139562280`(head `888fad247`)的 classify job 日志:

```
12:57:03  Run bash scripts/ci-classify.sh
12:57:47  ci-classify: fail-closed: no_completed_pr_baseline
```

- **耗时约 45 秒**(改前实测约 5 秒),即真的顺序走满了 12 页;
- 结论是 `no_completed_pr_baseline` —— 在 1200 条 pull_request 事件的 run 里一条都没匹配上 PR 881。
  而同一时刻我在本机用 PAT 跑同一份脚本、同一组输入,第一页就能选出基线。

`no_code=false` 这个**结果**在这个 head 上恰好是对的(diff 里有 `scripts/**`),但它**不是走到 diff 判据才否的**,
是压根没拿到基线。改动前的旧脚本在 11:24 / 11:31 两轮 CI 里都成功命中过基线并真的 skip 了重格子,
所以「Actions token 下 pull_requests 数组为空」这个老假设解释不了那两次成功。

**判据已跑完,结论:不是回归,分类器在真 CI 里仍然好用。** 我推了一次纯 docs commit(head `541968750`),
run `32143690238` 的 classify **命中基线、输出 true**,`Script Tests` / `Unit` 矩阵 / `NPM payload` 三组
**全 skipped**,`CI OK` success,日志里没有任何 fail-closed 行。所以 12:57 那次是**孤例,原因不明**,
我复现不出来 —— 它与 §8.5 那次是同一个原因串 `no_completed_pr_baseline` 出现在本该给出更具体原因的位置,
两次都 fail-closed(安全),都没有错放东西过去。

**可操作的建议(而不是猜机制)**:候选集为空时,把「走了几页 / 一共看到多少条 run」也打出来。
这一个数字就能当场分辨「API 什么都没返回」还是「返回了但过滤没匹配上」——
这次两种可能我都排除不掉,正是因为少这一个数。

### 8.3.1 分页的真实代价(订正我自己上面那句「多烧 40 秒」)

| | 改前 | 改后 |
|---|---|---|
| classify job 用时 | ~17 秒 | **~51 秒**(12 次顺序 API 调用) |
| 跳过重格子那轮的整轮墙钟 | 3m22s / 3m15s | **3m22s(没变)** |

**整轮时间没有变坏** —— 关键路径是 quick-gate(3m13s),classify 与它并行,多出来的 ~34 秒被吸收了。
真实代价只有两项:每轮多约 34 秒 runner 计费时间(按约 64.5 轮/天折算每月约 37 分钟,金额上可忽略),
以及全跑轮里重格子的起跑时间往后推约 34 秒。对照它挽回的约 $8/月,这笔账是划算的 ——
我上面那句「每轮反而多烧约 40 秒」的说法偏重了,以本表为准。

### 8.4 归属订正请求(不是缺陷)

`research.md §10` 把 12 页上界那张实测表(2页=0/9 … 11页=9/9)和 `11/328≈3.4%`、`约 $8/月`
记成了「QA 实测」。**这不是我做的测量** —— 按 Lead 的返工说明,那是 HL 侧的实测。
我本轮只验了「实现与所声明的上界一致」(12 页,已用变异钉住)与「口径叙述本身自洽」,
**没有独立复算 11/328 与 $8/月**。请把 §10 的归属改成 HL,免得以后被当成 QA 独立核过的数。

### 8.5 一条无法复现的观察(如实记,不夸大)

本机第一轮探针里,`BASE_SHA` 给错时曾出现过一次 `no_completed_pr_baseline`(正确应为 `baseline_base_sha_mismatch`)。
随后连跑 8 次全部稳定给出正确原因,`gh` 配额健康(4405/5000),我复现不出来,机制未知。
结果侧始终 fail-closed(安全),只是那一次的原因串会误导排查。记录备查,不作结论。

### 8.6 retest 结论

**PASS(维持)。** attempt 2 的三条回补都真的落地了,而且是用变异检验证明的、不是看代码里有没有那行:
symlink 那条空过绿测试做实了(删闸必红)、12 页上界被断言钉住了、8 条 fail-closed 分支在真数据上逐条打得出原因。
Track A / B 的产品文件本轮零改动,证据直接携带并在新 head 上复跑全绿。
Track C 的省钱语义在真 CI 上重新验过一次:纯 docs 推送 → 重格子全 skipped → `CI OK` 绿 → 整轮 3m22s。

**留给下游的三条(都不阻塞)**:
1. 候选集为空时补打「走了几页 / 看到多少条 run」,让 `no_completed_pr_baseline` 不再是一个无法分辨成因的黑盒(§8.3);
2. `research.md §10` 的测量归属改成 HL(§8.4);
3. §4.2 那条结构性口径仍然成立:在飞那轮被 `cancel-in-progress` 掐成 cancelled 后即为最新已完成轮,
   所以「落地期推台账」这类推送本来就拿不到 skip;分页只挽回「基线在第 1 页之外」那一类,约 $8/月。
