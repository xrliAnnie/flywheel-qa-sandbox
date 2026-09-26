# FLY-2802 首轮评审处置 — 调研
Issue: FLY-2802 (https://linear.app/geoforge3d/issue/FLY-2802/runner测试纪律-本机只跑相关测试写进-promptfly-2753后-runner-仍跑整包全量把-prompt-写到不留口子-在)
日期: 2026-09-23
基于: plan.md

Gate `357805e3-38bb-4316-ae81-c3ae1f4b640b` / request `250e5470-74d3-4e59-a41d-d8a1ea47acbf`：effective reviewVerdict=CHANGES_REQUESTED，3 HIGH、3 MEDIUM、1 LOW。逐项接受，无 overrule。

| findingKey | 处置 |
| --- | --- |
| task-category-code-cannot-realize-matrix | 改用 simple_code，明确 A/B 交叉 vendor 配对；不启动 eng_design、不改变同 vendor guard；slot adoption 加 simple_code |
| engineer-cell-undispatchable-in-slot | 明确 agents.engineer.node、候选 registry、部署前 ConfigLoader/AgentDispatcher 解析；直接 start API 传 agentName=engineer，不用不支持选择器的旧 inject 脚本 |
| in-repo-full-suite-instruction-sources-unswept | 补查并处置 QA README/agent、CONTRIB、pre-ship 和分发闭包；其他历史 root 标明未检查 |
| new-node-suites-missing-from-ci-enumeration | 新增 Node suites 登记 ci.yml 和 ci-source.yml；新增 shell suite 分类；运行枚举检查 |
| expect-head-unavailable-in-new-test-discipline-mode | 新 QA 模式强制 expected head，允许 ordinary 且在任何 slot 副作用前校验 |
| targeted-verification-list-omits-node-prompt-consumers | 补全已知 shell prompt 消费者、SkillInjector 旧断言迁移、配置解析相关测试 |
| codex-rollout-event-vocabulary-unverified | 把真实 vendor 原始记录脱敏固化设为步骤 0；候选字段不能当作已核实 schema |

另补清晰版本边界：candidateHead 是运行/注入代码，subjectBaseHead→subjectResultHead 是合成任务自身的变更；QA 只看任务 diff，避免套娃运行行为 suite。新开 gate + request-review 取得有效 verdict 后才发布。
