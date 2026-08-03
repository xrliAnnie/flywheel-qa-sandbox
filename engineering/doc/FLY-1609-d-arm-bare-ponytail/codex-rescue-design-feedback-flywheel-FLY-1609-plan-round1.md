# Design Review — plan.md (FLY-1609, Round 1)

Date: 2026-08-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案总体可行：新增独立 `bare-ponytail` 归因值、复用 FLY-615 的 requested/effective 模型、并把 D 的 skill assembly 映射回 bare，是当前架构里最小且清晰的方向。但当前计划遗漏了一个会越过显式 `ponytail-off` 的 fail-closed 场景、一个确定的 Codex 类型/装配边界，以及真正的 retry 和四臂分析接线；在这些问题修正前不宜进入生产实现。

## What's Good (Keep)

- 把 `bare-ponytail` 追加到固定 bucket order，而不是复用 `bare` 或新增持久化列；这保留了单列 arm attribution，`isSkillFrameworkMode` 驱动的 API、StateStore 和事件 guard 也能自然复用。
- 保持 mode=`bare-ponytail`、用 `ponytail_condition` 如实记录 `on` / `off` / `unavailable`，readiness 失败仍运行 bare，不用“降级成 C”掩盖失败；这是正确的归因边界。
- `skillAssemblyBaseArm(D)=bare` 的抽象方向正确：实验归因值与实际 prompt/skill assembly 值应明确分层，避免散落更多 `mode === "bare-ponytail"` 分支。
- 不改 ponytail 插件、ruleset、持久化 schema，也不新增 feature flag；改动面与 founder 要测“是否过度工程”的目的相称。
- TDD 顺序、四桶分布 mutation guard、D condition mutation guard、C-arm 零扰动回归以及 unsupported backend 的 degraded case 都值得保留。

## Issues & Recommendations

1. **D 的后置替换会在标签不可读时越过潜在的显式 `ponytail-off`，且没有真正实现 `arm > project` 的 source 语义。** `runs-route.ts:2327-2340` 会把标签读取失败明确传成 `labelStatus="unreadable"`；当前 resolver 仅在 project 为 ON 时返回 selector-unavailable，project off/absent 会返回 `off:default`（`ponytail.ts:109-120`）。计划随后把这个 `off:default` 改成 `on:arm`，因此一个实际带有、但本次读取不到的 `ponytail-off` issue 会被 D 强行开启，违反 `label > arm` 和 attribution-honesty 红线。另一个直接矛盾是 project ON 会解析成 `on:project`（`ponytail.ts:136-139`），而计划只替换 project/default 的 **off**，所以声明的 `arm > project` 实际不会留下 `on:arm`。建议把 arm 应用规则写成一个明确的纯语义：run/label source 原样保留；D fresh-start 在无 run override 且 labels unreadable 时返回 `unavailable:selector:label_unreadable`；其余 project/default source 无论原 want 是 on 还是 off，都归一成 `{want:"on",source:"arm"}`。补齐 D+project-on→`on:arm`、D+labels-unreadable+project-off→selector-unavailable、以及 unreadable 下 run override 仍胜出的测试。

2. **计划漏掉了 Codex adapter 的三值 assembly 合同，照计划实现会在 build 时失败或把归因值错误泄漏到 assembly 层。** `Blueprint.ts:2571-2583` 当前把完整 `skillFramework.mode` 传给 adapter，但 `AdapterExecutionContext.skillFrameworkMode` 与 `ProvisionCodexHomeOptions.skillFrameworkMode` 都仍只接受 `"superpowers" | "matt" | "bare"`（`packages/core/src/adapter-types.ts:171-176`、`packages/claude-runner/src/codex-home.ts:656-668`）。Task 3 只计划在 Codex probe 和变体文件两个位点做 base-arm 映射，漏了 adapter 参数；同时 Blueprint 从 `flywheel-config` barrel import，新 helper 还必须在 `packages/config/src/index.ts:220-241` 重导出。建议 envelope/session 继续写 D，但所有 assembly-only seam——probe 参数、prompt variant、`AdapterExecutionContext.skillFrameworkMode`——统一传 `skillAssemblyBaseArm(mode)`，不必扩大 core/Codex home 的三值类型。加一条断言：Codex D 的 envelope 是 `bare-ponytail`，probe 与 adapter args 都是 `bare`，disableNames 仍生效；并同步 `start-e2e.test.ts:1411-1423` 的 API allowed-list 与 D 接受用例。

