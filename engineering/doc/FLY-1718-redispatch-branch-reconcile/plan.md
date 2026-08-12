# FLY-1718 re-dispatch 重生对账 — 实施计划

Issue: FLY-1718 (https://linear.app/geoforge3d/issue/FLY-1718/re-dispatch-丢已拍板成果-fresh-start-无视-origin-同名分支open-pr从-main-另起分叉1704)
日期: 2026-08-12
基于: research.md

## 0. 一句话

重生(re-dispatch)必须先对账存量:fresh 派发前探 origin 同名分支(有则续接、探不清则拒发),worktree 注入 pre-push 护栏拒 force-push,路径绑定指令在建成/过门双点校验存在性,DOA 重生走退避断路器——四个工作包,P1 是数据丢失杀手,可独立先 ship。

## 1. 工作包总览与 ship 顺序

| 包 | 内容 | 治哪个形态 | 依赖 | 可独立 ship |
|----|------|-----------|------|------------|
| P1 | 分支延续性预检 + resume origin fallback | A(fresh 分叉) | 无 | ✅ 最先 |
| P2 | pre-push force-push 护栏 | B(覆盖拍板件) | 无(与 P1 互补) | ✅ |
| P3 | 指令路径快照双点校验 | C(孤儿门) | 无 | ✅ |
| P4 | DOA 重生退避断路器 | D(秒死循环) | 无 | ✅ 最后/可拆单 |

四包互不依赖,单 PR 分 4 个逻辑 commit 或拆 2 个 PR(P1+P2 / P3+P4)由 implement 节点按体量定;review 以包为单位可拆。

## 2. P1 — 分支延续性预检(branch continuity preflight)

### 2.1 新模块 `packages/teamlead/src/bridge/continuity-preflight.ts`

```ts
export type ContinuityProbe =
  | { kind: "exists"; sha: string }        // origin/<branch> 在,tip sha
  | { kind: "missing" }                     // 确认不存在(ls-remote exit 2)
  | { kind: "indeterminate"; error: string }; // 网络/超时/其他一切

export function probeOriginBranch(
  projectRoot: string, branch: string, timeoutMs = 20_000,
): ContinuityProbe;
// 实现:git -C <root> ls-remote --exit-code --heads origin <branch>
// exit 0+sha → exists;exit 2 → missing;其他(含超时)→ indeterminate
// (research §2 实测;三态契约镜像 FLY-1257 probePhaseRetryBranchTip)

export interface ContinuityDecision {
  startPoint?: string;          // exists → origin tip sha
  inheritedFromOrigin?: {       // 注入 runner prompt 的存量声明
    branch: string; sha: string; prUrl?: string; prNumber?: number;
  };
}

export function computeContinuity(
  probe: ContinuityProbe,
  pr: { url: string; number: number } | null,  // best-effort,null=查询失败/无
): ContinuityDecision | { failClosed: string };
```

纯函数 + 注入探针,与 `computeProgressResume` 同款分层(核心可单测,git 调用在 run-infra 接线)。

### 2.2 接线(`run-dispatcher.ts` `start()`,resume 计算旁)

在 `:1548` resume 计算之后加:

```
仅当 req.qaContext == null && req.startPoint == null && resume == null:
  probe = continuityProbe(issueId, role, projectName)   // 注入,同 resumeComputer 模式
  exists        → ctx.startPoint = origin tip;ctx.shareParentBranch = true;
                  ctx.continuityInherit = {...}(Blueprint 渲染进 runner prompt)
  missing       → 真 fresh(现状路径,byte-compat)
  indeterminate → abortPreLaunch + throw(镜像 :845 phase-retry indeterminate 的
                  fail-dispatch 语义;错误信息带 probe.error)
```

豁免面(research §4.1):caller 已 pin startPoint / qaContext / resume 命中 → 预检不跑。
kill-switch:`FLYWHEEL_CONTINUITY_PREFLIGHT=0` → 预检整体旁路(byte-compat 逃生口)。
显式重做:派发参数 `freshStart:true`(runs-route 边界校验 + 审计行)→ 跳过预检真 fresh;默认永远续接(research §7.3:宁可续接错、不可分叉丢)。

### 2.3 resumeComputer origin fallback(`run-infra.ts:1085-1122`)

`git()` helper 内:`branchTip`/`readBranchFile` 本地 miss → 先 targeted `git fetch origin <branch>`(一次,失败吞掉)→ 读 `refs/remotes/origin/<branch>`。恢复「close/terminate 清理后仍能 ledger-resume」的能力。`progress-resume.ts` 纯函数零改动。

### 2.4 open PR 增强(best-effort)

`gh api repos/{owner}/{repo}/pulls?head=...&state=open`,单次、20s 超时、失败静默降级(research §5)。成功 → PR 号进 `inheritedFromOrigin` + 审计行。**不是硬门**。

### 2.5 Blueprint 渲染

`BlueprintContext` 加可选 `continuityInherit`;渲染进 runner prompt 一段固定文案:「你的分支续接自 origin/<branch>@<sha7>(open PR #N)。先 `git log --oneline -10` + 读 PR 描述了解已有成果,在其上继续;禁止 force-push。」——prompt 是解释层,结构保证在 startPoint。

### 2.6 TDD

- `continuity-preflight.test.ts`:三态 probe(真 git 沙箱:bare origin + 分支存在/缺失/坏 remote,镜像 research §2 实测矩阵);computeContinuity 决策表;freshStart 压过;PR null 降级。
- `run-dispatcher` 集成:exists → ctx.startPoint=origin tip + shareParentBranch;missing → ctx 与现状逐字段相等(**byte-compat 断言**);indeterminate → dispatch 拒发 + abortPreLaunch 已调用;qaContext/caller-startPoint/resume 命中 → 探针零调用(spy);kill-switch=0 → 探针零调用。
- resumeComputer fallback:本地分支删除 + origin 在 → resume 仍命中且 startPoint=origin tip(真 git 沙箱);origin 也无 → null(现状)。
- 回归哨兵:`FLYWHEEL_CONTINUITY_PREFLIGHT=0` 全路径与 main 现状 byte-compat。

## 3. P2 — pre-push force-push 护栏

### 3.1 hook 部署(一处固定路径)

`scripts/push-guard/pre-push`(仓库内源文件,POSIX sh)→ 部署到 `~/.flywheel/state/push-guard/hooks/pre-push`(Bridge boot 时幂等安装,内容 hash 对比升级)。逻辑(research §3 实测形状):

```
每 stdin 行 <lref lsha rref rsha>:
  rsha == 0{40}(新分支)                → 放行
  lsha == 0{40}(删除远端分支)          → 拒
  merge-base --is-ancestor rsha lsha 真  → 放行(快进)
  否则(非快进,含 --force-with-lease)  → 拒,除非
      FLYWHEEL_FORCE_PUSH_ACK == 被拒分支名(精确匹配,单分支)
拒绝时:stderr 结构化原因 + append 审计行
  ~/.flywheel/state/push-guard/audit.log(ts/branch/lsha/rsha/acked)
```

### 3.2 worktree 注入(`WorktreeManager.create`)

`create()` 内、generation marker 写入旁(`WorktreeManager.ts:257` 同段):

```
git -C <wt> config extensions.worktreeConfig true        # 幂等,repo 级一次性
git -C <wt> config --worktree core.hooksPath ~/.flywheel/state/push-guard/hooks
```

fail-closed:任一步失败 → create 失败(镜像 generation marker 纪律)。hooksDir 缺失(未部署)→ create 失败并报「push-guard 未安装」——**不许裸奔**。
kill-switch:`FLYWHEEL_PUSH_GUARD=0` → create 跳过两行 config(byte-compat 逃生口;hook 文件本身无害残留)。

### 3.3 协议层收尾

- runner 规则文本(Blueprint 注入的 git 纪律段):口头禁令改为「护栏会拒;确需 force-push 先 `flywheel-comm ask` Lead,拿到确认后按 hook 提示设 ACK 环境变量,单次单分支」。
- 诚实边界写进规则:护栏防事故不防对抗(runner 可自设 env);审计行让事后必可追认。

### 3.4 TDD

- 真 git 沙箱 e2e(bash harness,`scripts/__tests__/test-push-guard.test.sh`):T1 快进过 / T2 `--force-with-lease` 拒 + 审计行落 / T3 主仓不受影响 / T4 删除远端分支拒 / T5 ACK=分支名放行 + 审计标记 acked / T6 ACK=别的分支名仍拒 / T7 新分支首推过。
- `WorktreeManager.create` 单测:两行 config 落盘(`git config --worktree --get core.hooksPath`);hooksDir 缺失 → create 抛;`FLYWHEEL_PUSH_GUARD=0` → 零 config 写(byte-compat)。

## 4. P3 — 指令路径快照双点校验

### 4.1 建成/重投点

`event-route.ts` `handleCodexAutoTrigger` 与 FLY-827 AutoQaCoordinator re-queue,build 指令前:

```
planPath 有值 → git show <session.branch>:<planPath>(20s 超时)
  blob 在   → 照旧
  blob 不在 → 按「MISSING」处理:走 codex-instruction.ts:43 现成 fallback 文案
              (re-run stage set design_review --plan <path>)+ log 一行 orphan 标记
  git 失败  → 按 MISSING 处理(保守降级:宁可让 runner 重设路径,不放孤儿门)
```

零新文案、零新状态——「有值但孤儿」并进「无值」的既有降级形态。

### 4.2 过门点(fail-closed 地板)

`flywheel-comm await-codex-gate design`:读 design-review.json 的 `reviewedTarget` 后,验该路径在**当前 worktree HEAD** 树上存在(`git cat-file -e HEAD:<path>`):

- 在 → 照旧放行流程;
- 不在 → gate 拒(非零退出 + 明确文案:reviewedTarget 已不在当前分支,re-run `stage set design_review --plan <path>`)。

对称于 code 侧 `reviewedHeadSha === HEAD` 的既有 fail-closed 校验。
kill-switch:随包全局 `FLYWHEEL_INSTRUCTION_PATH_CHECK=0`(两点同门,byte-compat 逃生口)。

### 4.3 TDD

- event-route 单测:孤儿路径 → 指令文本含 MISSING fallback 句(逐字);路径在 → 指令与现状逐字节等(byte-compat);git 失败 → fallback。
- await-codex-gate 集成(真 git 沙箱):reviewedTarget 在 HEAD → 过;被删/改道后不在 → 非零退出 + 文案;kill-switch=0 → 现状行为。

## 5. P4 — DOA 重生退避断路器

### 5.1 判定与账本

- DOA 判定:同 issue+role 最近 terminal 前任 `寿命 = last_activity_at - started_at < FLYWHEEL_DOA_THRESHOLD_MS(默认 60s)` 且 status ∈ {failed}。
- durable 账本:`~/.flywheel/state/doa-backoff.json`(或 StateStore 新表,implement 时按 FLY-1648 已落形态对齐——**优先复用 1648 的退避存储**,不建第二套):key=(project,issue,role),字段 = 连续 DOA 代数 + next_eligible_at。
- 策略:第 1-4 代 DOA → 1m/2m/4m/8m 退避(next_eligible_at 前拒发,错误信息带剩余秒);第 5 代 → 不再自动重派,severe alert 一次(既有 lead-alert 通道)+ 需 Lead 显式重派;任一代健康存活(寿命 ≥ 阈值)→ 计数清零。

### 5.2 接线

与 P1 预检同层(`start()` 入口、admission 检查旁):读前任 → DOA 判定 → 账本查 next_eligible_at → 未到 → abortPreLaunch + throw(结构化错误,engine/Lead 可见)。
kill-switch:`FLYWHEEL_DOA_BACKOFF=0`。

### 5.3 TDD

- 判定纯函数单测:寿命边界(59s/60s/61s)、status 过滤(terminated/blocked 不算 DOA——只有 failed 算,terminate 是人为动作)、无前任 → 不拦。
- 账本:代数递增、healthy 清零、第 5 代转 needs_lead + alert 恰一次(dedup)、跨进程重启读回(durable)。
- 集成:秒死前任 → 第二次派发被拒且错误带 next_eligible_at;kill-switch=0 → 现状。

## 6. 全局纪律

- **byte-compat 默认**:四个 kill-switch(`FLYWHEEL_CONTINUITY_PREFLIGHT` / `FLYWHEEL_PUSH_GUARD` / `FLYWHEEL_INSTRUCTION_PATH_CHECK` / `FLYWHEEL_DOA_BACKOFF`)全部 `=0` 时,行为与 main 逐字节一致(回归哨兵测试);默认全 ON(这是修 bug,不是实验特性——出生即启用,逃生口只为回滚)。
- **fail-closed 方向盘**:探不清存量(indeterminate)→ 拒发;hook 装不上 → create 失败;路径验不了 → 按孤儿降级;账本读不了 → (P4 例外)放行 + warn——退避是止血非安全边界,读账失败不该瘫痪派发。
- 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 新 shell harness;真机 QA(独立 QA 节点):FLY-1704 剧本重放——close done=true → 重派 → 断言新 run startPoint=origin tip 且 runner pane 可见存量声明;force-push 真拒;孤儿指令降级;DOA 双杀退避。
- 文档:CLAUDE.md 里程碑行 + 本文件夹随 PR 合入。

## 7. 验收标准(QA 节点用)

1. 重放 FLY-1704:origin 有同名分支 + open PR,close done=true 后重派 → 新 worktree HEAD == origin tip(非 main),runner prompt 含 PR 号。
2. origin 无同名分支 → 派发行为与 main 现状 byte-compat。
3. 断网/坏 remote → 派发被拒,错误含 indeterminate 原因,无 worktree 落盘。
4. worktree 内 `git push --force-with-lease`(rewrite 后)→ 被拒 + 审计行;`FLYWHEEL_FORCE_PUSH_ACK=<branch>` 后同命令 → 过 + acked 审计;主仓 push 不受影响。
5. 改道后孤儿 plan_path → 新指令为 MISSING fallback 形态;`await-codex-gate design` 对孤儿 reviewedTarget 非零退出。
6. 前任 failed 且寿命 <60s → 立即重派被拒(带 next_eligible_at);第 5 代 → needs_lead + 恰一条 severe alert。

## 8. 诚实边界(本设计不做)

- 不改 close done=true → completed 的终态语义(绕开:预检不看 session 状态)。
- 不做 GitHub 服务端 push 保护(follow-up 单)。
- 不防对抗性 runner(ACK env 可自设;审计留痕 + 合同约束)。
- 不做 DOA 死因自动归因/自动修复。
- 不覆盖非 WorktreeManager 建的工作区(Lead 自己的 clone、人类 worktree)。
- FLY-1712(信箱在途批对账)独立推进,互不阻塞。
