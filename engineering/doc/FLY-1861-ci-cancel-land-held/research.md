# FLY-1861 CI cancel 掐掉落地轮次 + land held 死角 — 调研

Issue: FLY-1861 (https://linear.app/geoforge3d/issue/FLY-1861/infraci-落地期间-runner-推台账-commit-掐掉在跑的-cicancel-in-progress-ship-merge)
日期: 2026-08-18
基于: exploration.md

> 本文回答 exploration §7 留下的 5 个问题,并把设计要依赖的每一条代码/平台事实钉到出处。
> 所有行号 as-of 本分支基点 `ca2eb8546`(main);行号会漂,重定位用 `git log -S` 或本文给的 grep 锚。
> **FLY-1866 引用状态声明**(Lead 订正 2026-08-18):1866 报告本身的 Codex review 终态是 CHANGES REQUESTED(未跑第 5 轮),本文引用其**数据与机制分析**按 issue 最新订正版口径($207/月 = 全部候选都命中时的机会收益上限 + 现价 $0.006/min;其 v1 的 $292 与旧单价 $0.008 作废),不将报告整体当 approved 结论引用。QA 后续把「仅修 run-list 分页」的增量收益订正为约 $8/月,见 §10。

---

## 1. 故障链逐环取证(代码 + 平台实况)

### 1.1 触发面:ci.yml 的 concurrency(`.github/workflows/ci.yml:18-20`)

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

`pull_request` 事件的 `github.ref` = `refs/pull/<N>/merge` ⇒ 同一 PR 的所有轮共享一个 group,任何新推送掐掉在跑轮。**被掐的轮属于旧 head**;当前 head 总有自己的一轮,伤害是「head 拿到 `CI OK` success 的时刻被每次推送重置」。

### 1.2 门:branch protection(gh api 实测 2026-08-18)

```json
{ "required_status_checks": { "strict": false, "contexts": ["CI OK"] },
  "enforce_admins": true }
```

`CI OK` = ci.yml 的 `ci-ok` 聚合 job(`needs` 全部 4 个 job,`jq -e 'all(.[]; .result == "success")'`)。`enforce_admins: true` ⇒ **没有任何 actor 能绕**(与 FLY-350 M-2 时代的 admin-bypass 已不同,现在收紧了)。

### 1.3 撞门:ship-on-comment 的 Merge 步(两张事故 run 的原始日志)

- run `32086773451`(PR #871)Merge @01:22:15、run `32086225279`(PR #868)Merge @01:16:20,同款:

```
RequestError [HttpError]: Required status check "CI OK" is expected.
status: 405   POST /repos/xrliAnnie/flywheel/pulls/<N>/merge
```

- ship run 内 build/typecheck/lint/`pnpm test:packages:run` **全绿**(#871 那次 9,004 passed);
- `sha:` pin 未触发(merge 时刻 head == approved_head,没走 409 "Head branch was modified");
- "is expected" = check 在 merge 时刻**没有结论**(在跑/缺席),不是红。

### 1.4 两个时钟的实测数据(`gh run list --workflow=ci.yml --branch=…`)

| 分支 | 轮次 | 起 → 终 | 墙钟 | 终态 |
|---|---|---|---:|---|
| FLY-1808 (#871) | 33e349c8 | 20:53 → 20:58 | 5m | cancelled(被 20:58 push 顶掉) |
| | aacbbf61 | 20:58 → 21:11 | 13m | cancelled(被 21:10 push 顶掉) |
| | cb485120 | 21:10 → 21:30 | 20m | success |
| | 88ca1180 | 00:46 → 02:05 | **79m** | failure(3× unit job 恰 15m00s timeout → `ci-ok` FAILURE) |
| FLY-1828 (#868) | 422e76b0 | 20:09 → 20:26 | 17m | success |
| | f19a3ecc | 23:29 → 23:48 | 18m | cancelled(被 23:47 push 顶掉) |
| | abf56d1b | 23:47 → 00:05 | 18m | success |
| | 4f773ae5 | 00:38 → **01:31** | **53m** | **success** |

ship run 时钟:#868 :cool: @00:53 → Merge @01:16(405);#871 :cool: @01:02 → Merge @01:22(405)。
**#868:merge 失败 15 分钟后 head 就绿了。** 正常轮墙钟 17–20m,高负载/排队下 53m,timeout 链上 79m。

两种 cancelled 的判据(照 issue 钉死,两家族处置相反):

| 观察 | 结论 | 家族 |
|---|---|---|
| 该轮 headSha ≠ 下一轮 headSha | 被新推送顶掉;重跑无意义(新轮已覆盖新 head) | 本单 |
| 同轮内多 job 在恰好 `timeout-minutes` 处同时断,head 未变 | job 超时;rerun 可能过(贴边抖动) | FLY-889/1233(修复不归本单;本单的 rerun 催熟对它顺带有效) |

### 1.5 receipt 与 land 侧判死

- ship-on-comment 每条路径落 HTML receipt comment:`<!-- flywheel-ship-receipt trigger_comment_id=… run_id=… head=… status=started|success|failure -->`(`.github/workflows/ship-on-comment.yml` Report failure 步)。
- `GhCliLandMergeDriver.inspectTriggeredWorkflow`(`packages/teamlead/src/bridge/land-executor.ts:723`)按 `trigger_comment_id` + `head` 过滤、取最后一条,regex 抽 `status=` → `failure|cancelled` ⇒ `{state:"failed", reason:<status>}`。
- `land-executor.ts:495`:workflow failed 且 PR 未 MERGED@approved_head ⇒ `release(…, "held", "ship_workflow_failed:failure")`。
- `land-retry-policy.ts:63`:`reason.startsWith("ship_workflow_failed:")` ⇒ **terminal** ⇒ `nextLandRetry` 返回 `state:"held"`、`nextAttemptAt:null`、retry_count 不动 —— 这就是生产 12 张 `retry_count=0` 的来源。

### 1.6 held 无出口 + 假出口(当前 main 逐处复核)

`packages/teamlead/src/StateStore.ts` 全部 9 处 `UPDATE land_operation`(grep 锚:`"UPDATE land_operation"`):

| 位置(≈行) | 守卫 | 对 held |
|---|---|---|
| 45237 | `run_id IS NULL`(绑 run,不动 state) | 无关 |
| 45332 | `state='running'` | 进不去 |
| 45459 / 45523 | `state='completed'`(Linear done 收尾) | 进不去 |
| 45563 | eligible 扫描 `intent/partial 到期/running 过期`;`makeLandOperationRetryRunnable` **只写 `WHERE state='partial'`** | no-op |
| 45635 | 认领 CAS:`SET state='running' … WHERE state IN (intent, partial 到期, running 过期)` | 进不去 |
| 45791 | step receipt(`WHERE owner+generation`,state 只会变 completed) | 进不去 |
| 45849 / 45908 | 失败写回:`WHERE state='running'` | held 只能被写入,不能被读走 |

假出口:`POST /api/lifecycle/land`(`packages/teamlead/src/bridge/lifecycle-routes.ts:212`)= `createIntent`(`INSERT OR IGNORE` + `UNIQUE(project_name, issue_id, pr_number, approved_head)` @ StateStore:17828)命中旧 held 行 → `makeLandOperationRetryRunnable`(只救 partial,no-op)→ `kick` → executor claim 不收 held → **202 返回,零字段变化**。设计不得把它当出口;plan 会让 resume 成为显式新动词而不是复用这个 POST。

### 1.7 生产存量(只读 `~/.flywheel/teamlead.db`,2026-08-18)

held 18 张(completed 35 张作对照):`ship_workflow_failed:failure` ×12(FLY-1808/1828/1844/1853/1827/1806×2/1750/1715/1680/1645/1672)、`pr_head_mismatch` ×5(FLY-1770/1763/1730/1701/1697)、`linear_lookup_failed_retryable` ×1(FLY-1751,FLY-1770 裁定保留 forensic 账据)。全部 `retry_count=0`。
12 张 ship_workflow_failed 里多数 PR 后来已被人工 merge(milestone 表可证:#868/#871/#865/#872/#867… 均已 Merged)—— resume 后 executor 走 `inspectPr → MERGED → finalization` 自动补收尾,不会重复 :cool:。

## 2. exploration §7 的 5 个问题逐条回答

### 2.1 `gh run rerun` 语义

- `gh run rerun <run-id>` 重跑整轮(新 attempt,同 run 记录);`--failed` 只重跑 failed/cancelled 的 job。需要 **`actions: write`** 权限 —— ship-on-comment 现有 permissions(contents:write / issues:write / pull-requests:write / checks:read)**不含**,要加一行。
- rerun 不产生新 git 事件,不受「GITHUB_TOKEN 触发的事件不再触发 workflow」防递归规则影响(那是 event→workflow 链;rerun 是 API 直接 re-dispatch)。**列为真机验收项**(平台行为,本地测不了)。
- rerun 的新 attempt 回到同一 concurrency group:若期间又有新推送起了新轮,新进入者存活、旧的被掐 —— 与现状语义一致,await 循环靠「盯 head 是否变了」处理。
- check 结论按 head SHA 关联,rerun 后 `CI OK` 的新结论落在同一 SHA 上,branch protection 直接受益。

### 2.2 Await 预算

数据:正常轮 17–20m,排队高峰 53m(#868 实测),timeout 链 79m。ship job `timeout-minutes: 30`(FLY-1504 提的)。
**结论:单次 await 不追求覆盖 p99。** ship 瘦身(砍自跑测试,§2.4)后自身 ~3m,await 预算定 **25m**,ship timeout 30 不动;预算耗尽 → fail with `failed_step=await_ci_timeout` → land 侧 retryable(8 档退避:1m/2m/4m/8m/15m/30m/1h/2h)→ 下一轮 :cool: 继续等。**用既有 retry 循环兜长尾,不用把单次 await 拉长。** #868 型(15 分钟后绿)第一次 retry 即愈。

### 2.3 `ci-structure.test.sh` / `ship-merge-token.test.sh` 会撞的钉(治理清单)

`ci-structure.test.sh`(444 行,全文读过)与 PR-C 相撞的恰好 4 处、与 PR-A 相撞 0 处:

| 钉(原文锚) | 现状 | PR-C 需要改成 |
|---|---|---|
| `expected_job_ids` 恰好 5 个 | 不许新增 job | + `classify`(共 6 个) |
| `quick-gate/unit-tests/script-tests must start independently (no needs)` | 重 job 禁 needs | `unit-tests`/`script-tests`/`payload-distribution` 加 `needs: classify`;**`quick-gate` 保持无 needs 且永远全跑**(轻,3-4m,同时是 classify 失灵时的兜底信号) |
| `ci-ok.needs` 恰好 4 个 | | + `classify` |
| 聚合 jq 正则钉死 `all(.[]; .result == "success")` | 无条件全 success | 新判据:`quick-gate`/`classify` 必须 success;重 job 允许 `skipped` **当且仅当** classify 输出 `no_code=true`(经 step env 传入),否则全 success。守卫同步钉新判据的完整形状(fail-open 检查:意外 skipped + no_code≠true ⇒ 红) |

不撞的钉(明确保留):`ci-ok.if = always() && !cancelled()`、unit-tests matrix 合同、timeout floors、FLY-1715/1364 step 钉、apt 钉、matrix.cmd 唯一执行步。**concurrency 不在守卫里但本单承诺不动(验收 3)。**

`ship-merge-token.test.sh`(T1-T3,parsed-YAML walk):await 步用默认 `GITHUB_TOKEN` 即不撞(T3 允许默认 token;T1/T2 只约束 SHIP_PAT 与 merge 步的绑定,await 是独立步)。**PR-A 需要的唯一权限变化:workflow 顶部 permissions 加 `actions: write`(rerun 用)。**

### 2.4 ship 瘦身(FLY-1866-B)的覆盖论证

- `CI OK` 的覆盖(quick-gate 的 shell 守卫群 + 22 包 matrix + script-tests + payload)**严格超集**于 ship 现在自跑的 build+typecheck+lint+`test:packages:run`(ship 从来不跑 shell 套件与 payload)。matrix 覆盖 22 包由 `ci-matrix-coverage.test.sh` 用真实 workspace 解析保证。
- 已知语义差(FLY-1866 已核,如实保留):ci.yml `pull_request` 的 checkout 是 **merge preview**(`refs/pull/N/merge`),ship 测的是 head 本身。branch protection 本来就按前者判;换成「读结论」= 与 GitHub 原生语义对齐,**不能说零风险,但不是回退**。
- 仓里已有「按 exact head 查 CI 结论」先例可抄:`packages/flywheel-comm/src/ship-ci-guard.ts`、`verify-approval.ts`。

### 2.5 classify 的正确判据:绿基线累计 diff(比 FLY-1866 的增量口径更严)

FLY-1866 的增量口径(event `before..after`)有一个它没写的 fail-open:上一轮(含代码)被本次台账推送顶掉且从未绿过 ⇒ 增量判 no-code ⇒ skip ⇒ **从未被测过的代码拿到绿章**。正确判据:

> `no_code=true` ⟺ 找得到 **绿基线** G(= 该 PR 分支最近一轮 `CI OK`=success 的 headSha,checks/runs API 查)∧ G 是当前 head 的 ancestor(`git merge-base --is-ancestor`,force-push 即失败)∧ `git diff G..HEAD --name-only` **全部**命中 allowlist。
> 其它一切情况(无绿基线 / 查询失败 / 非线性 / 命中任何非 allowlist 路径)⇒ `no_code=false`,全跑。

- 一个判据同时覆盖「连续多次台账推送」(每次都对比 G,全 skip)与「opened / reopened / force-push / 事件缺 before」(拿不到就全跑),**不需要** event `before..after` 的分支逻辑。
- allowlist(严格版,来自 FLY-1866 v3,理由:本仓 60+ `.md` 是运行时生产输入):`doc/**`、`product/doc/**`、`engineering/doc/**`、`content/doc/**`、`**/progress.md`。**`.flywheel/**`、`packages/**`、`scripts/**`、`agents/**`、`.lead/**`、`.github/**` 一律不放行**(`.github/**` 尤其:改 CI 自己必须全跑)。
- classify job 需要:`checkout fetch-depth: 0`(查 ancestor/diff)+ `checks: read`(查绿基线)。跑量 ~1 分钟。
- **对本单正确性面的贡献**:台账推送的新轮变成 classify(~1m)+ quick-gate(~4m)+ 重格子 skip ⇒ `CI OK` ~5 分钟内绿,PR-A 的 await 等待有界,不再被推送风暴重置 20 分钟时钟。

### 2.6 resume 的权威与告警面

- 落点:`lifecycle-routes.ts` 新 `POST /land/:operationId/resume`,复用该文件的 apiToken fail-closed guard(FLY-1185 reserved-actions 面;master-token-only,与 park/unpark 同权威档)。
- 前置校验(fail-closed,全部在一次事务里):`state='held'` ∧(PR MERGED@approved_head → 允许,resume 后走 finalization 补收尾;或 PR OPEN ∧ 当前 head == approved_head → 允许,重走 :cool:)。`pr_head_mismatch` 类天然被 head 校验挡住(它们的正路是 FLY-1772 kickback 重批)。PR CLOSED-unmerged 拒绝。
- StateStore 新方法(唯一合法的 held 出边):原子 `UPDATE … SET state='partial', next_attempt_at=<now>, last_error=<'resumed:'+旧值截断> WHERE operation_id=? AND state='held'`,并落一条 `land_operation_step` receipt(`resume_authorized`,记 actor/reason)。
- 告警面现状:held 时只有 `announce("merge_failed")` 进 issue thread(`land-executor.ts:489`),**没有 Lead 告警** —— held 是沉默死角。补:release→held 时经既有 Lead alert 通道发一条(带 operation_id + resume 指引),每 operation 一次(announce 的 receipt 去重机制现成)。

## 3. 对 ship-on-comment 改造的落点细节(供 plan 引用)

- 现状步序:pr-info(校验+started receipt)→ checkout(pinned head)→ setup → install → build → typecheck → lint → **test(~19m)** → Merge(`if: success()`,sha pin)→ Report failure(`if: failure()`,receipt `status=failure`)。
- 改后:pr-info → **Await CI verdict**(默认 GITHUB_TOKEN;轮询 head 的 `CI OK` check;cancelled/缺席 → `gh run rerun`;head 变了 → fail `head_moved`;预算 25m)→ Merge(不动,SHIP_PAT 合同原样)→ Report failure(receipt 增加 `failed_step=<step-id>`,读 `steps.<id>.conclusion` 判定哪步挂了)。build/test 步整体删除(FLY-1866-B),`timeout-minutes` 30 → 可回落(plan 定数)。
- receipt 兼容矩阵:旧 Bridge×新 receipt(regex 不看新字段,照旧);新 Bridge×旧 receipt(`failed_step` 缺席 → 维持 terminal,行为=现状)。**双向字节兼容,无部署顺序死锁**;但要拿到自愈收益需 PR-A(产生方)先于 PR-B(消费方)上生产。
- Await 逻辑抽成 `scripts/ship-await-ci.sh`(bash + gh),让它可以进 `scripts/__tests__/` 单测(mock gh);yml 里只调脚本 —— workflow 本身的行为只能真机验收(与 FLY-1701 同现实)。

## 4. 边界(与相邻单,已在 exploration §6 划过,这里钉引用)

FLY-889/1233(timeout 家族,判据表 §1.4)/ FLY-1863(script-tests 逼近 20m 线,FLY-1866-C 的地盘)/ FLY-1866(A、B 并入本单,C-H 不动)/ FLY-1772(pr_head_mismatch 的重批正路)/ FLY-1655(held=需要人看的哲学,resume 是「人看完之后的动作」)。

## 10. QA 追查后的 run-list 分页上界与收益订正

### 10.1 上界实测

QA 对 9 个「page 1 找不到、但更早确有可用轮次」的样本逐档扩大 Actions runs 查询窗口,得到:

| 最大页数(`per_page=100`) | 找回样本 |
|---:|---:|
| 2 | 0/9 |
| 3 | 2/9 |
| 4 | 5/9 |
| 5 | 6/9 |
| 8 | 8/9 |
| 11 | 9/9 |

实现取 **12 页硬上限**:覆盖实测最深的第 11 页并留 1 页余量,同时保证 API 查询有界。按同窗口约
64.5 runs/day,`12 × 100 ÷ 64.5 ≈ 18.6` 天;生产脚本旁的规范注释因此写成
`12 pages ≈ ~18 days lookback, based on ~64.5 runs/day; table in research.md §10`。页不足 100 条时提前停止。

### 10.2 收益口径

分页只能挽回「正确基线落在 page 1 之外」这一类 fail-closed,不能解决最新 completed run 本来就是
cancelled/failure 的结构性不命中。QA 同窗口计数为 **11/328 = 3.35%≈3.4%**,折算约 **$8/月**;
此前把分页说成 23.5% 收益的口径作废。`$207/月` 仍只是全部无代码候选都能跳过重格子时的机会收益上限,
不能拿来描述本次分页补丁的实际增量。
