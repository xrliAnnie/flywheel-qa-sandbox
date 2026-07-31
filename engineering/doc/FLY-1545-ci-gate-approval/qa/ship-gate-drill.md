# FLY-1545 ② founder ship 审批门 drill — QA 物料

**Issue**: FLY-1545 [v2·P1] 二合一:ship 前等 CI 绿 / ship 审批门真机验证
https://linear.app/geoforge3d/issue/FLY-1545
**Date**: 2026-07-30
**基于**: `engineering/doc/FLY-1545-p1-four/plan.md` §3(feat/fly1545-p1-four,PR #730)+ 本分支实现(`packages/v2-dag/src/ship.ts` CI-wait + `packages/v2-cli/src/dag-ports.ts` readCiState)

## 0. 口径声明(no silent skips)

plan §3.1 的主验证形态是**测试房 + sandbox 真 GitHub**。测试房已被 founder
拆到 **FLY-1539**(2026-07-30 14:45 PDT issue 收窄),不在本单。按 plan
§3.2 预定义的降级路径,本单 ② 的交付形态显式声明为:

1. **PR 内 committed QA 物料** = 本文档 + 可重复自动化 drill
   `packages/v2-cli/src/__tests__/ship-gate-drill.test.ts`(CI 每次跑):
   **真 `flywheel-v2` CLI 子进程**(founder 实际敲的同一组 direct verb)
   + **真 live-authority kernel DB**(完整 cutover 生命周期带起)
   + **真 git worktree**(admission/completion 读真 head)
   + **唯一的假件是 GitHub**:有状态 fake-gh 子进程,`:cool:` 评论翻转为
   MERGED,精确镜像 `ship-on-comment.yml` 的行为。
2. **生产 smoke** = 本单 PR 自己走生产 ship 门(§3 runbook)。验证对象是
   **生产已装的门**(旧 dist;新 CI-wait 代码 merge+部署后才生效——
   plan §3.2 诚实口径)。证据 merge 后落 Linear/lead 报告,不进本 PR。
3. **测试房 + sandbox 真 GitHub 的全链 drill** 由 FLY-1539 继承
   (plan §3.1 形态,含 `QA_CI_MODE` 确定性翻绿)。

## 1. 七步 drill(自动化,plan §3.1 逐步对照)

复现命令(仓库根):

```bash
pnpm -r --filter flywheel-v2-kernel --filter flywheel-v2-engine \
  --filter flywheel-v2-dag --filter flywheel-v2-cli build
cd packages/v2-cli && npx vitest run src/__tests__/ship-gate-drill.test.ts
```

| # | 步骤 | plan 判据 | 实测(2026-07-30 本机) |
|---|---|---|---|
| 1 | admit 单节点 DAG → dispatch → complete → 全员 done | `ship_gate` state='open';`gate_opened` event | PASS:gate open / attempts 0 / `gate_opened`×1 |
| 2 | **负例先行**:不 approve,伪 capability 直接 `ship` | 拒绝;gate 不变 | PASS:exit 1 `DagContractError: ship authority is incomplete`;gate 仍 open |
| 3 | founder `approve-ship`(真 approvalRef) | `gate_approved` event;capability mint 未消费;`ship_authorized` 到 actor 信箱;`pr_ready` lifecycle | PASS:全中。注:lifecycle 行按 FLY-1544 founder 裁决**双投递**(issue lead + discord-messenger),`pr_ready`×2 是设计值 |
| 4 | **负例**:同 approvalRef 换 target(pr 32)重放 | `ship approval replay conflicts` | PASS:exit 1 `DagConflictError: ship approval replay conflicts` |
| 5 | **负例:tip 漂移**:PR head 漂离已批 tip 后 `ship` | 拒绝;capability 未消耗 | PASS:exit 1 `DagContractError: world head drifted`;capability `consumed_at` NULL;attempt_count 0;修复=世界恢复已批 head(生产即 force-push 回) |
| 6 | **CI 红→同 head 翻绿→同凭 ship**(①+② 交点) | 红:`ci is not green` 零消耗;绿:`:cool:` 落 PR→merge→`ship_completed`;`settled.merged_sha`=mergeCommit;`issue_merged` lifecycle;**全程零重批** | PASS:红拒 `ci is not green: checks failed: ci` 零消耗;同一 capability 二次 `ship` 成功,`mergedSha` = fake mergeCommit oid;`:cool:` 评论恰 1 次;`ship_completed`×1;`issue_merged`×2(双投递) |
| 7 | **负例**:settle 后再 `ship` | 拒绝,账本不动 | PASS:exit 1;见下方行为注记;settled/mERGED action 均不变(github_merge action 恰 1 行) |

### 行为注记(与 plan 预期的两处已核实差异)

- **步骤 7 的拒绝层**:plan 预期 `"ship effect is already successful"`。装上
  CI-wait 后,已 merge 的 PR `mergeStateStatus=UNKNOWN` → fail-closed red,
  拒绝发生在观察层:`ci is not green: mergeStateStatus is undecided: UNKNOWN`,
  在账本自身的 already-successful 防线**之前**。拒绝语义不变(零写入),
  账本防线仍在(单测覆盖)。
- **步骤 2 的错误文本**:未 approve 的门 `target` 为 null,实际错误是
  `ship authority is incomplete`(不是 capability binding 错——那条防线在
  approve 之后才可达,由步骤 5/单测覆盖)。

## 2. 修复流 (b)(改代码路径)的覆盖位置

plan §6.1-4':rework completion 推进 `span_tip` → 门对新 tip 重开(需新
approvalRef)→ 旧 capability 变死权威;approved 门拒新 approvalRef。
由 `packages/v2-dag/src/__tests__/ship-ci-wait.test.ts` 的
"repair flow (b)" describe 块覆盖(drill 不重复,plan 原判)。

## 3. 生产 smoke runbook(merge 后执行,证据落 Linear)

本单 PR 走生产门时生产跑的是旧 dist,验证对象=**已装审批门本身**。

1. 全员 done 后确认 `ship_gate:FLY-1545` open(生产 DB 只读查询)。
2. founder `approve-ship --request-file`(真 approvalRef,observedTip=
   账本 tip)。判据:`gate_approved` event、capability mint、
   `ship_authorized` 信、`pr_ready` 落 `[FLY-1545]` 线程。
3. 持凭者跑 `ship`。判据:`:cool:` 落 PR → ship workflow 重跑 CI →
   merge;`ship_completed` event;`settled.merged_sha` 与
   `gh pr view --json mergeCommit` 对账;`issue_merged` 落线程。
4. 摘取证据(gate 行、events、merged_sha 对账)回填 Linear FLY-1545。
   负例 2/4(不落 merge)可顺跑,tip-drift 负例生产**不做**(需要对生产
   分支 force-push,风险不对称)。

## 4. 残余(显式)

- `ship-on-comment.yml` 侧的互指注释(指回 `DEFAULT_SHIP_TIMEOUT_MS`)
  无法从 runner 侧交付:push 凭据(两个 gh token)均无 `workflow` scope,
  SSH 无钥。dag-ports.ts 侧注释已写明单向指向与同改规则。属注释级残余,
  不影响行为;可由任何带 workflow scope 的人后补。
- 真 GitHub(真 check-run / 真 `:cool:` workflow)drill 归 FLY-1539 测试房。
