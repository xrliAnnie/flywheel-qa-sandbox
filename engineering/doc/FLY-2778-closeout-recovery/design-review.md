# FLY-2778 收尾恢复 — 设计审查交接
Issue: FLY-2778 (https://linear.app/geoforge3d/issue/FLY-2778/收尾清理失效-ship-之后-worktree-没被删thread-没归档land-收尾-issue-closeout-incomplete)
日期: 2026-09-26
基于: plan.md

第三轮有效 `reviewVerdict=APPROVED`，原始 reviewerVerdict 同为 APPROVED。gate `ff61f960-cd76-436b-b827-99c74f8f42ad`，request `1dfddf70-eecd-4411-ad1d-e4d770d85f4c`。服务端 approved proof `b022a5ff-ef6b-487b-bced-7a18e9ed03a5` 绑定计划 blob `ab06ff9db83ddba71f4cf70f84b6a2c16a5da251`、commit `07e830a5e52e963881db479e620fb5e216c44136`；当前计划逐字节一致。证据见 evidence/review-r3.json。plan.md 中“待有效 review”是冻结版本当时的状态，最新审查状态以本收据为准，不改已批准 blob。

第二轮 HIGH 的 stock cwd 误杀风险已获第三轮明确确认修复。下列为非阻塞 advisories，转 Lead 选择落实；本文件不把建议冒充新的批准设计，也不宣称已解决。

| findingKey | 实施前需要注意的具体问题 |
|---|---|
| stock-reclose-window-teardown-signal | MERGED held/partial 的 physical pass 在目录检查前可能关闭 tmux 窗口，向 pane 进程发 SIGHUP。需明确存量模式排除残留窗口，或严格限定受信纯 viewer；补 founder shell 阴性测试，保持 no-signal 承诺。 |
| never-started-branch-liveness-source-undefined | 2919 对无 binding 的普通执行仍 unknown；需明确可信 never-started 分支的来源事实、closed launch、owner/spawn_inflight/socket/lock 闭包以及任何 execution-id census 的唯一归属，不能默默恢复第二套评估或宣称零回收已解决问题。 |
| apply-claim-scope-not-in-schema | 现有 apply claim 按 root_uuid/approved_hash 无条件 upsert；目录回收需明确独立 scope/key 与 CAS 状态转换，防止覆盖或重放整单 founder apply epoch。 |

设计阶段只做源码/只读数据审计与 HTML 静态、脚本行为检查。未实施，未运行真实 ship、生产清理或完整测试。两张 Mermaid 图已按规定本地尝试并重试，均因 Chromium Permission denied (1100) 无法渲染；源码和明确待渲染标记保留。Lead 已允许带文字流程发布，不能据此声称浏览器视觉 QA 通过。
