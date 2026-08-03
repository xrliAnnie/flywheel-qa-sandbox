# FLY-1609 开 D 臂:bare + ponytail — 调研(代码审计)

Issue: FLY-1609 (https://linear.app/geoforge3d/issue/FLY-1609/实验founder-直令-开-d-臂bare-ponytail代码极简-四臂分桶-归因-1458-分析脚本升级)
日期: 2026-08-03
基于: exploration.md

逐位点审计当前分桶 / ponytail / 归因 / 分析链路,列出加第四臂需要碰与**明确不需要碰**的每一处。

## 1. 分桶器(packages/config/src/skill-framework-mode.ts)

- `SKILL_FRAMEWORK_MODES = ["superpowers", "matt", "bare"]`(L27)—— 单一真相数组。**加 `"bare-ponytail"` 于末位**后:
  - `hashModeBucket`(L95-101)用 `% SKILL_FRAMEWORK_MODES.length` → 自动变 %4。存量未 stamp issue 桶位重排(接受,exploration §3.2);已 stamp issue 由 sticky 保护。
  - `isSkillFrameworkMode`(L83)自动接受新值 → 以下全部**零改动**生效:
    - API 边界校验 runs-route.ts L1102-1113(400 的 `allowed` 列表引用数组本身);
    - sticky 回读 StateStore.ts L5164 + L9729(`isSkillFrameworkMode(row.skill_framework_mode)`);
    - resolver 的 `sanitizeMode`(override / priorStamp / parentMode);
    - forced env:`FLYWHEEL_SKILL_FRAMEWORK_MODE=bare-ponytail` 即全局强制 D(定向测试用);
    - successor 携带:phase-orchestrator.ts L696/L1481/L1702/L2143(`via === "override"` 时原样传 mode 字符串);
    - auto-QA 继承:auto-qa-coordinator.ts L1297-1298(`skillFrameworkModeParent`)。
- `BACKEND_SKILL_ASSEMBLY`(L65-73):按 backend 不按 mode,**不用改**。agy/kimi = "none" → D 臂在这些 backend 上 via=noop_backend,mode 照记。
- 语义映射缺口:codex probe 与变体文件解析按 `"matt" | "bare"` 字面比较(见 §3),需要一个集中的 **base-arm 映射**(`bare-ponytail` → `bare`),建议就放本模块。

## 2. ponytail 解析(packages/config/src/ponytail.ts)

- `PonytailSource = "run" | "label" | "project" | "default"`(L35)→ **加 `"arm"`**;`isSource`(L244-246)同步。这是本模块唯一实质改动。
- 加 `"arm"` 后自动正确的现成机制:
  - `toPonytailCondition`(L161-184):encoded 用 `${source}` 内插 → `on:arm` / `unavailable:readiness:on:arm` 自动成立;
  - `decodePonytailConditionForRetry`(L208-239):`on:arm`、`unavailable:readiness:on:arm` 都能解出 frozen `{want:"on", source:"arm"}` → retry 保 D 注入;
  - `resolvePonytailRequested` 的 `frozen_requested` 短路(L95-97):retry 原样返回,不再走 ladder。
- ladder 本体(L89-143)**不动**:D 注入不进 ladder,在 Blueprint 后置替换(见 §3)。
- 插件本体(marketplace `ponytail@ponytail`)与 ruleset 注入(`ponytail-ruleset.ts`)**不动**。

## 3. 装配层(packages/edge-worker/src/Blueprint.ts)

- **解析顺序需对调**:现在 `resolvePonytailCondition`(L889)先于 `resolveSkillFrameworkForRun`(L895)。D 注入需要 mode 先出结果 → 对调两行并把 resolved mode 传入 ponytail 解析。两函数彼此无其它数据依赖(已核:skill-framework 解析不读 ponytail 任何输出),对调安全。
- **注入点** `resolvePonytailCondition`(L983-1020):在 `resolved.kind === "resolved"` 之后、readiness 折叠之前,加后置替换:`mode === "bare-ponytail" && requested.want === "off" && (source === "project" || source === "default")` → `requested = {want:"on", source:"arm"}`。conflict(L1008)/ selector_unavailable(L1011)分支保持原样(如实记,D 组排除)。
- **注入以最终 resolved mode 为键**(`resolveSkillFrameworkForRun` 的返回值):
  - `fallback_superpowers` 改写后 mode 已不是 D → 自然不注入 ✓;
  - `noop_backend`(agy/kimi):mode 记 `bare-ponytail`、注入照做,但 `defaultPonytailReadiness` 对无 adapter 的 backend 返回 false(L141-156 注释:agy/kimi ignore → ponytail 永不可用)→ 如实记 `unavailable:readiness:on:arm` ✓。
- **skill 装配对 D 的等价性**(runInner L1134-1167):
  - `enablePonytail = ponytail_condition.startsWith("on:")`(L1136)→ `on:arm` 自动启用 ponytail 注入,零改动 ✓;
  - Claude 插件面:`claudePluginAssembly = mode !== "superpowers"` → D 自动禁 superpowers 插件;`modeEnabledPluginsExtra` 仅 `mode === "matt"` 加 matt 插件 → D 不加 ✓ 零改动;
  - Codex 面:L1091-1093 `resolved.mode === "matt" || resolved.mode === "bare"` 才走 `codexSkillAssemblyProbe`,且 probe 参数类型 `mode: "matt" | "bare"`(L232)→ **需要 base-arm 映射**(D → probe 收到 "bare"),否则 D 在 codex-tmux 上会跳过 skill 拆除、superpowers namespace 残留(臂被污染);
  - 变体提示词:`readAgentFileWithSkillVariant`(L2917-2928)`(mode === "matt" || mode === "bare")` 才找 `.{mode}.md` → **需要 base-arm 映射**(D 读 `.bare.md` 变体,与 C 同 prompt —— 这正是「C + enable ponytail」的实验定义:两臂 prompt 完全一致,唯一自变量是 ponytail)。
- matt readiness 闸(L1081-1090)仅对 `mode === "matt"`,D 不涉及,不动。

## 4. 持久化与事件链(全部零改动,值为字符串直通)

- StateStore.ts:`sessions.ponytail_condition` / `skill_framework_mode` / `_via` 均 TEXT 列(L1964-1982 幂等 ADD COLUMN),upsert 双位点(L4026/L4789)COALESCE 直写 → 新值直通。
- envelope → session_started → DirectEventSink / event-route:携带字段为 string,无 enum 白名单(sticky 回读处的 `isSkillFrameworkMode` 在 §1 已覆盖)。
- run_attempt / retry:retry-dispatcher.ts L290 携带 `ponytailInput`(frozen)→ §2 decode 已覆盖。

## 5. flag 面(packages/config/src/feature-flags/registry.ts L2770-2800)

- `skill_framework_mode` 条目 `enumValues: ["superpowers", "matt", "bare", "split"]` → **加 `"bare-ponytail"`**;description 补 D 臂一句。kill 语义(设回 superpowers)不变。
- `directToggleProof` 指向的 direct-toggle 测试若枚举断言 allowed 值,需同步(plan 内核对)。
- dashboard 渲染(feature-flag-render.ts)按 registry enumValues 泛型渲染,预期零改动(plan 内以 grep 断言无三臂硬编码文案)。

## 6. 1458 分析脚本(engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/scripts/)

- `design_compare.py`(39 行):已 `GROUP BY skill_framework_mode` 思路(SELECT mode 列 + `order=['superpowers','matt','bare']` 聚合)。升级点:
  1. order 加 `'bare-ponytail'`;
  2. SELECT 补 `ponytail_condition`;
  3. D 组聚合过滤 `ponytail_condition LIKE 'on:%'`,不满足的行单独打印为 `D-excluded`(mode=D 但 effective≠on);
  4. 每臂打印 ponytail_condition 分布 → C 臂对照(全 off)直接可见。
- `analyze.py` / `final.py`:三 pilot issue(FLY-1392/1385/1393)硬编码快照,保留不动(exploration §3.7)。
- 库字段现状:`sessions` 已有 `skill_framework_mode` / `ponytail_condition` 两列,脚本只读 `mode=ro`,无 schema 依赖风险。

## 7. 测试基线(packages/config/src/__tests__/skill-framework-mode.test.ts)

- L28「exposes the three modes in fixed bucket order」、L287-296 bucket membership + 均匀分布(30%–36.7% per bucket, N=10000)→ 需升级为四臂(每桶 ~25%,界放宽同比例);
- L208-209 precondition `hashModeBucket(ID) === "bare"`:%4 后该 ID 桶位可能漂移,需按新分布重选 fixture ID(测试意图是「非 superpowers 桶」);
- ponytail.test.ts:补 `arm` source 的 encode/decode/retry 用例。

## 8. 风险与结论

| 风险 | 评级 | 处置 |
|---|---|---|
| %3→%4 存量未 stamp issue 重排 | 低 | sticky 保护存量;文档明示(exploration §3.2) |
| codex/变体文件按字面 "bare" 比较漏 D | 中(不修则 D 臂在 codex 被污染) | base-arm 映射集中于 config 模块,两处调用点换用 |
| D 注入压过显式 off | 中(归因撒谎) | 后置替换只针对 source ∈ {project, default} 的 off;显式信号保留 + 分析排除 |
| 测试 fixture 桶位漂移 | 低 | 按新 hash 重选 fixture,并在测试内断言 precondition |

结论:改动集中在 4 个文件(skill-framework-mode.ts / ponytail.ts / Blueprint.ts / registry.ts)+ 1 个脚本(design_compare.py)+ 测试。持久化、事件链、API 边界、successor/auto-QA 继承全部自动生效。

→ plan.md
