# FLY-2456 宿主偏差回填 — 实施记录
Issue: FLY-2456 (https://linear.app/geoforge3d/issue/FLY-2456)
日期: 2026-09-10
基于: plan.md; host-runs/driver/DEVIATIONS.md

范围是 Lead 返工 #5：提交宿主报告、修正 17 项路书/工具偏差。不改 pinned plan、packages、FLY-2352 代码或官方装房/重启/拆房原语。本节点没有执行真机演练。

产物 b5539a4d6：76 文件与 ~/.flywheel/qa-evidence/FLY-2456 原件逐字一致；Lead e0a04d0a 明确总报告在 r2，R2 复用 r1/precondition。按其字面秘密规则扫描为零。原始 ps、alerts、identity 和数据库证据不入库；比较文件中的原有路径和数字不重写。

代码 1d9075347、1a9a19c7e、523c99c47：#6/#7/#8/#12/#16 先见预期红再绿；另加 #9 空库/有行/坏库、#10 沙箱分支发布收养、#15 owner exhaustion/B3 skip/public report 的回归。路书各项位置见末尾 #1–#17 对照。Lead 414b4a59 明确 #9 的操作版只用 managed_snapshot、错误即停和 release；原 driver 不改。

验证回执（原始日志保留在 /tmp/fly2456-rework5-*）：

- pnpm lint：exit 0（保留仓库现有 warnings）。
- pnpm -r build：exit 0。
- pnpm test:packages:run：exit 1。TeamLead 926 文件、12452 测试通过、7 skipped，但 Vitest 有 1 个 unhandled onTaskUpdate timeout；绝不称全包绿。按 FLY-2492，完整门仍为新头 CI14/14。
- 全 FLY-2456 工具测试：508/509，唯一失败是未改 liveness 的 unknown vs alive，仅确认 unknown vs alive 症状；本 runner 独立 ps 命令被权限拒绝，但未证明这就是该用例成因。评审在其环境复现为并行负载下2s探针超时、单文件通过。该整套不称绿，也不把两种环境观察混为同一根因。
- 改动相关测试：129/129；公开报告补测27/27。
- /bin/bash 3 与 Homebrew Bash5 的路书测试各11/11；Python inline 比较8/8。
- CI 枚举：302 shell suites / 45 Node suites 分类通过；本轮没有新增 shell test 文件。
- 实际62命令块 scanner/dry-run通过，digest 9bed6c0e73d69e1a791e89da3a3aa0d43c4e5085ce18cb5f5416ca0708f3b317。

R1(main d6cda1fc) 0/2，R2(main⊕#1128 85d516e6) 0/2；修后 drift=0 仍 owner-before-commit 失败。这是 Lead 原始实测，历史 verdict 保留 fail，不由工具修正重新生成历史报告。F1–F5 与 unbounded-production-evidence-projection/FLY-2503 已追加 PR body。

接下来用 literal-last milestone 固定新审查头，普通 push 后 review 期间不推；新 review 和 CI14/14 后 complete --route needs_review --pr1150。409 park_wake 只向 Lead 报告，不 park、不原地 ask/retry。


第一轮新审 cfff7285 / 21555cf4 在3827fb8b8上 CHANGES_REQUESTED，唯一 HIGH 为 lead-proc-attribution-transient-outranks-production。Lead300233ea授权只修#7操作版，历史归档文件不动。新 scripts/lib/qa-fly-2456-lead-proc-attribution.py 将生产签名置于瞬态之前；仅精确瞬态/工具壳直接子进程可豁免，移除任意瞬态祖先继承。路书改调操作版，原 R1/R2 verdict 不复算。既有 CI Python 测试文件新增12测试中的4项，包括3种真实形状生产伤亡在旧版误报pass的RED与新GREEN、未知worker不能靠git祖先豁免、slot祖先链仍归slot、post-teardown added未知仅披露。

其余MEDIUM/LOW只披露：comm marker集合未绑定投影；scanDelta依赖rowid稳定；R1 B1 verdict仍要求replaced；liveness并行2s探针超时；整表指纹尚无比较消费者；manifest异常退出残锁。上述不是本轮硬门修复范围。
