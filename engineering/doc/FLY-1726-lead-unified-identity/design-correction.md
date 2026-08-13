# FLY-1726 QA 实测增量修正 — 设计修正(design-correction)

Issue: FLY-1726 (https://linear.app/geoforge3d/issue/FLY-1726/设计议题基础层-lead-统一-identity-身份在-n-处以不同形式表现无单一权威今日三重嵌合体活爆雷标本annie-直令立单)
日期: 2026-08-13
基于: plan.md(Codex design review 5 轮通过版)

## 0. 性质与范围

本文档是**增量修正**,不是重设计。依据 Lead 接棒简报(`[lead-instruction b8f115a3-fa45-45a2-bc92-8be4e1cee92c]`):

- 方案本体(registry 单一权威源 + resolver 单实现 + 三道启动断言 + fail-loud 清扫)**不变**;
- QA 已验过的部分**不重做**:A1 拦嵌合、A4 写边界(11/11、16/16 哨兵)、部署闸 fail-closed 全过;
- 只补 QA 独立实测判 FAIL 的**两个口**(§1、§2),并把 ship 卡三条硬前置固化进设计物料(§3)。

按 Lead 指令本修正走轻量采纳确认(「几分钟过场,别重设计」),不重开 Codex design review 循环;两个修复口均由 QA 单变量复现确认根因、由 Lead 指定修法。

## 1. FAIL-1(HIGH):QA 隔离房 Bridge 启动即 fatal

**现象**:529 隔离房 `test-deploy.sh` 起 Bridge 立刻 fatal(QA 复现两次;补上环境变量后 8 秒 ready,单变量归因确认)。

**根因**:plan §5 既定设计把 `TEAMLEAD_DEFAULT_LEAD_AGENT` 从静默默认值 `"product-lead"` 改为**必填**(`packages/teamlead/src/config.ts:137-140`,方向正确、不回退);但 `scripts/test-deploy.sh` 的**两个 Bridge 启动 env 块**(reply-by-issue ON 分支 ~`:1510`、OFF 分支 ~`:1540`)从未设置该变量 ⇒ 隔离房 loadConfig 直接 fatal。这是 FLY-1608「529 房既有缺陷」同类的 QA 房 plumbing 缺口,不是设计缺陷。

**修法(implement 节点执行)**:
1. `test-deploy.sh` 两个 Bridge 启动块各加一行 `TEAMLEAD_DEFAULT_LEAD_AGENT="${AGENT_ID}"`(slot 的主 Lead agentId,与 slot registry 生成一致);
2. 加一条 shell 断言防再次静默退化:启动块前断言该变量非空(或 harness 静态断言两个启动块都携带该键),缺失即 fail-loud 报名字——不许再以「Bridge 起不来」的形态间接暴露。

## 2. FAIL-2(LOW):身份失败 marker 目录污染生产

**现象**:隔离 slot 里 Lead 身份核验失败时,失败留痕 marker 写进**生产**的 `~/.flywheel/state/lead-identity-failures/`。

**根因**:`packages/flywheel-comm/src/lead-identity-failure.ts:59-61` 的 `failureDir` 回退值 homedir 硬派生;调用链 `flywheel-lead-wrapper-v2.sh:149` → `flywheel-comm lead-identity record-failure`(`commands/lead-identity.ts:76`)没有任何覆盖口。

**修法(implement 节点执行)**:
1. 目录解析链升级为 `input.failureDir ?? env FLYWHEEL_IDENTITY_FAILURE_DIR ?? homedir 默认`——CLI `record-failure` 读该 env(非 flag plumbing,与 FLY-1608 `FLYWHEEL_COMPLETE_MARKER_DIR` 同款模式);
2. QA 房(`test-deploy.sh`)为 slot Lead 注入 `FLYWHEEL_IDENTITY_FAILURE_DIR=${SLOT_DIR}/state/lead-identity-failures`;生产 unset 路径行为逐字不变(byte-compat);
3. 测试:env 设/不设两侧回归 + 隔离房零生产目录写入断言。

## 3. Ship 卡三条硬前置(出卡时印卡面)

以下三条已按 QA 实测升级为 ship 硬前置,**必须印在 ship 卡卡面**,任何一条未完成不得 :cool::

| # | 前置 | 依据 |
|---|---|---|
| ① | `migrate-bot-user-ids` 先跑:16 个 Lead 的 botUserId 迁入 registry 并**逐一核验 16/16**(plan §7.1 工序) | managed Lead 缺 botUserId = resolver fail-loud,数据不齐先于代码上线会全舰拒启 |
| ② | **build 与全舰换代必须同一次原子动作**:生产 14 条 `lead_lease` 行的 `identity_digest` 全 NULL,新 `authorizeLeadWrite` 先查身份 ⇒ 只 build 不换体 = 全部 Lead send/respond 被拒(QA 实测,team task #239) | plan §2.1「存量 NULL 行不兼容放行——必须重启重获」的运维推论:部署窗口内 build 完成后必须立即全舰重启换体,两步不可分离、不可隔夜 |
| ③ | 插件配套 PR(claude-plugins-official **#22**,已 exact-head APPROVED)按**双仓顺序**上:QA 房 → canary → fleet;回滚先退 plugin 再退主仓(plan §9 runbook) | plugin cache 是 fleet 共享,顺序即安全 |

## 4. 不做

- 不回退 `TEAMLEAD_DEFAULT_LEAD_AGENT` 必填化(fail-loud 正是设计目的;FAIL-1 修的是 QA 房 plumbing,不是放松合同);
- 不给生产路径改任何默认行为(FAIL-2 的 env 口 unset 即现状);
- 不重开已 QA PASS 的面(A1/A4/部署闸)。
