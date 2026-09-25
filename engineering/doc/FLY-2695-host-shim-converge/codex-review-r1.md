# Design Review — plan.md (Round 1)

Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary
本轮核对了计划 blob `93cac2defd054844850154abdc3dc5156cf2a083` 与评审起始 checkout `8caeb7428cd76c61dcb1b1d1c8c2c6dad0978119` 的源码和相关测试；L1 shim、packaged 排除及 forward rollback 的总体设计可沿用现有架构实现。实施前需要补齐并发转移、marker 删除证明、既有测试断言和 QA ④(B) 的可执行验收合同。上游 §14 的六项修订没有改变 S2，本轮不重开已裁定偏差，也不涉及 S3/S4/M0/T1–T6。

## What's Good (Keep)

- shim 保持 cwd、用 `exec node ... "$@"` 透传参数和退出码，符合真实 CLI 的 workspace 语义；≥1024 B 与配置失败 78 的要求有源码依据。见 `packages/raya-cos/src/cli.ts:76-83,153-175,212-225`、`scripts/lib/script-sanity.sh:24-40`、`scripts/lib/host-config.sh:104-106,145-148`。
- monorepo 的原有 `FILES=` 行末追加、packaged 行不动、另用 `RETIRED_FILES`，符合包装测试的两行和子串合同。本轮在内存中应用该追加并执行等价匹配，结果通过；没有修改脚本。见 `scripts/__tests__/flywheel-lead-packaging.test.sh:50-63`。
- C15 预置旧 shim 和 marker，再验证删除、保留未知文件及二次幂等，落实了上游 §6.2 的非空阴性测试；不存在 retired 项时保持静默，也兼容 `packaged-seams.test.sh:385-400` 的 S7 零告警要求。
- 复用 `strict_discard`、共享累计 `rc`，并让删除循环位于全局写入守卫之后、symlink lane 守卫之外，方向正确。forward rollback 保留框架再移动名字，符合上游 `plan.md:692-712`；旧 Raya wrapper 留给 T6。
- 三个兄弟夹具先因新增源缺失跑红、再补枚举的顺序合理；新增 shell suite 的 CI 登记位置确实在该 job 的 build 之后。QA ①②③⑤均有直接测试映射，③的 schemaVersion 更正符合真实输出；④明确区分策略复演与真实 Codex 回合的证明范围。

## Issues & Recommendations (blocking)

1. **[P1] 两个正常 converge 重叠时，首次采纳和 retirement 都可能被误判为故障。**

   首次采纳：A、B 都读到 shim 缺失；A 安装并写 marker；B 随后完成安装，在现有 `:251` 才检查 marker，于是进入普通 `repaired` severe 告警分支。只把名字加入白名单不能兑现计划 `:91,242` 的首次部署静默承诺。retirement：B 的外层 `-e` 已成功，A 此时删掉文件，B 的内层 `-L/-f` 都失败，便进入 `retired-shape-unsupported; rc=1`，尽管目标已正确消失。

   **影响：**前者会产生 founder 首次部署误报；后者会通过既有 pre-kickstart 合同拒绝整波 Lead 重启。并发不是假设出来的新使用方式：每个 Claude Lead 启动都独立调用 converger，没有共享的 converge 锁。

   **建议：**在计划中明确并发下的幂等语义。首次采纳资格应在该文件的检查/修复开始前确定，避免被另一进程刚写出的 marker 改成“历史漂移”；对并发已删除的目标应验证消失并成功返回，不能落入 unsupported-shape。补两个有确定同步点的并发用例，断言首次采纳零告警、并发 retirement 两次 rc 均为 0，且真实后续漂移仍告警；不必因此引入全局锁或新状态机。

   **证据：**计划 `engineering/doc/FLY-2695-host-shim-converge/plan.md:91,124-133,160-164,242`；`scripts/converge-flywheel-bin.sh:215-216,249-264`；`packages/teamlead/scripts/claude-lead.sh:1467-1481,1543-1546`；`scripts/restart-services.sh:3297-3303`。**[verified by executing]** 本轮直接提取现有安装后分支和计划删除循环，以 mock 依赖控制交错、无文件写入地回放：分别得到 `raya-cos.sh|repaired|aaaaaaaaaaaa` 和 `retired-shape-unsupported / converge_rc=1`；回放进程均 exit 0。这是分支反例，不是完整并发集成测试。

