# FLY-1466 剥 #696 三个新 feature flag 再 ship — 实施计划

Issue: FLY-1466 (https://linear.app/geoforge3d/issue/FLY-1466/p1剥-flag-fly-1448-696-剥-3-个新-feature-flag-再-ship-在既有分支上做不新建分支)
日期: 2026-07-24
基于: research.md

## 0. 目标 / 非目标

**目标**:在既有分支 `flywheel-FLY-1448`(PR #696)上:①与 origin/main 合流解除 CONFLICTING;②剥掉 3 个新 flag(`engine_declared_park` / `founder_decision_deadline_ms` / `terminal_receipt_settlement`)改为无条件行为;③全仓 gate 绿后 push,产出可 ship 的新 head。

**非目标**:不新建分支/PR;不改 FLY-1448 断路修的行为语义;不碰其他 flag;不修 1448 claim 卡死引擎 bug(FLY-1462 同类);不清 worktree untracked QA 残留;不自 merge、不自 ship。

## 1. Preflight(implement 第一步)

```bash
cd ~/Dev/flywheel-FLY-1448
git status                 # 期望:干净(untracked qa-*.{mjs,md} 残留可在,不入 commit)
git fetch origin main
git log --oneline -1       # 期望 head = 设计时基线 b863b4d8 之后仅多 design docs commit
gh pr view 696 --json headRefName,state   # 期望 flywheel-FLY-1448 / OPEN
```

若 head 与预期不符(有他人新 commit),先重读增量再继续 —— 不盲做。

## 2. Commit A — 合流 `origin/main`(普通 merge,不 rebase、不 force-push)

```bash
git merge origin/main      # 预期冲突恰好 3 个文件(research §3)
```

冲突解决原则(**以 main/FLY-1374 新结构为基座,重挂 FLY-1448 新增**;两侧语义互补,都保留):

1. `runner-receipt-patrol.ts` — 保 main 侧:`wakeFailureEpisodeFingerprint()`、`processOne` 终态目标 `disposeRunnerPhaseWakeForTerminal`(不再 escalate)、alert `firstDetectedAtMs` 读 episode start;保我们侧:park 探针接进 wake admission。
2. `plugin.ts` — 以 main 的 event-driven session truth 重构(dual reconcilers / holder rehydration)为基座,把 1448 的 settlement projector / park outbox / decision convergence 接线重新挂到重构后的 seam 上。**此步 flag 读点代码一律原样保留**(剥 flag 是 Commit B 的事,变量隔离)。
3. `runner-receipt-patrol.test.ts` — 两侧用例全部保留。

验证(合流正确性的客观锚 = 两侧断言同时绿):

```bash
pnpm -r build
pnpm --filter teamlead test -- run   # 重点:runner-receipt-patrol / plugin 相关 / StateStore.terminal-settlement /
                                     # terminal-receipt-settlement / workflow-engine-park-projector /
                                     # founder-reply-receipts / founder-decision-convergence
```

红了先判:是冲突解错(修),还是已知 pre-existing machine-state flake(用 origin/main HEAD 同套件对照证伪;memory: `teamlead_full_suite_preexisting_machine_state_flakes`)。绿后 `git commit`(merge commit,message: `merge main into FLY-1448 branch (resolve FLY-1374 x FLY-1448 overlap)`)。

## 3. Commit B — 剥 3 个 flag(单 commit,单一语义「去可配置性」)

**顺序上以 drift test 当 RED 锚(TDD)**:先删 registry entry + 加 tombstone → `feature-flags-drift` 因「tombstone 的 envVar 在 src 复活/读点未注册」变红 → 删全部读点转绿 → 清测试脚手架。

### 3.1 registry + truth

- `packages/config/src/feature-flags/registry.ts`:删 3 个 entry 及 `─── FLY-1448 ... ───` 分节注释。
- `packages/config/src/feature-flags/truth.ts` `RETIRED_FLAGS` 追加 3 条 tombstone,`retiredBy: "FLY-1466"`(research §1.4 逐字形态)。

### 3.2 源码读点(逐处,research §1 为准)

- `plugin.ts`:7888 短路行删;8013 短路块删;8259 `enabled:` 参数行删。
- `StateStore.ts`:11062 短路删;4089/4148 `!== "0"` if 包裹去掉保留体;4320/4345/4390 `=== "0"` 短路删。
- `terminal-receipt-settlement.ts`:51/85/106 短路删。
- `founder-reply-deliverer.ts`:560-567 env 解析块删,`const deadlineMs = DEFAULT_FOUNDER_DECISION_DEADLINE_MS;`。
- `workflow-engine-park-projector.ts`:`enabled?: () => boolean` 接口字段 + 守卫行删(死选项,唯一调用点已删)。

(行号为 `b863b4d8` 基线;Commit A 合流后可能漂移,按符号定位。)

### 3.3 测试

- `StateStore.terminal-settlement.test.ts`:删 env 脚手架;「OFF writes no intent and ON catch-up creates exactly one」改写为「catch-up ensure is idempotent per terminal lifecycle」(OFF 段删;保留 `ensureTerminalSettlementIntent` 连调两次 → 同 intent_id、总数 1)。
- `bridge/__tests__/terminal-receipt-settlement.test.ts`:删「kill switch freezes existing intents and side effects」整个 it + env 脚手架。
- 其余测试零改动(research §2.2 已核:另两个 flag 全仓测试零引用)。

### 3.4 残留核验(claim 级,不止改动位置)

```bash
grep -rn "ENGINE_DECLARED_PARK\|FOUNDER_DECISION_DEADLINE_MS\|TERMINAL_RECEIPT_SETTLEMENT\|engine_declared_park\|founder_decision_deadline_ms\|terminal_receipt_settlement" \
  --include="*.ts" --include="*.sh" --include="*.mjs" . | grep -v engineering/doc | grep -v truth.ts
# 期望:零输出(truth.ts tombstone 与本 issue docs 是仅有的合法残留)
```

## 4. 全仓 gate(FLY-224/248 教训:全仓,不是只跑改动包)

```bash
pnpm lint && pnpm -r build && pnpm test:packages:run
```

teamlead 全套件已知 flake 处理同 §2。绿后 commit(若 §3 拆过中间 commit 可 squash 成 Commit B)。

## 5. Commit C — CLAUDE.md 里程碑修订(PR 最后一个 commit)

#696 已带 FLY-1448 里程碑行(`b863b4d8`)。修订该行:补「3 个新 flag 已剥(FLY-1466,Annie 铁律)+ 与 main 合流(解 FLY-1374 冲突)」;不加独立 FLY-1466 行(1466 是 1448 的执行单,合并叙述)。合流时 CLAUDE.md auto-merge,注意行落在 1448 行位置。

## 6. Push + mergeable 核验

```bash
git push origin flywheel-FLY-1448        # 普通 push(merge 策略无 force 需求;禁 force)
gh pr view 696 --json mergeable,mergeStateStatus   # 期望 MERGEABLE
```

## 7. 下游(不归本 implement,列给 Lead/DAG 编排)

1. **codex code review** @ 新 head:xhigh、经 `codex:rescue`,真跑不 skip;review 材料点明两块 diff:合流解冲突(1374×1448 交互)+ 剥 flag。loop 到 APPROVED。
2. **独立 QA** @ 新 head:529 房**真 Discord N-to-N**(批准链是 Discord 面,不是 code-only);范围含 1374×1448 合流交互面 + 剥 flag 后无条件行为(terminal settlement backfill / park admission / 3min decision deadline)。
3. 新 head 开 **approve gate** → Annie 重批 ship(founder-only;`verify-approval` 后才准 merge,永不自 merge)。

## 8. 验收标准(全部客观证据)

- [ ] `gh pr view 696` = `MERGEABLE`,headRefName 仍 `flywheel-FLY-1448`,无新 PR。
- [ ] §3.4 残留 grep 零输出;`feature-flags-drift` / `flag-truth` 套件绿。
- [ ] `RETIRED_FLAGS` 含 3 条 `retiredBy: "FLY-1466"`。
- [ ] 删 OFF-path 后:`StateStore.terminal-settlement` / bridge `terminal-receipt-settlement` 套件绿,且无任何测试再设这 3 个 env。
- [ ] `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` 绿(flake 需 main 对照证伪记录)。
- [ ] 1374 侧断言(episode fingerprint / terminal disposal)与 1448 侧断言(park 探针 / settlement / convergence)在合流后同时绿。
- [ ] codex code review APPROVED @ 最终 head;QA verdict @ 最终 head(head 再变则重验)。

## 9. 风险与回退

| 风险 | 缓解 |
|------|------|
| plugin.ts 合流解错(最大风险:±235 vs +243 同区域) | 以两侧测试同时绿为硬锚;解不动/语义存疑 → `flywheel-comm ask` Tadashi,不硬猜 |
| 剥掉逃生口后线上出批准链事故 | 回退手段 = revert PR(Annie 铁律:宁 revert 不留 flag);行为本身已过 QA scoped-PASS |
| tombstone 触发 env 校验报错 | 已核生产 env 未设这 3 个变量(research §1.4) |
| teamlead 套件 flake 误判回归 | main HEAD 同套件对照证伪并留记录 |
| push 后 head 变化使旧 QA/review 失效 | 本来就要求 @ 新 head 重跑 codex review + QA(issue 流程内置) |

## 10. Scope 确认状态

「合流纳入 1466」已向 Tadashi 发非阻塞 ask(id `ed611965`,2026-07-24);design 按纳入推进,若 Lead 要求拆单,§2 独立成单、§3-6 不变。
