# Design Review — plan.md (Round 1)
Date: 2026-08-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

31 条范围推导、registry 默认值与主要读点方向整体正确，`lead_dry_run` 退出本批也有真实生产 setter 证据。但计划对 `roundtable_thread_autocontinue` 的 `_EFFECTIVE` 链作了错误等价化，照写执行会改变无 roundtable parent 的运行时行为；Chrome manifest 链、writer preflight、完删证明和 commit 顺序也还没有闭合，因此尚不能进入实现。

## What's Good (Keep)

- 上游 §3 的 46 条减去 13 条待查、`qa_auto`、`lead_dry_run` 后正好是 31 条；实查台账无缺项、无多项、无重复。
- 31 个 registry row 均存在，`default` 与台账方向一致；布尔读点的 `!== "0"` / `=== "1"` / shell `true` 形态及 3 个数值 sanitizer 的回落值也与计划一致。
- 生产 `~/.flywheel/.env` 当前未出现这 31 个 env；15 个现有 Lead manifest 的 `chromeEnabled` 当前均为 `false`。这些是有价值的 implementation-time preflight 基线。
- `lead_dry_run` 的退出判断正确：`scripts/verify-anna-isolation.sh:122` 与 `scripts/lib/buddy-captain-preview.sh:148` 都会在生产工具路径主动设为 `1`，删除会把预演变成真实启动。
- 复用 `RETIRED_FLAGS`、不新造 watcher/报警器的方向符合既有 FLY-1560/1674/1466 模式；逐条 PR value+reason 与发现反向值即退出 E3 的门也应保留。

## Issues & Recommendations

1. **[HIGH] `_EFFECTIVE` 不只是 raw flag 的别名，不能整链删除或把 consumer 固化为 `true`。** 计划 §4.3 称“固化开 ⇒ producer 恒发 `1`、consumer 恒真”，但真实 resolver 是“存在可解析 parent **且** raw flag 未关”：`codex-lead-runtime.ts:648-668` 只在 `parentChannelId` 存在时创建 `replyInThread`，`codex-lead-tui-home.sh:117-127` 同样先解析 parent；producer 在 `codex-lead-runtime.ts:1436-1438` 仍按该有效状态条件发送。`gateway/gateway-main.ts:201-204`（计划漏列的 consumer）在 marker 缺席时必须保持 `false`，现有 `gateway-main.test.ts:46-59` 与 `codex-lead-tui-home.test.sh:229-235` 明确钉住“无 parent ⇒ false/无 marker”。按计划恒真会让没有 roundtable 配置的 gateway/lead-actions 进入 auto-continue fail-soft 策略，违反零行为变化。**建议：**只删除 raw `FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE` 判断；在 runtime/TUI resolver 中把“flag 未关”焊成 true，但保留 parent-resolvability 条件、`FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE` transport、`NON_FLAG_ALLOWLIST` 行及 producer/consumer。把 `mcp-config.ts:158` 正确标成 producer，并把 `gateway-main.ts`、gateway/config/mcp-config 与 TUI 的 parent/no-parent 用例纳入实施台账。

2. **[HIGH] 当前值硬门仍错误地把“.env 未设”当成充分条件，writer/setter 核验必须前置且逐条化。** 计划 §3 的通用理由写成“.env 未设 ⇒ 当前生效值=内联缺省”，而本计划自己已用 `lead_dry_run` 证明调用方注入可以推翻这个推理。当前 31 条中也已有同向 writer/transport（例如 `qa-room.sh` 注入 auto-continue、manifest→`lead-body.sh` 注入 Chrome）；§4.1 第 6 步在塌缩后才说“命中就删 setter”，若实现窗口新增反向或动态 writer，会直接删掉行为而不是触发 E3。**建议：**把 repo-wide writer/forwarder/manifest-field inventory 放到每条读点塌缩之前，分类为无 writer、同向常量 writer、动态/反向 writer；最后一类立即退出 E3。PR 的逐条理由也应写“所有生产 writer 的值/无 writer”而不只写 `.env` 未设，并在实现节点重新跑这一 inventory。

3. **[MEDIUM] `lead_chrome_enabled` 的“整链删”遗漏了 env 名 sweep 捕获不到的 manifest 配置面。** 除计划列出的三处外，`scripts/materialize-lead-manifests.sh:87-93` 仍生成 `chromeEnabled:false`，`scripts/flywheel-fleet.sh:473-483` 把它纳入 launch-affecting CAS projection，`scripts/test-deploy.sh:1379-1402` 从项目配置读取并写回 manifest；相关契约还在 `materialize-lead-manifests.test.sh`、`flywheel-fleet.test.sh`、`fly1663-lead-v2-runtime.test.sh`、`restart-env-propagation.test.sh`。按计划只 grep env 名/registry snake_case 会留下一个看似可配、实际永远无效的 `chromeEnabled`。**建议：**把 `chromeEnabled`、`CHROME_ENABLED` 加入该条专属 sweep，明确删除 repo 内 manifest producer/projection/QA fixture 与相关测试；已部署的 15 个 false 字段可说明为读点删除后的兼容残留，不必原地改写。

4. **[MEDIUM] drift guard 的证明范围被高估，定向测试清单也漏了直接受影响套件。** 守卫只扫描四个 `packages/*/src`、只读非测试 `.ts`；对注入式 `env.X` 只匹配布尔比较（`feature-flags-drift.test.ts:23-28,35-73`），所以 `workflow-ship-ready.ts` 的数值 `env.FLYWHEEL_SHIP_READY_REMIND_MS` 即使漏删也不会被它发现，更不覆盖 shell/bin、camelCase manifest 字段或 QA 脚本。计划 §4.2 的“任何漏删的 TS 读点都会红”和 §5 的“shell 侧完删”都不准确。**建议：**把既有 drift test 描述为布尔 TS 辅助守卫；PR 必须附对 31 个 raw env、31 个 registry key 及专属别名的全仓 live-code 零命中结果（历史 doc 与 tombstone 例外显式列出）。定向集至少补 `gateway-main.test.ts`、`qa-room-env.test.sh`、`test-deploy-generalized.test.sh`、`quota-monitor*.test.ts`、`claude-profile.test.ts`、`boot-sha-check.test.ts`、`bridge-event-loop-guard.test.ts`、`auto-qa-effects.test.ts`、`residue-harvest.test.ts`、Chrome manifest/fleet tests，以及直接引用 `lead_chrome_enabled` 的 `feature-flags-resolve.test.ts`；再加一个表驱动断言证明 31 条均已从 registry 消失并进入 FLY-1806 tombstone 集。

5. **[MEDIUM] commit 分组与 registry/tombstone 顺序互相矛盾，rebase 风险描述已过期。** §6 的 G1 `#1-10` 与 G4 `#4,5` 重复；更重要的是，把所有 registry/tombstone 留到 G7 会使 G1-G6 删除读点后触发 drift guard 的 reverse check（registry row 声称的 readSite 已无 env 名），中间 commit 不可独立验证，这也与 §4.1 的逐条同构顺序冲突。另 PR #695（commit `fa9fd4b06`）已是当前 HEAD 的祖先，不再是“若它先合”的未来冲突。**建议：**给 31 条建立唯一、不重叠的 group assignment，并在每个 group commit 同交代码塌缩、行为测试、registry row、tombstone 与 registry/truth 测试；G7 只做最终机械 sweep/文档。删除过期的 #695 rebase 条件，改为说明当前 baseline 已包含其幸存者标记。

## Verdict

CHANGES REQUESTED — address items above