2. **[P2] marker 的存在性判断绕过了“不可证明即失败”的删除合同。**

   `if [ -e "$marker" ] || [ -L "$marker" ]` 不能区分“不存在”和“父目录不可遍历”。例如 marker 原本存在，`converge-adoptions` 丢失 search 权限，而 bin 仍可访问：shim 能删除，marker 检查的两个谓词都为假，`strict_discard "$marker"` 根本不会执行。managed loop 对 marker 写入失败只告警、不置 `rc=1`，因此整轮可以返回 0，留下上游要求必须清除的 marker。

   **建议：**不要把 `-e/-L` 的双假当作删除成功证据；在精确目标范围内，复用 `strict_discard` 证明 marker 已消失（包括表面上“不存在”的分支），或显式区分 ENOENT 与无法检查。保持真正不存在时零日志零告警，并补“marker 父目录不可遍历 → rc=1；恢复权限后重跑清除”的用例。bin 目标的缺席分支也应遵循同一原则。

   **证据：**计划 `plan.md:124,136-146,163,214`；`scripts/converge-flywheel-bin.sh:120-132,226-234`；`scripts/__tests__/converge-flywheel-bin.test.sh:259-275`；上游 `engineering/doc/FLY-2680-raya-merge-plan/plan.md:255-257,698-709`。**[verified by reading code]** 权限错误会被存在性谓词折叠；**[verified by executing]** 对原计划循环模拟该返回值，输出只含 shim 的 `DISCARD` 与成功通知，没有 marker 的 `DISCARD`，`converge_rc=0`。未运行真实 chmod 故障夹具。

3. **[P2] 测试改动清单遗漏 C9d 的确定性计数变化。**

   C9d 故意把 adoption 目录变成普通文件，断言恰好 6 条 `adoption baseline FAILED`。按计划同时增加 shim 源、稳态副本和首次采纳白名单后，健康的 `raya-cos.sh` 也会尝试记录 marker 并失败，结果必然是 **7 条**；只改生成枚举和 `COPY_FILES`，原套件仍会红。

   **建议：**在 §2/§5.1 的施工清单中明确更新 C9d：断言 7 条，并确认新增一条属于 `raya-cos.sh`；继续保留 rc=0 和运行时字节健康的既有合同。将它与三个兄弟夹具一起纳入红后再修的记录，不要放宽成任意数量告警。

   **证据：**计划 `plan.md:27,91,166,183-186`；`scripts/__tests__/converge-flywheel-bin.test.sh:259-275`，特别是 `:273` 的 `-eq 6`；`scripts/converge-flywheel-bin.sh:153-155,226-234`。**[verified by reading code]**；本轮内存枚举也确认白名单从 6 名增加到 7 名，未声称已执行修改后的整套测试。

