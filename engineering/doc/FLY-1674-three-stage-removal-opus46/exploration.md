# FLY-1674 删三段式旧路径 + QA 节点真启用 Opus 4.6 — 探索

Issue: FLY-1674 (https://linear.app/geoforge3d/issue/FLY-1674/chore-删掉三段式旧路径founder-直令-真启用-opus-46-于-qa-节点-让模型配置只剩-dag-一条路径验收真实-run)
日期: 2026-08-12
基于: 无

## 1. 问题与 founder 直令

founder(2026-08-10):「我们已经非常久没有再走过旧的三段式了,过去几周也一直在走 DAG……你可以把旧的三段式直接删掉,省得你还会在那里搞错」+ 补充「可能也要看下它有没有什么 feature flag,这些东西可以给它都清理掉」。

触发事故:founder 拍的「QA 节点用 Opus 4.6」被写进三段式 `phases` 表(`phases.qa=claude-opus-4-6[1m]`),而实际派发走 DAG template 读 `bindings.opus`(=opus-5)⇒ 配置写进了废墟,从未生效(实证:FLY-1573 run 快照 qa 节点固化 `claude-opus-5[1m]`)。这是近期第二例「配置写了 ≠ 生效」(上一例 FLY-698:`qa.auto` 默认 OFF 数周未发现)。根治方向 = **把不走的路径删掉,让模型配置只有一个地方可写**。

## 2. 已核实的现状事实(2026-08-12,本 worktree @ dbb58771)

### 2.1 models.json(生产 `~/.flywheel/models.json`,mtime 08-09 14:01 = 回滚时刻)

```json
{ "version": 1,
  "bindings": { "opus": "claude-opus-5[1m]" },
  "tiers": { "medium|light|trivial": "claude-opus-5[1m]" },
  "phases": { "qa": { "vendor": "claude", "model": "claude-opus-4-6[1m]" } } }
```

`phases.qa` 就是那笔「写进废墟」的 4.6 配置,本单要随 `phases` 段一并删除。

### 2.2 boot 炸弹仍在(交付物 2 未被 FLY-1650 顺带解决)

- `packages/teamlead/src/workflow-menu.ts:162-172`(`parseMenuModel`):菜单 YAML 的 `allowedEfforts` 必须**逐字等于** registry 条目的 workflow 档位面,否则 throw。
- `menus/shapes/code.yaml` qa 节点声明 `allowedEfforts: [low, medium, high, xhigh, max]`、`defaultEffort: xhigh`。
- FLY-1650(PR #787,已 merge)把 4.6 注册进 registry 并做档位收窄:`UNSUPPORTED_EFFORTS_BY_MODEL` 里 4.6/4.6[1m] 排除 `xhigh`(`model-builtins.ts:74-79`),bound() 路径自动继承(注释明说「万一将来把 opus 档绑到 4.6,bound() 会接管」)。
- 结论:一旦 `bindings.opus → claude-opus-4-6[1m]`,registry 的 opus workflow 档位面变成 `[low, medium, high, max]`(4 档),`code.yaml` 声明 5 档 → `parseMenuModel` throw → boot 时 `importWorkflowMenuSeeds`(`plugin.ts` 无 try/catch)→ Bridge exit 1。**这正是 2026-08-09 14:01 被迫回滚的原因,现在依然会炸。**

### 2.3 FLY-1650 已交付的基建(本单可依赖,不必重做)

- 4.6 + 4.6[1m] 注册表条目(alias `opus-4-6` 等),**无 `lead` 面**(founder 明确 Lead 这轮不换;Lead 设 4.6 会 fail-loud)。
- `resolveAllowedEffort` 四咽喉点收窄(runner tmux spawn / Lead launcher / **workflow admission**(写不可变审计行 `dispatch_vendor_resolved`)/ cross-family reviewer):不支持的档位**丢弃并降到模型默认档、出声**,不 throw。
- FLY-1652 独立 QA PASS(真机、真 models.json 8 形态矩阵)。
- ⚠️ FLY-1652 QA 矩阵 F4(`bindings.opus=claude-opus-4-6`)显示 lead 面解析 4.6 = `THROW:ModelPolicyError` — 切 binding 前必须预检 fleet 里没有任何 Lead 绑在 opus 档上(现役 Lead 均为 Fable,但要真查不能假设)。

### 2.4 生产 DB 残留(`~/.flywheel/teamlead.db`,只读查询)

- `three_stage_turn` 表:**0 行**。
- phase-role sessions 分两族:`workflow_node_id IS NULL`(三段式)最后一跑 design 07-31 / implement 08-05 / qa **07-29**;`workflow_node_id IS NOT NULL`(DAG 节点)持续活跃至今(08-12)。
- `design_backend` 非空最后 07-31。
- 结论:**当前无 in-flight 三段式 run**,founder 的「很久没走了」有账面铁证。删除前仍需运行时预检(active session 中无 phase-role 且 workflow_node_id IS NULL 的行)。

### 2.5 三段式开关生产现状

- `.flywheel/config.yaml:257-258`:`pipeline.three_stage: true` **仍开着** — 但实际派发走 DAG(FLY-1436 work-kind cutover 后 DAG dispatch entry 接管),这正是「配置写了 ≠ 生效」的机理本体:开关还开着,路却不走了。
- `~/.flywheel/.env`:`FLYWHEEL_THREE_STAGE_CODEX_DESIGN=0`(:132)、`FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT=1`(:145)— 两个都显式写着**默认值**,属于「写了不生效也不报错」的同族垃圾。`FLYWHEEL_THREE_STAGE` / `FLYWHEEL_THREE_STAGE_KEEPALIVE` 未设。
- 引用面:grep three-stage 命中 50+ 源文件 — 纯三段式文件(`three-stage-policy.ts` 339 行、`phase-orchestrator.ts` 2376 行、`three-stage-phases.ts` 326 行)+ 大量共用件分支。删除边界盘点在 research.md。

## 3. 四件交付的方案方向

### 3.1 删三段式(净删除)

先诊断后删:已派全量引用盘点(见 research.md)。已知共用陷阱(必须保留/改名而非盲删):
- `no-three-stage` label:FLY-1372 起 DAG dispatch entry 也消费,语义=「run as single session」— 对 DAG 的语义要保留。
- `isThreeStagePhaseRole` / NODE_TYPE_REGISTRY `isPhaseRole` / `resolveCompletionSessionRole`:DAG 节点 role 同为 design/implement/qa,完成链共用。
- thread 徽章(`PHASE_THREAD_BADGE` 族):DAG 节点 thread 也用。
- `turn` 机制:`three_stage_turn` 表(0 行,三段式)与 `workflow_activation_turn` 表(DAG)是两套;flywheel-comm `turn` 命令为共用外壳。
- `session_role` / `design_backend` 等 DB 列:列保留(历史行仍在),消费逻辑按 DAG 语义收敛。

### 3.2 菜单 effort 兼容 — 方向选择:**对齐菜单声明**(方案 A)

- **A(选定方向):`code.yaml` qa 节点 `allowedEfforts` 改为 `[low, medium, high, max]`、`defaultEffort: xhigh → high`。** 纯数据改动、零新逻辑,判据「逻辑只减不加」满足。`parseMenuModel` 的逐字相等校验**原样保留**(它就是防「声明与现实脱节」的那道门,本次事故恰证明它有用 — 它把错误从「静默不生效」变成「fail-loud」,只是 fail 的位置在 boot,时机糟糕)。
- B(否决):派发层做 xhigh→high 显式降级映射 — 新增映射逻辑,违反「只减不加」;且 FLY-1650 的 `resolveAllowedEffort` 已经在 admission/launch 层提供了「丢弃+降默认+出声」,再加一层映射是重复机制。
- defaultEffort 取 `high` 而非 `max` 的理由:4.6 无 xhigh,原 xhigh 意图是「高于 high 低于 max」;FLY-1650 的丢弃语义也是「降到模型默认档」;`max` 是显式升档,founder 未拍,不擅自升。QA 节点菜单仍留 `max` 可选,要升走菜单 override。

### 3.3 切 `bindings.opus → claude-opus-4-6[1m]`(在 3.2 落地后)

- 同时把 `tiers.medium/light/trivial`(现=opus-5[1m])是否同切?**不切**:issue 只拍了 QA 节点(经 bindings.opus 流到 menu `opus` 别名),tiers 是难度分档路由,founder 没拍,超范围。→ 需在 plan 里显式说明 tiers 维持 opus-5[1m](注意:bindings 与 tiers 是两个独立段;删 phases 段不伤它们 — research.md 验证)。
- 预检:fleet manifest 无 Lead 绑 opus 档(§2.3 THROW 风险)。
- 生效时机(热 or 重启)在 research.md 落实;boot 阴性对照(重启一次不炸)是硬验收。

### 3.4 真实 run 验证

- 新 run 快照 qa 节点 = `claude-opus-4-6[1m]`(查 workflow run 节点行,不看配置文件)。
- QA session 进程实际加载 4.6:tmux pane 的 claude 进程 argv `--model claude-opus-4-6[1m]` + session 内证据。
- Bridge 重启一次成功(boot 炸弹阴性对照)。
- 此件属 implement/QA 节点执行;design 只定验收方法与证据形态。

## 4. 开放问题与倾向

| # | 问题 | 倾向 | 定案位置 |
|---|------|------|---------|
| Q1 | `no-three-stage` label 删后语义 | 保留 label 与其 DAG 消费(改注释去三段式措辞);不改名(改名要动 Linear 存量 label,超范围) | plan |
| Q2 | `pipeline.three_stage` config 键删除后,存量 config.yaml 里 `pipeline:` 块如何处理 | ConfigLoader 对未知键的行为决定:若 strict 则删键要同步清两处 config.yaml;fail-loud 优于静默忽略 | research |
| Q3 | 4 个 env flag 的删除形态 | 按 FLY-1466 模式进 retired tombstone + 从 `~/.flywheel/.env` 清行 | plan |
| Q4 | `phases` 段删除后 models.json 校验行为 | 未知段应被拒(fail-loud)还是忽略?跟随 model-config.ts 既有 schema 姿态,research 落实 | research |
| Q5 | phase-orchestrator 删除对 StateStore 表/FSM 状态的影响 | 表保留(历史数据),FSM 三段式专属状态/边随代码删;需盘点 FSM 状态机里 phase 态 | research |
| Q6 | in-flight 三段式 run 预检 | 账面已 0;实施时以同一查询做删除前预检,非零则先收敛 | plan |
