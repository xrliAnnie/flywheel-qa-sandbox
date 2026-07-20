# FLY-1356 skill_framework_mode 三选一开关 + 生产分流 — 实施计划

Issue: FLY-1356 (https://linear.app/geoforge3d/issue/FLY-1356/eng-建三选一开关-skill-framework-modeabc-生产分流-瘦身第一刀的-build)
日期: 2026-07-20
基于: research.md

> **For agentic workers:** 按 task 顺序 TDD 执行(RED → GREEN → commit)。本 plan 由 design 阶段产出,
> implement 阶段在同一分支 `flywheel-FLY-1356` 上执行。
> Lead 拍板已折入(ask `e2c42079`,Tadashi 2026-07-20):v1 split 作用域**全局** + **必须**建
> per-project 参与开关(默认全参与;用途 = 项目 Lead 即时退出杠杆;开关状态落 mode 归因记录)。
> **本单只建不 ship;入库/ship = Annie 最后 gate。merge 后默认行为零变化(flag 默认 `superpowers`)。**
>
> **v2(独立设计审 R1 后,2026-07-20)**:Codex school 额度封顶(至 Jul 24,唯一有权限 profile,
> 轮转救不了)→ 本轮由 Bar-Raiser 独立审替补(实码核验全部锚点),8 项 findings 全采纳:
> R1#1 HIGH resolver 改 total 函数(env≠split 时 override **忽略**而非抛错 —— 原文与 successor
> 无条件传递自相矛盾,kill 时会打断在飞强臂 pipeline)= §0/Task 1/Task 4;R1#2 direct-toggle
> 共享谓词硬拒非 bool → widen + File Map 补 `direct-toggle.ts`(「apply core 不动」原述有误)
> = Task 3;R1#3 auto-QA 独立 QA issue 会自哈希分裂臂 → QA 继承父 session mode = §0/Task 4;
> R1#4 identifier 源不稳(UUID/回落)→ 恢复 exploration D2 的 sticky-stamp 查库层(按 issue_id)
> = §0/Task 4/5;R1#5 bare 变体合同测试升级整词 Superpowers grep-zero + 白名单 = Task 8;
> R1#6 休眠 EdgeWorker webhook 通道记入 runbook;R1#7 非 claude-tmux via=`noop_backend` +
> event-route enum 校验 = §0/Task 5/6;R1#8 resolve.ts enum 非法 raw 显示 error 而非假 effective
> = Task 2。Codex 恢复后是否补一轮由 Tadashi 在 design gate 定。
>
> **v2.2(采纳对账,2026-07-20,design runner 21f7116b)**:上一世系(plan v5 @
> `origin/fly1356-v5-implement-archive`,07-18)implement 期间落过两条 lead-instruction 修订
> (`dcbcaad9`、`4496f8a0`),v2.1 成文时未见到(死分支不可见),现按原文折入,要求不丢:
> ① **观测量 = 四个**:完成率、token、纪律违规、**返工轮数**(第四观测量,独立采集呈报,
> 不折进完成率、不并进 token、不降级为 advisory —— 轻而笨的臂靠它现形,HL 点名;
> 数据源 = FLY-616 `reworkRounds`(auto_qa_record fail 计数,`sqlite-reader.ts:100`)已现成,
> runbook 把它从 advisory 提为一等呈报列)= 评测集成 + 验收标准 3 已同步。
> ② **拍板人 = Annie**:四观测量数据呈她,任何默认模式切换只认她明示 = Ship 前置清单已同步。
> ③ **能力级 E2E 验收(HL 4496f8a0)**:三臂冒烟 —— A/B/C 各**真跑通一张单**(529 房),
> 且四观测量对每臂都**真采得出来**;任何一臂采不出数据 = 验收不过(FLY-1299 正式实验的
> 前置健康检查)= 验收标准 3 已同步。
> ④ HL 四条硬要求在 v2.1 的落位对照:1335 硬前置 = 排程与依赖 + runbook 前置;返工轮数
> 独立埋点 = 本条①;臂归属落库一单一臂 = sessions 两列 + sticky/inherited(gen1 命名
> `skill_framework_condition` ≡ 本 plan `skill_framework_mode`,语义同);kill 秒级不重启 =
> Task 3 direct-toggle(**绝不做成重启才生效**;代码 deploy 的一次性 Bridge 重启是上线动作,
> 不是开关生效方式)。
> 与 gen1 唯一冲突项:enroll 范围 gen1 写「v1 = flywheel 项目」,已被**更新**的 Tadashi 拍板
> (ask `e2c42079`,07-20:v1 全局 + per-project 退出)覆盖,按 v2.1 执行,非遗漏。