4. **[P2] QA ④(B) 需要明确待测产物、准备顺序和工具执行证据，不能只验模型最终回显。**

   计划 `:212` 唯一写出的 B 命令让模型调用真实 `~/.flywheel/bin/raya-cos.sh`，但安装动作直到 `:221` 的 A2-deploy 才出现；上游又要求这条核心风险先在隔离夹具中验证。当前没有说明部署前如何准备该入口、如何绑定本次 PR 的 shim，也没有要求确认回显来自成功的 shell 执行。仅匹配最终 JSON，可以在模型没有调用工具时通过，无法证明 A 层未覆盖的 PATH/env/approval 链路。

   **建议：**给 B 补一个简短、可复现的配方：先在隔离 state/bin 安装本次待审 shim（记录 sha、555；放在业务工作区及其 writable roots 之外），配置实际 host-config/dist 解析，再用隔离 CODEX_HOME 和明确的 full-access 安全参数执行该绝对入口；真实宿主路径检查留在 A2-deploy。临时目录若不是 git 仓，要准备合适的工作区或使用 CLI 支持的 `--skip-git-repo-check`。记录二进制版本、实际 sandbox/approval/network/writable roots 配置及真实工具调用事件，确认命令、cwd、工具 exit code=0 和原始 stdout 满足③；不能仅凭 agent 最后一条回复。B 未执行/池不可用时，④继续标为未验证并交 Lead，不以 A 自动替代。

   **证据：**计划 `plan.md:32,209-212,220-221`；上游 `engineering/doc/FLY-2680-raya-merge-plan/plan.md:276-281,883,924-925`；`packages/teamlead/scripts/codex-lead-tui-home.sh:576-580,683-695`；`packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:408-414`。**[verified by reading code]** full-access 合同还包含 `approval_policy="never"`、network ON、单一业务 writable root；**[verified by executing]** 本机 `codex exec --help`（exit 0，另有 PATH alias 权限警告）确认支持 `--skip-git-repo-check` 和 JSONL 事件输出。未发起 Codex 业务回合，未探测账号池。

## Advisory (non-blocking)

1. **明确自检的放置点并修正少量行号。** §4.2 把含 `RETIRED_FILES` 赋值的整段放在 managed loop 后面，§4.2 不变量却要求“启动自检、零写”。建议明确：清单赋值和交集检查在 `rc=0; for f in $FILES` 前，删除循环在其后，写操作仍受现有 temp/worktree 守卫约束。当前主循环实际结束于 `scripts/converge-flywheel-bin.sh:272`，不是 `:283`；测试结果打印在 `converge-flywheel-bin.test.sh:328`，新增测试应在该行之前。C17 应让一个 managed 文件确实待修，再证明自检没有修它；仅对稳态 bin 做前后 `ls -l` 比较不能证明没有写。

2. **统一文字与图示，不增加机制。** `plan.md:80` 的“不读 env 之外的任何配置”与 `host_config_load` 读取 host.json 矛盾，宜改成“只通过 host-config 读取宿主配置，不 source .env”。`:104` 图示在 marker 删除成功后才发成功通知，`:127-137` 代码则先通知再清 marker，二者选定一种并写清成功通知覆盖的对象；变更面还写 C13–C16，而正文已有 C17。

3. **保持 shim 测试环境可控。** S1 只 unset `FLYWHEEL_DIR` 和 `FLYWHEEL_STATE_DIR`，还应隔离 `FLYWHEEL_HOST_CONFIG` 及 source guard 等宿主输入，否则假 HOME 仍可能被继承配置覆盖（`scripts/lib/host-config.sh:26-27,59-60`）。环境构造可复用 `packaged-seams.test.sh:359-363` 的显式环境做法，不需要扩大生产配置接口。

4. **写明跨版本回滚的操作前提。** 同一版本两个 retirement 进程应按阻断项 1 幂等；旧 managed 版本与新 retired 版本同时写同一个 state/bin，则各自的清单交集检查也无法阻止对方重新安装。forward rollback 的“部署后验证消失”应在旧写入进程退出后执行，避免把瞬时缺席当成稳态；本单无需为此引入跨版本协调框架。

本轮以源码静态审查为主，只执行了无文件写入的分支回放、字面合同检查和 CLI help；没有运行 build、完整 shell suites、真实沙箱业务回合或生产收敛。本轮未修改任何仓库文件。交付期间另有并行提交将 HEAD 推进到 `99a3654cd097a635e2b92b608ef22be5c89ed26c`（图/HTML/progress），随后工作区的 plan.md 也出现未提交修改。本反馈仅评审请求指定的已提交 blob `93cac2defd054844850154abdc3dc5156cf2a083`；后续计划修改不在本轮 verdict 内。已复核本轮引用的运行时源码和测试与评审起始版本一致。

## Verdict
CHANGES REQUESTED — address blocking items above
