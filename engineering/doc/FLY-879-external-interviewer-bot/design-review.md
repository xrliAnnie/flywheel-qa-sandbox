# FLY-879 对外 PM 卫星 bot(Anna)基建 — Codex Design Review 记录

Issue: FLY-879 (https://linear.app/geoforge3d/issue/FLY-879/pm-对外-pm-卫星-bot-基建-bot-身份-客户-channel-锁死权限-访谈-flow-骨架按-fly-679-设计)
日期: 2026-07-05
基于: plan.md

---

## 结果

**APPROVED(3 轮,effort xhigh,持久会话 threadId `019f3123-32b7-7282-9ed4-acd20de0ac23`)**

## Round 1 — CHANGES REQUESTED(10 项,全部采纳)

方向被认可(external 角色类 / companion 前例复用 / 双 server / go-live gate / M2 蒸馏后置都被点名保留),问题集中在「会被当前 launcher/config 细节绊住」:

1. Anna 的 projects.json entry 缺必填 `match.labels` → 加惰性标签 external-interviews + department external(避开 PM/Triage 路由词)。
2. persona 路径错:launcher 不自动读 LEAD_WORKSPACE/agent.md → 显式 `AGENT_SOURCE`。
3. 「松散镜像 companion」不够 —— 脚本里还有 shared-rule 同步 / cross-dept / reply 规则 / screencap / Agent Team / MCP 生成 / pane env 转发等 universal 面会漏内部规则与工具 → 角色态显式三值化(standard|companion|external)+ 排除面逐项列出 + `FLYWHEEL_LEAD_EXTERNAL=1` pane 标记 + post-compact early-exit + 「恰好只有允许的 prompt 文件」断言。
4. 校验落点应为 `parseAndValidateProjects()`(纯校验器,防其他 config 写入路径漂移)+ 完整测试矩阵。
5. wrapper 要显式 allowlist 注入模型(不是 source 全量再挑着不导出);W5 以 dry-run PANE_ENV 为准。
6. GH_TOKEN 只管 gh CLI 不自动管 raw git → repo-local credential.helper(gh auth git-credential 桥),W5 增 git ls-remote/push --dry-run 双向断言。
7. materialize-lead-manifests.sh 不 carry effort → 部署经 flywheel-fleet.sh apply --effort(materializer 补 carrier 为可选 follow-up)。
8. fail-STOP 告警缺落点 → Anna entry 加 alertChannel(#pm-interviewer)+ alertBotTokenEnv。
9. 「零内部信息」要具体化 → public-safe 内容闸(blocklist 可重跑)+ interviews 仓 .gitignore 预置 launcher 落盘文件。
10. 「物理不可见」措辞夸大于 MVP 真实强度 → 改为诚实表述(工作区+凭据+工具面锁;同用户文件系统隔离 MVP 不强制,OS 沙盒 = 生产化 follow-up)。

## Round 2 — CHANGES REQUESTED(2 项,全部采纳)

1. `alertBotTokenEnv: ANNA_BOT_TOKEN` 与「不导出裸 ANNA_*」矛盾(lead-alert.sh 与 LeadAlertNotifier 都按 env 名间接展开取 token)→ 边界精确化:**wrapper/launcher 辅助进程保留 ANNA_BOT_TOKEN,「无裸 ANNA_*」只约束 Claude pane(PANE_ENV 断言)**;加 hermetic fail-STOP 告警测试(token 可解析 + 真发出)。
2. 告警 kind 未对上 lead-alert.sh allowlist(现只认 companion_config_error 等)→ 新增 `external_config_error` 进 allowlist + typed 告警面同步 + 路径测试。

## Round 3 — APPROVED

无阻塞项。一条实现期备注(已纳入 Implement 段注意事项):写 external 的 MCP/shared-rule 排除负向测试时,要**seed 脏 fixture**(残留 .mcp.json / 残留 ~/.flywheel/lead-rules/<leadId>)或显式清空输出 —— 「恰好只有允许面」的断言只在干净工作区上过 = 假绿的主要方式。

## 过程说明

- Review prompt 按纪律 lead with problem+goal+founder 决策语境,并声明「founder 已拍的产品岔口不重开」;Codex 全程用真实文件核验(读了 claude-lead.sh / ProjectConfig.ts / lead-alert.sh / materialize-lead-manifests.sh / wrapper 等)。
- 三轮反馈原文存 /tmp/codex-rescue-design-feedback-flywheel-FLY-879-plan-round{1,2,3}.md(会话产物,本文件为持久记录)。
