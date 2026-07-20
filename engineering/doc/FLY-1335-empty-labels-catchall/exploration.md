# FLY-1335 空 labels 永不匹配 → general catch-all 失效 — 探索

Issue: FLY-1335 (https://linear.app/geoforge3d/issue/FLY-1335/bug-agentdispatcherlabelsmatch-空数组永不匹配-config-里-general-catch-all)
日期: 2026-07-18
基于: 无

## 问题陈述

`AgentDispatcher.labelsMatch` (packages/edge-worker/src/AgentDispatcher.ts:311-318) 对空
`match.labels` 数组永远返回 `false`(循环体不执行)。空数组不是 wildcard。

`.flywheel/config.yaml` 的 `general` agent 恰好是 `labels: []`,注释声称
"Top-level catch-all … Used when the Lead passes agentName:\"general\" **or no executor
label matches**" —— 后半句是注释冒充功能。实际后果:

1. 所有 label 未命中部门角色的 Flywheel issue 静默 fall through 到 shipped generic
   (`agents/generic-executor.md`,Superpowers RPC 那份提示词),而不是项目自己的
   `.flywheel/agents/general-executor.md`。
2. FLY-1326 的影响面结论因此改写:Superpowers 耦合今天就活在 Flywheel 自己的派发路径里。

## 代码审计事实(全部本仓实读验证)

| # | 事实 | 出处 |
|---|------|------|
| 1 | 空 `match.labels` → `labelsMatch` 永远 `false`;`labelsMatch` 只被 `dispatch()` 的 Step 2a/2b 调用,无其他调用方 | AgentDispatcher.ts:311-318, 226, 241 |
| 2 | 派发链 = 2a(部门内 label 匹配)→ 2b(top-level label 匹配)→ **3a `default_agent`** → 3b shipped-generic | AgentDispatcher.ts:215-268 |
| 3 | **Step 3a `default_agent` 机制已存在且已测**:声明且存在 → `matchMethod:"default"`;3 个现成测试覆盖(命中 / 未声明 / 指向未知名) | AgentDispatcher.ts:252-264;AgentDispatcher.test.ts:214-253 |
| 4 | ConfigLoader 已校验 `default_agent` 必须存在于 `agents` map,否则 load 时抛错 | packages/config/src/ConfigLoader.ts:827-838 |
| 5 | flywheel 的 config.yaml **没有声明 `default_agent`**;`general` 是全 config 唯一空 labels 的 agent | .flywheel/config.yaml(grep 双证) |
| 6 | `.flywheel/agents/general-executor.md` 存在,自述就是 catch-all/fallback("or you were selected as the fallback"——这条路径今天从未发生) | 该文件 frontmatter + 正文 |
| 7 | `dispatchByName("general")` 走项目 config 查找,与 RESERVED `"generic"`(shipped)不冲突;显式点名路径今天可用 | AgentDispatcher.ts:276-297 |
| 8 | ConfigLoader 校验错误(非 ENOENT)会从 run-infra **rethrow** → 该项目 run 基建 fail-closed。硬性禁止空 labels = 对存在同模式 config 的其他项目是 breaking(本仓审计不到 sub/joycon 等项目的 config) | packages/teamlead/src/bridge/run-infra.ts:773-802 |
| 9 | `match.labels` 的类型文档只说 "Linear labels that map to this agent",没写空数组语义;校验只查「是字符串数组」,不禁空 | packages/config/src/types.ts:155-161;ConfigLoader.ts:800-805 |

## 候选方案

### A. `labelsMatch` 空数组返回 true(空 = wildcard)— 否决

让注释变真、config 零改动,但语义爆炸半径覆盖所有项目:

- Step 2a:部门内 agent 若声明空 labels,会吃掉该部门**所有** issue;
- 消灭「name-only agent」模式(只想被 Lead 显式 `agentName` 点名、不参与 label 派发的
  agent 无法再表达——shipped generic/qa 的合成 config 自身就是 `labels: []` 语义);
- Step 2b 按 YAML 顺序 first-match,wildcard 条目位置靠前会 shadow 后面的 top-level
  agent 与 `default_agent`,顺序脆弱;
- `matchMethod` 会报 `"label"` 但实际没匹配任何 label,遥测撒谎;
- 需要重审所有生产项目 config 里的空数组(本仓不可见)。

### B. 声明 `default_agent: general`(config 修复,走已有机制)— 推荐

兜底机制(Step 3a)本来就是为这个意图造的,已实现、已校验、已测试。修复 =
`.flywheel/config.yaml` 加一行 `default_agent: general` + 重写撒谎注释。

- dispatcher **零代码改动**;其他项目零行为变化;
- `matchMethod: "default"` 诚实(不是伪装的 label 命中);
- 显式 `agentName:"general"` 路径(dispatchByName)完全不动,天然不回归;
- label 未命中 → 2a miss → 2b miss(general 空 labels 不参与)→ 3a → **general**。

### C. 校验器禁止空 labels(fail-loud)— 降档为警告采纳

全禁是错的:name-only agent 是合法模式,且硬错误经事实 #8 的 rethrow 会 fail-closed
打崩其他项目的 run 基建 = 不可审计范围内的生产 breaking。

**C-lite(采纳)**:ConfigLoader 对「空 `match.labels` 且非 `default_agent`」的 agent 打
load 警告(console.warn):空 labels = 只能被显式 agentName 派发;想要 catch-all 请声明
`default_agent: <name>`。非 breaking,让下一个想用 `labels: []` 当 wildcard 的人在 boot
日志里被点醒。升级为硬错误 = 先审计全部生产项目 config 的 follow-up,不在本单。

## 推荐设计(B + C-lite + 文档修正 + 回归测试)

1. **config**:`.flywheel/config.yaml` 声明 `default_agent: general`;重写 `general`
   条目注释,如实描述机制(空 labels = name-only;兜底靠 default_agent)。
2. **ConfigLoader**:C-lite 警告(不 throw)。
3. **types.ts**:`match.labels` 文档补空数组语义;`default_agent` 文档指明它才是
   catch-all 的表达方式。
4. **回归测试**:
   - **真 config 合同测试**:用真 ConfigLoader 加载仓库 `.flywheel/config.yaml`
     (非 fixture,防「fixture 没开启被断言机制」的空绿测),断言 label 未命中派发落
     `general` / `matchMethod:"default"`,而非 shipped-generic;
   - `dispatchByName("general")` 仍返回项目 general(override 不回归);
   - C-lite 警告触发/不触发各一条;
   - 现有 AgentDispatcher + ConfigLoader 测试全绿(字节兼容其余路径)。

## 行为变化与影响面

- **flywheel 项目**:label 未命中的 issue(无 label,或 ops/marketing 等未注册标签)
  从 shipped generic(Superpowers RPC flow)改落项目 `general-executor.md`——这正是
  config 注释一直宣称的意图。shipped generic 在 flywheel 只剩显式 `agentName:"generic"`
  一条路。
- **其他项目**:零行为变化(C-lite 只加警告;未配 default_agent 的项目仍走 shipped
  generic 兜底,3b 不动)。
- **FLY-1326 排程**(HL 2026-07-17 对齐):本单先行;1326 B/C 臂(改写
  generic-executor.md)按上述结论开工——shipped generic 的受众收窄为「零 config 项目 +
  显式 generic 点名」。两单动同一条派发路径,不并行。

## 开放问题(带进 research/plan)

- 真 config 合同测试放哪个包(packages/config 直接读仓库根 config.yaml 的相对路径是否
  稳定;或走 scripts/__tests__ shell 合同测试模式,FLY-880 先例)。
- C-lite 警告的去重/输出通道(console.warn 一次即可;ConfigLoader 现无 warning 先例,
  需选最小侵入形态)。
