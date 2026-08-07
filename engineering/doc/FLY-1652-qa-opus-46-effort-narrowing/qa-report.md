# QA 独立复核报告 — FLY-1650 Opus 4.6 注册表 + effort 咽喉收窄 (PR #787)

**Issue**: FLY-1652 (QA·FLY-1650 真机独立验收)
**URL**: https://linear.app/studio/issue/FLY-1652
**审对象**: PR #787 branch `flywheel-FLY-1650` head `6d243b82`（派单 pin = `6d243b82`；复核开始与结束各核一次，**未漂移**，`gh pr view 787 → headRefOid 6d243b8277c3d75a5fef4b5b7de06ef6e6893ee9`, `MERGEABLE`）
**Base**: `origin/main` = `4857d999`
**日期**: 2026-08-06
**判定**: **PASS**（4 项申报改动全部真机复现；8 个阳性对照全部翻红。另有 3 条**非阻塞**观察，见 §7）

---

## 0. 复核方法（为什么这不是实现者测试的回声）

四处刻意与实现者的 harness 不同：

1. **不 harness，跑真配置链**。所有断言都由一个独立 node 进程 `import` **QA worktree
   里真编译出来的 dist**（不是 vitest 转译的 src），配置来源是磁盘上真的 `models.json`
   —— 包括**生产的** `~/.flywheel/models.json`（只读）。8 种 models.json 形态见 §2。
2. **skew 用真的两份 dist，不是造出来的 JSON**。实现者的 shell 测试把 "旧 dist" 模拟成
   一段少了字段的 JSON 字面量。本复核直接拿**生产 main 检出里已经编译好的**
   `packages/teamlead/dist/lead-model-launch.js`（`grep -c companionDefaultEffort` = **0**，
   真的早于 FLY-1650）当旧侧，与 QA worktree 的新 dist 交叉，再交叉 main 的
   `claude-lead.sh` 与 FLY-1650 的 `claude-lead.sh`，全部在**真 bash 3.2.57** 下跑
   launcher 自己的 `node --input-type=module -e` 解析块。断言的是 launcher 真实 argv。见 §4。
3. **阳性对照做在被审代码上**，8 个修复逐个摘掉、重编译、重跑对应断言（§6）。
4. **workflow admission 用真 StateStore + 真 bundled seed**（`:memory:` SQLite，不碰生产库）。

**安全边界（授权约束逐条核对）**：全程未部署、未重启任何服务、未写生产库、未碰生产
launchd。收尾复核证据：生产 repo `packages/teamlead/dist/lead-model-launch.js` mtime 仍是
`Aug 6 12:31`（本次会话之前）、生产 repo `git status --porcelain` 空、
`~/.flywheel/models.json` mtime 仍是 `Jul 28 18:37` 且内容逐字未变。

**QA 隔离 worktree**: `/Users/xiaorongli/Dev/flywheel/worktrees/qa-fly1650`（detached @ `6d243b82`）。
全部复核结束后 `git status --porcelain` = 空，`HEAD` = `6d243b8277c3d75a5fef4b5b7de06ef6e6893ee9`。

---

## 1. 申报改动 ↔ 判定对照

| # | PR 申报 | 判定 | 主要证据 |
|---|---------|------|----------|
| 1 | model-builtins 注册表加 `claude-opus-4-6`（排除 xhigh） | **PASS** | §2 全 8 种配置形态 |
| 2 | `resolveAllowedEffort` 四咽喉点堵 effort 透传（含 `max→xhigh` 盲转修复） | **PASS** | §3 四点逐个真机跑通 |
| 3 | `claude-lead.sh`：字段缺失 = build/deploy 错位 → fail-loud + 清掉 resolver 产出的**全部** effort | **PASS** | §4 真旧 dist E2E（A→B 前后铁证） |
| 4 | admission 测试回读持久化 `dispatch_vendor_resolved` 审计事件 | **PASS** | §5 |

---

## 2. 配置链矩阵 — 真 `models.json`，8 种形态

驱动脚本对每种形态起一个独立 node 进程，import QA worktree 的 `packages/config/dist/index.js`，
dump 注册表条目 / 别名 / `resolveAllowedCanonicalModel` / `resolveAllowedEffort` 全矩阵。

