# Design Review — plan.md (Round 2)

Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary
本轮重读磁盘上的计划，确认 blob 为 `df7be8bc49f41b0e7c7fc4990415e23ae7275e61`；评审开始时 HEAD 已到 `cc73ee7c9900a2efa41d7e724dece4579f04eaab`，相对请求中的 `bc509b58a` 仅更新 progress，计划及所涉运行时源码未变。R1 的主要修订和四项 advisory 均已落实，但 retirement 形态判断仍保留原竞态，C16b 的故障会被前面的 managed loop 修复，④(B) 的临时目录布局仍未证明执行位于沙箱写入范围之外的 shim。以下仅追踪这些修订的剩余缺口，不重开 L1、packaged 排除、forward rollback 或其他子单架构。

## What's Good (Keep)

| R1 条目 | Round 2 回验结论 | 当前计划证据 |
|---|---|---|
| 阻断 #1：并发 | **首次采纳部分关闭**：`adopt_pending` 在检查/修复前确定；安装后 marker 写入失败但已存在有效 marker 时静默成功；真实后续漂移仍告警。retirement 部分见本轮阻断 1。 | `plan.md:95-112,213-216` |
| 阻断 #2：删除证明 | **运行时方案关闭**：bin 与 marker 的缺席不再依靠 `-e/-L` 双假证明；正常/缺席路径均执行 `strict_discard`，marker 不可证时 rc=1 且不发成功通知。C16b 的夹具问题单列为本轮阻断 2。 | `plan.md:153-185,211` |
| 阻断 #3：C9d | **关闭**：明确 6→7，检查额外告警属于 raya-cos.sh，保留 rc=0 与字节健康，并要求先跑红。 | `plan.md:202-203` |
| 阻断 #4：④(B) | 本 PR 的 shim、部署前隔离安装、显式 sandbox 参数、工具事件证据及池不可用时不替代的合同均已补齐；入口所在目录的权限范围仍见本轮阻断 3。 | `plan.md:264,268-286` |
| Advisory 1 | **关闭**：清单/交集检查在 managed loop 前，删除在后；C17 用确实缺失的 managed 文件证明零写，行号已纠正。 | `plan.md:117-118,141-153,200,212` |
| Advisory 2 | **关闭**：host-config/.env 措辞、C13–C19 范围以及先清 marker 再发成功通知的图文顺序一致。 | `plan.md:29,82-84,127-131,171-178` |
| Advisory 3 | **关闭**：S1 使用显式 `env -i` 隔离宿主输入。 | `plan.md:225` |
| Advisory 4 | **关闭**：forward rollback 验证等待旧 managed 版本进程退出，不引入跨版本协调框架。 | `plan.md:193-196` |

`plan.md` 在本反馈中均指 `engineering/doc/FLY-2695-host-shim-converge/plan.md` 的上述固定 blob。既有 FILES 两行合同、全局写入守卫、累计 rc、packaged S7 零告警及 S2 范围保持原审结论。

## Issues & Recommendations (blocking)

