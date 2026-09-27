# FLY-2802 设计批准与 Follow-ups — 调研
Issue: FLY-2802 (https://linear.app/geoforge3d/issue/FLY-2802/runner测试纪律-本机只跑相关测试写进-promptfly-2753后-runner-仍跑整包全量把-prompt-写到不留口子-在)
日期: 2026-09-23
基于: plan.md

## 有效批准

- R2 question：`e7e84e2a-eaa0-4e73-bf75-a8924603ace2`。
- R2 request：`8ac3ec1e-e662-481d-b66b-a697ea432f66`。
- `reviewVerdict=APPROVED`，`reviewerVerdict=APPROVED`，round=2。
- R1 三个 HIGH 已解决；R2 无 HIGH，settled=[]。
- 被批准的 plan 内容由 commit `2fbc1c3bb` 引入，批准后未改动 plan。
- `policyNote=medium_low_findings_are_non_blocking_v1`；以下不是阻断项，不重开设计评审，已通过 ask --report 转交 Lead。

## Follow-ups：实现阶段核对，Lead 可另行安排

| findingKey / severity | 具体建议与当前边界 |
| --- | --- |
| phase-protocols-new-file-not-in-payload-allowlist / MEDIUM | 新规则资产会被整目录复制，但 payload gate②逐文件穷举。实施需核对并登记 `node_modules/flywheel-teamlead/phase-protocols/local-test-policy.md`。skill-audit 的“不修改 allowlist”仅适用于 pre-ship-check/CONTRIB/qa-parallel 三者，不应读成对新增规则文件的豁免。当前尚未实施。 |
| slot-menu-readiness-asserts-exact-code-generic / MEDIUM | `test-deploy.sh:2495` 的精确 code/generic 就绪断言和 :1273 日志应随新模式 adoption 更新。simple_code 的 binding 已由现有六条 seed/verify 提供，不新增绑定层。当前尚未实施。 |
| codex-runner-flag-mapping-stale-for-runs-a-b / MEDIUM | A/B 的逐节点模型由 overrides 决定，建议不带 --codex-runner，核对 resolved.nodeModels；C 不带、D 带。避免把一个混 vendor run 等同于单个 backend cell。当前尚未执行。 |
| engineer-run-auth-kind-unpinned / MEDIUM | C/D 明确使用普通 slot 的非-master入口（默认 tokenless），部署前核实 agentName 生效；不要因新增 sidecar/expect-head 顺手开启 master auth 导致 template 分支忽略 agentName。若将来改用 master，需合法 no-three-stage 路径和明确核验，不能默认为等价。当前尚未执行。 |
| codex-rollout-source-location-unspecified / LOW | 从 execution 所有的隔离 CODEX_HOME 中，用已绑定 threadId 查询 SQLite threads.rollout_path；记录定位方法、路径与内容 hash，拒绝跨 home 路径，不全盘搜索别人的 transcript。fixture schema 仍须真实取证。当前尚未取证。 |

这些条目保留 reviewer 的非阻断处置与实现注意点，不声称已经修复代码或取得真实 529 PASS。设计只做有界观察式验收，不开放命令拦截、ship 或生产切换。
