# FLY-1609 开 D 臂:bare + ponytail — 实施计划

Issue: FLY-1609 (https://linear.app/geoforge3d/issue/FLY-1609/实验founder-直令-开-d-臂bare-ponytail代码极简-四臂分桶-归因-1458-分析脚本升级)
日期: 2026-08-03
基于: research.md
版本: ship 时取空号(现行 v1.55.0,多单 pending)
Review: Codex design review 4 轮(xhigh)→ **R4 APPROVED**(台账见 §5)

## 0. 方案一页纸

第四臂 **D = `bare-ponytail`**(mode 新枚举值):归因值(envelope / session 列)记 D,**所有 assembly-only 缝隙**(codex probe / 变体提示词 / adapter 参数)统一传 `skillAssemblyBaseArm(D)="bare"` —— prompt / 插件面与 C 逐字一致,唯一自变量 = per-run 注入 ponytail(FLY-615 现成通路)。

**ponytail 优先级 —— arm 槽位做进纯 ladder(R1#1)**:`resolvePonytailRequested` 加可选 `armInject`(默认 false = 字节兼容),ladder 变为:

```
run > label > arm(D 注入) > project > default
```

armInject=true 时的精确语义(纯函数,config 包内可全枚举测试):
1. `runOverride` 存在 → 原样(run 胜出,含 unreadable 场景);
2. labels **unreadable** 且无 runOverride → `selector_unavailable`(**不论 project on/off** —— 看不见的 `ponytail-off` 不许被 D 越过,fail-closed;retry 按既有语义 re-resolve);
3. label on/off → 原样(`on:label` / `off:label`);
4. **arm 槽位**:走到这里(原本会落 project/default,不论 want)→ `{want:"on", source:"arm"}`(D 下不再产出 `on:project`,`arm > project` 名实相符);

**归因诚实红线**:readiness 失败 → mode 保持 `bare-ponytail`(sticky 保臂)+ `ponytail_condition = unavailable:readiness:on:arm`,session 照跑 bare;**D 组统计口径 = `mode='bare-ponytail' AND ponytail_condition LIKE 'on:%'`**;A/B/C 对照组只计 `off:%`(label/project 开了 ponytail 的行进 excluded 桶,可见不混组)。

**arm-frozen 有效性绑定最终 mode(R2#2 / R3#2 精确化)**:frozen `source:"arm"` 只在本次 resolved mode 仍为 `bare-ponytail` 时可用;mode 已不是 D(如全局 kill 强制 A 后的 retry)→ 丢弃 frozen arm,按本次可信 fresh signal 以 `armInject=false` 重解普通 FLY-615 ladder。**kill 保证的是「不再有 arm-derived ponytail(`on:arm`)」,不是禁掉独立的 FLY-615**:kill 后无信号的 D predecessor → A + `off:default`;真实 `ponytail` label / project-on 合法产生 A + `on:label` / `on:project`(source 绝不为 arm)。

**retry 数据合同(R3#1)**:最终 mode 只有 Blueprint 在 hydrate 后才知道,而 `PonytailInput` 是互斥 union —— retry 必须**同时携带两份**:`ponytailRetry: { frozen?: PonytailRequested; freshSignal: PonytailRunSignal }`(actions 产出,`RetryRequest` → RunDispatcher → `BlueprintContext` 全链新增该字段;现 `retry-dispatcher.ts` 的 `ponytailInput` 属 StartRequest,不复用)。Blueprint 拿到最终 mode 后三选一:frozen 且(source≠arm 或 mode=D)→ 用 frozen;frozen source=arm 且 mode≠D → 以 freshSignal、armInject=false 重解;无 frozen(reresolve)→ 以 freshSignal、armInject=(mode=D) 解。freshSignal 缺席时按 `labelStatus:"unreadable"` fail-closed。

改动面:`skill-framework-mode.ts` / `ponytail.ts` / `Blueprint.ts` / `registry.ts` / config barrel + retry 补接线(teamlead)+ `design_compare.py` 通用化 + `.github/workflows/ci.yml`(self-test step)+ 测试。

## 1. 任务清单(TDD:每任务先 RED 后 GREEN)

### Task 1 — config:第四臂枚举 + base-arm 映射(`packages/config/src/skill-framework-mode.ts`)

RED(`__tests__/skill-framework-mode.test.ts`):
- 「fixed bucket order」升级为四值 `["superpowers","matt","bare","bare-ponytail"]`;
- 分布测试:10,000 合成 id 每桶 25%±3.5pp,且**断言恰好 4 个不同桶值、含 `bare-ponytail`**(变异判据 1);
- `hashModeBucket` %4 后重选 stamp-read-failed fixture ID(保留非 superpowers precondition 断言);
- resolver 边界:`priorStamp="bare-ponytail"` → sticky 返回 D;`parentMode=D` 继承;`override=D`;forced env=D(R1#6);
- `skillAssemblyBaseArm`:`bare-ponytail`→`bare`,其余恒等。

GREEN:
- `SKILL_FRAMEWORK_MODES` 末位加 `"bare-ponytail"`;
- 新导出 `skillAssemblyBaseArm(mode: SkillFrameworkMode): "superpowers" | "matt" | "bare"`;
- **`packages/config/src/index.ts` barrel 重导出**(Blueprint 从 flywheel-config 进口,R1#2);
- 模块头注释补 D 臂定义。

### Task 2 — config:ponytail ladder 加 arm 槽位(`packages/config/src/ponytail.ts`)

RED(`__tests__/ponytail.test.ts`):
- armInject=false(缺省):全部现有用例逐字不变(字节兼容回归);
- armInject=true:runOverride on/off 胜出;unreadable+无 override → `selector_unavailable`(project on 与 off 两种都断言);label on/off 保留;project-on → `on:arm`(非 `on:project`);project-off/absent → `on:arm`;
- `toPonytailCondition({want:"on",source:"arm"}, true/false)` → `on:arm` / `unavailable:readiness:on:arm`;
- `decodePonytailConditionForRetry("on:arm" | "unavailable:readiness:on:arm")` → frozen `{want:"on",source:"arm"}`;`off:run` → frozen(供 Task 3b 行为测试)。

GREEN:`PonytailSource`/`isSource` 加 `"arm"`;`resolvePonytailRequested(input, projectConfig, opts?: { armInject?: boolean })` 按 §0 语义实现(frozen_requested 短路在 armInject 之前,原样保留);头注释补 arm 语义。

### Task 3 — edge-worker:Blueprint 装配(`packages/edge-worker/src/Blueprint.ts`)

RED(扩 `Blueprint.fly1356-skill-framework.test.ts` 或新 `Blueprint.fly1609-d-arm.test.ts`):
1. split 命中 D、无显式信号 → envelope `ponytailCondition === "on:arm"` 且 ponytail 启用走通(变异判据 2);
2. D + readiness false → `unavailable:readiness:on:arm`,mode 仍 D,session 照常装配 bare;
3. D + per-run off / label off → `off:run` / `off:label` 保留;D + label on → `on:label`;D + project-on → `on:arm`;D + labels unreadable → `unavailable:selector:label_unreadable`;
4. **C 臂零扰动回归**:mode=bare 无信号 → `off:default`,adapter 参数 / 插件 flags / prompt 变体逐字 sentinel 断言(R1#6);superpowers / matt 不变;
5. codex-tmux + D → **envelope=`bare-ponytail`,probe 与 `AdapterExecutionContext.skillFrameworkMode` 均收到 `"bare"`**,disableNames 生效(R1#2);
6. 变体提示词:D 读 `.bare.md`;
7. noop backend(kimi-tmux)+ D → via=`noop_backend`;
8. conflict / selector_unavailable 编码维持。

GREEN:
- `run()` 对调解析顺序:先 `resolveSkillFrameworkForRun`,再 `resolvePonytailCondition(ctx, hydrated, skillFramework?.mode)`;后者以 `armInject: mode === "bare-ponytail"` 调 ladder,不再自带替换逻辑;
- **assembly-only 缝隙统一走 `skillAssemblyBaseArm`**:codex 闸 + probe 入参(L1091-1099)、`readAgentFileWithSkillVariant`(L2928)、**传给 adapter 的 `skillFrameworkMode`(~L2571-2583)** —— core/claude-runner 的三值类型(`adapter-types.ts:171-176` / `codex-home.ts:656-668`)**不扩**,归因值不泄漏进 assembly 层(R1#2);
- matt readiness 闸、Claude 插件面零改动。

### Task 3b — teamlead:retry 补接 ponytail frozen(R1#3,FLY-615 既有缺口在 D 下变实害)

现状(Codex 实核):`decodePonytailConditionForRetry` 全仓零生产调用;`actions.ts` retry 构造与 `run-dispatcher.ts` retry context 都不带 `ponytailInput`(retry-dispatcher 的字段是空椅子)。不修则 D 首跑显式 `off:run` 的 issue 在 retry 时会被 arm 重新开成 ON —— 直接违反归因红线。

RED(teamlead retry 行为测试;**断言落在最终 envelope / adapter 行为,不止 ctx 收到什么** — R3#1):
- predecessor `on:arm`、mode 仍 D → envelope `ponytailCondition="on:arm"`;
- predecessor `unavailable:readiness:on:arm`、mode 仍 D → frozen 保留,readiness 重探;
- predecessor `off:run` → `off:run`(**不被 arm 翻开**);
- **kill 反例(R2#2/R3#2)**:predecessor `on:arm` / `unavailable:readiness:on:arm`,env 强制 `superpowers` 后 retry:无信号 → `off:default`;带 `ponytail` label → `on:label`;project-on → `on:project` —— **任何情况下不得再出 `on:arm`**;
- **reresolve 标签可信度(R2#1)**:predecessor `unavailable:selector:*` / `unavailable:conflict`:本次 fresh fetch 成功才 `labelStatus:"readable"`;无 LINEAR_API_KEY / 请求失败 → `"unreadable"`(**stored labels 不许冒充成功读取**)→ D 下仍 selector-unavailable;fetch 成功且 `ponytail-off` 在 → `off:label`;**fetch 成功且无 labels → `on:arm`**;
- freshSignal 缺席 → 按 unreadable fail-closed。

GREEN(R3#1 数据合同):
- `actions.ts` retry admission 读 predecessor `ponytail_condition` → `decodePonytailConditionForRetry`,**始终**产出 `ponytailRetry: { frozen?, freshSignal }`(freshSignal 的 `labelStatus` 如实来自本次刷新;现状 `actions.ts:853-909` 刷新失败静默沿用 stored labels,须补 refresh-status 输出);
- `RetryRequest`(`retry-dispatcher.ts:41-142`,现无 ponytail 字段)→ RunDispatcher → `BlueprintContext` 全链新增 `ponytailRetry` 字段;
- Blueprint `resolvePonytailCondition` 在拿到最终 mode 后按 §0 三选一。
只接这一条既有通路,不做其它 retry 语义改动。

### Task 4 — config:flag 面(`registry.ts`)+ API / 事件链边界测试

- `skill_framework_mode.enumValues` 加 `"bare-ponytail"`;description 补 D;
- 核对 `feature-flags-direct-toggle.test.ts` 枚举断言;grep `feature-flag-render.ts` / `feature-flag-report-html.ts` 硬编码;
- **`start-e2e.test.ts:1411-1423` allowed-list 同步 + 新增 split 下 per-dispatch D 被接受(200)的用例**(R1#2/#6);
- **D 持久化边界用例落到具名文件(R2#5)**:StateStore skill-framework stamp 测试补 D 写入→`getSkillFrameworkStamp()` 回读 `bare-ponytail`;`event-route.test.ts`(现仅用 `bare`)补 D session_started 持久化断言(`skill_framework_mode='bare-ponytail'` + `ponytail_condition='on:arm'` 列值);`DirectEventSink.test.ts` 补同款 round-trip。

### Task 5 — 1458 工具链四臂通用化(R1#4)

`design_compare.py` 升级为**权威 future-data 四臂入口**(`final.py`/`analyze.py` 保留为三 pilot 定格快照,README 明示分工):
- 去掉硬编码 issue cohort:默认查全部 `skill_framework_mode IS NOT NULL` 的 design session;可选 `--issues` 过滤;
- **`--since <ts>` 对比模式强制(R2#3)**:四臂对比必须从 %4 rollout epoch 起算,不传 → 拒绝运行并提示;显式 `--allow-pre-rollout` 才允许全历史(smoke 用);ship 收尾时把实际 rollout 时刻写进 README 供 copy-paste;
- eligibility:**D 组只计 `on:%`;A/B/C 对照组只计 `off:%`**;其余(`on:%` 的 A/B/C、`unavailable:*`、NULL)全部进 per-arm excluded 桶,带 condition 值逐行可见;
- 每臂输出 `ponytail_condition` 分布(C 对照全 off 直接可见);
- **`--self-test`**:内置临时 SQLite fixture(D-on / D-off:run / D-unavailable / C-off / C-on:label / epoch 边界)断言分组与 eligibility,**并断言缺 `--since` 拒绝运行、`--allow-pre-rollout` 才放行**;
- **CI 显式注册(R2#4)**:新增 `scripts/__tests__/test-fly1609-design-compare.test.sh` 调 `--self-test`,并在 `.github/workflows/ci.yml` 加显式 step(本仓 CI 无 `scripts/__tests__/*.test.sh` 自动发现,测试逐项枚举);
- 对现有生产库 `mode=ro` 实跑一次,PR 附输出(四组结构可用,D 组为空 OK);
- 同步 `engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/README.md` 的 rerun 入口说明。

### Task 6 — 全仓门 + 收尾

- `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 新 shell 测试;
- CLAUDE.md 里程碑 + 文档收尾为 PR 最后一 commit;
- Codex code review(`codex:rescue`)循环至 APPROVED。

## 2. 验收对照

| 验收 | 证据 |
|---|---|
| 新 session 四臂分布 | Task 1 分布测试(10k id,25%±3.5pp,恰 4 桶) |
| sticky 保臂照旧 | Task 1 priorStamp=D 用例 + 现有 sticky 回归 + StateStore stamp D 回读用例(R1#6) |
| D 臂实测 effective=on(列核验) | Task 3 用例 1 + 真机:沙箱 dispatch 强制 env=D,查 sessions 行 `mode='bare-ponytail' AND ponytail_condition='on:arm'` |
| C 臂对照 off | Task 3 用例 4 sentinel + Task 5 分布输出 |
| 脚本四组对比结构可用 | Task 5 真库输出 + self-test CI 门 |
| 变异判据:去 D 分支 → 红 | Task 1 恰 4 桶断言 |
| 变异判据:去 flag 接线 → 红 | Task 3 用例 1 |

## 3. 运维与回滚(R1#5 修正)

- **全局 kill(唯一跨 backend 热停)**:`FLYWHEEL_SKILL_FRAMEWORK_MODE` 设回 `superpowers` → 新 dispatch 全回 A,秒级免重启。这会停整个实验,不只 D。kill 停的是 **arm-derived ponytail(`on:arm`)**;独立的 FLY-615 label/project ponytail 不受影响(R3#2)。
- **Claude-only 缓停**:禁用 Claude ponytail marketplace plugin → 仅 Claude D session readiness=false 如实记 unavailable;**codex-tmux 注入纯文本 ruleset、readiness 恒 ready,不受此阀影响**。只停 D 而保 A/B/C 分流 = 需要代码回退/重部署,无现成热开关(不加新 flag 的诚实代价,明示)。
- 生效方式:merge + Bridge 重启;in-flight 不追改。
- %3→%4 存量未 stamp issue 重排:接受(sticky 保护存量)。

## 4. 不做(scope 红线)

- 不动 ponytail 插件本体 / ruleset 注入机制;不扩 core/claude-runner 三值 assembly 类型;
- 不做终局分析报告;不为 agy/kimi 开 ponytail 通路;
- 不新增 feature flag / 持久化列;retry 只补 ponytail frozen 一条线,不动其它 retry 语义。

## 5. Design review 台账

- R1(Codex,xhigh):CHANGES REQUESTED,6 条全采纳 —— #1 arm 槽位进纯 ladder + unreadable fail-closed;#2 assembly seam 统一 baseArm + barrel 重导出 + start-e2e;#3 retry frozen 补接线(Task 3b);#4 design_compare 通用化 + eligibility + epoch + self-test;#5 运维承诺改诚实(Claude-only);#6 边界行为测试落地。
- R2(Codex,xhigh):CHANGES REQUESTED,5 条全采纳 —— #1 HIGH:reresolve 传显式 start_signal,labelStatus 如实来自本次刷新(刷新失败=unreadable,stored labels 不冒充);#2 HIGH:frozen `source:arm` 绑定最终 mode=D,kill 后 retry 不得再出 `on:arm`;#3 `--since` 强制 + `--allow-pre-rollout` 逃生;#4 CI step 显式注册进 `ci.yml`;#5 event-route / DirectEventSink / StateStore D 用例具名落 Task 4。
- R3(Codex,xhigh):CHANGES REQUESTED,2 条全采纳 —— #1 HIGH:retry 数据合同定型 `ponytailRetry: { frozen?, freshSignal }` 全链新增(`RetryRequest` 现无 ponytail 字段),Blueprint 在最终 mode 处三选一,断言落最终 envelope/adapter 行为,补「refresh 成功且无 labels → on:arm」用例;#2:kill 合同精确化 —— kill 停的是 arm-derived ponytail(`on:arm`),FLY-615 label/project 信号照常(`on:label`/`on:project` 合法)。
- **R4(Codex,xhigh):APPROVED** —— 零阻塞;实施提醒:`ponytailRetry` 保持 retry 专用 carrier,最终 mode 判断不前移到 actions/RunDispatcher。