| Fixture | models.json 形态 | 4.6 的 `surfaces` | 4.6 的 `effortsBySurface` | `lead` 面解析 4.6 | 重复 id |
|---|---|---|---|---|---|
| **F0** | **生产 `~/.flywheel/models.json`**（只读） | `dispatch,runner,workflow,cron` | runner/workflow = `low,medium,high,max`；cron = `[]`；**无 lead 键** | `THROW:ModelPolicyError` | 0 |
| F1 | 文件不存在（纯内建） | 同上 | 同上 | `THROW:ModelPolicyError` | 0 |
| F2 | `models:` overlay 重新声明 4.6（claude vendor，含 lead 面） | `dispatch,lead,runner,workflow,cron` | **lead 也是** `low,medium,high,max` | `claude-opus-4-6` | 0 |
| F3 | overlay 把 4.6 声明成 `runtimeVendor: codex` | 同 F2 | **runner = `[]`**（不是 `["xhigh"]`） | — | 0 |
| F4 | `bindings.opus = claude-opus-4-6` | `dispatch,runner,workflow,cron` | 同 F0 | `THROW:ModelPolicyError` | 0 |
| F5 | `bindings.opus1m = claude-opus-4-6[1m]` | 同 F0 | 同 F0 | `THROW` | 0 |
| F6 | overlay 声明 **Opus 5**（对照组） | 同 F0 | 同 F0；**Opus 5 保留全 5 档含 xhigh** | `THROW` | 0 |
| F7 | `bindings.opus` + `opus1m` 都绑 4.6 | 同 F0 | 同 F0 | `THROW` | 0 |

要点：

- **`xhigh` 在三条进 registry 的路径上都拿不回来**：内建条目（F0/F1）、
  `models:` overlay（F2）、codex-vendor overlay（F3）。F3 是 Codex R1 MEDIUM 那条 —— 旧代码
  `efforts[surface] = ["xhigh"]` 写死，一个把 4.6 声明成 codex 的 overlay 就能绕开收窄；
  现在实测是 `[]`。
- **别名可解析**：`opus-4-6 → claude-opus-4-6`，`opus-4-6-1m → claude-opus-4-6[1m]`。
- **Lead 下拉不多出 4.6**：`buildModelCatalog("lead")` 里 4.6 条目数 = 0；
  `isModelSelectable({surface:"lead", model:"claude-opus-4-6"})` = `false`。
  runner 面 = `true`，两条目 efforts 都是 4 档。
- **收窄是响亮的**，不是静默：`resolveAllowedEffort` 每次丢弃都打 stderr，例如
  `[model_config] effort xhigh is unavailable for claude-opus-4-6 on runner; dropping it (supported: low, medium, high, max)`。
- 编译期 `DEFAULT_OPUS_BINDINGS` 绑到 4.6 的那条路（源码注释声称的「另一个决定」）单独验过：
  `buildModelRegistry({opus:"claude-opus-4-6", ...})` → pilot 条目让位、`bound()` 接管、
  **无重复 id、`assertValidModelRegistry` 不抛**、4.6 拿到 `lead` 面且 lead 档位仍是
  `low,medium,high,max`。注释属实。

---

## 3. 四个咽喉点 — 真 dist、真配置

### 3.1 Runner spawn（`TmuxAdapter.buildCliArgs`）

生产 models.json 下，驱动真 `TmuxAdapter` 子类直接取 argv：

| ctx.model / ctx.effort | `--model` | `--effort` |
|---|---|---|
| `claude-opus-4-6` / `xhigh` | `claude-opus-4-6` | **`<absent>`** |
| `claude-opus-4-6[1m]` / `xhigh` | `claude-opus-4-6[1m]` | **`<absent>`** |
| `claude-opus-4-6` / `max` | `claude-opus-4-6` | `max` |
| `claude-opus-4-6` / `high` | `claude-opus-4-6` | `high` |
| 别名 `opus-4-6` / `xhigh` | `claude-opus-4-6` | **`<absent>`** |
| 对照 `opus` / `xhigh` | `claude-opus-5[1m]` | `xhigh` |
| 对照 `claude-fable-5` / `xhigh` | `claude-fable-5` | `xhigh` |
| 无 model / `xhigh`（未知模型 ⇒ 原样） | `<absent>` | `xhigh` |

### 3.2 Lead 启动（`resolveLeadLaunchSelection` 三个出口 + `resolveLeadModelLaunch`）

生产配置下三个出口都对（`authoritative_absence` / `configured` / `model_invalid` 替换后
**按替换模型重新校验**，不是把原模型的 effort 顺下去）。

替换模型 Fable 接受全部 5 档，所以在生产形态下这条收窄是 no-op（字节兼容）。要看见
`configured` 出口真的收窄，用 F2（overlay 给 4.6 挂上 lead 面）：

