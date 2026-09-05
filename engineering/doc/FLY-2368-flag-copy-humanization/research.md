# FLY-2368 Flag 文案人话化 — 调研
Issue: FLY-2368 (https://linear.app/geoforge3d/issue/FLY-2368/2356s5-flag-文案人话化-删-governance-gate-类别registry-每条-flag)
日期: 2026-09-05
基于: exploration.md

## 数据链路

```text
registry.ts FeatureFlagSpec.whenOn
  -> resolve.ts FlagView.whenOn
  -> management-existing-writers.ts ManagementFlagView.whenOn
  -> /api/fleet/snapshot
  -> fleet-console-html.ts flagReading()

registry.ts FeatureFlagSpec.whenOn
  -> resolve.ts FlagView.whenOn
  -> feature-flag-render.ts effectSentence()
  -> localhost / phone flag card
```

`whenOn` 只沿既有只读投影传递。实际值仍由 `resolveFlag()`、flag store codec 和 scoped precedence 决定；本单不触碰这些路径。

## 当前 23 条人话字段

以下文案的主语由页面统一补成「打开代表」或「这个值代表」。文案本身直接说结果，不带 issue 号，不要求 founder 理解 `launchd`、`call_time`、`project_opt_out` 等实现词。

| flag | kind / default / polarity | `whenOn` |
|---|---|---|
| `cmux_watcher_rebuild_disabled` | bool / false / opt_in | 停止自动重建掉线的 cmux 监看窗口；健康检查和告警仍继续 |
| `cmux_rebind_disabled` | bool / false / opt_in | 停止自动补建并重新连接丢失的 Runner cmux 窗口 |
| `summary_absorption_cadence_ms` | value / 21600000 / default_on | Raya 两轮总结复盘之间要等待的毫秒数；默认 21600000 毫秒（6 小时） |
| `alert_system` | bool / true / default_on | 把系统告警发到 Discord、创建处理工单，并通知值班 Claw；原始告警仍会留档 |
| `review_quota_auto_retry` | bool / true / default_on | Claude 额度恢复后，自动重试仍然有效的跨模型评审 |
| `loop_profiler` | bool / true / default_on | Bridge 卡顿时自动抓取一份限时 CPU 分析，方便排查原因 |
| `shipped_husk_force` | bool / true / default_on | 合入后的节点正常关闭失败一次后，自动清理已确认无用的残留进程 |
| `flag_retirement_scan` | bool / true / default_on | 每周检查长期没变的 flag，整理成「保留或清理」候选；不会自动删除 |
| `workflow_rework_reentry` | bool / true / default_on | QA 或 founder 要求返工时，让原来的执行节点继续修改；关闭后只暂停并告警 |
| `workflow_node_reuse` | bool / false / opt_in | 后续 QA 复验要求返工时，优先交回同一个仍在线的执行节点；节点已退出才新建 |
| `database_archive` | bool / true / default_on | 定期压缩已结束的 TeamLead 和 CommDB 历史记录，避免数据库一直变大 |
| `node_dwell` | bool / true / default_on | 检查仍在运行的工作流节点是否停留过久，并输出巡检结果或采取处理动作 |
| `node_dwell_threshold_hours` | value / 3 / default_on | 工作流节点持续运行多少小时后算「停留过久」；默认 3 小时 |
| `pipeline_dag` | bool / true / default_on | 让这个项目的新任务按设计、实现、QA 等独立节点组成的 DAG 流程运行 |
| `pipeline_work_kind` | bool / false / opt_in | 这个项目使用 DAG 流程派发时，检查任务类型是否符合当前节点，避免交给错误角色 |
| `doc_flow` | bool / false / opt_in | 要求这个项目的 Runner 随任务提交探索、调研、计划和进度文档 |
| `runner_memory_mode` | enum / off / opt_in | 决定新 Runner 使用哪种记忆方案；off 不注入实验记忆，其余选项用于对照实验 |
| `skill_framework_mode` | enum / superpowers / default_on | 决定新 Runner 启动时加载哪套技能框架；默认 superpowers，也可切换实验方案或分流 |
| `skill_framework_split_participation` | bool / true / default_on | 只在技能框架处于分流模式时生效：关闭后这个项目退出分流、固定使用 superpowers；全局强制指定某个方案时这个开关不起作用 |
| `proofshot` | bool / false / opt_in | 这个项目有界面改动时，自动要求用 ProofShot 做视觉验收 |
| `xiaohongshu_learning` | bool / false / opt_in | 定期读取这个项目的小红书收藏，把可执行内容整理成后续任务草稿 |
| `ponytail` | bool / false / opt_in | 让这个项目的新 Runner 使用更精简的 ponytail 编码流程 |
| `workflow_turn_divergence_alerts` | bool / false / opt_in | 发现工作流引擎和 TURN 记录不一致时发送严重告警；关闭时仍检测并留证 |

条件审计：两条 cmux 停用开关都明确哪些能力停止、哪些告警保留；review retry、强制清理、返工回流、节点停留检查、DAG work-kind、ProofShot 都写出各自触发条件；技能分流参与开关明确只在全局 `split` 下生效；TURN 严重告警明确关闭后仍保留 shadow 检测。其余行是无额外前提的周期、模式或项目开关。没有一条把「某个条件下才生效」写成无条件承诺。

## 字段策略

### 为什么不覆盖 `description`

`description` 还被 flag retirement scan 和既有报告消费，里面的 issue provenance、边界和实现名对工程排障有用。直接覆盖会损失工程信息，也无法保证所有页面都知道它是 founder 文案。新增 `whenOn` 明确表示 founder-facing copy，旧字段继续作为技术说明。

### 为什么暂时保留 `onMeans`

它已是公开 config 类型和 snapshot 字段。删除会把本单从「加展示文案」扩大为 schema 收缩；保留它不会妨碍页面读取 `whenOn`。本单只删掉 `name.endsWith("_disabled")` 这一启发式，继续保留「bool 必填、非 bool 不填」的结构守卫。

`whenOn` 在 TypeScript 接口上保持 optional，兼容 drift/scan/store-policy 的合成测试 spec；真正的 registry 由 `validateWhenOnContract()` 遍历 `FEATURE_FLAGS` 强制每条非空。management snapshot 把缺失投影为 `null`，页面据此 fail closed，不会渲染 `undefined`。

### 页面文案规则

- bool：`打开代表：${whenOn}。`
- value / enum：`这个设置决定：${whenOn}。`（这是 flag 级说明，不冒充某个枚举值的逐值释义。）
- 当前值与默认关系在下一行写成 `当前：开/关/值；维持默认/已偏离默认`；`tone` 只按 `current === default` 标色，不再用名字或 `onMeans` 猜业务含义。
- 当前值读不到时仍展示 `whenOn`，再明确写 `当前：未知`，避免失败态反而丢掉解释。
- `whenOn` 缺失或空白时 fail closed，显示「没有登记人话说明，这里不猜」，不显示 `undefined`。

## `governance_gate` 与 CI 守卫

生产代码搜索 `packages/` 与 `scripts/` 已无 `governance_gate`。唯一 live 约定文档命中是 `flag-authoring-runbook.md` 的禁止规则；历史 engineering docs 记录过去事实，不属于残留分支。仓内与 FLY-2105 相关的守卫是 Gemini 退役守卫，不引用该 flag category，因此无需改动。

每周 flag 留/清页也是 founder surface：`flag-retirement-scan.ts` 当前把 `spec.description` 冻结进 run item，再在「人话说明」下展示。本单应把**新扫描 run** 冻结的该字段改为 `spec.whenOn`；既有持久化 run 保持历史快照，不回写数据库。

## 受影响测试

- `packages/config/src/__tests__/feature-flags-registry.test.ts`：必填人话字段、空白变异体、删除后缀启发式断言。
- `packages/config/src/__tests__/feature-flags-resolve.test.ts`：`whenOn` 投影。
- `packages/teamlead/src/__tests__/management-existing-writers.test.ts`：snapshot/provider 投影。
- `packages/teamlead/src/__tests__/management-console-{ui-contract,dom,snapshot}.test.ts`：页面读取新字段、转义、人话句、当前/默认显示。
- `packages/teamlead/src/__tests__/feature-flag-render.test.ts`：共享卡片读取新字段并 HTML escape。
- `packages/teamlead/src/bridge/__tests__/flag-retirement-scan.test.ts`：新扫描冻结并展示 `whenOn`，历史 run item 仍可渲染。
- 受 `ManagementFlagView` / `FlagView` 类型影响的 fixture 同步补字段。
