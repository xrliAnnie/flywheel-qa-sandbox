# FLY-709 统一 fleet 控制台 P5 — 三源合一批量流 + overflow 修复 + 治理门只读一致化 — 实施计划

Issue: FLY-709 (https://linear.app/geoforge3d/issue/FLY-709/dashboard-统一-fleet-控制台-per-项目模型effort-所有-feature-flag-状态-founder-直接)
日期: 2026-07-02
基于: plan.md（P1/P2/P4 已 ship 到 PR #408）+ Annie staging 验收反馈（拍板 A）

## 0. 来源与范围

Annie 在 localhost:9931 staging 亲测 709 console 后拍板 **A（现在统一）**，Lead 给了完整方向（lead-instruction c3a0e6ce）。本计划实现三件事，全部叠在 PR #408（同分支 flywheel-FLY-709、同 issue），走 design review + code review + tests，做完发新 staging 预览给 Annie 验收，她满意后才 ship。

**不改**：老 apply endpoint（`/api/fleet/stage|apply`、`/api/fleet/flag/stage|apply`）语义不变；`flywheel-comm runner-config` CLI 保留（CLI 用户不受影响）；console 仍在 `FLYWHEEL_FLEET_CONSOLE` 后（已 ship）。

## 1. 现状（三套割裂的交互 —— 就是 Annie 的 #4/#5 UX 批评）

| 源 | 当前交互 | 当前 apply 机制 | 进顶部计数器? |
|----|----------|-----------------|---------------|
| Lead model/effort | 卡片 chip → 草稿 → 顶部「应用 N 项」 | live fleet-apply（每 Lead 重启 ~15s） | ✅ |
| Lead backend | 卡片 chip → 草稿 | 仅生成 cutover 说明（FLY-264 未做，不能 apply） | ✅（但标「仅说明」） |
| Runner 默认 model/effort/backend | 每项目卡下拉 + **「复制命令」按钮** | `applyRunnerDefaults()` 写 config.yaml（**仅 CLI 调用，无 Bridge 路由**）；新 run 生效 | ❌（独立段） |
| Feature Flag（direct） | 卡内**「切换」即时按钮** | `applyFlagToggle()` 写 .env + mutate env（立即热生效） | ❌（即时切） |
| Feature Flag（conversational=需重启） | 只读展示 + 命令 | 改 .env 后需 Bridge 重启 | ❌ |
| Feature Flag（readonly=治理门/dormant/值） | 只读 | 不可切 | ❌ |

三种交互模型（batch-apply / copy-command / instant-toggle）割裂 = Annie 觉得「整表没连一起」「改 3 处只显 2」。

## 2. 目标（Annie + Lead 方向）

**一个统一批量流**：所有可改项（lead model/effort/backend + runner model/effort/backend + **仅 direct** flag）进**同一个 draft + 同一个顶部总计数器**；删 runner 复制命令按钮 + flag 即时切换按钮；顶部一个「应用 N 项修改」→ 一次提交 → 后端按每项该走的机制 route。UI + 计数对 founder 是**一个动作**，底层机制不同没关系。**conversational/需重启 flag + 治理门/dormant/值配置**只读项保持不可改（安全线），但**展示一致**（disabled 态,一句机制说明如「需改 .env + 重启 Bridge」/「只读」,不是特殊交互）。修 overflow bug。

## 3. 设计

### 3.1 统一 draft 模型（client）

client 现有 `draft/draftEffort/draftBackend`（per lead key）。扩成三源统一：

```
// lead（现有，不变）
draft[leadKey], draftEffort[leadKey], draftBackend[leadKey]  vs original*
// runner 默认（新）——每 project 一组
draftRunner[proj] = {model, effort, backend}  vs originalRunner[proj]
// flag（新）——【仅 direct-toggleable flag】一个 target
draftFlag[flagName] = <bool>  vs originalFlag[flagName]
```

**flag 编辑范围（Codex R1 #1 采纳 — 关键 scope 决定）**：统一草稿里**只有 `direct`-toggleable flag（9 个,call-time 读）可编辑**进 batch —— 因为现有 `/api/fleet/flag/apply`（`handleFlagStage`/`applyFlagToggle`）**只接受 direct flag**,conversational（29 个,需重启）flag 走该 endpoint 会被拒。所以本 P5:
- **direct flag** → 卡内一个「计入草稿」的 toggle（不再即时切；改 → 进统一草稿/计数 → 提交时走 flag/apply 热生效）。
- **conversational/需重启 flag** → **保持只读展示**（disabled 态,一句「需改 .env + 重启 Bridge」,不进草稿）—— 它们本来在 console 也不可即时切,现状就是只读/命令,不回归。**不新造 .env-restart-write 路由**（避免新安全面;若将来要让重启型也可改 = 单独 issue 单独 review,不塞进 P5）。
- **governance/dormant/值** → 只读 disabled（§3.6）。

统一 `allChanges()` = lead 变更 ∪ runner 变更 ∪ direct-flag 变更（每项带 `kind`: `"lead"|"runner"|"flag"` + 维度 + from/to）。顶部计数器 `n = allChanges().length`。`applyableChanges()` 仍剔除「仅说明」的 lead backend diff（进计数但不进真正 apply,沿用现有 `N 项(其中 X 项后端=仅生成 cutover 说明)` 文案,扩成覆盖所有源）。

### 3.2 一次提交 = client 编排 fan-out，**按后端契约分组**（Codex R1 #4/#5 采纳）

**选定：client 编排 fan-out 到各自已审计的 endpoint**（而非新建大一统服务端 endpoint）。理由：复用现有 **已审计 + confirmToken** 的 `/api/fleet/stage|apply`（lead）、`/api/fleet/flag/stage|apply`（flag，**仅 direct**），只**新增 runner 路由**（§3.3），不新造跨类型 canonical/confirmToken 安全面。Codex R1 确认 fan-out 方向正确。

**关键（Codex R1 #4）：fan-out 按【后端契约分组】,不是按 visual row 逐项**——否则会 spawn N 个 Lead engine、丢掉现有 per-batch 进度模型：
- **Lead 组 → 一次 `/api/fleet/stage` + 一次 `/api/fleet/apply`**（沿用现有:一个 canonical `changes[]` 数组 → 一个 detached engine batch → 终态经 SSE）。**绝不逐 Lead 拆开。**
- **Runner 组 → 每 project 一次 `/api/fleet/runner/stage`+`apply`**（runner writer 无 batch 格式,一项目一次;§3.3）。
- **Flag 组（仅 direct）→ 每 direct flag 一次 `/api/fleet/flag/stage`+`apply`**（现有 flag 路由无 batch 格式,一 flag 一次）。

**提交顺序 + partial-success 策略（Codex R1 #5,§3.8 详）**：`stage` 紧挨在各自 `apply` 前（不是全部先 stage）;各组独立提交,某组失败不阻断其它组;结果是 durable per-group 状态,任一组已提交 + 后续组失败 = 明示「部分成功」。Lead batch 是**异步**（terminal 状态来自 SSE,不是 apply 的即时返回）。

### 3.3 新服务端路由 `/api/fleet/runner/stage` + `/api/fleet/runner/apply`

**镜像 flag 路由**（loopback host + same-origin + 单次 confirmToken + audit；**不走 Bearer**，与 fleet/flag 一致）。handler 抽到 `runner-routes.ts`（纯函数 `handleRunnerStage/handleRunnerApply`，可单测），plugin.ts 挂载（gated on `fleetConsole`，同 flag）。deps 复用 `fleetConsole.tokens` + `fleetConsole.audit`。

**边界契约（Codex R1 #6，显式 + 测试）**：
- `project` 必须是 string 且在 liveProjects 里**恰好解析到一个** project（重名 → 拒；`resolveProjectRoot` 复用 CLI 的 exact-name 语义）。**projectRoot 只服务端从 liveProjects 解析,绝不信客户端传的 root。**
- `change` 只允许 `{model?,effort?,backend?}`；未知 backend/effort → 400（复用 `EXECUTOR_BACKENDS`/`ROLE_EFFORT_LEVELS` 白名单，前置到 stage）；`model` = 有意的 CLI-兼容自由字符串（与 CLI 一致，非空即可；ConfigLoader 只校验非空），不强约束到 `runnerCapabilities.models`（保持与 CLI 同语义）。
- 缺 `config.yaml` → 在 **stage** 阶段就拒（token 不发）；malformed JSON → 400。

**stage**：入 `{project, change}` → 服务端解析 projectRoot → 读 `<root>/.flywheel/config.yaml` 当前内容 → canonical `{project, change, fileSha=sha(内容), batchId, ts}` → **记 `staged` audit;`audit.record(...) === false`(audit DB 不可用)→ 503,不发 token**（Codex R2 #1 fail-closed,对齐 Lead route `fleet-routes.ts:164-182`）→ 发 confirmToken。

**apply（Codex R1 #2/#3 锁+expectedSha + R2 #1 audit fail-closed）**：入 `{canonical, confirmToken}` → `verifyAndConsume` → 服务端解析 projectRoot → **记 `apply-requested`(pre-write)audit;false → 503,不写 config**（fail-closed,对齐 `fleet-routes.ts:216-228`）→ `applyRunnerDefaults(configPath, change, {expectedSha:canonical.fileSha})`（**锁内 read→check-sha→写**;漂移 409）→ post-write 记 `apply-result` audit(此步 false 只诚实上报,不谎称完全 audited) → 返回 `{changed}`。

**单一 lock owner（Codex R2 #3,防非重入锁死锁）**：`applyRunnerDefaults` **内部获锁一次**;route 调 `applyRunnerDefaults(configPath, change, {expectedSha})`（有 expectedSha=锁内校验后写）,CLI 调 `applyRunnerDefaults(configPath, change)`（无 expectedSha=锁内直接写）。**无嵌套锁**（route 不在外层再包一层锁,writer 是唯一获锁点）。锁 = `<configPath>.lock`,route 与 CLI 共用,防 route-vs-CLI + route-vs-route 竞态。

**runner-config-writer.ts 改动（Codex R1 #2/#3）**：
- 新增/暴露一个 **config-file 锁**（`withConfigFileLock(configPath, fn)`，仿 flag-toggle 的 `withEnvFileLock`）；`applyRunnerDefaults` 增可选 `{expectedSha?, lock?}` —— 有 expectedSha 则**锁内 read→check-sha→写**（route 用），无则保持现状（CLI 用,CLI 也应包进锁但 expectedSha 可选）。
- **修 `validateAndPersist` 的 post-rename chmod（Codex R1 #3）**：temp 文件写时已 `mode:0o644`,把 rename 后的 `chmodSync` 去掉或改 best-effort（catch 后仍 return success）—— rename 是 commit point,rename 成功后不能因 chmod 抛异常让调用方误判失败。
- CLI（`runRunnerConfig`）改为经同一把锁调用（保持行为,只加锁）。加并发测试（两 writer 打同一 config / CLI-vs-route race）。

### 3.4 统一 confirm 对话框（按后果分组 —— founder 安全清晰）

点「应用 N 项修改」→ 一个 modal，**按后果分组**列出（不是混成一坨；每组只在有变更时出现）：
- **🔴 会重启 Lead（约 15s 不响应）**：lead model/effort 变更，逐 Lead 列 —— 强调「这几个运行中的生产 Lead 会重启」（Codex R1 #4:防 founder 误改一个 Lead model 就重启一堆生产 Lead;这组醒目 + 逐个列 Lead 名让她看清打了谁）。
- **🟢 写项目配置（对新 run 生效，无重启）**：runner 默认变更，逐项目列。
- **⚡ 立即热生效（无重启）**：direct flag 变更。
- **📋 仅生成 cutover 说明（不自动改）**：lead backend diff。
（conversational/需重启 flag 不出现在这里 —— 它们只读,不可进 batch,见 §3.1。）
底部「确认应用」→ runApply 编排（§3.8）。confirm 文案沿用现有 per-item 自动回滚说明。

### 3.5 CSS overflow 修复（Annie 截图 bug）

1. **长 flag key 竖排单字符断行**（`qa.auto` / `doc_flow.enabled` / `skills.proofshot.enabled` / `xiaohongshu_learning.enabled` / `founder_ux_gate.mode`）：flag 卡的 key/configKey 元素当前无换行控制 → 加 `overflow-wrap:anywhere; word-break:normal; white-space:normal;`（在点号处优雅断，不逐字符）+ 给 key 元素足够宽度/不被挤压。
2. **per-项目 ON/OFF badge 横向溢出卡片外**（project-scope flag 的每项目 effective 行，7 项目时溢出）：per-project badge 容器加 `display:flex; flex-wrap:wrap; gap` + 卡片 `overflow:hidden`（或该行 `overflow-x:auto`），badge 换行不溢出。

### 3.6 治理门/dormant/值 只读一致化（item 3）

readonly flags（`founder_consent_decision_mode` / `comm_bypass_bridge` / `founder_ux_gate` / `ponytail` / `codex_lead_read_deny` / 值型 `lead_cross_dept_channel_ids` / `reports_ttl_days`）：
- 展示为**统一 disabled 态**（灰/锁标，无下拉无 toggle affordance），不是特殊交互；不进 draft/计数（不可改）。
- 视觉上跟可改项一致布局（同卡片形态），只是控件 disabled + 一句「只读（治理门/dormant/值配置）」。安全线不变（服务端本来就拒治理门 toggle）。

### 3.7 partial-success 结果模型（Codex R1 #5 — 显式 + 测试；§3.2/§3.4 引此）

fan-out **非原子**（一次提交可能 runner config 写成功、随后某 lead 重启失败、或 flag 热切成功后 runner 撞 409）。对 admin console 可接受,但结果 UI **绝不能暗示 all-or-nothing**：
- **顺序 + 失败策略**：每组各自「紧挨 stage → apply」（不全部先 stage）;某组失败**不阻断**后续组（各组独立提交）。
- **durable per-group 状态**：每组显 `applied / no-op / rejected(stale 409) / manual-cutover / Lead-batch-running / Lead-batch-terminal(SSE)`。Lead batch 是异步 —— apply 立即返回「已派发」,终态经 SSE（沿用现有 progress 模型）。
- **总结**：任一较早组已提交 + 任一较晚组失败 = 明示「**部分成功**」（不是「全部成功」也不是「全部失败」）。
- 测试覆盖：runner 成功 + lead 失败;flag 成功 + runner 409;全成功;全 no-op。

## 4. 变更文件

- `packages/teamlead/src/bridge/runner-routes.ts` — **新**：`handleRunnerStage/handleRunnerApply`（纯函数 + 锁内 expectedSha 守卫 + projectRoot 服务端 exactly-one 解析 + 边界契约 §3.3）。
- `packages/teamlead/src/bridge/plugin.ts` — 挂 `/api/fleet/runner/stage|apply`（gated on fleetConsole，与 flag 同 loopback+same-origin block）。
- `packages/config/src/runner-config-writer.ts` — **改（Codex R1 #2/#3）**：加 `withConfigFileLock` + `applyRunnerDefaults` 可选 `{expectedSha?,lock?}`（锁内 read→check-sha→写）+ 修 `validateAndPersist` post-rename chmod（temp 预设 mode,rename 后 chmod best-effort）。
- `packages/flywheel-comm/src/commands/runner-config.ts` — CLI 改经同一把锁调用（行为不变,加锁）。
- `packages/teamlead/src/bridge/fleet-console-html.ts` — **localhost console** client JS：统一 draft/计数/confirm/runApply 按契约分组 fan-out（§3.2/§3.7）+ 删 localhost 的 copy-cmd/instant-toggle + CSS 修（§3.5）+ 治理门/conversational disabled（§3.1/§3.6）。
- `packages/teamlead/src/bridge/fleet-console-model.ts` — snapshot：console 卡携带 direct-vs-conversational 标记 + runner draft 目标（不影响 phone report 数据）。
- **不改**（Codex R1 #7 phone 兼容）：`feature-flag-report-html.ts` / `feature-flag-render.ts` 的 **hosted phone 页保持 copy-paste**（hosted 页调不了 loopback Bridge,copy-paste 是它的必需交互；本 P5 只改 localhost console 的交互,不动 phone 页控件。若渲染函数 shared,用参数区分 `mode:"console"|"phone"`,console 走统一草稿、phone 走原 copy-paste，不 globally 删控件）。

## 5. 测试

- `runner-routes.test.ts`：stage 发 token + audit；apply verify+consume+applyRunnerDefaults；fileSha 变→409；project 不在 liveProjects→拒；重名 project→拒；缺 config.yaml→stage 阶段拒(不发 token)；malformed body→400；非法 backend/effort→400；projectRoot 只服务端解析（客户端传 root 被忽略）；**audit fail-closed（Codex R2 #1）：stage 的 `staged` audit.record 返 false → 503 不发 token；apply 的 pre-write audit 返 false → 503 不写 config**。
- `runner-config-writer` 并发测试（Codex R1 #2）：两 writer 打同一 config / CLI-vs-route race（锁串行化,后者见前者结果 or expectedSha 漂移 409）；chmod-fail 不误报（rename 已 commit → return success）。
- client-model 单测（如现有 fleet-console-html 测试模式）：统一 `allChanges()` 跨三源计数正确（改 2 lead + 1 runner + 1 flag = 4）；治理门不进计数；discard 复位三源。
- CSS/render 测试：长 key 不逐字符断（含点号断行断言）；per-project badge 容器 flex-wrap；治理门卡 disabled 属性。
- 全 config + teamlead 套件 + 全仓 lint 绿。

## 6. Byte-compat / 安全

1. 老 apply endpoint（`/api/fleet/stage|apply`、`/api/fleet/flag/stage|apply`）语义不变；runner-config CLI 保留（只加锁,行为不变）。
2. 新 runner 路由：loopback + same-origin + confirmToken + audit + **锁内 expectedSha** 守卫 + projectRoot 服务端 exactly-one 解析（不信客户端），与 flag 路由同安全模型。
3. 治理门/conversational 只读服务端强制不变（UI disabled 是第二层，非唯一层；后端本来就拒非 direct flag toggle + 治理门）。
4. console 仍 gated `FLYWHEEL_FLEET_CONSOLE`；关掉 = 回退旧 dashboard（字节兼容）。
5. **hosted phone report 保持 copy-paste 不变（Codex R1 #7）** —— 只改 localhost console 交互;phone 页调不了 loopback,必须留 copy-paste,不 globally 删控件。

## 7. 流程

design review（Codex）→ 采纳 → implement（TDD）→ code review（Codex）→ tests + lint 绿 → 重启隔离 staging（localhost:9931，同零碰生产配方）发新预览进 [FLY-709] thread（1521754535142490202）→ Annie staging 验收 → 满意后 Lead 走 ship。**不自 ship。**

## 8. Codex design review R1 采纳（CHANGES REQUESTED → 已修订）

- **#1 [HIGH] conversational flag 不能走 direct-only endpoint** → §3.1:P5 只让 **direct flag** 可编辑进 batch;conversational/需重启 flag 保持只读(不新造 .env-restart 路由)。
- **#2 [HIGH] runner fileSha 需锁 + 锁内 expectedSha 临界区** → §3.3:`withConfigFileLock` + `applyRunnerDefaults({expectedSha,lock})`,锁内 read→check→写,CLI 共用锁 + 并发测试。
- **#3 [MED] post-rename chmod 失败误报** → §3.3:temp 预设 mode,rename 后 chmod best-effort。
- **#4 [HIGH] 别逐 visual row fan-out(会 spawn N Lead engine)** → §3.2:**按后端契约分组**,Lead=一个 batch(现有)、runner=每项目一次、flag=每 direct flag 一次;Lead batch 异步终态经 SSE。
- **#5 [MED] partial-success 结果模型显式** → §3.7:顺序/失败策略/durable per-group 状态/「部分成功」+ 测试。
- **#6 [MED] runner 路由边界契约** → §3.3:exactly-one project/缺 config stage 阶段拒/malformed 400/未知 backend-effort 400/model free-string 同 CLI。
- **#7 [LOW] 别删 hosted phone copy-paste** → §4/§6:只改 localhost console,phone 页保留 copy-paste。

**架构方向 Codex R1 确认**：fan-out（复用已审计端点 + 只加 runner 路由）正确,不走大一统 endpoint。**异构后果**靠 §3.4 confirm 分组讲清(哪些真重启生产 Lead vs 无害),partial-success §3.7 讲清结果非原子。