| 输入 | model | effort | reason | `companionDefaultEffort` |
|---|---|---|---|---|
| 4.6 + xhigh | `claude-opus-4-6` | **`null`** | `configured` | **`null`** |
| 4.6 + max | `claude-opus-4-6` | `max` | `configured` | `null` |
| 4.6，无 effort | `claude-opus-4-6` | `null` | `configured` | **`null`** |
| Opus 5，无 effort | `claude-opus-5` | `null` | `configured` | **`"xhigh"`** |
| Opus 5 + high | `claude-opus-5` | `high` | `configured` | `"xhigh"` |
| 无 model | `claude-fable-5` | `null` | `authoritative_absence` | `"xhigh"` |

`companionDefaultEffort` 对每个接受 xhigh 的模型都逐字是 `"xhigh"` —— 今天的舰队不变。

### 3.3 Bridge review runner（`buildClaudeReviewArgv`）

| model / effort | argv 尾部 |
|---|---|
| `claude-opus-4-6` / 默认(xhigh) | `--output-format json --model claude-opus-4-6`（**无 `--effort`**） |
| `claude-opus-4-6[1m]` / 默认 | 同上（无 `--effort`） |
| `claude-opus-4-6` / 显式 `xhigh` | 无 `--effort` |
| `claude-opus-4-6` / 显式 `max` | `--model claude-opus-4-6 --effort max` |
| 对照 `claude-opus-5` / 默认 | `--model claude-opus-5 --effort xhigh` |

### 3.4 Workflow admission（`resolveNodeDispatchAtLaunch`，真 StateStore + 真 seed）

`phases.implement` 从真 models.json 读，`tpl_eng_heavy` seed 真物化一个 run：

| Fixture | `phases.implement`（配置） | admission 落的 dispatch |
|---|---|---|
| F8 | `claude / claude-opus-4-6 / **max**` | `claude / claude-opus-4-6 / **max**` ← **R3 remap 守卫生效** |
| F9（对照） | `claude / claude-opus-5 / max` | `claude / claude-opus-5 / **xhigh**` ← 旧 remap 仍照常发生 |
| F11 | `claude / claude-opus-4-6 / high` | `claude / claude-opus-4-6 / high` |
| F10 | `claude / claude-opus-4-6 / **xhigh**` | 配置解析阶段就被拒（见下） |
| F0（生产） | `codex / gpt-5.6-sol / xhigh` | 原样，未受影响 |

F10 值得记一笔：`phases` 段的解析器本来就拿 `entry.effortsBySurface.runner` 校验 effort，
所以注册表一收窄，`4.6 + xhigh` 直接在**读配置**时被拒（warning
`phase implement ignored: unavailable dispatch selection`）并回落内建，根本到不了 admission。
这是 admission 收窄之外多出来的一层，非本 PR 新增，但因本 PR 的注册表改动才对 4.6 生效。

---

## 4. build/deploy skew — 真两份 dist × 真两份 launcher × 真 bash 3.2

`old-claude-lead.sh` = `git show origin/main:packages/teamlead/scripts/claude-lead.sh`。
旧 dist = 生产 main 检出已编译的 `lead-model-launch.js`（`companionDefaultEffort` 出现 0 次）。
用 `models:` overlay（新旧两份 config 代码解析路径相同）让 4.6 在两侧都成为 lead-eligible，
才构成 apples-to-apples 的对照。

| Case | dist | launcher | Lead 配置 | 真实 ARGV |
|---|---|---|---|---|
| **A. 事故形态** | 旧(0) | main 的 | 4.6 + xhigh | `--model claude-opus-4-6 --effort xhigh` ← **就是要防的那对** |
| **B. skew** | 旧(0) | FLY-1650 的 | 4.6 + xhigh | `--model claude-opus-4-6`（+ 两条 WARNING log） |
| C. 已修 | 新(1) | FLY-1650 的 | 4.6 + xhigh | `--model claude-opus-4-6` |
| D. 已修 | 新(1) | FLY-1650 的 | 4.6，无 effort | `--model claude-opus-4-6` |
| E. 字节兼容 | 新(1) | FLY-1650 的 | Opus 5，无 effort | `--model claude-opus-5 --effort xhigh` |
| F. 字节兼容 | 新(1) | FLY-1650 的 | Opus 5 + high | `--model claude-opus-5 --effort high` |
| G. skew 副作用 | 旧(0) | FLY-1650 的 | Opus 5 + high | `--model claude-opus-5`（**valid 的 high 也被拒掉**，见 §7 OBS-2） |
| H. 生产形态 | 新(1) | FLY-1650 的 | 生产 models.json + Opus 5 | `--model claude-opus-5 --effort xhigh` |

