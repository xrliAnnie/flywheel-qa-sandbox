# FLY-2397 强度二证据台账 — 验收

Issue: FLY-2397 (https://linear.app/geoforge3d/issue/FLY-2397/2309b3-强度二证据台账-真环境跑过-外部可查可重跑的记录两个独立字段p0-影子跑前置)
日期: 2026-09-06
基于: plan.md

## 1. 真实环境副本与边界

- 来源:运行中 Flywheel 环境的 `~/.flywheel/teamlead.db`,用 SQLite `.backup` 取得一致副本,验收脚本以 `readonly + query_only` 打开。
- 副本完成时间:`2026-09-07T04:11:21Z`;大小 `814628864` bytes;SHA-256 `c461bdeef2103afe2b8eb5021eded569ca8e9f71acdb5aec97cf38237e7b0112`。
- 结构化状态见 `acceptance-state.json`:真实 `cutover_at` 保持 `null`;影子取样只写独立的 `shadow_boundary_at=2026-09-07T04:11:15.000Z`,两者不能互相回退或替代。本 implementation 节点没有部署权限;独立 updater 到 production cutover 时写入真实 `cutover_at` 并以该时刻重跑。
- 副本共有 `901` 条 `workflow_claims`;副本没有 `strength_two_evidence_record` 表。脚本把表不存在解释为零行,仍由 production `evaluateStrengthTwo([])` 作 fail-closed 判定,没有把旧 claim 当作台账。

执行命令:

```sh
node scripts/fly-2397-strength-two-acceptance.mjs \
  --db <sqlite-backup> \
  --shadow-boundary-at 2026-09-07T04:11:15.000Z
```

脚本逐条打印了候选全集 `(workflow_run_id, '__main__', subject_digest)` 及两半判定。最终机器输出:

```text
cutover_at=null cutover_status=unknown cutover_reason=cutover_not_recorded shadow_boundary_at=2026-09-07T04:11:15.000Z cohort_total=305 cohort_excluded=0 positive_1=305/305 positive_2=pass symmetric=pass negative=pass rows_sha256=4cdc58d98ab21a849e95df98b8b1b3c5bef674b7fa52a8dc3cd6b698846e7450
```

## 2. 四组对照

| 对照 | 输入 | 独立结果 | 总结论 |
| --- | --- | --- | --- |
| 阳性 1:自称跑过、没有台账行 | 真实副本中 305 条 pre-shadow-boundary `qa_passed + git_head + vercel.app` claim;按 `(run, '__main__', head)` 查台账为空 | `ran=false/no_ledger_row`;`record=false/no_ledger_row` | 305/305 `unsatisfied` |
| 阳性 2:台账行存在、外部地址取不到 | 固定内存台账行:`ran=ok`;`record=url_http_error` | `ran=true`;`record=false` | `unsatisfied` |
| 对称组合:房/head 不符、外部记录有效 | 固定内存台账行:`ran=site_head_mismatch`;`record=ok` | `ran=false`;`record=true` | `unsatisfied` |
| 反向对照:两半各自满足 | 固定内存台账行:`ran=ok`;`record=ok` | `ran=true`;`record=true` | `satisfied` |

后三组 rows 固定在 `STRENGTH_TWO_ACCEPTANCE_ROWS_V1`,运行者不能提供 fixture。脚本先把 rows 插入 `:memory:` SQLite 台账并读回,再调用 production `evaluateStrengthTwo`;canonical JSON 的 SHA-256 为 `4cdc58d98ab21a849e95df98b8b1b3c5bef674b7fa52a8dc3cd6b698846e7450`。测试还会把阳性 2 的 record 半边突变成 `ok`,并确认断言必然失败,排除恒真测试。

结论:旧 `qa_passed` claim 或文字自称不能满足强度二;没有台账行 fail-closed。台账有行时,`ran_status/ran_reason` 与 `record_status/record_reason` 仍分别判定,其中任一半失败都不能被另一半盖住。

## 3. 给 B4 的只读接口

1. 以绑定键精确读取:`StateStore.listStrengthTwoRecordsForHead(runId, targetRepoIdentity, headSha)`。主仓 v1 的 `targetRepoIdentity` 是 `__main__`;不得只按 run 或 head 猜配。
2. 把返回行原样交给 `evaluateStrengthTwo(rows)`。空数组返回两半 `no_ledger_row`、总判定 `unsatisfied`;有满足行时返回其 `basisRecordId`。
3. 对展示中的 basis 行调用 `probeRecordLiveness(row, deps)`,单独显示 `live / verified_then_expired / unsatisfied`。liveness 是当前可取性,不回写、也不回溯改变写入时判定。
4. B4 必须把 `(run, repo, head)` 对不上显示为「绑定失败」,不能跨 head 或跨 repo 借用其它行;表头分别显示「真环境跑过」「外部记录可取」「强度二」。
5. 托管报告可能在 14 天后过期;写入时已验证过、之后过期的记录显示 `verified_then_expired`,不能伪装成仍 `live`。
6. 任何依赖 production cutover 语义的消费者必须调用 `requireCutoverForDecision(state)`;当前结构化状态会 fail-closed 为 `unknown: cutover_not_recorded`。禁止退回读取 `shadow_boundary_at`,也禁止把 `unknown` 当作满足。

## 4. 已知不解与边界

**flaky(FLY-1833 型)**:一个 flaky 的端到端测试照样会偶然全绿 ⇒ 台账照记「跑过 + 有记录」,判满足。本单没有新解法。

另外,驱动器退出码仍是 recorder 自报项;v1 只支持 529 槽位房和主仓;`manual_test_deploy` 只能落为 `lane_unproven`;记账必须发生在房 teardown、worktree 再提交以及 `qa-result` 消费 credential 之前。这些限制没有被本实现悄悄扩写成已覆盖能力。
