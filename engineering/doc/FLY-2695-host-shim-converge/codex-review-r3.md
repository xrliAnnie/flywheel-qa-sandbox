# Design Review — plan.md (Round 3)

Date: 2026-09-24
Author: Codex
Status: APPROVED

## Summary
已重读磁盘上的计划并确认 blob 为 `314f715de3e250d779b93626706745ed5bdc6cf6`，本轮 R2 的三项阻断和一项 advisory 均已关闭，计划可以进入实施。当前 HEAD `3c421a62a9a003d167351e7ac308f47ccbd88ec1` 相对请求中的 `90b6d7c48` 仅更新 progress，所审计划、运行时源码及测试未变。本结论是设计就绪批准；实际回归测试、C19 夹具红/绿记录及④(B)实机证据仍按计划在实施阶段取得。

## What's Good (Keep)

以下 `plan.md` 均指 `engineering/doc/FLY-2695-host-shim-converge/plan.md` 的上述固定 blob。

- **R2#1 关闭：形态判断与 C19 现在对应同一个竞态。** `plan.md:159-170` 先接受文件/链接，最后检查缺席；对正常文件或链接的并发删除，不再由一次过早的存在性观察进入 unsupported。目录等不支持的形态仍被拒绝，删除证明仍由 `strict_discard` 承担。C19 明确在形态谓词之间注入删除，并要求旧顺序跑红、新顺序跑绿（`:222-225`）。**[verified by executing]** 使用两版原计划循环及真实 `strict_discard` 函数、以 mock 谓词/rm 控制交错：同一注入下 R2 为 `rc=1, dst=0, marker=1` 并发出 `retired-shape-unsupported`；R3 为 `rc=0, dst=0, marker=0`，且注入确实发生。
- **R2#2 关闭：C16b 的故障不再被前面的 managed loop 修好。** 权限故障移到 `$ST/state` 后，`record_adoption` 无法穿过该父目录去执行对子目录的 `chmod 700`（`plan.md:219`；`scripts/converge-flywheel-bin.sh:164-175`）。用例保留失败 rc、无成功通知及恢复后精确删除的断言，并将其他名字的 baseline 失败告警与目标 retirement 告警分开计数。**[verified by reading code]**；本轮未执行真实 chmod 故障夹具。
- **R2#3 关闭：④(B) 现在能验证所要求的路径边界。** fixture 根明确排除 `$TMPDIR`、`/private/tmp` 和业务 writable roots；同一 Codex 回合先做 state/bin 写入负对照，再执行 shim status 正对照，并从工具事件核对结果（`plan.md:281-299`）。版本、有效权限配置、规范化路径、shim sha 与 HEAD 均需留档，且池不可用时④保持未验证，A 不替代 B（`:273`）。**[verified by reading code / plan]** 这是可执行的验收设计，尚不是已取得的实机结果。
- **R2 advisory 关闭：工具命令固定了目标解析输入。** `env -u FLYWHEEL_DIR` 清除优先级更高的继承值，显式 `FLYWHEEL_HOST_CONFIG` 指向 fixture 的 host.json，后者指向已 build 的待审 worktree（`plan.md:285,293`；`scripts/lib/host-config.sh:59-60,104-106`）。
- **此前已关闭的合同保持关闭。** 首次采纳资格提前及并发 marker 成功回退、C9d 的 6→7、交集自检先于写入、bin/marker 的严格删除、S1 显式环境、兄弟夹具先跑红、跨版本回滚等待旧写进程退出均保留。FILES 两行合同、packaged S7 零告警和 T6 范围边界未被本轮修订改变。

本轮共执行 **18 项内存分支检查，全部通过预期断言**，涵盖上述旧红/新绿、普通文件/链接/悬空链接的删除时序、目录拒绝、缺席静默、marker 删除不可证与恢复路径。所有回放进程 exit 0、无 shell 错误；被测逻辑的预期失败 rc 单独断言。回放未写文件，不替代实际双进程或文件权限集成测试；本轮未运行 build、完整 shell suites、账号池探测、真实 Codex 业务回合或生产收敛。

## Issues & Recommendations (blocking)

无。R2 三项阻断均已关闭；未发现本轮修订引入的新阻断。

## Advisory (non-blocking)

1. `plan.md:194` 的解释文字“三者皆假只可能因为它已消失 ⇒ ! -e 为真”存在笔误。可改为：“若 -f 与 -L 均为假且目标已经消失，则 ! -e 为真；三个条件均为假才是仍存在的不支持形态。”`:165` 的可执行规格正确，本条不影响批准，也不需要为此另开评审轮次。

## Verdict
APPROVED — ready to implement


---

## 批准后差异(design 节点自记)

Codex R3 批准的 plan blob 为 `314f715de3e250d779b93626706745ed5bdc6cf6`。批准后仅按 R3 advisory 1 改了一句解释性文字(§4.2 不变量「并发幂等」条,把「三者皆假只可能因为它已消失」改为 Codex 建议的准确表述),不含任何规格变更;R3 明言此项不需另开评审轮次。修改后的 blob 见提交 3c421a62a 的 plan.md。
