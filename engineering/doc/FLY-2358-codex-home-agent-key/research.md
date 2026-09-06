# FLY-2358 任务级 Codex home 改键 (agent, 项目) — 调研
Issue: FLY-2358 (https://linear.app/geoforge3d/issue/FLY-2358/2355b1-ic-层地基任务级-codex-home-改键-executionid-agent)
日期: 2026-09-05
基于: exploration.md

## 1. 调研目的

exploration.md 裁定 (a) 共享持久家。本文把这条路依赖的每个事实核到文件:行,把 C1-C8 的收口机制定成实现合同,给 plan.md 直接引用。凡是「本轮实测」都标 2026-09-05;凡是引用 FLY-2119 旧证据都标 09-02。

## 2. 身份:复用 FLY-2147 的 `(project, role)`,不造第二套词表

| 项 | 文件:行 | 事实 |
|---|---|---|
| 解析函数 | `packages/edge-worker/src/runner-memory.ts:71-130` `resolveRunnerMemoryIdentity({projectName, nodeId, agentName})` | `role = nodeId ?? agentName`;两者都要过 `SAFE_IDENTIFIER_RE` 且 ≤128;失败原因闭集 `no_project / no_role / invalid_project / invalid_role` |
| 路径编码 | `runner-memory.ts:151-175` `encodeMemoryPathComponent` | 小写 + 大写位掩码后缀,大小写不敏感文件系统上仍单射 |
| Blueprint 取值 | `packages/edge-worker/src/Blueprint.ts:2734-2742` | `nodeId = generalizedExecutionContext?.nodeId`(仅 pipeline.dag 引擎派发),`agentName = dispatchResult?.agentName`,`projectName = ctx.projectName` |
| 持久化 | `packages/teamlead/src/StateStore.ts:7719,8808-8815` | `sessions.workflow_node_id` set-once;`sessions.agent_name`、`project_name` 同表 |
| reown 重建 ctx | `packages/teamlead/src/bridge/codex-session-reown.ts:190-240` | 已从 `input.session` 取 `project_name`;`workflow_node_id` / `agent_name` 同一行可取 |
| 生产实测 | teamlead.db(2026-09-05) | codex-tmux 行:`(implement, flywheel)` 535 行带节点 id;runner-memory 已为它落在 `~/.flywheel/runner-memory/flywheel/implement`(8 行 `runner_memory_arm=role`) |

**合同 K1(R2 修订:节点 id 是唯一来源)**:`codexAgentHome = { project, role }` 由 `resolveRunnerMemoryIdentity({ projectName, nodeId })` 产出;首次派发在 Blueprint 取 `(projectName, generalizedExecutionContext?.nodeId)`,reown 在 `codex-session-reown.ts` 取 `(session.project_name, session.workflow_node_id)`。两处**同一个函数、同一组入参**;**不用** `agentName`(准入点在 agent dispatch 之前,它还不存在;见 §5 A2)。解析失败 ⇒ 不准入、不传该字段 ⇒ adapter 走今天的执行级家;失败原因在 Blueprint / reown 调用点打 `codex-home identity_unresolved reason=<no_project|no_role|invalid_project|invalid_role> exec=<id>`(闭集原因只在那里还在,codex-home.ts 不再自行打这条日志)。

**合同 K2(路径)**:`codexAgentHomeDir({project, role}, env) = join(codexHomesRoot(env), "agents", encode(project), encode(role))`。根目录仍由 `codexHomesRoot()`(`FLYWHEEL_CODEX_HOMES_ROOT`)决定;`agents/` 子树把键式家与旧 UUID 家在**结构上**分开(根下已有非 UUID 名字,不能按名字判)。socket 路径与家无关(`codex-daemon-runtime.ts:7-16`,按 executionId 哈希放短路径),不受家名长度影响。

## 3. 家里每一项在共享下的归属(本轮 E1 起两个真 app-server 后的清单)

| 文件/目录 | 谁写 | 共享下 | 处置 |
|---|---|---|---|
| `auth.json` `.active` | 我们 provision 整份覆盖;Codex 刷新时 truncate+write(`core/src/auth/storage.rs:111-127`) | 同账号:守卫式 reload(`core/src/auth.rs:1042-1065`)让后刷新者直接用先刷新者写下的新票;混账号:各自刷各自写,文件来回翻 | **P1**:有其它活租约时仍覆盖(新 runner 需要当前源身份),但 `.active` 与源身份不同时打 `keyed_home_identity_switch from= to= live_leases=N` |
| `config.toml` GH_TOKEN 受管块 | provision 注入;终态 scrub 剥离 | C1/C2 | **P2** 租约计数 |
| `config.toml` notify 受管块 | provision | 所有执行相同 | 幂等,不变 |
| `config.toml` trust 受管块 | provision 只放一条(`codex-home.ts:712-732,883-892`) | C5 | **P3** 键式家累加:合并已有受管块里的路径 + 本次路径,去掉磁盘上已不存在的路径 |
| `config.toml` `[[skills.config]]` 受管块 + `skills/` | provision 按臂重写/删除(`codex-home.ts:1146-1170`) | C6 | **P4** 家级臂 |
| `AGENTS.md` | provision | 内容同源 | 幂等,不变 |
| `sessions/` `history.jsonl` `state_5/logs_2/queue_1/goals_1.sqlite` | Codex | WAL 多进程;E1 双 app-server 共存 | 不管 |
| `memories/` `memories_1.sqlite` | Codex phase1/phase2 | 全局锁串行(E0/E2/E3) | 不管 |
| `app-server-control/app-server-startup.lock` | Codex | E1:不互斥 app-server | 不管 |
| `.flywheel-leases/<executionId>` | **新增**,我们 | — | 见 §4 |
| `.flywheel-agent-home.json` | **新增**,我们 | — | 见 §4 |

## 4. 家的并发合同(R1 修订:租约只是归属记录,互斥另有其锁)

Codex R1 指出租约文件不能当互斥用,而 provision 本身是「覆盖 config / 删装 skills / 读改写 trust」这类多步写;scrub 的「数租约 = 0 就剥令牌」与一个刚写完 config 还没落租约的 provision 也会撞。修订后的合同:

**合同 L0(每家一把短锁 = 仓内已验证的 mkdir-lock,R2 修订)**:不新造裸锁文件。复用 `withMkdirLock(lockPath, fn, opts)`(今天在 `packages/teamlead/src/account-heal/mkdir-lock.ts:304`,FLY-696:mkdir 原子获取、`holder.<pid>.<token>` 持有者标记 + 进程启动时间身份、死 pid 立即可回收、畸形/无 pid 标记按年龄兜底、释放与破锁只 unlink **精确观察到的**标记与 inode)。依赖方向:claude-runner 不能 import teamlead ⇒ 把 `mkdir-lock.ts` 与它唯一的内部依赖 `pidfile.ts`(只用 node:fs / node:child_process)**原样搬到 `flywheel-config`**,teamlead 的两个原路径改为再导出(既有 8 个消费者与测试零改动)。锁路径不在家里面(R3 #4:家还不存在时 `withMkdirLock` 的非递归 `mkdirSync(lockPath)` 会 ENOENT),而是同级:`<root>/agents/<project>/.locks/<role>/`;准入前先 `mkdirSync(<root>/agents/<project>/.locks, { recursive: true, mode: 0o700 })`(幂等、并发安全)并逐段 `lstat` 校验 `agents`、`<project>`、`.locks` 都是非 symlink 目录、修复为 0700,任一段是文件/symlink ⇒ 准入拒绝。家目录本身在锁内创建(路径上已有文件/symlink ⇒ 拒绝)。参数 `timeoutMs: 10_000, retryMs: 20, staleMs: 60_000`;等待是 `await sleep`,不冻结事件循环。只护**毫秒级临界区**:准入决定(标记/臂/租约)、trust 合并写、skills 物化、retire 的「删租约 → 计数 → 剥令牌」;跑任务不持锁。所有受管文件写入走「临时文件 + rename」。启动清扫对每个家各自 try/catch,一家失败不影响其余家。

**合同 L1(准入 = 一次原子决定,返回句柄)**:新增 `async admitCodexAgentHome({ project, role, executionId, requestedAssemblyArm }, env)` → `{ handle: { home, executionId, token }, effectiveAssemblyArm, inherited, liveLeases }`。在 L0 锁内:家不存在 ⇒ mkdir 0700 + 写 `.flywheel-agent-home.json`(`assemblyArm = requested`,`materializedArm = null`);家存在且其它活租约 > 0 ⇒ `effective = marker.assemblyArm`(`inherited = effective !== requested`);其它活租约 = 0 ⇒ `marker.assemblyArm = requested`(`materializedArm` 若 ≠ 新臂则保留旧值,由随后的 provision 物化);然后写本执行租约 `.flywheel-leases/<executionId>`(0600 常规文件,内容 = `token`)。同一 executionId 重复准入(reown)幂等:租约已在 ⇒ 不改 marker,返回当前 marker 臂与同一 token。有活租约但 marker 缺失/坏 ⇒ 准入抛错,不写任何文件。

**合同 L1a(租约句柄与所有权交接,R3 修订:公共入口每条返回路径都归还)**:`releaseCodexAgentHomeLease(handle)` 只认句柄(不反查):锁内删除 `<handle.home>/.flywheel-leases/<executionId>`(内容 token 须相符),归零则剥 GH_TOKEN。**所有权交接点 = 调用 adapter 公共入口(`execute` / `resumeExistingExecution`)的那一刻**:Blueprint / reown 调用点在准入之后、交给 adapter 之前的任何失败(含生效臂探针失败、emitStarted 之后的 worktree/prompt 失败)自己 `release(handle)`。adapter 在**公共入口**创建一个幂等的 `retireOnce` 闭包:发布 `codexAgentHome` 记录(L2)成功之前它按**句柄**释放,之后按**记录 + 期望身份**退休(L3);`resumeExistingExecution` 的快照读取失败、`executeOwned` 里发布记录失败 / preflight / `gh` 凭据 / provision / 运行时失败 / 正常终态 —— 每条返回路径都恰好调用一次 `retireOnce`;**例外(R4 #1)**:`runWithOwnership` 的进程内所有权拒绝意味着**另一个活着的 owner 正持有同一执行的租约**(租约是每执行一份、重复准入幂等且同 token),被拒的重复调用**不得**释放它 —— 准入结果带 `createdLease: boolean`,只有本次调用新建的租约才随 `retireOnce` 归还;被拒调用只归还自己新建的(通常没有)。**`retireOnce` 状态机(R4 #5)**:`idle | pending | succeeded | failed`,并发调用共享同一个 pending promise;只有磁盘退休(租约删除、必要时剥令牌)成功才置 `succeeded`;失败置 `failed` 并记 `teardownError`,受控关停**不得**在 `failed` 后发成功 ack(沿用 FLY-1269 的顺序语义);外层兜底对 `failed` 做最多一次重试,仍失败则留给 L4 清扫并告警 `keyed_home_retire_failed`(两个既有 scrub 点直接调用它以保住 FLY-1269「先退凭据再 ack」的顺序,外层 finally 只是兜底,幂等 no-op)。ctx 里携带 `codexAgentHome: { project, role, assemblyArm, home, token }`。测试断言的是**磁盘状态**(租约在不在、GH_TOKEN 在不在),不是 spy 调用次数。

**合同 L1b(键式 provision 是独立的异步入口,只消费准入)**:新增 `async provisionCodexAgentHome(handle, opts)`(与 `provisionCodexHome` 共用内部 helper;旧函数签名、同步语义、既有测试逐字节不变)。锁内:断言租约存在且 token 相符(否则抛错);auth.json / `.active` / AGENTS.md / GH_TOKEN / notify / trust(累加)照旧写(原子);**skills 只在 `marker.materializedArm !== marker.assemblyArm` 时物化**(装 matt 目录或删除 + 重写 `[[skills.config]]`),成功后 `materializedArm = assemblyArm`;相等 ⇒ **零 skills 变动**。因为 `assemblyArm` 只在活租约为 0 时改变,正在跑的 app-server 永远看不到技能树被换;第一次物化失败,后一个被准入的执行会在锁内补完。ctx 的 `assemblyArm` 必须等于 marker(不等 ⇒ 抛错,fail-closed)。

**合同 L2(执行 → 家的反查 = 每执行一份的结构化记录 + 期望身份,三态,R3 修订)**:adapter 进入 `executeOwned` 后、provision 之前,用现有 `mergeSessionState` 把 `codexAgentHome: { home, project, role }` 写进 `~/.flywheel/state/codex-sessions/<executionId>/session.json`,**set-once / equal-only**(已有且任一字段不等 ⇒ 抛错,不覆盖)。`resolveExecutionCodexHome(executionId, expected?: { project, role })` 三态:`{kind:"keyed", home, project, role}` 当且仅当记录可读、`record.home === codexAgentHomeDir(record.project, record.role, env)`(精确两段路径)、路径经 `lstat` 不是 symlink 且是目录、marker 可读且 `{project, role}` 与记录一致、**且**(给了 `expected` 时)`expected` 与记录逐字段相等 —— 一个自洽但属于别的执行的键式家,只靠内部一致性是证明不了归属的(R3 #3),所以**破坏性/身份敏感消费者(retire、remove、reaper、janitor)必须传 `expected`**,来源是可信的 session 行(`project_name`, `workflow_node_id`)或 ctx.codexAgentHome;只读消费者(rollout 探针)可不传。`{kind:"legacy", home: codexHomeDir(executionId)}` 当 session.json 不存在或无该记录**且**给了 `expected` 时 `codexAgentHomeDir(expected)/.flywheel-leases/<executionId>` 不存在;`{kind:"prepublished", home, project, role}`(R4 #2)当无记录但该精确租约存在(准入之后、记录发布之前进程死掉的窗口 —— started 行已落、L4 的活集合会一直保留这把租约);`{kind:"unknown", reason}` 其余一切(畸形 JSON、指向根外、symlink、路径/marker/expected 任一不一致)。`unknown` 一律 fail-closed 并打日志。**不**按租约文件反查。

**合同 L3(退休 = 租约计数擦令牌)**:新增 `async retireCodexExecutionHome(executionId, expected: { project, role }, env)`(R4 #3:期望身份是必填参数,来源 ctx.codexAgentHome 或 session 行):先 L2(传 `expected`);`legacy` ⇒ 调用今天的同步 `scrubCodexHomeCredential`(逐字节不变);`keyed` ⇒ L0 锁内删自己的租约、数剩余**常规非 symlink 且文件名过 `^[A-Za-z0-9._-]{1,128}$`** 的租约,0 才剥 GH_TOKEN,否则 `keyed_home_scrub_deferred live_leases=N`;`unknown` ⇒ 不动、打 `keyed_home_scrub_unresolved`。adapter 的 `scrubCredential` 接缝类型放宽为 `(executionId) => void | Promise<void>` 并 `await`;`provisionCodexHome` 自己失败路径里的同步 scrub 只服务旧式家(键式 provision 的失败由 L1a 的句柄释放兜底)。

**合同 L4(启动清扫的活集合,R3 修订:两个函数)**:`scrubOrphanedCodexHomes(liveExecIds, env?)` **签名、行为、测试逐字节不变**;新增 `async scrubOrphanedCodexAgentHomes(sessions: ReadonlyMap<executionId, { status, project, role }>, env?)` 只管 `agents/` 子树(R4 #3:输入不是活 id 集合,而是从 StateStore 一次快照出的「执行 → 状态 + 可信身份」映射),`run-infra.ts:1204` 先调旧函数再 `await` 新函数并分别记数。对每个租约文件:**无 session 行** ⇒ 孤儿,删除;**有行且状态在 reown 候选集**但身份缺失/与该家 marker 不符 ⇒ 不动、告警 `keyed_home_janitor_identity_mismatch`(fail-closed);**有行且状态终态** ⇒ 核对身份后删除;**有行且活** ⇒ 保留。第二个集合由 reown 候选状态集算出:`running | ship_parked | awaiting_review | design_done | approved_to_ship`(`run-infra.ts:364-377` 现有集合缺后两者,而 boot reown 覆盖它们,`StateStore.ts:651-658` 注明 approved_to_ship 非终态)。清扫在 L0 锁内、每家各自 try/catch:删掉不在集合里的租约,归零才剥令牌。

**合同 L5(reaper 身份集合;结构化记录名统一为 `codexAgentHome`)**:`defaultListCodexHomeExecutionIds` = 旧式根目录名 ∪ `agents/*/*/.flywheel-leases/*` 中**常规、非 symlink、名字合法**的文件名;`agents` 本身不进集合;`agents/` 子树不可读 ⇒ 整个探针返回 `unknown`(沿用 reaper 的 fail-closed 姿态)。候选的 `codexHome` 字段经 L2,`unknown` 时该候选跳过并审计。

**合同 L6(孤儿租约)**:runner 崩溃留下的租约到下次 Bridge 启动由 L4 清;运行中不做额外判活(与今天「Bridge 被杀 ⇒ finally 没跑」同级窗口)。

## 5. 家级装配臂(R1 修订:三值装配臂,不是四值实验模式)

| 项 | 文件:行 | 事实 |
|---|---|---|
| 四值实验模式 | `packages/config/src/skill-framework-mode.ts:28-42` | `superpowers / matt / bare / bare-ponytail`;`skillAssemblyBaseArm("bare-ponytail") = "bare"` |
| 家里实际装的 | `CodexTmuxAdapter.ts:189-215`、`codex-home.ts:1013-1029` | adapter 与 provision 只收三值 `SkillAssemblyBaseArm`;ponytail 是每执行的提示词状态,不落家 |
| 臂决定与派发顺序 | `Blueprint.ts:951`(臂)→ `:1020`(emitStarted)→ `:1605`(agent dispatch,在 runInner 内)→ `:2830`(adapter.execute) | started 行写在派发前;adapter 起跑在很久之后 |
| 持久化 | `DirectEventSink.ts:278-279` → `sessions.skill_framework_mode / _via`;via 闭集含 `"inherited"`(`skill-framework-mode.ts:52-62`) | A/B 分析读的字段 |

**合同 A1(准入在 emitStarted 之前,且就是唯一决定;R2 修订:继承后为生效臂重跑装配探针)**:Blueprint 在 951 之后、1003 之前,对 codex-tmux 且身份可解析的运行调用 L1 的 `admitCodexAgentHome` —— 传 `requestedAssemblyArm = skillAssemblyBaseArm(skillFramework?.mode ?? "superpowers")`(默认路径 `skillFramework` 为 `undefined`,`Blueprint.ts:1167-1168`)。返回 `inherited = true` ⇒ 有效四值模式按确定性规则算:`effectiveMode = effectiveAssemblyArm`(ponytail 附加态只在 base 相同时保留:请求 `bare-ponytail` 而家是 `bare` ⇒ 不算继承;家是 `matt` ⇒ `matt`),然后**为 `effectiveAssemblyArm` 重跑 `codexSkillAssemblyProbe`**(把 `resolveSkillFrameworkForRun` 里的探针段抽成可单独调用的 `probeCodexAssembly(arm)`),得到该臂自己的 `codexSkillDisableNames` / `codexMattSkillsSourceDir`,丢弃请求臂的那份;`skillFramework = { mode: effectiveMode, via: "inherited", …探针结果 }`。生效臂探针失败(如活 matt 家但 matt 源缺失)⇒ `release(handle)` 并让本次派发失败(**不**回落到别的臂 —— 那会让 session 行与家再次不一致)。未继承 ⇒ `skillFramework` 逐字节不变。这样 `sessions.skill_framework_mode` 就是实际装进家的臂,`_via = "inherited"` 是过滤标记。

**合同 A2(身份来源,R1 修订)**:准入点在 agent dispatch(`:1605`)之前,`dispatchResult.agentName` 尚不存在 ⇒ 键式家身份只取 `resolveRunnerMemoryIdentity({ projectName, nodeId: generalizedExecutionContext?.nodeId })`;无 nodeId(非 DAG 的 legacy 派发)⇒ 走旧式执行家并在 Blueprint 打 `[Blueprint] codex-home identity_unresolved reason=no_role exec=<id>`(闭集原因在这里还在)。reown 同规则:`session.workflow_node_id` 为空 ⇒ 旧式家。runner-memory 自己的 `agentName` 回落不动(它在 2734 有 dispatchResult)。**不移动 agent dispatch 的位置**(改可观察顺序,风险大于收益);影响范围 = 非 DAG 的 Codex 运行(生产历史 4 行 `main`)。

**合同 A3(准入与 provision 的一致性)**:provision 收到的 `assemblyArm` 必须等于准入返回值(由 ctx 携带 `codexAgentHome.assemblyArm`);provision 不做第二次决定,marker 与 session 行因此一致。已知限制收窄为:准入之后其它执行的准入只会**继承**这个臂(活租约 > 0),不会改它。

## 6. 删家保护(PRD §5.5.3 硬条;R1 修订:按目标结构判,不依赖活租约)

**合同 D1**:`removeCodexHome(executionId, env?, expected?)` 返回 `{ removed: boolean; reason?: "agent_home_protected" | "unresolved" | "rm_failed" }`。先 L2(传 `expected`;没给 `expected` 而记录存在 ⇒ 按 `unknown` 处理,拒绝是安全方向):`keyed` ⇒ 拒删 + `console.error("[codex-home] refuse_remove_agent_home …")`;`unknown` ⇒ 不删 + `console.warn(… remove_home_unresolved)`;`legacy` ⇒ 删 `codexHomeDir(executionId)`(今天的行为),`rmSync` 抛错 ⇒ `console.warn("[codex-home] remove_home_failed …")`。结构兜底:无论 L2 结果,最终 rm 目标的 realpath 落在 `codexHomesRoot()/agents/` 下 ⇒ 一律拒删。**`removeCodexSessionState` 先做 L2 分类,再删 session 状态目录**(R2 #6:今天它先 `rmSync(codexSessionStateDir)` 再 `removeCodexHome`,那会先毁掉反查记录);`legacy` 分支保持今天的删除顺序逐字节不变,`keyed` 分支只删状态目录、家拒删并告警,`unknown` 两者都不删。**不新增** `removeCodexAgentHome({force})`。验收顺序照真实生命周期:provision → 终态 retire(租约已删)→ `removeCodexSessionState` ⇒ 家仍在。

## 7. 现有 Codex runner 路径逐条核

| 路径 | 入口 | 改键后 |
|---|---|---|
| spawn | `Blueprint.ts:951-1020` 准入 → `CodexTmuxAdapter.ts:771-827` | Blueprint 准入(L1)+ 生效臂探针(A1)后 ctx 带 `codexAgentHome{project, role, assemblyArm, home, token}`;adapter 进 `executeOwned` 先发布 `codexHome`(L2)再 `provisionCodexAgentHome`(L1b),整段 try/finally 归 `retireCodexExecutionHome`(L3) |
| 恢复(Bridge 重启 reown) | `plugin.ts:7488-7594`(读快照、`buildCodexRecoveryContext`、`runtime.resume`)→ `run-infra.ts:258-278` → `adapter.resumeExistingExecution` | **先分类再准入**(R3 #2):对 session 行做 L2(expected = `{project_name, workflow_node_id}`):`legacy` ⇒ 不准入、ctx 无 `codexAgentHome`、留在旧家(部署前起跑的执行**永不迁移**);`keyed` ⇒ 只允许重新准入到记录里那个家(租约在 ⇒ 幂等返回 marker 臂;租约被清 ⇒ 以快照 `launchContext.skillFrameworkMode` 为请求臂重新准入),且 `effectiveAssemblyArm` 必须等于快照的臂,否则恢复失败并打 `keyed_home_reown_arm_mismatch`(**不做**重探/重算/改 session 行的对账 —— 快照不可变,漂移就 fail-closed);`unknown` ⇒ 恢复拒绝。`prepublished` ⇒ 在该家的 L0 锁内核对租约 token 文件与 marker,然后**收养**:以快照臂重新准入(幂等)并立即发布结构化记录,再走 keyed 路径(R4 #2;不能塌成 legacy,否则那把租约会被活集合永久保留、钉死家的臂与令牌);准入的请求臂一律 `skillAssemblyBaseArm(snapshot.launchContext.skillFrameworkMode ?? "superpowers")`(R4 #4:快照字段可空)。准入在 `plugin.ts` 调用 `runtime.resume` 之前完成,失败即 `release(handle)` |
| 换体(daemon 死后换号重起) | `codex-daemon-goal-runtime.ts:622` 在同一执行内重起 daemon | 家不变、租约不变;auth.json 由 provision 用新源身份覆盖(P1 日志) |
| rollout 探针 | `codex-rollout-probe.ts:40` | 经 L2 找家;`sessions/` 下按 threadId 过滤,不受同家多线程影响 |
| 529 房 | `scripts/test-deploy.sh:901-903` | 三轴仍生效;`agents/` 子树落在 slot 的 `FLYWHEEL_CODEX_HOMES_ROOT` 下 |

## 8. 本单不动的与已知限制(写给 plan 边界)
- 不改四道节流闸、`cli_auth_credentials_store`、`~/.codex`、`~/.codex-*`;不清理旧家。
- 真凭据并发臂不重跑(Lead 99a2e4f7);truncate 窗口与 refresh_token 高频兑换仍是未证项(exploration §4.1)。
- 孤儿租约到下次 Bridge 启动才清(L6);准入之后其它执行只会继承臂不会改它(A3),原「臂漂移窗口」已由准入原子化消除。
- 非 DAG 的 Codex 运行(无 `workflow_node_id`)暂走旧式执行家(A2)。
- 回滚不是零条件:见 plan §4。
- Lead 家仍由启动脚本管;解析器接受任何过 `SAFE_IDENTIFIER_RE` 的 role(含 Lead id),但本单不改 Lead 启动器。
- 源码行号引用:Codex 以本机 checkout `~/Dev/codex@db6aa80`(2026-02-14)为准,生产二进制 0.153.2 更新;E1 用的是真二进制。