Case B 的原始 log（真 bash 3.2.57）：

```
LOG: model_config WARNING: dist predates the FLY-1650 effort narrowing (build/deploy skew);
     dropping BOTH the configured effort (xhigh) and the companion fallback rather than
     launching claude-opus-4-6 with an unvalidated tier
LOG: Companion: no --effort (FLY-1650; claude-opus-4-6 accepts no companion fallback tier)
ARGV: --dangerously-skip-permissions --model claude-opus-4-6
```

A → B 就是这个 seam 的前后铁证：同一份旧 dist、同一份配置，只换 launcher，
`--effort xhigh` 消失且错位被喊出来。

---

## 5. admission 审计回读（申报 4）

`workflow-dispatch-resolution.test.ts` 的
`persists the narrowed dispatch into the immutable audit event` 逐行核过：它把 live manifest
的 `work` 节点改成 `claude-opus-4-6[1m] + xhigh` → `resolveNodeDispatchAtLaunch` →
`admitGeneralizedWorkflowExecution` → 再用 **`store.listWorkflowRunEvents("run-v2")`
从库里读回** `kind === "dispatch_vendor_resolved"` 的事件，断言 payload 恰好
`{vendor:"claude", model:"claude-opus-4-6[1m]"}` 且 `not.toHaveProperty("effort")`。
是真回读持久化行，不是断言函数返回值。独立复跑通过。

---

## 6. 阳性对照 — 摘掉修复，对应断言必须翻红

每条都：改被审源码 → 重编译 → 跑「本该守住它」的断言 → 恢复 + 重建 dist。
**8/8 全部翻红。**

| # | 摘掉什么 | 实现者的断言 | 我的真机探针 |
|---|---|---|---|
| M1 | `UNSUPPORTED_EFFORTS_BY_MODEL` 清空 | config **10 failed** / 23 | 4.6 runner/workflow 恢复 5 档，`resolveAllowedEffort(xhigh)` = `"xhigh"` |
| M2 | TmuxAdapter 的 `resolveAllowedEffort` 还原成裸 `ctx.effort` | TmuxAdapter **1 failed** / 133 | — |
| M3 | `max→xhigh` 的 `workflowSurfaceHasXhigh` 守卫去掉 | workflow-dispatch **1 failed** / 7 | F8：配置 `max` → admission 落**无 effort**（静默降档，正是守卫要防的） |
| M4 | skew 分支不再清 `decision.effort` | shell suite **11 passed / 1 failed** | 真 skew E2E case B 变回 `--model claude-opus-4-6 --effort xhigh` |
| M5 | `companionDefaultEffort` 写死回 `"xhigh"` | lead-model-launch **1 failed** / 7 | F2 下 4.6 的 `companionDefaultEffort` 变回 `"xhigh"`；真 launcher E2E case D 变成 `--model claude-opus-4-6 --effort xhigh` |
| M6 | review runner 无条件加 `--effort` | claude-review-runner **1 failed** / 28 | — |
| M7 | overlay 路径还原成 `ROLE_EFFORT_LEVELS` | config **2 failed** / 23 | F2 下 4.6 三个面全部拿回 xhigh |
| M8 | codex+runner 特例写死 `["xhigh"]` | config **1 failed** / 23 | F3 下 4.6 runner 面变回 `["xhigh"]` |

恢复后在干净 head 上复验全绿（§8），且两个探针输出与 mutation **之前**的运行逐字一致
（`diff` 空），确认没有 dist 漂移污染结论。

> **本复核自身的一个坑，记在这里**：M3 第一次跑时我的 dist 探针显示「没变化」，
> 但正确结果应该是「静默降档」。根因是 `pnpm --filter teamlead build` —— 包真名是
> `flywheel-teamlead`，pnpm 对 filter 不匹配**返回 0**并打印 `No projects matched the filters`，
> 于是重编译静默 no-op，探针读的还是旧 dist。这是典型的**空过绿**：阳性对照本身失效了还看着像通过。
> 修法是给 `rebuild()` 加了 `grep -q "No projects matched"` 的硬闸，M3/M5/M6 全部重跑。
> 上表是重跑后的结果。

---

## 7. 非阻塞观察（不影响本 PR 判定，供 Lead 决定是否另立单）

