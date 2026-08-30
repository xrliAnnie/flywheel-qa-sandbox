# FLY-2121 workflow 命名统一 — 设计增量留痕

Issue: FLY-2121 (https://linear.app/geoforge3d/issue/FLY-2121/命名-workflow-shapenoderole-三处-design-命名互撞-后端改名-稳定-id-与展示名分离)
日期: 2026-08-28
基于: plan.md

## 2026-08-28 founder 反馈与 Lead 裁定

来源:Discord `[FLY-2121]` thread message `1543056683117318314`,由 Lead 指令 `[lead-instruction 59b5e5e4-daa1-4f8d-ab93-da7010bdcaf2]` 转交。当前 runner 无 Discord 原消息读取能力,以下保留 Lead 转交的原意,不伪称逐字引文。

1. founder 在设计页图中看不到 PM、Designer、Prototype 三个单节点 DAG 层,担心方案没有引入它们。实际 `plan.md` §1.1 `graphs` 已包含 `prd`、`product_design_flow`、`prototype`、`generic`;遗漏只发生在设计页的压缩画法。修订:`d1-collision` 和 HTML 页面改为逐条画出全部六个 graph,显式展示三个单节点业务 DAG 及 `generic`。
2. founder 问节点名是否应加项目前缀。动机是 IC 记忆统一固化在 markdown 时,跨项目同名可能调用错执行者或串记忆。Lead 裁定:不加前缀;运行时身份是 `(project, nodeName)`,bundled registry 提供统一 IC markdown,project overlay 提供项目特化,记忆按 `(project, identity)` 分桶,展示名可以带项目。除非 founder 后续明确推翻,实现沿用此裁定。
3. personal-assistant 的 registry 与 companion 转换不属于本 worktree。Lead 将在激活阶段以 operator 身份执行。本 PR 交付 schema、迁移命令、两入口可验证 preflight 与迁移回执;目标项目 registry 缺失或任一入口校验失败时 fail-loud,拒绝激活并保留旧 loader,不得半切换。激活前置清单明确列出 personal-assistant operator 动作。

## 2026-08-28 code review R1 后续裁定

Review finding `catalog-migration-bricks-bridge-on-founder-owned-template` 成立,Lead 通过 question gate `a940643c-7f9b-4794-9e2d-c3a8dd9f333a` 裁定不 overrule。fleet-console 正常编辑会产生 `seed_owner=founder`,属于常规数据而非腐坏状态;常规数据不得触发 Bridge boot loop。实现边界修订为:

1. founder-owned/customized template/seed 原样保留,绝不覆盖或删除;
2. 未 retired 或仍被合法 run/binding 引用的 cleanup 白名单模板跳过,其余 safe rows 继续迁移;
3. 每个 skip 写 append-only `workflow_catalog_migration_audit`,启动时逐行告警;相同状态重跑不重复写审计;
4. category 冲突、悬空引用、manifest/hash/digest/事务后置条件破坏仍 fail-loud;
5. project config 只在条目使用 `node` 时加载 registry;legacy `agent_file` loader 保留到该项目 operator 激活成功,且同一条配置严格禁止双字段。

本次是增量澄清,不回滚已 APPROVED 的两层 registry 架构。

## 2026-08-28 code review R2 风险处置

Review finding `skipped-template-retains-unresolvable-legacy-roles` 成立。R1 的“founder-owned/customized template 原样保留”只解决了启动可用性,没有保证这些模板在 registry-only 项目中仍可执行;它们可能继续引用已退役的 node/role 身份。由于本单明确禁止双名兼容层,处置边界修订为:

1. migration preflight 用 authoritative bundled registry 的 node 名集合检查每个被保护模板的 published manifest;
2. 模板与 revision 继续逐字节保留,不自动重写、不注入 alias;
3. 审计详情写入 `dispatchStatus=unrunnable`、稳定诊断码 `FLY2121_PRESERVED_TEMPLATE_UNRUNNABLE` 与 `unresolvableRoles`,Bridge 启动时输出带模板 id、旧 role 集合和 republish 动作的显式错误;
4. 若用户仍尝试启动该模板,materialization 在创建 run 前抛出 typed error,HTTP 入口返回稳定 `409`、`retryable=false`、`silent=false`;不得落下半创建的 run;
5. 只有 operator 用当前 registry node 重新发布模板后才恢复可执行。历史行的可读性仍由永久 decoder 保证,与新 run 的执行资格分离。

这条修订让保护策略同时满足两项约束:Bridge 不因合法自定义数据 boot loop,新调度也不会把不可解析模板静默放行。

## 2026-08-28 code review R3 启动安全修正

Review finding `preflight-validates-founder-manifest-and-blocks-boot` 成立。fleet console 的 repair path 允许用 `allowUnsupportedModels=true` 保留已退役 model pin;因此“能被合法存储”不等于“能通过当前严格 validator”。R2 在 migration preflight 中无保护地严格验证 founder manifest,会重新制造 Bridge boot loop。

最终边界修订为:

1. DB 读取与结构完整性错误仍 fail-loud;只捕获 stored manifest 的 JSON parse / 当前严格 validation 失败;
2. 失败时不覆盖模板,而是在 skip audit 中记录 `manifestStatus=unreadable`、稳定诊断码和验证原因,plan 标记 `manifestUnreadable=true`;
3. Bridge 输出明确的 startup error 后继续 ready;materialization 读取最新一条审计,在严格验证失败处转成同一个 typed 409,且仍在任何 run 写入之前;
4. 审计读取只认最新行。operator 修复并 republish 后的新审计没有风险标记,旧风险行不得继续污染后续诊断。

这不是放宽新发布或新 run 的 validator;它只把已有合法 repair-state 数据从“全局启动失败”隔离成“单模板不可调度”。

## 2026-08-29 QA2 F4 生产 census 终态证据

QA attempt 2 以只读方式对活体生产库运行 `bash scripts/fly2121-legacy-census.sh /Users/xiaorongli/.flywheel/teamlead.db`,本轮实现返工后再次执行同一命令,两次结果一致:

```json
{"legacyNodeRuns":20,"unpinnedAgentRuns":0,"removable":false}
```

这里必须按 `plan.md` §4 的两个独立收场条件解释,不能把聚合字段 `removable` 误当成 `BUILTIN_NODE_AGENT` 的单项删除条件:

1. census(a)=`legacyNodeRuns=20`,所以服务旧 node id 的其余 B 类执行分支尚不可整体删除;
2. census(b)=`unpinnedAgentRuns=0`,说明不存在非终态 engine run 的 schema-v1 / 未 pinned-agent snapshot;founder 为 `BUILTIN_NODE_AGENT` 单独设定的终态条件已满足;
3. 因此本 PR 删除 `BUILTIN_NODE_AGENT`,但不宣称全部 B 类兼容面均可收场。被 QA2 CI 暴露的 legacy 测试 fixture 改为显式 registry pin,验证当前可执行合同,而非恢复生产 fallback;
4. census 命令以 SQLite `-readonly` 打开数据库,本次核验没有删除或改写任何生产行。`fly2121-legacy-census.test.ts` 固化 `(a)>0,(b)=0,removable=false` 这一中间态,防止后续再次混淆单项与整体收场门。