3. **计划声称 retry decode 会自动保留 `source:"arm"`，但 decoder 当前没有任何生产调用点。** 全仓只有 `ponytail.test.ts` 调用 `decodePonytailConditionForRetry`；`RetryRequest` 没有 `ponytailInput`，`actions.ts:1184-1269` 构造 retry dispatch 时也没有从 predecessor 的 `ponytail_condition` 解码，`run-dispatcher.ts:800-869` 的 retry Blueprint context 同样未携带它。Task 2 新增 decode 单测只能证明 parser，不会证明 runtime retry；尤其 D 首次显式 `off:run` 的 session，retry 会丢掉这个 frozen override并重新被 arm 开成 ON。建议在 retry admission 读取并 decode predecessor condition，把 frozen 结果作为 `ponytailInput:{kind:"frozen_requested",...}` 经 `RetryRequest`/RunDispatcher 送入 Blueprint；`reresolve` 才走刷新后的 selector 路径。至少做 `on:arm`、`unavailable:readiness:on:arm`、`off:run` 三个 predecessor→retry 行为测试。若本 issue 明确不修这条既有 FLY-615 缺口，则必须删除“retry 自动保留”的设计声称，并明确 per-run override 只对单次 execution 生效。

4. **Task 5 尚未把 FLY-1458 工具链升级成能分析新 D 数据的四臂 cohort。** `design_compare.py:15-17` 仍硬编码旧的 7 个 issue；本轮对生产库只读实跑，它只输出 9 个 design session，而库中已有 93 个带 `skill_framework_mode` 的 design session。仅增加第四个 order 值会让“D 为空”的 smoke 轻易通过，即使所有新 D issue 都被查询条件排除。README 自己也明确写着未来要去掉硬编码 issue、按 mode 分组（`README.md:29-48`），且当前 rerun 入口仍指向三臂硬编码的 `final.py`；后者才包含 implement/QA/review-round/wall-clock 指标。建议先确定一个权威 future-data 入口：要么真正升级 `final.py`/`analyze.py`，要么把 `design_compare.py` 做成通用 CLI 并同步 README。通用入口至少应有 rollout epoch/`--since`（避免 A/B/C 混入 %4 上线前历史数据）、可选 issue filter、所有四臂查询，以及明确 eligibility：D 只计 `on:%`；作为纯实验 control 的 A/B/C 应只计 `off:%`，其余/null/unavailable 单列 excluded，避免现有 label/project ponytail 污染对照。再用临时 SQLite fixture 自动验证 D-on、D-off、D-unavailable、C-off、C-on 和 epoch 边界；一次生产输出不能替代这个回归门。

5. **“只停 D 的安全阀”在 Codex backend 上不成立。** `defaultPonytailReadiness` 对 `codex-tmux` 明确始终 ready，因为它注入纯文本 ruleset；只有 Claude 会探测 marketplace plugin（`Blueprint.ts:158-186`）。因此禁用/卸载 Claude ponytail plugin 最多停止 Claude D 数据，Codex D 仍会继续 effective=on；计划中“D 组数据自动停止累积”的跨 backend 运维承诺不真实。建议删除或明确标成 Claude-only；在不新增 flag 的 scope 下，唯一现成且跨 backend 有保证的热停机是把全局 mode 设回 `superpowers`（停止整个实验）。若必须只停 D，应如实写成需要代码回退/重新部署，而不是现成安全阀。

6. **把自动继承的路径也落成边界测试，而不只依赖类型数组推断。** 计划应明确加入 `priorStamp="bare-ponytail"` resolver 用例、`StateStore.getSkillFrameworkStamp()` 对 D 的真实回读、event-route/DirectEventSink 的 D 持久化、runs-route 对 D 的 200/allowed-list、以及 C 的 exact adapter/prompt sentinel。这样“sticky/API/事件链自动生效”才有可执行证据，也能防止未来某个 consumer 再引入三臂闭集。`pnpm -r build` 会捕获类型漏接，但不能替代这些行为断言。

## Verdict

CHANGES REQUESTED — address items above
