# Design Review — plan.md (Round 2)
Date: 2026-08-17 / Author: Codex / Status: CHANGES REQUESTED

## Summary

Round 2 已把 Round 1 的主体问题认真落进实际文档：cmux 的真实调用图已纠正，Wave B 的 B-1 已覆盖真实 runtime resolver，D-2 改成了“审计沉默不能证明是否批准”，workflow 消费者与历史 run 合同、founder-UX 全手术面、AutoContinue 四模块以及两条显式 exemption object 也都补齐。Wave A / Wave B 的授权分割与 D-3 排除仍然正确。

但当前计划仍不能进入实现。一个 blocker 是 A-1/B-1 只改 `registry.default`、没有同步 `polarity`；而中央展示 resolver、flag panel 写入和 management writer 都以 `polarity` 决定 absent 值与 raw 写法，因此这两个“先改值”commit 仍会让 registry 控制面和 runtime 背离，甚至让 UI 无法写出计划声称保留的 opt-out。另一个高风险缺口是 cmux 已选择“删除观测行为”，但 RED 同时要求“得到 A0B1”与“不再产告警”，和删除 latch 本身相互矛盾；跨 shell/TS 的 `cmux_flag_state` 公共 kind 族也没有完整 disposition。

本轮通过当前源码、测试和只读生产数据复核：生产五个 workflow env 仍为 `1`，`FLYWHEEL_CMUX_LINKED_VIEW=0`，D-3 的 `FLYWHEEL_MAILBOX_DISCORD=1` 未动；active/held engine run 当前均 enrolled 且 epoch=1。`git diff --check` 通过。本轮是设计复审，没有执行实现测试。

## What's Good (Keep)

- 保留修正后的 cmux 调用图：`linked_view_enabled()` 只喂 `check_cmux_flag_state()`，view/WAL/receipt/lifecycle 活链一行不动。research.md §2.4 也明确留下了初稿被推翻的纠错记录。
- 保留 B-1/B-2 两阶段：B-1 先把五个 TS resolver 及 claims-read 的 argsEnv/live-`.env`/processEnv 三层改成 absent=ON、显式 `0`=OFF；B-2 才让 `0` inert。这已经修复 Round 1 最主要的 runtime 顺序问题。
- 保留 D-2 的授权门：Wave B 在 founder 回答 A 前零代码，回答 B 则废弃 Wave B、重新立项。卡片对批准证据的主句已改为“无可援引出处，沉默证明不了两边”，方向正确。
- 保留 Wave B 的完整消费者清单和历史合同矩阵，尤其是 `merge-ship-gate.ts`、`external-merge-reconcile.ts`、DB 直构 epoch-0 fixture、unenrolled fail-closed 负例，以及开工前 active/held census。
- founder-UX 手术面现已覆盖公开 CLI、stage fail-close、retry/successor 传播、route mount 和三列 StateStore wiring；三条 ADD COLUMN migration 保留，避免破坏旧库重放。合法及畸形 stale config 的 inert 测试也值得保留。
- AutoContinue 现在按“机制不存在”删除四个模块、全部 wiring/test 和唯一 companion knob ledger；runner-state 残留不做破坏性清理，FLY-818②保持边界。
- 两条“搬”落成 `FLAG_EXEMPTIONS` 显式 object，并保留 17 项 `QA_AND_INVOCATION_SEAMS` 不变；四联守卫正确表达了 registry → exemption 的账目迁移。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[BLOCKER] A-1/B-1 没有翻 `polarity`；中央 resolver 和写入面仍会与新 runtime 语义相反。**

   **Why it matters:** plan.md:81 只把 `cmux_linked_view.default` 从 `true` 改成 `false`，但当前 registry 行仍是 `polarity: "default_on"`；plan.md:105 只把五个 workflow `default` 改成 `true`，但五行仍是 `polarity: "opt_in"`。这不是纯元数据问题：`packages/config/src/feature-flags/resolve.ts:143` 用 `polarity` 计算 effective，`packages/teamlead/src/bridge/flag-routes.ts:75-96` 和 `management-existing-writers.ts:867-880` 也用它决定“默认值删行 / 非默认值写 0 或 1”。

   因此 A-1 后 runtime absent/非法值都已 OFF，但 resolver 仍显示 ON；更严重的是 UI 的“打开”会按 default-on 规则删行，删行在新 runtime 中反而是 OFF。B-1 后则相反：runtime absent=ON，但 resolver 仍显示 OFF；UI 的“关闭”会按 opt-in 规则删行，删行在新 runtime 中仍是 ON，计划声称保留的显式 `=0` opt-out 无法由控制面正确写出。`feature-flags-direct-toggle.test.ts` 还逐条断言 absent effective 等于 `spec.default`，所以 B-1 按当前计划也不能独立全绿。这直接违反 plan.md:19 的“任何 commit 上 registry 与 runtime 不背离”。

   **Suggested fix:** A-1 同 commit 把 `cmux_linked_view` 改为 `polarity: "opt_in"`、`default:false`；B-1 同 commit 把五个 workflow 行改为 `polarity:"default_on"`、`default:true`。为 A-1/B-1 加 resolver + flag-stage/raw-write 测试，分别锁定 absent、`0`、`1`、非法值及 on/off 写入结果。同步改掉所有在该中间 commit 中已经说谎的文本，而不只两条 registry 条款：至少包括 cmux registry 描述及 sync 的 default-on 注释、`workflow_template_dispatch`/`workflow_generalized_templates`/`workflow_claims_write` registry 描述、`workflow-claims.ts:113-128` 的 DEFAULT-OFF 注释、`ship-eligibility.ts:90` 的 default-off 注释，以及对应 exact-metadata tests。A-2/B-2 下一 commit 会删这些行，不构成让前一 commit 失真的理由。