1. **[P1，R1#1 未完全关闭] `-e && ! -f && ! -L` 仍存在同一个 retirement 竞态，C19 没有覆盖它。**

   `plan.md:157` 是三个依次执行的 shell 判断，并非一次原子观察：B 的 `-e` 返回真 → A 删除目标 → B 的 `! -f`、`! -L` 都返回真 → B 仍进入 `retired-shape-unsupported; rc=1`，且没有执行 `strict_discard`。把嵌套 if 改成 `&&` 没有消除这个交错；`plan.md:186` 的“绝不落进 unsupported-shape”尚不成立，仍可能经 `scripts/restart-services.sh:3297-3303` 拒绝整波 Lead kickstart。

   **C19 的问题：**`plan.md:214` 把删除放在 `rm()` 内，此时形态判断已经结束。这个交错在 R1 原循环也能成功，因为 R1 本来就使用 `strict_discard`；它不能检验这次修订是否修复 R1 的反例。

   **建议：**调整判断顺序，让正常文件/链接并发消失时不会由一次过早的 `-e` 决定 unsupported。例如针对这里两个 converger 只删除文件/链接的场景，先判 `! -f`、`! -L`，最后判 `-e`；继续保留目录/其他真实不支持形态的拒绝语义，不需要新锁。C19 的同步点须覆盖形态谓词之间的消失，并保留旧循环跑红、修订后跑绿的证据，不能只注入 rm 内的重复删除。

   **[verified by executing]** 本轮分别提取 R1、R2 的原删除循环，复用源码中的 `strict_discard`，用内存 mock 控制谓词和 rm：在形态检查中途删除，**R1、R2 均为 `rc=1, dst=0, marker=1`**，且发 `retired-shape-unsupported`；在 C19 指定的 rm 内删除，**两版均为 `rc=0, dst=0, marker=0`**。这些是确定性交错的分支回放，不是双进程集成测试。

2. **[P2，R1#2 的测试修订] C16b 的 chmod 000 会先被 managed loop 恢复，不能形成所写的故障。**

   `plan.md:211` 只把 `state/converge-adoptions` chmod 000。循环仍先处理其他首次采纳白名单名字；它们的 marker 因父目录不可遍历而被判未完成，随后调用 `record_adoption`。现有实现先 `mkdir -p "$ADOPTION_DIR"`，再 **`chmod 700 "$ADOPTION_DIR"`**，最后写 marker。对拥有该目录的普通测试用户，000 不妨碍其从可遍历的父目录把目录改回 700，因此 retirement 执行前该权限故障已经被修复；C16b 会得到成功删除，而不是预期的 `retired-marker-unproven`。

   **建议：**保留已修好的生产删除逻辑，仅调整故障夹具。可将不可遍历故障放在 `$ST/state` 这一父目录，使 `record_adoption` 无法到达并 chmod 子目录；或用 fixture-only rm 故障注入，在删除指定 marker 时返回失败。前者更直接保留本用例的 EACCES 语义。恢复原权限后仍应验证 marker 消失，并保留未恢复时 rc=1、无成功通知的断言。

   **证据：**`plan.md:104,118,211`；`scripts/converge-flywheel-bin.sh:159-175,226-234`；`scripts/__tests__/converge-flywheel-bin.test.sh:259-275` 说明 marker 记录失败本身并不设置失败 rc。**[verified by reading code]** 完整执行顺序会先尝试恢复 adoption 目录权限；另以 mock 命令回放原 `record_adoption` 控制流，确认经过 `mkdir -p → chmod 700 ADOPTION_DIR → 写 marker`，未执行真实 chmod 故障测试。

   **这是对我 R1 建议的更正：**上一轮建议该 chmod 故障时漏算了 managed loop 的权限修复，不能要求实施者照原夹具保留一个必然不成立的预期。

3. **[P2，R1#4 未完全关闭] ④(B) 的 shim 仍放在沙箱可写的临时根下。**

   `plan.md:270-275` 将全部内容放在 `T=$(mktemp -d)`，shim 位于 `$T/state/bin`，业务 cwd 位于 `$T/ws`。两者虽然是兄弟目录，但 workspace-write 的有效写入范围还包括 `$TMPDIR` 和 `/private/tmp`；本单 `research.md:81-87,108-110` 已记录并专门纠正过这个例外。仅设置 `writable_roots=["$T/ws"]` 不会取消临时目录写权限，mode 555 也不能把位于可写父目录下的文件变成沙箱外的入口。

   因此这次 B 仍只能证明执行临时可写根内的 shim，未兑现 R1#4 要求的“待测入口在业务工作区及其 writable roots 之外”，不能据此关闭宿主只读路径的实机验证缺口。

   **建议：**把隔离 fixture 根显式创建在 `$HOME` 下一个不属于 `$TMPDIR`、`/private/tmp`、业务工作区或任何额外 writable root 的专用目录，仍使用彼此分离的 state/bin、ws、CODEX_HOME；无需修改生产目录或增加配置机制。运行时记录规范化路径与实际有效写入范围，并在同一 B 沙箱中用该隔离 state 目录的写入负对照证明它不可写，再执行 shim 的 status 正对照。保留目前的 sha/555、工具执行事件和池不可用时标记未验证的约束。

   **证据：**`plan.md:270-285` 与 `engineering/doc/FLY-2695-host-shim-converge/research.md:81-87,108-110`；R1 反馈阻断 #4 的明确边界要求。**[verified by reading code / documented policy]** 本轮没有运行真实 Codex 沙箱或探测账号池，不把现有 A 层记录冒充 B 层证据。

## Advisory (non-blocking)

1. **④(B) 的目标解析建议也显式固定。** 配方只在工具命令中设置 `FLYWHEEL_STATE_DIR`，但 `host_config_load` 会优先使用继承的 `FLYWHEEL_HOST_CONFIG` 和 `FLYWHEEL_DIR`（`scripts/lib/host-config.sh:59-60,104-106`）。执行时显式给出本次 fixture 的 host.json 路径及已 build worktree 的 FLYWHEEL_DIR，或清除这些继承值，可避免同样的空 status JSON 实际来自另一份 dist；这属于配方的环境确定性，不要求新增生产接口。

原 R1 四项 advisory 均已关闭。本轮没有修改仓库文件，也未运行 build、完整 shell suites 或生产收敛。首版内存回放的 mock `[` 转发发生 shell 参数错误，已纠正并重跑；上文只采用重跑后无 stderr 的六个 retirement 回放和三个 adoption 回放（各进程 exit 0；被测 rc 如上单列），不把 mock 的初次错误列为产品缺陷。

## Verdict
CHANGES REQUESTED — address blocking items above