**OBS-1 — `models.json` 的 `bindings.opus` 绑到 4.6：现在会被接受，但只改别名指向。**
main 上写 `bindings.opus = "claude-opus-4-6"` 会被拒（`bindings.opus ignored: unknown Claude
model claude-opus-4-6`）；本 PR 把 4.6 放进注册表后这个绑定**被接受**了。但 registry 始终由
**编译期常量** `DEFAULT_OPUS_BINDINGS` 构建，运行时 `applyBindings` 只把 `opus` / `opus-1m`
别名重新指向目标，不重建 surfaces。后果实测（case I）：

```
models.json: {"bindings": {"opus": "claude-opus-4-6"}}
Lead 配置:   model = "opus"
→ [model_config] Lead model opus is not resolvable; substituting claude-fable-5
→ ARGV: --model claude-fable-5 --effort xhigh
```

即：运维在 models.json 里把 opus 档绑到 4.6，所有用 `opus` 别名的 Lead 会被换成 Fable。
**是响亮的**（warning + `substituted:true` + `reason:model_invalid`），不静默，也不掉 Lead。
源码注释说的「走 `DEFAULT_OPUS_BINDINGS` 那条路」指的是编译期常量，那条路我验过是对的
（§2 末）；只是它和 models.json 里同名的 `bindings` 键**不是同一个机制**，容易踩。

**OBS-2 — skew 拒绝的影响面是全舰队，不只 4.6。**
Case G：旧 dist + 新 launcher + Opus 5 + 配置 `high` → `high` 也被丢掉。这是「拒绝猜」的
刻意设计（PR 里 R6 注释写明「dropping BOTH」），且是 fail-safe 的（Lead 照常起，按模型自身
默认档跑，日志喊出来）。但真实代价是：**任何 shell 领先 dist 的部署窗口内，每个 companion
Lead 和每个配了 effort 的 Lead 都会暂时失去 effort 标志**，直到 dist 重建。值得在 ship 说明里
让运维知道（`restart-services.sh` 先构建再重启，窗口很短，但不是零）。

**OBS-3 — `resolveAllowedEffort` 对「条目没声明该面」返回原值，是刻意的 narrowing-only。**
4.6 在 `lead` 面就是这种情况（没有 `lead` 键 ⇒ 返回 `"xhigh"`）。生产上不可达，因为
`resolveAllowedCanonicalModel` 在此之前就对 4.6 的 lead 面抛了。记录以免日后误读成漏洞。

---

## 8. 独立复跑与最终复验（干净 head，全部 mutation 之后）

| 套件 | 结果 |
|---|---|
| `packages/config` → `fly1650-opus-46-pilot.test.ts` | **23 passed** |
| `packages/teamlead` → `workflow-dispatch-resolution` + `lead-model-launch` + `claude-review-runner` | **42 passed** |
| `packages/claude-runner` → `TmuxAdapter.test.ts` | **133 passed** |
| `packages/teamlead/scripts/__tests__/fly1650-companion-effort.test.sh`（**真 bash 3.2.57**，PATH shim 让内层 `bash -c` 也是 3.2） | **Passed: 12, Failed: 0** |

CI 接线也核过：`.github/workflows/ci.yml` 已把该 shell 套件加进 shell-tests 步骤。

---

## 9. 本次复核**没有**覆盖的（诚实边界）

1. **未验证上游 API 对 `claude-opus-4-6 + xhigh` 的真实反应**。"Opus 4.6 不认 xhigh、会
   换回 400" 这个前提取自 issue，本复核验的是**管路是否忠实执行这个前提**，不是前提本身。
   要证前提需要一次真实 API 调用。
2. **未部署、未重启、未切 `models.json`**。按派单约束，merge 与生产切档（把 QA 段或
   runner 档真的切到 4.6）不在本单范围。
3. **未跑全仓 `pnpm -r test` / `pnpm lint` / `pnpm -r build`**。本单是针对 4 项申报改动的
   独立验收；全仓门禁属实现者/ship 节点。（QA worktree 里 `pnpm -r build` 跑通过一次，
   18 个带 build 脚本的 `packages/*` 全部成功，输出里无 `error TS` / `ERR_PNPM`。）

---

## 10. 复现方式

QA 隔离 worktree（可直接删）：

```bash
git -C /Users/xiaorongli/Dev/flywheel worktree remove worktrees/qa-fly1650
```

驱动脚本与 fixture 留在本次会话的 scratchpad：
`.../scratchpad/qa1652/{probe-registry.mjs, probe-throats.mjs, skew-e2e.sh, mutate.sh, fixtures/}`。
所有脚本只读生产文件，不写任何生产状态。