2. **[HIGH] cmux 已选择删除观测族，但当前 RED oracle 不可能同时满足，跨层 kind 清单也不完整。**

   **Why it matters:** A-1 后注入 `FLYWHEEL_CMUX_LINKED_VIEW=1`，现有 `check_cmux_flag_state()` 会写 `A1B1|0` latch，且不会发 A0B1 告警。plan.md:83 的“仍得到 A0B1 结果 / 告警项不再产生”有两个问题：若 oracle 只是“无告警”，改前已经 GREEN；若 oracle 要求 A0B1，它改前确实 RED，但 A-2 又要删除整个观测项和 latch，改后不可能再“得到 A0B1”。这还没有形成可执行的 RED→GREEN 合同。

   同时，plan.md:82 只写了模糊的“`CMUX_FLAG_STATE` kind 文案(:6879)与对应测试”。当前 `CMUX_FLAG_STATE` 实际是 shell latch 路径变量(`flywheel-cmux-sync.sh:105`)，事件 kind 是 `cmux_flag_state`；该 kind 还进入了 `scripts/lead-alert.sh` 的 informational/合法 kind 集、`LeadAlertNotifier` union 与 informational 集、`kind-contract.ts`、`alert-kind-copy.ts`、`infra-event-router` 说明及多组测试。当前 B bit 固定为 1，观测族没有第二个真实 flag 可保留；“若还覆盖其他 flag”不是当前源码的 disposition。

   **Suggested fix:** 既然已决定有意删除观测行为，就把 RED 写成唯一明确 oracle：清空 latch，注入 `=1` 并启动真实 check seam，断言“不创建 `CMUX_FLAG_STATE` 文件且不发 `cmux_flag_state` 事件”；改前会因创建 `A1B1|0` 文件而 RED，A-2 删除 check 后才 GREEN。手术表逐项列出并删除 `CMUX_FLAG_STATE` 变量、`check_cmux_flag_state()` 与 watch 调用、shell alert kind、TS notifier/kind-contract/copy/router 面及其测试。若反而选择保留并固化 A0B1 latch，则不能再称为“删除观测项”，两种形状必须二选一。