**Goal:** 三值互斥模式(A=superpowers 现状 / B=matt / C=bare)+ 生产分流(per-issue 稳定哈希,
派单时定死,记录在案可归因)+ A 默认 + kill 秒级钉回不重启 + 为 FLY-1260 评测提供强制指定臂与
归因查询钩子。

**Architecture(一句话):** 解析收口在 **Blueprint**(ponytail/FLY-615 同轨:spawn 前解析 →
envelope 双 sink 落库),生效走**现有 per-launch `--settings enabledPlugins` seam**(插件层)+
**agent 文件 mode 变体回落**(prompt 层),控制面走 **FLY-709 flag 注册表 + enum 扩展的
direct-toggle**。真机 spike 已证 per-launch disable 压掉 SessionStart 注入(research.md S1)。

**红线:**
1. flag 默认值下**字节兼容**(spawn args / prompt / envelope 均不变)——反向兼容哨兵测试钉死;
2. 实验臂只在**确定授权**时进入:任何解析疑义(非法 enum / config 读失败 / matt 探针失败)
   一律回落 A + 记录原因,绝不静默进臂、绝不静默跑残缺 B;
3. 评测期间 generalized-workflow 模板 flag 保持 OFF(纪律,写进 runbook)。

**Tech Stack:** TypeScript, vitest, pnpm monorepo;真机 QA 脚本 = bash + `claude -p`。

---

## 0. 模式语义总表(实现的单一真相)

