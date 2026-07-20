# FLY-1356 skill_framework_mode 三选一开关 + 生产分流 — 调研

Issue: FLY-1356 (https://linear.app/geoforge3d/issue/FLY-1356/eng-建三选一开关-skill-framework-modeabc-生产分流-瘦身第一刀的-build)
日期: 2026-07-20
基于: exploration.md

> 全部条目为本 session 实读代码 / 实跑命令所得,标注文件:行号。两处真机 spike 附命令与输出。

## 1. 真机 spike(本设计的两块基石证据)

### S1. per-launch settings 能压掉 Superpowers SessionStart 注入(带阳性对照)

| 组 | 命令 | 输出 |
|---|---|---|
| 对照(尺子校验) | `claude -p --model haiku "…context contain 'using-superpowers'…YES or NO"` | **YES** |
| 处理 | 同上 + `--settings '{"enabledPlugins":{"superpowers@superpowers-dev":false}}'` | **NO** |

⇒ per-launch `enabledPlugins:false` **压掉的是整个插件(含 SessionStart hook 注入),不只是 MCP 子进程**
(FLY-615/751 只测过 MCP 子进程那半)。这是 C/B 臂 session-launch 层的机制根据。
残留验证项(implement 段 fixture 补):catalog metadata(skill 列表条目)是否同步消失 —— 预期消失
(catalog 由插件贡献),用「问模型 superpowers:brainstorming 是否在可用 skill 列表」的 fixture 钉死。

### S2. 插件 key 实测

`claude plugin list` → `superpowers@superpowers-dev`,Version 5.1.0,Scope: user;
`~/.claude/settings.json` 中 enabled。key 字面量 = **`superpowers@superpowers-dev`**。

## 2. 现有机制盘点(seam map)

### 2.1 session-launch 层:per-launch 插件控制(FLY-615/751/1185 全套先例)

| Seam | 位置 | 事实 |
|---|---|---|
| CLI flag 组装 | `packages/claude-runner/src/TmuxAdapter.ts:849-865` (`buildClaudeArgs`) | `ctx.enablePonytail` / `ctx.disabledPlugins`(false)/ `ctx.enabledPluginsExtra`(true)三源合并为**单个** `--settings '{"enabledPlugins":…}'`;无条目 → 不加 flag(字节兼容)。注释:per-launch settings = 最高非-managed 优先级;正向 opt-in 在 disable 之后应用(显式 enable 恒胜,可压过机器级 default-off,FLY-1185 §2.7 实测) |
| ctx 注入 | `packages/edge-worker/src/Blueprint.ts:2114-2130` | `enablePonytail` / `runnerMcpProfile.{disabledPlugins,disableChrome,enabledPluginsExtra}` 展开进 `adapter.execute`;absent 保持 absent(字节兼容 spawn) |
| profile 计算 | `packages/config/src/runner-mcp-profile.ts:95`(`resolveRunnerMcpProfile`),调用点 `run-dispatcher.ts:768/1382` | FLY-751 slim 名单的计算与传递轨 |
| 后端边界 | `Blueprint.ts:122` 注释 | antigravity/kimi adapter 忽略这些字段;codex 不吃 claude 插件(不同 harness)—— mode 对非 claude-tmux 后端机制上 no-op |

### 2.2 归因/实验条件记录(FLY-615 ponytail = 完整同构先例)

| Seam | 位置 | 事实 |
|---|---|---|
| 条件解析(spawn 前) | `Blueprint.ts:644-651`(`resolvePonytailCondition`) | 在 event envelope **之前**解析,readiness 失败 → `unavailable` 条件(不加 --settings、记录在案、评测排除)——「探针失败回落 + 诚实记录」的既有形状 |
| envelope 持久化 | `Blueprint.ts:687`(`…(ponytailCondition && { ponytailCondition })`) | session_started upsert 携带 → `sessions.ponytail_condition`(FLY-614/616 的 A/B join key) |
| readiness 探针 | `Blueprint.ts:137-166` | `claude plugin details ponytail@ponytail` exit 0;**负结果不缓存**(装好后下一个 run 即生效,无需重启 Bridge) |
| sessions 列先例 | `StateStore.ts:1412/1418/1596`(design_backend / ponytail_condition / doc_tier 的幂等 ADD COLUMN) | 迁移模式现成 |
| 双 sink | `event-route.ts:838`(designBackend)+ DirectEventSink | started 字段两个 sink 都要接(design_backend 先例) |

### 2.3 prompt 层:agent 文件读取

| Seam | 位置 | 事实 |
|---|---|---|
| agent 文件解析 | `Blueprint.ts:2007-2022` | `readAgentFile(agentFileBaseDir, dispatchResult.agentConfig.agent_file)`;root 由 `agentFileRoot`("project" → 项目 cwd / "flywheel" → 主仓根)判别;40k char 截断 |
| generalized workflow 路径 | `Blueprint.ts:2001-2006` | `isGeneralizedExecution` 走 `ctx.workflowAgentContent`(模板快照)——**不经 readAgentFile**;模板本就 flag-gated default-off,评测纪律 = 保持 OFF(FLY-1326 plan §3①3) |
| codex 翻译头 | `Blueprint.ts:2029-2041` | codex runner 拿固定 translation header,角色文件不做 per-vendor 改写 |

### 2.4 派发语义(FLY-1335 落地后)

PR #646(OPEN,同 overnight batch,先行):`.flywheel/config.yaml` 声明 `default_agent: general`
走 dispatcher 现成 Step 3a(`AgentDispatcher.ts:252-264`,机制已存在已测),**AgentDispatcher 零代码改动**;
ConfigLoader C-lite 警告空 labels。落地后:

- Flywheel label 未命中 issue → 项目 `.flywheel/agents/general-executor.md`(FLY-1326 实测 **0** Superpowers prompt 耦合);
- shipped `agents/generic-executor.md` 只剩:显式 `agentName:"generic"` + 零配置项目(sub/joycon);
- prompt 层活跃耦合不变:`agents/generic-executor.md`(99-204)+ `.flywheel/agents/engineering/designer-executor.md`(:68/:141)。

### 2.5 flag 基建(FLY-709/1344)

| Seam | 位置 | 事实 |
|---|---|---|
| 注册表 | `packages/config/src/feature-flags/registry.ts` | 支持 `valueKind:"enum"` + `enumValues`(先例 `issue_gate_supersede_mode`);`toggleable:"direct"` 要求所有 Bridge readSite 为 call_time + `directToggleProof` 测试 |
| resolver | `feature-flags/resolve.ts:121-126` | enum flag effective = raw ?? default(display 语义) |
| apply core | `flag-toggle.ts:39-47, 85+`(`applyFlagToggle`) | **raw string 语义**(`rawFrom/rawTo: string\|null`,null=删键回默认)→ **enum-ready**;事务 = 锁内 re-verify(fileSha+live rawFrom)→ .env 原子先写 → in-proc `process.env` 后改(call_time 读立即生效 = 「不重启」的机制根据) |
| stage/console 层 | `flag-routes.ts:29-40`(`FlagCanonical.effectiveFrom/To: boolean`) | **bool 专用**:canonical 用 boolean effective + 「per polarity 写策略」推目标值 → enum flag 今天无法从 console/CLI stage。**这是「秒级钉回」要补的唯一缺口**(有界:apply core 不动,扩 stage/canonical/UI/CLI 接受 enumValues 目标值) |

### 2.6 override 参数边界先例

`runs-route.ts:332`(`rawDesignBackend` 校验)+ `run-dispatcher.ts:730/1318`(threading)+
phase/retry/rescue 传递(`phase-orchestrator.ts:672/1450/1653/2078`、`retry-dispatcher.ts:106/222`、
`rescue-runtime.ts:236/259`)—— per-dispatch 参数从边界校验到 successor 传递的完整轨。

## 3. 设计选型确认(基于以上证据)

1. **解析位点 = Blueprint(ponytail 同轨),不是 run-dispatcher**:
   - Blueprint 是所有 runner session 的收口(legacy dispatch / DAG / retry / phase successor 全经过);
   - hash 确定性 ⇒ 粘性免查库(同 identifier 恒同桶);唯一要线程传递的是 529 用的显式 override
     (走 designBackend 同轨);
   - Blueprint 跑在 Bridge 进程内 ⇒ `process.env` call_time 读 = flag console in-proc mutate 立即生效,
     注册表可标 `direct`(附 proof test)。
2. **生效方式 = 复用现有 ctx 字段合并**,不发明新通道:mode 的插件增删并入
   `disabledPlugins`/`enabledPluginsExtra` 组装处;mode=superpowers 恒零贡献(字节兼容哨兵)。
3. **matt readiness = ponytail 探针同款**(负结果不缓存);失败回落 superpowers + via 记
   `fallback_superpowers` + 告警 —— 绝不静默跑残缺 B。
4. **落库 = envelope 双 sink**(design_backend/ponytail 同轨):`sessions.skill_framework_mode` +
   `skill_framework_mode_via` 两列,记录**实际生效值**(探针回落后的真值,不是意图值)。

## 4. 风险与未知项

| # | 项 | 处置 |
|---|---|---|
| R1 | catalog metadata 是否随插件 disable 消失(S1 只证 hook 注入) | implement 段 fixture 钉死(问模型 skill 列表);预期消失 |
| R2 | 交互式 tmux 路径 vs `-p` headless 路径的 `--settings` 行为一致性 | FLY-615/751 已在真 runner 路径实测过 per-launch settings 生效;implement 段 QA 脚本再走一遍真 tmux spawn |
| R3 | `--settings` 与 FLY-751 slim profile 的合并冲突 | 同一 map 合并(TmuxAdapter 已处理);superpowers key 不在 slim 名单(实读 runner-mcp-profile.ts 确认)→ 无键冲突;测试盯合并结果 |
| R4 | enum stage/console 扩展的回归面 | apply core 不动;bool 路径字节兼容测试 + enum 新路径测试 |
| R5 | in-flight B/C session 在 kill 后仍保持 spawn 时插件状态 | 设计边界,写进 runbook(exploration D6);非缺陷 |
| R6 | Matt 6-skill vendor 的安全审查 + `to-spec`/`to-tickets` 翻 model-invoked 后的 headless 行为(FLY-1326 U4) | vendor 任务内含审查 checklist;U4 行为在 529 排雷阶段暴露(评测目的之一),不在本单预答 |
| R7 | split 作用域(全 Bridge vs 仅 Flywheel 项目) | 已非阻塞 ask Tadashi(id `e2c42079`);默认按推荐「v1 全局」设计,plan 里留 per-project 参与开关的扩展位 |
| R8 | FLY-1335 未 live 就开 split → 未命中 issue 落 shipped generic 变体 | 两臂变体文件对 shipped generic 也存在 ⇒ 臂内仍一致;但按 issue 依赖声明,**开启 split 的 runbook 前置 = 1335 已 merge + 生产 Bridge 已带其 config** |
