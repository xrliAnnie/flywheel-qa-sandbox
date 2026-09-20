# FLY-2753 本机定向测试守则 — 探索
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: 无

## 目标与已授权范围

本机只运行全仓 lint（静态格式与代码检查）、受影响包的构建/类型检查，以及直接相关测试。完整包测试交给 exact-head CI：远端自动验证必须绑定最终提交的同一个提交标识。当前节点仅设计，不实现、不派发后继、不申请 ship、不合并或部署。

问题中的并发数量、1–2 小时等待与 founder 的 2026-09-19 授权来自本次任务正文；本节点没有重测宿主负载，也不为重现问题启动全量套件。

## 当前基线与不确定项

- 实际可写仓库为 `xrliAnnie/flywheel-qa-sandbox`，初始提交 `1855f7a1a`，分支 `project-slot-3-FLY-2753`。
- 本仓存在 `.flywheel/agents/engineering/engineer-executor.md` 与 `qa-executor.md`；不存在任务点名的 `.flywheel/agents/nodes/{implement,qa,engineer}.md`、`scripts/sync-phase-protocols.mjs` 和 canonical phase protocols。
- 注入命令所在工作树 `/Users/xiaorongli/Dev/flywheel-FLY-2753` 只读核对为 `3d67d8350`，三份目标守则已包含本单新规则，且已有 FLY-2753 实现文档。这是另一工作树的参考事实，不是本分支实现或验证证据。
- 已通过 question `7f5f22f8-74f5-4e9a-ad6f-2fb736347237` 请求 Lead 决定基线。默认设计描述题目要求的现代 nodes 布局；不得用仅改旧版两文件冒充三份守则验收，也不得把另一分支实现整包拷入 sandbox。

## 方案比较

| 方案 | 收益 | 代价/结论 |
| --- | --- | --- |
| 修改三份 domain 守则的验证段，复用现有投影检查 | 范围最小，保留 CI 与权限边界 | 推荐；先确认实现仓库具备既有节点基础设施 |
| 保留本机全量但串行或限制并发 | 降低资源尖峰 | 仍重复 CI，仍拖慢每个 runner，不满足目标 |
| 新建自动影响图/测试调度服务 | 可自动选测试 | 超出守则修改范围，引入新状态与维护成本，拒绝 |

## 锁定行为

1. 保留 `pnpm lint`。构建仅受影响包和必要依赖；导出接口或类型改变时覆盖直接受影响下游类型检查。
2. 按改动文件所属包与直接测试消费者选取；新增 shell 测试全部运行。发现测试文件但排除时写理由，不能只挑易通过的测试。
3. 删除本机全量及 `PACKAGE_GATE_RECEIPT` 的交卷要求；既有 package-gate 执行器、CI 工作流与收据机制不删除。
4. full exact-head CI 才是全量证据。轻量汇总 `CI Scope OK` 仅说明部分检查通过；`CI OK` 在确认属于完整运行且与当前最终提交一致后才合格。
5. 任一当前提交 CI job 红即处理；实现者修复，QA 判 FAIL 并交回作者，不能将 host-pressure 文本当免检凭证。
6. 只改验证条款与直接锁定其内容的测试/fixture。其他角色、ship 权限、重启、真实行为验证等条款保持既有合同。

## 成功证据

三份目标守则负 grep + 正向语义检查；`sync-phase-protocols.mjs --check`；直接消费守则的合同/模板测试；本机定向命令与选择理由；最终提交 CI 链接、提交标识、全量模式及所有 job 结论。设计评审通过只证明方案可执行，不证明实现或 CI 已绿。