3. **[HIGH] D-2 的纠正口径尚未贯穿 research evidence，且 census 文案把“采用量”写成了“每条历史 run 都依赖两个 gate”。**

   **Why it matters:** plan.md:17 明确说 PR 判词以 research.md §1 为底稿，但 research.md:18 仍把 `workflow_generalized_templates` 写成“无批准记录”，没有带上已接受的限定“无可援引批准出处；审计路径不记录这类批准，沉默证明不了两边”。这会在实现 PR 中重新引入 Round 1 已否定的断言。

   另外，plan.md:134 写 `{N} run / {M} claim 全部跑在这两个开关上`。本轮只读复核时 DB 已从文档的 312 漂到 313 个 run / 261 个 claim；313 个 run 的 snapshot 分布是 schema2=218、schema1=36、NULL=59。`workflow_generalized_templates` 只在 schema2 分支参与 block reason，因此总 run 数能证明采用规模，不能证明每一条历史 run 都依赖 generalized + claims_write 两个 gate。真正足以支持“现在关闭会停摆”的证据仍然成立：当前 5 个未退役 published template 全是 schema2，而 fresh dispatch 还串联 claims WRITE/READ。

   **Suggested fix:** 把 research.md:18-19 都统一成修正后的“无可援引出处 / audit blind”口径。D-2 卡改成两句不混因果的事实：“截至 timestamp，账本已有 N 个 workflow_run / M 个 claim；当前 5 个 published template 全为 schema2，fresh dispatch 需要 generalized + claims WRITE/READ，因此关掉会停止当前派工链。”在计划里钉住 relay census 的精确只读 SQL，至少包含总 run、snapshot schema 分布、claim 总数和 current published template schema；不要只写表名，以保证“重跑同一 census”可复现。

4. **[MEDIUM] 验收集合把“10 个删除 flag”“env tombstone”和 companion knob 混成了同一个数字。**

   **Why it matters:** 10 个真删 registry row 中，#7 `founder_ux_gate` 是 project config key，不是 env；因此真正的 flag env 只有 9 个。Round 2 又为 AutoContinue companion tuning env `FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS` 增加 tombstone，环境名总数恰好变成 10。plan.md:127/177 和 research.md:87 仍笼统写“10 条 env”，会让一个按数量写的集合守卫在“漏了 project config key、却数进 companion knob”时仍然通过。

   **Suggested fix:** 在计划中给守卫列出具名集合而不是只给总数：10 个删除 registry row；9 个退休 flag env；1 个退休 companion non-flag env；1 个删除的 project config key `founder_ux_gate.mode`（registry/config read/type/validator 零残留，StateStore migration 白名单除外）；2 个搬迁 exemption。`RETIRED_FLAGS` 继续只承担环境 tombstone，不把注释伪装成 config-key tombstone。

5. **[MEDIUM] AutoContinue 的“`autocontinue` 符号零命中”范围过宽，会撞到独立的 roundtable auto-continue 功能。**

   **Why it matters:** plan.md:68 若按字面做不可能零命中：`roundtableAutoContinue`、`ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE` 及 Codex Lead/Discord 相关测试是独立的 FLY-676/roundtable 活链，不属于 FLY-818①。一个泛化 `rg -i autocontinue` 守卫要么永久红，要么诱导实现者误删相邻机制，违反本单的 scope boundary。

   **Suggested fix:** 把 sweep 写成 exact inventory：四个文件名/模块名、`AutoContinueArmer`、FLY-818①专属 helper/export，以及 `FLYWHEEL_RUNNER_AUTOCONTINUE` / `FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS` 两个 env；显式列 `roundtableAutoContinue` 和 `FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE` 为不相关保留项。对 FLY-818②继续用其自己的测试证明 source diff 为零。

## Verdict

CHANGES REQUESTED

先修正 A-1/B-1 的 `polarity` 与控制面测试，再把 cmux 观测删除写成单一可执行的 RED→GREEN 合同；同时统一 D-2 research 口径与具名守卫集合。其余 Round 1 修复可保留，不需要重开已经闭合的架构决定。
