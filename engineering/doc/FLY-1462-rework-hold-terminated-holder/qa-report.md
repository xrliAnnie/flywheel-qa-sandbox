# FLY-1462 rework 永久 hold(terminated holder 空 tmux)— 实现自验记录

Issue: FLY-1462 (https://linear.app/geoforge3d/issue/FLY-1462/infra引擎-rework-永久-holdpersisted-target-missing-terminated-holder-空)
日期: 2026-07-24
基于: plan.md(v3,含 Codex R1+R2 折入)/ claude-design-review-r1.md

> 实现者自验记录,不替代独立 QA 节点。验证对象 = 含 Codex R1 两 HIGH + R2 三 HIGH 修复的实现终态(本 commit;更早版本针对 6f382d7d 的记录已废弃——那份记录曾被 Codex R2 MEDIUM 正确指出是旧证据)。

## 变更终态

1. **classifier 收敛条件**(`phase-actor-reentry.ts`):空 `tmux_session` + FSM 六态,须 marker 全局扫描 `missing` **且** 进程残留扫描 `none` 才 replace(`terminal_status_dead`);任一存疑 → hold(`terminal_status_unconfirmed`);依赖未接线 → `persisted_target_missing`。
2. **Fix A**(`phase-actor-probe.ts`):CommDB 读错误 → `indeterminate`,不再折叠成 `absent`。
3. **Fix C(R2 加固)**(`phase-actor-remnant.ts`):
   - claude 族:argv needle(与 spawn 同源 `deriveRunnerMailboxIdentity`)命中 → found;零命中还须**窗口记账**——每个 `runner-*` session 存活窗都被 `@flywheel_exec_id` 归属给别的 execution 才 none;无 marker 窗(identity-less 合法 spawn,R2 HIGH-2)→ indeterminate。
   - codex:`daemonPid` 是 shim/组长(R2 HIGH-1),none 需 pid ESRCH + socket 无 holder(`lsof -t`)+ 进程组空(`ps -g`)三事实齐;state 缺失/探测失败 → indeterminate。
4. **crash recovery**(`workflow-engine-dispatcher.ts`):扫 `replacement_pending` 幂等重物化(R1 HIGH-2);receipt replay 时若 ledger 已 `started`,幂等补齐 node `running` + delivery `wake_delivered`,绝不重 launch(R2 HIGH-3)。
5. plugin 两处接线 `probeProcessRemnant`;消费者 2 经 ALIVE 过滤不可达六态(零行为变化)。

## 测试执行(实跑)

- 目标套件 **121/121 PASS**:coordinator 34 + remnant 18 + probe 3 + dispatcher 66。
- 对抗用例逐条对应 review 发现:R1 HIGH-1(marker 发布失败活 pane / 从未注册活 runner / 孤儿 daemon → hold);R2 HIGH-1(shim ESRCH + socket holder 活 → found;+组员活 → found;三事实齐才 none);R2 HIGH-2(无 marker runner 窗 → indeterminate;marker=本 exec → found);R2 HIGH-3(两道 seam:ledger-started/node-running 后崩 → 下 tick 收敛 wake_delivered 且 `fake.start` 不再被调);needle 派生漂移守卫(fixture 用 helper 本身构造)。
- 全仓:`pnpm lint` exit 0(15 warning 全在未触碰的既有文件);`pnpm -r build` 绿;`tsc --noEmit`(teamlead)干净;全仓测试矩阵以 PR #700 CI 为准。

## 真机 spike 记录(设计依据)

- `ps axeww` 看不到他进程 env(洁净 spike:活窗口 0 命中)→ env-sweep 否决;`ps eww -p <真 runner pane pid>` argv 完整可见(`--agent-id runner-<8>@...`)→ argv needle 成立。
- `@flywheel_exec_id` 由两 adapter 建窗设置但 best-effort(`set-option` 失败只 warn)→ 单靠 marker 不是死亡证明(R1 HIGH-1 实证)。
- codex daemon:`codex-daemon-runtime.ts` 自己的合同 = 死亡只认 socket + 进程组,从不认 shim pid(R2 HIGH-1 实证)。

## 结论

实现与 plan v3(含 R2 折入)一致;R1+R2 全部 HIGH 的失败场景各有专测拦截;FLY-1150 自愈路径在 coordinator/dispatcher 两层测试走通。待:Codex R3 复审 + PR #700 CI + 独立 QA 节点(在本 head 重验)。
