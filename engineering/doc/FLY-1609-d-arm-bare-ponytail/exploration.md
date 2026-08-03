# FLY-1609 开 D 臂:bare + ponytail(代码极简)— 探索

Issue: FLY-1609 (https://linear.app/geoforge3d/issue/FLY-1609/实验founder-直令-开-d-臂bare-ponytail代码极简-四臂分桶-归因-1458-分析脚本升级)
日期: 2026-08-03
基于: 无

## 1. 背景与目标

Founder 原话(2026-08-03):

> beyond abc臂 I am thinking to add a new path, basically C + enable ponytail, do you think it is possible? just to see how much that could help us, **I do feel we are over engineering sometimes**

目标:在现有三臂 skill-framework 实验(A=superpowers / B=matt / C=bare,FLY-1356)之上加**第四臂 D = bare + ponytail(代码极简主义 ruleset)**,让 duration / token / 评审轮数对比成为「我们是否过度工程」的直接测量。

## 2. 现状(审计事实,详见 research.md)

- 三臂分流活跃:`sessions.skill_framework_mode` 经 `resolveSkillFrameworkMode`(`packages/config/src/skill-framework-mode.ts`)分桶,`hashModeBucket` 用 `sha256 % SKILL_FRAMEWORK_MODES.length`,sticky 语义(同 issue 保臂)靠 `priorStamp` 优先于 hash。
- ponytail(FLY-615)分级开关已交付:`packages/config/src/ponytail.ts`,两段条件模型(`requested` / `effective`),per-session 持久化 `ponytail_condition` 列,`unavailable` 两类 + retry 语义已定。
- 1458 分析脚本现成:`engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/scripts/{analyze,final,design_compare}.py`,只读连 `~/.flywheel/teamlead.db`。其中 design_compare.py 已按 `skill_framework_mode` 列分组;analyze.py / final.py 按三个 pilot issue 硬编码。

## 3. 决策空间与选择

### 3.1 D 臂的归因值:新 mode 值 `bare-ponytail`(选定)

| 选项 | 说明 | 判定 |
|---|---|---|
| **新 mode 值 `bare-ponytail`**(选定) | `SKILL_FRAMEWORK_MODES` 数组加第四值。单列 group-by 即可分组;`isSkillFrameworkMode` 校验、sticky 回读、API 边界 400 allowed 列表、successor 携带、auto-QA parent 继承全部自动生效 | ✅ 改动最小、归因最干净 |
| mode 仍记 `bare`,靠 `ponytail_condition` 区分 D | C 与 D 在 `skill_framework_mode` 列不可分 —— C 臂也可能被 label/project 打开 ponytail,单列无法 group-by;违反 scope 明确要求 | ❌ |
| 独立新列 `experiment_arm` | 新增持久化列 + 全链路双写,复杂度高且与现有归因键重复 | ❌ 过度工程(讽刺) |

命名:采用 issue 建议的 `bare-ponytail`。连字符不参与任何 split 逻辑(mode 只做整串比较);变体文件后缀经 base-arm 映射落到 `.bare.md`,不产生 `.bare-ponytail.md` 文件族。

### 3.2 hash 分桶从 %3 变 %4 的副作用:接受重排,sticky 保护存量

`hashModeBucket` 用 `% SKILL_FRAMEWORK_MODES.length`,数组变 4 后**未 stamp 的新 issue 的桶位会整体重排**(mod 3 → mod 4 无保序性)。已 stamp 的 issue 由 sticky(`priorStamp` 优先)完全保护,不受影响。重排对实验完整性无害:分臂仍是稳定随机,实验本来就按「session 落在哪臂」归因,不依赖历史桶位连续性。**接受,文档明示。**

### 3.3 D 臂 ponytail 注入层位:Blueprint 内 mode→ponytail 耦合(选定)

| 选项 | 说明 | 判定 |
|---|---|---|
| **Blueprint 内注入**(选定):先 resolve skill-framework mode,再把 mode 传入 ponytail 解析;命中 `bare-ponytail` 且无显式信号时,把 requested 替换为 `{want:"on", source:"arm"}` | 单点、离两个 resolver 最近;retry / sticky / readiness / 两段条件模型全部复用 FLY-615 现成通路 | ✅ |
| runs-route 在 HTTP 边界注入 per-run flag | 边界看不到 sticky stamp 与 hash 结果(mode 在 Blueprint 内才最终确定,还有 fallback_superpowers / noop_backend 改写),边界注入会与最终 mode 脱节 → 归因撒谎风险 | ❌ |
| ponytail.ts ladder 内感知 mode | 把 skill-framework 概念渗进 FLY-615 纯模块,双向耦合 | ❌ |

### 3.4 新 `PonytailSource` 值 `"arm"`(选定)vs 复用 `"run"`

复用 `run` 会让 D 臂注入与真实 per-run 手动 override 在 `ponytail_condition` 上不可分(都是 `on:run`),归因变浑。新增 source 值 `arm` 后:D 臂注入 = `on:arm` / `unavailable:readiness:on:arm`,一眼可辨;`decodePonytailConditionForRetry` 的 frozen 语义自动覆盖(只需 `isSource` 认识新值)。改动落在 `packages/config/src/ponytail.ts` 的**配置解析模块**(union + isSource + 注释),不碰 ponytail 插件本体 —— 符合 scope「不动 FLY-615 已交付插件」。

### 3.5 优先级:显式信号压过臂注入(选定)

D 臂注入插在 ladder 的 label 与 project 之间:**run > label > arm(D) > project > default**。实现为"后置替换":正常 ladder 解析后,若 mode=`bare-ponytail` 且结果为非显式的 `off`(source ∈ {project, default}),替换为 `{want:"on", source:"arm"}`;显式 `off:run` / `off:label` 保留(人类显式意图压过实验臂)。这些 session 记 mode=`bare-ponytail` + effective=off,由分析脚本**排除出 D 组**(也不混入 C 组)—— 归因诚实优先。

### 3.6 readiness 失败:mode 不降级,condition 如实记 unavailable(scope 钦定)

D 臂命中但 ponytail readiness 探针失败 → **mode 保持 `bare-ponytail`(sticky 保臂)**,`ponytail_condition = unavailable:readiness:on:arm`,session 照跑 bare。绝不把 mode 降级回 `bare`(那会让该 issue 的后续 session 永远留在 C,且 D 组数据被静默稀释)。分析口径:D 组 = `mode='bare-ponytail' AND ponytail_condition LIKE 'on:%'`,排除行单独可见。

### 3.7 1458 脚本升级形态:原地升级 design_compare.py 为四臂主对比口径

- `design_compare.py`(已按 mode 分组)原地升级:arm order 加 `bare-ponytail`;SELECT 带出 `ponytail_condition`;D 组聚合只计 `on:%` 行,排除行单独列出;各臂打印 ponytail_condition 分布(C 臂对照断言 off 由此可见)。
- `analyze.py` / `final.py` 是三 pilot issue 的定格快照,保留不动(历史产物);四臂通用对比以升级后的 design_compare.py 为准。验收「脚本对现有库跑出四组对比(D 组初期可为空)」由它满足。

## 4. 明确不做

- 不动 ponytail 插件本体与 ruleset 注入机制(FLY-615 已交付;本 issue 只走它的现成通路)。
- 不做终局分析报告(数据攒够后按 1458 口径另出)。
- 不为 agy/kimi(assembly=none 后端)开 ponytail 通路 —— readiness 天然 false → 如实记 unavailable,D 组自动排除。

## 5. 下游

→ research.md(逐位点代码审计)→ plan.md(实施任务 + 变异判据)