| 输入优先级(高→低) | 结果 mode | via 记录 |
|---|---|---|
| env `FLYWHEEL_SKILL_FRAMEWORK_MODE` 未设(默认) | `superpowers` | `default` |
| env = `superpowers` / `matt` / `bare`(全局强制;kill = 设回 `superpowers` 或删键)——**此时如收到 override(来自 successor 传递的旧值),忽略之 + console.warn,绝不抛错**(R1#1:resolver 是 total 函数,kill 不许打断在飞 pipeline) | 该值 | `forced` |
| env = `split` + 项目 config `skill_framework.split: false` | `superpowers` | `project_opt_out` |
| env = `split` + auto-QA session(sessionRole=`qa`,独立 QA issue)且父 session 有已记录 mode | 父 session 的 mode(R1#3:一张单从头到尾同一臂,QA 不自哈希分裂) | `inherited` |
| env = `split` + per-dispatch override(529 评测;含 successor 传递) | override 值 | `override` |
| env = `split` + 同 issue 已有 stamp(按 `issue_id` 查 sessions 既有 `skill_framework_mode`,run-dispatcher 侧一条索引查询)| stamp 值(R1#4:identifier 源可能不稳,粘性以 issue_id 查库为准,哈希只发生在首次 admission) | `sticky` |
| env = `split`(首次 admission) | `hash(issueIdentifier) % 3 → {superpowers,matt,bare}` | `hash` |
| 以上任一解析出 `matt` 但 readiness 探针失败 | `superpowers` | `fallback_superpowers` |
| env 非法值 | `superpowers`(fail-closed)+ console.warn | `default` |
| (正交标记)backend ≠ claude-tmux 的 session | mode 照解析记录 | via = `noop_backend`(R1#7:机制 no-op 的行不混进 naive GROUP BY) |

- hash = `sha256(identifier)` 前 4 字节 big-endian uint32 `% 3`,桶序固定
  `[superpowers, matt, bare]`。identifier = Linear identifier 字符串(如 `FLY-1234`),
  取法与 FLY-272 displayId 对齐:**`||` + `.trim()` 语义**(空/空白串也回落),
  `ctx.issueIdentifier || hydrated.issueIdentifier || issueId`(R1#4)。
- **resolver 是 total 函数,永不抛**(R1#1)。400 fail-loud 只存在于 `/api/runs/start` HTTP
  边界(显式传 override 且当前 flag≠`split` → 400,新 run 挡在门外);已在飞 run 的 successor
  带旧 override 撞上 kill → 按 `forced` 解析 + warn,pipeline 不断。
- 各模式生效面:

| mode | 插件层(claude-tmux spawn) | prompt 层 |
|---|---|---|
| `superpowers` | 零贡献(不新增任何 enabledPlugins 条目) | 基准 agent 文件 |
| `matt` | `superpowers@superpowers-dev: false` + `matt-skills@matt-skills: true` | `<agent-file>.matt.md` 变体,缺则回落基准 |
| `bare` | `superpowers@superpowers-dev: false` | `<agent-file>.bare.md` 变体,缺则回落基准 |

- 非 claude-tmux 后端(codex/agy/kimi):插件层与 prompt 变体机制上 no-op(codex 不吃 claude
  插件,角色文件走翻译头不改写),但 **mode/via 仍照记**(归因完整;评测分析时按
  `adapter_type` 分层)。
- Lead session(claude-lead.sh)、Bridge、CLI 不读本 flag —— 只作用 Runner spawn 路径。

---

## File Map

| 动作 | 文件 | 职责 |
|------|------|------|
| Create | `packages/config/src/skill-framework-mode.ts` | 枚举/解析器/哈希(单一真相实现)+ 插件 key 常量 |
| Create | `packages/config/src/__tests__/skill-framework-mode.test.ts` | 解析优先级 / fail-closed / 哈希确定性+分布 |
| Modify | `packages/config/src/feature-flags/registry.ts` | 注册 env enum flag + project 参与 flag(两行) |
| Modify | `packages/config/src/types.ts` | `FlywheelConfig.skill_framework?.split?: boolean` |
| Modify | `packages/config/src/index.ts` | 导出 |
| Modify | `packages/config/src/feature-flags/direct-toggle.ts` + `feature-flags-direct-toggle.test.ts` | 共享 direct 谓词 widen:bool ∨(enum 且 enumValues 非空)(R1#2) |
| Modify | `packages/teamlead/src/bridge/flag-toggle.ts` + `flag-routes.ts`(stage 层)+ console/CLI 面(`feature-flag-render.ts` / `management-existing-writers.ts`) | enum flag 的 stage/apply(事务 core 已 raw-string;准入谓词经上行 widen) |
| Modify | `packages/teamlead/src/bridge/runs-route.ts` | 可选 `skillFrameworkMode` 边界校验(designBackend 同位) |
| Modify | `packages/teamlead/src/bridge/run-dispatcher.ts` / `retry-dispatcher.ts` / `rescue-runtime.ts` / `phase-orchestrator.ts` / `actions.ts` | override 线程传递(designBackend 同轨,仅 override,不是解析) |
| Modify | `packages/edge-worker/src/Blueprint.ts` | 解析(envelope 前,ponytail 同位)+ 插件层合并 + prompt 变体回落 + envelope 字段 + matt 探针 |
| Modify | `packages/teamlead/src/StateStore.ts` | `skill_framework_mode` / `skill_framework_mode_via` 两列幂等迁移 + upsert |
| Modify | `packages/teamlead/src/bridge/event-route.ts` + DirectEventSink | started 双 sink 接新字段(designBackend 同轨) |
| Create | `vendor/matt-skills/`(plugin 布局) | B 臂 6-skill 冻结 vendor(@`9603c1cc`)+ LICENSE + 审查记录 |
| Create | `scripts/setup-matt-skills.sh` | 幂等安装 user-scope 本地 plugin + settings.json 默认 disabled |
| Create | `agents/generic-executor.matt.md` / `agents/generic-executor.bare.md` | shipped 四步流 B/C 变体(臂定义冻结) |
| Create | `.flywheel/agents/engineering/designer-executor.matt.md` / `.bare.md` | designer 裸名 `brainstorming` 的 B/C 变体 |
| Create | `scripts/qa-fly-1356-mode-visibility.sh` | 真机 QA(S1 spike 产品化 + matt catalog 探测) |
| Create | `packages/claude-runner/src/__tests__/…`(并入现有 TmuxAdapter 测试)| spawn args 合并 + 字节兼容哨兵 |
| Create | `engineering/doc/FLY-1356-skill-framework-mode-split/runbook.md` | 开启/kill/退出/评测操作手册 |

不动:`AgentDispatcher.ts`(派发选 agent 逻辑零改)、`agents/generic-executor.md` 与
`designer-executor.md` **基准文件**(A 臂 = 现状字节不变)、workflow 模板、lead-rules。

---

## Tasks

### Task 1 — config 包:`skill-framework-mode.ts` 单一真相模块

- 导出:`SKILL_FRAMEWORK_MODES = ["superpowers","matt","bare"] as const`、
  `SkillFrameworkMode`、`SkillFrameworkVia`、
  `SUPERPOWERS_PLUGIN_KEY = "superpowers@superpowers-dev"`(research.md S2 实测)、
  `MATT_SKILLS_PLUGIN_KEY = "matt-skills@matt-skills"`、
  `hashModeBucket(identifier: string): SkillFrameworkMode`、
  `resolveSkillFrameworkMode(args: { env; issueIdentifier; override?; priorStamp?; parentMode?; projectSplitParticipation?: boolean }): { mode; via }`
  —— 语义严格按 §0 总表(探针回落与 `noop_backend` 标记不在此层,属 Blueprint apply 层)。
- **resolver 是 total 函数,任何输入组合都返回 `{mode, via}`,永不抛**(R1#1)。
- TDD 用例:优先级全表逐行(含 sticky/inherited 两行);非法 env 值 fail-closed →
  superpowers+default;哈希确定性(固定 identifier → 固定桶,含真实样例 `FLY-1356`);
  分布(10,000 个合成 identifier,每桶 30%–36.7%);env=`split` 时 override 生效;
  **env≠`split` + override 存在 → 忽略 override、按 flag 解析、via=`forced`**(R1#1 —— 测试
  钉的是 total 语义,不是抛错)。

### Task 2 — flag 注册表 + project config key

- registry 新增两行:
  1. `skill_framework_mode`:category `feature`,env `FLYWHEEL_SKILL_FRAMEWORK_MODE`,
     valueKind `enum`,enumValues `["superpowers","matt","bare","split"]`,default `"superpowers"`,
     readSites = Blueprint 解析点(`call_time`,pattern env-param),toggleable **`direct`**
     (依赖 Task 3 的谓词 widen),`directToggleProof` = 新增 live-observe 测试
     (in-proc mutate → 下一次 resolve 观察到);description 写明 kill 语义
     (设回 superpowers/删键 = 全 A)与存量 session 不追改边界。
  1b. **resolve.ts enum 校验**(R1#8):enum flag 的 raw ∉ enumValues → FlagView 走显式
     `error`(DECISION_MODE 先例),不把垃圾 raw 当 effective 展示 —— 否则配错的瞬间
     console 显示与 Blueprint fail-closed 实跑值背离。`issue_gate_supersede_mode` 同受益,
     其现有测试如有 raw-passthrough 断言随之修正。
  2. `skill_framework_split_participation`:source `project_config`,configKey
     `skill_framework.split`,scope `project`,polarity default_on,default `true`,
     toggleable readonly;description 写明这是**项目退出杠杆**(false = 该项目在 split 下钉 A,
     via 记 `project_opt_out`),不是启用开关。
- `types.ts` 加 `skill_framework?: { split?: boolean }`;ConfigLoader 沿用宽松校验
  (非 bool → load 报错走既有 error 面)。
- **participation 的读取时机 = 每次解析新读**(Tadashi「即时可退」要求):Blueprint 解析时经
  注入的 config 读取器拿当前值;读失败 fail-closed → 该项目钉 A + via=`project_opt_out` 变体
  记录 + console.warn(疑义不进臂红线)。实现形态:Blueprint 构造注入
  `skillFrameworkParticipation(projectName): boolean`(默认实现 = 轻量 fresh read,mtime 缓存
  可选;测试注入桩)。
- 跑 registry drift scanner(已有 CI 门)确认 readSites 锚点有效。

### Task 3 — enum flag 的 direct-toggle 扩展(谓词 + stage 层)

- **现状更正(R1#2)**:`applyFlagToggle` 的**事务** core 已 raw-string(不动),但共享准入谓词
  `isDirectToggleMetadata`(`packages/config/src/feature-flags/direct-toggle.ts:27`)硬性
  `valueKind === "bool"`,且被 apply core 自身(`flag-toggle.ts:100`)、stage 层
  (`flag-routes.ts:92`)、console 渲染(`feature-flag-render.ts:114`)、writer 列表
  (`management-existing-writers.ts:96/286/830`)共用 —— 不 widen 它,enum flag 第一次 apply
  就在 core 准入处 400。
- 改法:
  1. `isDirectToggleMetadata` widen 为 `bool ∨ (enum 且 enumValues 非空)`;
     `feature-flags-direct-toggle.test.ts:70` 的「structurally rejects non-bool」断言同步改写
     (改为 rejects `value` 类与空 enumValues);
  2. canonical 的 effective 域 widen 为 `boolean | string`;enum flag 的 stage 请求带显式
     `targetValue`(必须 ∈ enumValues,否则 400);写策略 = `rawTo = targetValue`
     (target === default 时写默认值本身,不删键 —— 语义显式,与 bool 的 per-polarity 删键策略并存);
  3. console UI(FLY-709/1344 flag 面板)对 enum direct flag 渲染下拉;CLI(`flywheel-comm`
     flag 命令面)接受 `--to <value>`。
- 测试:bool 路径**字节兼容**(现有全部 stage/apply 测试除上述一条断言改写外不动全绿);
  enum stage→confirm→apply happy path;非法 targetValue 400;sha 漂移 409 复用现测。
- 本 task 是「秒级钉回不重启」的控制面;完成标准 = 从 console/CLI 把
  `skill_framework_mode` 在 `split`↔`superpowers` 间翻转,**不重启** Bridge,下一次 dispatch
  观察到新值(directToggleProof 测试 + 真机 QA 脚本步骤)。

### Task 4 — runs-route 边界 + override 线程传递

- `runs-route.ts`(rawDesignBackend 同位):可选 `skillFrameworkMode` ∈ 三值;
  非法 → 400;当前 flag ≠ `split` → 400(错误文案指明 kill-switch 生效中);合法 → 进
  dispatch 请求。**400 只挡新 run 的 HTTP 边界;successor 传递的旧 override 撞 kill 由
  resolver total 语义兜住(§0,R1#1),不在此层**。
- threading(designBackend 同轨、仅 override 值):run-dispatcher(两个 dispatch 位点)→
  BlueprintContext 新字段 `skillFrameworkModeOverride`;phase-orchestrator 4 个 successor
  位点 / retry-dispatcher / rescue-runtime / actions.ts 从 session 行回读 override 继续传
  (session 行记录见 Task 6;override 粘性 = 529 一次强臂全程有效)。
- **sticky-stamp 查库(R1#4)**:run-dispatcher 在 dispatch 前按 `issue_id` 查 sessions 既有
  `skill_framework_mode`(一条索引查询,store 就在手里),作为 `priorStamp` 传入 ctx;
  identifier 源不稳(sub Lead 传 UUID / PreHydrator 回落,`Blueprint.ts:2082-2093` 注释自证)
  不再影响同 issue 桶一致性 —— 哈希只发生在该 issue 首次 admission。
- **auto-QA 继承(R1#3)**:`auto-qa-coordinator.ts:1239-1264` spawn 独立 QA issue 时,把父
  session 已记录的 `skill_framework_mode` 作为 `skillFrameworkModeParent` 线程进 ctx
  (spawnQa 手里就有父行,designBackend 同款);resolver 按 §0 `inherited` 行处理。
  QA 不自哈希 ⇒ 一张单的实现臂与验证臂恒一致。
- 测试:边界校验四况(合法/非法/flag≠split 拒/缺省);successor 传递 + priorStamp 传递 +
  QA 继承(phase-orchestrator / auto-qa-coordinator 现有 fixture 上加断言)。

### Task 5 — Blueprint:解析 + 双层生效 + envelope

- **解析位点** = `resolvePonytailCondition` 同段(envelope 之前):
  `resolveSkillFrameworkMode({ env: process.env, issueIdentifier(‖+trim,FLY-272 对齐), override: ctx.skillFrameworkModeOverride, priorStamp: ctx.skillFrameworkModePrior, parentMode: ctx.skillFrameworkModeParent, projectSplitParticipation })`;
  backend ≠ claude-tmux 时 via 覆写为 `noop_backend`(R1#7,mode 照记)。
- **matt readiness**(ponytail 探针同款,负结果不缓存):`claude plugin details
  matt-skills@matt-skills` exit 0;仅在解析结果 = `matt` 且 backend = claude-tmux 时探;
  失败 → mode=`superpowers`、via=`fallback_superpowers`、console.warn(带 setup 脚本指引)。
- **插件层**:adapter.execute 组装处合并 ——
  `disabledPlugins = [...(ctx.runnerMcpProfile?.disabledPlugins ?? []), ...(mode≠superpowers ? [SUPERPOWERS_PLUGIN_KEY] : [])]`,
  `enabledPluginsExtra = [...(ctx.runnerMcpProfile?.enabledPluginsExtra ?? []), ...(mode==="matt" ? [MATT_SKILLS_PLUGIN_KEY] : [])]`;
  **mode=superpowers 且无 mcpProfile 时字段保持 absent**(字节兼容哨兵);TmuxAdapter 自身
  不改(合并逻辑已存在)。
- **prompt 层**:`readAgentFile` 调用点包一层变体解析 —— mode ∈ {matt,bare} 时先试
  `agent_file` 去 `.md` 加 `.{mode}.md`,存在用变体、不存在回落基准;`domain_file` 不做变体;
  `isGeneralizedExecution`(workflow 模板)路径不做变体(模板评测期 OFF,注释注明)。
- **envelope**:`…(skillFrameworkMode && { skillFrameworkMode, skillFrameworkModeVia })`
  —— 记录**实际生效值**(探针回落后),ponytailCondition 同位。
- 测试(Blueprint 现有测试基建上):A 模式 envelope 无新字段 + adapter 字段 absent(哨兵);
  bare/matt 的 disable/enable 合并(含与 mcpProfile 共存);探针失败回落;变体文件命中/回落;
  override 优先;participation=false 钉 A。

### Task 6 — StateStore + 双 sink 持久化

- 幂等迁移:`ALTER TABLE sessions ADD COLUMN skill_framework_mode TEXT` +
  `skill_framework_mode_via TEXT`(design_backend/doc_tier 同款 try-catch 模式);
  typed 接口两处(632/736 附近)补字段;started upsert 写入;
  暴露查询(评测归因用,SQL 直查即可 —— 不建新 API,runbook 附样例 SQL)。
- 双 sink:event-route(838 designBackend 同段)+ DirectEventSink 同步接;event-route 侧
  **enum 校验**(`isDesignBackend` 同款 `isSkillFrameworkMode` guard,不收任意字符串 ——
  /events ingest token 对 runner 可见,归因列不许被塞垃圾,R1#7)。
- 测试:迁移幂等(新库/旧库两跑);双 sink 各一条 started→行值断言;event-route 非法值拒收。

### Task 7 — Matt 6-skill vendor + setup 脚本

- `vendor/matt-skills/`:plugin 布局(`.claude-plugin/plugin.json` name `matt-skills` +
  marketplace 元数据),skills = FLY-1326 plan §2 钉死子集
  `tdd` / `code-review` / `grilling` / `diagnosing-bugs`(原样)+ `to-spec` / `to-tickets`
  (删 `disable-model-invocation: true`,**diff 留档进 `vendor/matt-skills/VENDOR.md`**:
  上游 commit `9603c1cc8118d08bc1b3bf34cf714f62178dea3b`、逐文件 sha、frontmatter diff、
  MIT LICENSE 原文保留)。
- **安全审查**(VENDOR.md 附 checklist 结果):逐 skill 通读;无网络外呼指令、无
  凭据/秘钥触碰、无破坏性 shell 模式;`to-spec`/`to-tickets` 的「向 issue tracker 发布」段落
  按臂定义保留但在变体 prompt 里明确接到我们的 Linear 约定(529 排雷观察项,FLY-1326 U4)。
- `scripts/setup-matt-skills.sh`:幂等(重跑 diff 空);`claude plugin` 安装本地 marketplace
  → user scope;**settings.json 置 `matt-skills@matt-skills: false`(默认 disabled)**;
  校验步骤打印 `claude plugin details` 结果。**脚本属部署面,merge 不执行**(runbook 步骤,
  开 split 前由 ops 跑;探针负结果不缓存 ⇒ 装完即生效无需重启)。
- 测试:vendor 目录结构/frontmatter 合同测试(scripts/__tests__ shell 合同模式,FLY-880 先例):
  6 个 SKILL.md 存在、to-spec/to-tickets 无 `disable-model-invocation`、LICENSE 在。

### Task 8 — B/C prompt 变体(臂定义冻结)

- `agents/generic-executor.matt.md`:99-204 四步流改指 Matt 子集
  (brainstorm→`grilling`、plan→`to-spec`/`to-tickets`、TDD→`tdd`、自检→`code-review`);
  **三条 Flywheel override(A→BRAINSTORM GATE、B→doc-flow、C→简单档跳文件)与
  headless-Runner 通则逐字保留**;权威 review 仍 = Codex gate(不交控)。
- `agents/generic-executor.bare.md`:四步流改纯自有机器
  (BRAINSTORM GATE → `/write-plan` → flywheel-tdd → Codex code review gate),其余同上。
- `.flywheel/agents/engineering/designer-executor.{matt,bare}.md`:基准全文复制,仅
  :68/:141 两处裸名 `brainstorming` → matt 变体指 `grilling`(语义偏差注记进文件头注释)、
  bare 变体指 `product-brainstorming` + BRAINSTORM GATE。
- **变体从基准全文改写,不只 99-204**(R1#5):`generic-executor.md:35` 的
  「Default Workflow — Superpowers RPC」章节指针、`:117-119` plugin-unavailable 回落段、
  `:197-204` scope note 都在区间外,变体里同步改写,不留悬空指针。
- 合同测试:变体文件存在;matt 变体含 `grilling` 不含裸名 `brainstorming`
  (连字符-感知边界 `[^A-Za-z0-9_-]`,FLY-1326 v5 口径,防 `product-brainstorming` 误报);
  **bare 变体对整词 `Superpowers`(大小写不敏感)grep-zero**,有意保留处显式白名单
  (R1#5,FLY-205 sub#17 多形态 sweep 教训 —— 裸 skill 名/namespace 口径抓不住
  "Superpowers RPC" 这类散文引用);bare 变体同时不含任何 Superpowers 裸 skill 名/namespace;
  基准文件与 main 字节一致(A 臂不动哨兵)。

### Task 9 — 反向兼容哨兵 + 全套回归

- 哨兵(独立测试文件,FLY-205 OFF-sentinel 先例):默认 env(无
  `FLYWHEEL_SKILL_FRAMEWORK_MODE`、项目无 `skill_framework` 键)下 —— Blueprint 产出的
  adapter.execute 参数、envelope 字段集、agent 文件选择与改动前**逐字段一致**;突变验证
  (故意设 `split` 断言哨兵能红,防空绿)。
- `pnpm -r test` + lint 全绿;registry drift scanner 绿。

### Task 10 — 真机 QA 脚本 + runbook

- `scripts/qa-fly-1356-mode-visibility.sh`(529 排雷前置自检,S1 spike 产品化):
  1. 阳性对照:默认 `claude -p` → 断言含 superpowers 注入(YES);
  2. bare:`--settings` disable → 断言无注入(NO);
  3. matt:disable superpowers + enable matt-skills → 断言无 superpowers 注入 **且**
     `grilling`/`tdd` 在可用 skill 列表(catalog 残留验证 = research.md R1 钉死);
  4. 打印真 tmux spawn 一条(隔离 529 房)args 中的 `--settings` 内容供人工核对。
- `runbook.md`:开启 split 前置(FLY-1335 已 merge 且生产 Bridge 已带其 config;
  `setup-matt-skills.sh` 已跑且探针绿;workflow 模板 flag 确认 OFF)→ 开启步骤(console/CLI
  set `split`)→ kill 步骤(set `superpowers`,含「存量 in-flight B/C session 不追改,要清场
  用现有 close-runner」的诚实边界)→ 项目退出步骤(项目 config 加 `skill_framework.split:
  false`,即时生效)→ 529 用法(隔离 Bridge env 置 `split` + `/api/runs/start` 带
  `skillFrameworkMode` 强臂)→ 归因查询样例 SQL(**按 mode/via/adapter_type/session_role
  分层**,R1#3/#7:`noop_backend` 与 `inherited` 行不混进 naive GROUP BY)→ 备注:休眠的
  EdgeWorker webhook 通道(`EdgeWorker.ts:971` 直接 `new ClaudeRunner`,不经 Blueprint;
  生产 Bridge 无消费者)在本治理之外,若该通道复活需补接(R1#6)。

---

## 评测集成(复用 FLY-1260,不另造)

- **阶段一(529 排雷)**:隔离 Bridge env=`split`,用 override 逐臂派同批 issue;**四观测量**
  (v2.2①,lead-instruction dcbcaad9)取数途径 —— 完成率(盲评 rubric,分母同批 issue)、
  token(session usage 四类分记,FLY-1326 plan §1 口径)、纪律违规(事件轨迹 + git 提交序)、
  **返工轮数**(FLY-616 `reworkRounds` = auto_qa_record fail 计数,独立呈报,不并进 token
  不折进完成率);mode/via 列 = join key(ponytail_condition/FLY-614/616 同款用法)。
- **阶段二(生产分流)**:生产 Bridge set `split` 数日 + Annie 体感;归因 = sessions 两列
  SQL 直查。
- 本单交付到「钩子齐备」为止;评测执行与盲评组织属 FLY-1299/评测单,不在本 PR。

## 验收标准(implement 段完成定义)

1. 默认 env:反向兼容哨兵绿(含突变验证);全仓测试 + lint 绿。
2. console/CLI 不重启完成 `split`↔`superpowers` 翻转,下一 dispatch 观察到(directToggleProof)。
3. 529 隔离房真机:三臂各真 spawn 一个 runner —— bare 无注入、matt 无注入且 Matt catalog 可见、
   superpowers 现状注入在(qa 脚本 1-4 全 PASS);sessions 两列记录与实际臂一致。
   **且(v2.2③,HL 4496f8a0 能力级验收)三臂各真跑通一张单,四观测量(完成率/token/
   纪律违规/返工轮数)对每臂都真采得出来 —— 任何一臂采不出数据 = 验收不过。**
4. override / 项目退出 / matt 探针回落 / sticky(二次 dispatch)/ inherited(auto-QA)
   五条路径的 via 记录逐一验证;kill 场景(split→superpowers)下带旧 override 的 successor
   正常 spawn 为 A(R1#1 回归)。
5. Codex code review APPROVED;独立 QA(auto-QA 流程)PASS。

## 排程与依赖

- **FLY-1335(PR #646)先 merge**(同 overnight batch;两单动同一条派发语义链,本单 rebase 其上)。
- 与 FLY-1299 顺序执行:本单 merge + 评测定赢家后才开第二刀;本单不碰提示词清理。

## Ship 前置清单(design gate 批准时 Tadashi 附加,2026-07-20)

- **Codex 审 = deferred-not-waived**:Codex design + code review 因 school 额度封顶(至 Jul 24,
  唯一有 Codex 权限 profile)未执行,由 Bar-Raiser 独立审替补(实码核验,R1 8 findings 已折入)。
  额度恢复(或出现其他有权限 profile)后**必须补一轮增量审**;在此之前 PR 出来同样
  Bar-Raiser 先审 + Codex 记 deferred。
- **ship gate 呈给 Annie 时必须明写**:「Codex 审 deferred(quota),Bar-Raiser 替补」,
  让她知情拍板。
- FLY-1335 已 merge 且与本单同批 approve、restart 同车(批次计划一致)。
- **四观测量数据呈 Annie;任何默认模式切换(含开 `split`、默认换臂)只认她明示**
  (v2.2②,lead-instruction dcbcaad9)。

## Out of scope(明确不做)

- Lead session 的 Superpowers 处置(本刀只切 Runner spawn 路径)。
- Matt skills 的 FLY-216 机器级正式 vendor(B 臂胜出并 Annie 拍采纳后另开单)。
- workflow 模板的 mode 变体(模板 default-off;开旗属 FLY-1299 之后)。
- 单变量 hook ablation 臂(FLY-1326 U7,留评测单决定)。
- 评测执行本身(盲评组织/rubric 打分/报告)。

## 风险登记(research.md §4 摘要)

R1 catalog 残留(fixture 钉)· R2 tmux 路径一致性(真机 QA 步骤 4)· R3 settings 合并
(测试盯)· R4 enum stage 回归(bool 字节兼容测试)· R5 in-flight 不追改(runbook 诚实边界)·
R6 vendor 审查 + U4(VENDOR.md checklist + 529 观察)· R7 作用域(Tadashi 已拍:全局+项目退出杠杆)·
R8 1335 时序(runbook 前置)。
