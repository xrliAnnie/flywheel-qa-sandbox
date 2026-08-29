# FLY-1185 Runner 分支/worktree 收尾清理根治 — 探索

Issue: FLY-1185 (https://linear.app/geoforge3d/issue/FLY-1185/fix-runner-分支worktree-收尾清理没有自动发生-症状304-远端分支51-worktree-积压fly-603)
日期: 2026-07-11
基于: 无

## 1. 症状回顾

2026-07-11 Annie 爆炸:repo 积压 **304 远端分支 / 51 本地 worktree / 430+ 本地分支**,Tadashi 第 N 次人肉清到 68/11/73。Annie 直令根治("这东西让你做了多少遍了")。

## 2. 审计结论:真实原因坐实(不是猜测,全部有生产证据)

### 2.1 FLY-603 机制现状 — **在跑,没有回归,但覆盖面有 6 个结构性缺口**

FLY-603 交付了两层机制,均 default-on(`FLYWHEEL_WORKTREE_AUTOCLEAN`,registry 确认 default:true):

- **Layer A**(on-merge,`packages/teamlead/src/bridge/worktree-cleanup.ts`):ship 收尾时,tmux 确认关闭后,dirty-safe 删除该 session 的 worktree + 本地分支。挂在 `runPostShipFinalization`(DirectEventSink + /events 两路 + merge-ship-gate)。
- **Layer B**(boot reconciler,`packages/teamlead/src/bridge/worktree-reconciler.ts`):Bridge 启动时全量扫 sibling worktree,dead+clean+merged+无 open PR 才删(fail-closed)。

生产 DB(`~/.flywheel/teamlead.db` `session_events`)证明两层都在持续工作:

| 事件 | 累计 |
|---|---|
| worktree_reconciled (Layer B 删除成功) | 129 |
| worktree_cleanup_done (Layer A 删除成功) | 77 |
| worktree_reconcile_skip (Layer B 跳过) | **2181** |
| worktree_reconcile_gh_unavailable (整项目放弃) | 100(其中 87 = personal-assistant 项目,flywheel 仅 3) |

时间线:2026-07-04 ~ 07-11 每天都有 reconciled/cleanup_done 事件。**结论:issue 候选原因 1(机制没接线/flag 关着/挂了)不成立** — 机制活着;积压来自下面的跳过分布 + 两类根本没有机制覆盖的对象。

### 2.2 Layer B 跳过原因分布(2181 条)— 每个 bucket 都有当前生产实例

| skip reason | 次数 | 实质 | 生产实例(2026-07-11 13:06 sweep) |
|---|---|---|---|
| no_merge_evidence | 794 | QA scratch(永不 merge)、abandoned run、**merge 后分支 head 又动过**(squash-merge 下 headRefOid 不再匹配) | flywheel-FLY-1099(已 ship #545 仍被跳)、FLY-980、FLY-915 |
| open_pr | 417 | 正确保留 | FLY-836、FLY-806 |
| dirty | 347 | runner 留下未提交产物 → **fail-closed = 永久滞留** | FLY-967、FLY-1093、FLY-1065 |
| not_managed_path | 237 | ① 项目内部 `worktrees/` 目录(全局 git-workflow 规则产物);② **三段式 phase 分支挂在 base worktree 上导致 branch-key ≠ path-key** | `flywheel/worktrees/FLY-1048-pr-c`;`flywheel-FLY-1160`(挂 `flywheel-FLY-1160-phase-b` 分支) |
| nested_parent | 209 | 内部嵌套 worktree 挡住父 worktree 清理 | FLY-1060 |
| live_live | 177 | 正确保留 | — |

### 2.3 远端分支(304 个)— **根本没有任何机制,最大的洞**

- 全代码库 grep:**零处** `git push --delete` / remote branch 删除逻辑。
- GitHub repo 设置 `delete_branch_on_merge` = **false**(gh api 实测)。
- 结果:~560 个 merged PR,每个都留一条远端分支,只出不进。Tadashi 手动清到 68(origin 当前实测 68,其中 44 条 `flywheel-FLY-N` 形)。**不修机制必然复发。**

### 2.4 本地孤儿分支(430 个)— 只有"随 worktree 删除"一条路

Layer A/B 只在删 worktree 时顺带删本地分支。worktree 已不在(pruneOrphans 只清注册、手动删过、异常退出)的孤儿分支**没有任何清理路径**。当前 74 条本地分支中 `git branch --merged` 只报 4 条 — 因为全仓 squash-merge,merged 分支 tip 不是 main 祖先,肉眼/naive 脚本都看不出已 merge。

### 2.5 QA scratch 族(`flywheel-<uuid>-qa`)— issue 候选原因 3 成立

auto-QA(FLY-579)spawn `sessionRole:"qa"` session → `deriveWorktreeKey(ident,"qa")` → sibling worktree + 分支 `flywheel-<key>-qa`(ident 缺失时 fallback 到 UUID,故出现 `flywheel-<uuid>-qa` 族)。QA worktree 检出在被验 PR 的 head:
- 永不产生自己的 merged PR → Layer B `no_merge_evidence` 永久跳过;
- 常带验证产物 → `dirty` 永久跳过;
- QA 完成路径(qa_result)不含 teardown。
**QA scratch 完全没有清理出口。** 当前本地分支里仍有 2 条 `flywheel-UUID-qa`。

### 2.6 其他确认

- 异常退出(OOM/终止)现场:Layer B 兜底本可收,但受 2.2 各 bucket 挡住 → issue 候选原因 4 部分成立(兜底存在但漏)。
- `close-runner`/blocked/no_code 等非 ship 终态:Bridge 注释明示"Bridge only closes tmux; worktree 清理是 Runner/Orchestrator 责任" → 无人做 → 积压。issue 候选原因 2 成立(收官 cascade 不含清理)。
- Layer B 只在 **boot** 跑;两次重启之间零清理(重启按 Annie 规矩攒批,间隔可达数天)。
- personal-assistant 项目 87 次 `gh_unavailable`(无 GitHub remote / gh 不可用)→ 该项目 sweep 每次 boot 全程 no-op,静默。

## 3. 必须保护的对象(误删红线)

审计中发现的、任何新删除逻辑绝不能碰的:
1. open-PR 分支(现有规则,保留);
2. 活 runner 的 worktree(现有 tri-state liveness,保留);
3. **QA Room slot worktree / qa-sandbox remote**(长期基础设施,不能因"没 merge 证据+老化"被扫);
4. 最近 3 天有活动的分支(Annie 明确要求);
5. founder 点名保留清单(需要新增机制);
6. main / 默认分支本体。

## 4. 方向选项

### 方案 A(推荐):三管齐下 — 源头关阀 + 收尾扩围 + sweep v2
1. **源头关阀**:GitHub `delete_branch_on_merge=true`(founder 一次性批准)→ 新 merged PR 远端分支自动消失,存量再由 sweep 清。
2. **收尾扩围**:ship 收尾(post-ship finalization)补删远端分支;QA session 终态(qa_result 落库后)补 QA scratch teardown;三段式 finish 用 phase 实际分支而非推导 key。
3. **Sweep v2**(Layer B 扩展,boot + 事件搭车触发,零新 timer):覆盖内部 `worktrees/`、嵌套先清子再清父、QA 族 ephemeral 规则(dead+终态+≥3 天 → 可删,dirty 先归档 quarantine)、merged-then-moved-head 补充证据(该分支存在 merged PR + 无 open PR + ≥3 天不活跃)、孤儿本地分支、远端 merged 分支存量。全部动作留审计事件 + 支持 dry-run。

优点:治本(源头)+ 治标(存量)+ 防复发(sweep);沿用 FLY-603 骨架和 fail-closed 契约,增量可审。缺点:面广,需拆 PR。

### 方案 B:只加大 sweep(不动收尾、不动 GitHub 设置)
一个更强的定期 sweep 硬扫一切。缺点:留着源头持续进水;force 删 dirty 的安全论证更重;单点复杂度高。

### 方案 C:只开 delete_branch_on_merge + 手动 runbook
最小改动。缺点:worktree/本地分支/QA 族完全没治,Annie 的"根治"不成立。

**推荐 A。** B 的 sweep 强度被 A.3 吸收但 A 有源头阀;C 不达标。

## 5. 已知约束

- 新删除能力挂 `FLYWHEEL_WORKTREE_AUTOCLEAN` 总闸之下,另设分闸(远端分支删除单独可关)。
- 不加新周期负载(FLY-169/FLY-208 先例):sweep 触发 = boot + post-ship 事件搭车(可选 GatePoller N-tick 搭车)。
- 审计事件沿用 `session_events`(`bridge.worktree-cleanup` / `bridge.worktree-reconciler` source 族)。
- 改 GitHub repo 设置属 founder-only 动作,进 plan 的 founder 步骤,不由 runner 擅动。

## 6. 事故复盘(2026-07-11 夜 · 三 Lead 共识)——「活 runner 一律不动」红线的真实由来

> Tadashi 指令(lead-instruction 1d2a051d):本段是 plan 红线「活 runner / 活 session 现场一律不动」的出处,写进文档让任何后来者(包括 Lead 本人)都能被它救一次。

**事件**:机器上 54 个 playwright 进程(27 对),被当成「孤儿积压」。真相:**27 对全部挂在活着的 Claude session 上**(13 Lead + 12 runner),**零孤儿**。根因不是泄漏,是设计——playwright-mcp 在 plugin marketplace 的 .mcp.json 里自动注册,每开一个 claude session 就必然生一对;「高龄」只说明那个 Lead 开了很久,不代表它死了。

三个人都被同一个框架骗了,没有谁比谁聪明:

- **Tadashi**:更早时按「≥1 天 = ancient orphan」reap 掉了 16 个,**没有追父进程链就动手**。是否误伤活 session 未证实(影响≈0),但**不验证就动手**这件事是实的。
- **Peter**:把「27 个孤儿、最老 12 天」原样上报,而他自己跑出的 ppid 数据其实已经显示父进程是活的。
- **Cass**:第一版 grep **也误判了** —— 因为 **Lead 用 `--agent <name>`、runner 才用 `--agent-id`**,朴素 grep 下**活 Lead 的子进程看着像没爹**。⚠️ 这是这个坑的精确形状。

**救场的不是谁拦了谁,是「动手前先做只读诊断(先追父链)」这条纪律本身。** Cass 做了诊断所以停住,Tadashi 没做所以动了手。差的不是信息,是纪律。

**两条方法论**:

1. **不把看不到的说成看到了**:Cass 老实标注「我看不到 18:13 之前」,正是这个"我不知道"留下的口子,才让真相被查出来。假装确定会关上这扇门。
2. **邀功与过度自责是同一种病**:都是拿未证实的东西当结论。同一晚两个方向各犯一次(先说"我拦下了别人的 reap",后说"我杀了 6 个活 session"),两条都未证实。要求:**两个方向都要精确**。

**一个技术事实(它推翻了整个前提)**:**playwright-mcp ≠ claude-in-chrome,两套互不相干的机制。** claude-in-chrome 是 **CLI 原生注入**(claudeInChromeDefaultEnabled),**不是 npm-exec 子进程** → 杀 playwright **动不到任何人的浏览器能力**。所以「Playwright 占着 Chrome / 争抢 / 负载」这一整条推理**从根上就是错的**(真因是账号切换 + 老会话假阴性)。

**落进本单实现的形状**(与 plan §2.7 独立条目一致):Prevention = machine settings 默认关 + QA/`playwright`/`full-mcp` 显式 opt-in(源头不让生,同时不推翻 FLY-812 founder 裁决);Cleanup = 终态时 reap **自己 pane 的子进程树** + **ppid==1-only** 的孤儿兜底(双重身份复核,fresh 快照下 pid+argv 不符绝不发信号)。现存挂在活 session 上的 playwright 对,**本单一个不杀**,等各自 session 自然终态由 Cleanup 收。
