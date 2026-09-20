# FLY-2749 设计续跑核验 — 调研
Issue: FLY-2749 (https://linear.app/geoforge3d/issue/FLY-2749/额度lead-成本-lead-会话占-fable-额度-92percent每个小事件都唤醒-lead每轮重读-50-60-万-token)
日期: 2026-09-20
基于: handoff.md、validation.md、plan.md

## 继承与当前权威

本次接续的代码头为 `f0c79efaf3fba347ef9aa5ff58c6d667c03ba8dd`，PR #1275 仍 OPEN。接续前 progress.md 是 implement 7/7，nextStep 为 CI evidence contract 修订后的精确 HEAD 复审与 CI。该实现状态保留；本记录及设计进度游标不代表实现、代码评审或 QA 已完成。

2026-09-20 的 `turn` 返回 design、epoch=11、run=`50898ad0-107e-45fa-8a85-0569b332a799`、activation=`activation:e9916077-f18b-4797-9955-7bcdde2fe01d:50898ad0-107e-45fa-8a85-0569b332a799:eng_design:1`。当前 inbox 无新指令。原设计问题 `a89021c5-8393-4d3c-b180-b2a2b908616d` 经当前 check 接口再次确认为 effective reviewVerdict=APPROVED；11 条 advisory 仍按 review-followups.md 保留，不重开设计、不宣称已修复。

当前 check 接口也确认后续 Lead 裁定 `28ec08bf-60cf-4315-9e8d-be2b78b78638`：`session_started` 保持 immediate，因为它提供交接所需的 issue 与新 execution id。该裁定及已继承实现优先于原 research.md/plan.md 对普通启动可静默的候选描述；不恢复该候选，不新增替代事件。复用 disposition-receipt 的既有裁定继续优先于原计划的新 relay 提案。

## 本次验证

- `verify-founder-html.mjs` 再次 PASS：9 个 section，pathname 隔离存储，存储失败处理，长评论分块，以及 clipboard 缺失/拒绝后的回退。仅为结构和控制器检查；浏览器视觉、托管 CSP 均未验证。两张 Mermaid 仍明确标记 PENDING LOCAL RENDER。
- `measure-usage.py --manifest evidence/baseline-usage.json` 本次失败：46 个冻结源文件中 5 个原路径不存在；脚本 SHA 与 manifest 一致。保留历史重放成功记录，但不能据此声称 9/20 可重放。
- 在原 transcript root、其余 `.claude` 文件，以及 `.flywheel/{archive,archives,backups,backup,preserved,rescued,claude-sessions}` 文件名范围内未找到这些文件。这不是对全机或远端备份不存在的证明。

缺失文件：

```
2da56b91-b162-4bed-8a49-c38c78bec9ee.jsonl
5346544b-d64c-4044-8c4f-1570bc47bfe5.jsonl
80d4bee5-6a92-4d6e-a09f-97460774e33c.jsonl
8f3dbd4c-7a75-4b1c-b997-8a51894ddcd8.jsonl
ee96313c-5a79-4233-ba3e-4107f3390119.jsonl
```

后续量测需先从保留副本找回原始文件，并验证 exact prefix length/SHA 后重放。不得删除缺失项、换基线或用缩小的样本声称同口径通过。本次未改脚本、manifest、业务代码或生产状态；缺口已通过 report `dd261f87-85f4-47d7-af24-63d8d8cfe855` 报告 Lead。

## 发布与阶段交接

当前 check 接口再次返回问题 `7d432b5f-12ea-4595-bef1-c7b287093cea` 与 `8625df09-5855-458f-b670-ed8d3a7a3017` 的明确裁定：停止托管重试，已提交推送 HTML 满足产出，记录 DESIGN-HTML publish-failed 后 phase_design_complete 并 park；恢复后另行唤醒 publish-only。此处沿用已有裁定，不宣称宿主已经恢复，也不把历史 502 当作本次新探测结果。

本次范围澄清问题 `143312aa-b385-4d4e-9711-56316dcef9fc` 尚未回答；这是非阻断问题，不撤销上述明确交接指令。设计完成命令及 park 的结果以本次 CLI/Bridge 收据为准，本文件不预先宣称成功。没有新增可复用角色经验，不写重复 memory 条目。
