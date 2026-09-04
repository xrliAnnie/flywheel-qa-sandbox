# FLY-2147 Runner 记忆分流改判 — 设计修正
Issue: FLY-2147 (https://linear.app/geoforge3d/issue/FLY-2147/2132b0-引擎能力runner-spawn-挂记忆目录角色项目)
日期: 2026-09-03
基于: plan.md

## 被撤销的概念

`plan.md` revision 14 与 `[lead-instruction 46a6afdc-6c8a-42d1-a8b0-3b5a8a7cb4b7]` 中「本单不得有任何运行时开关」的约束已被撤销。新裁定由 `[lead-instruction b5b49b4f-d6b6-43f0-ac0b-75c8100ec163]` 发起，并在 question gate `c8eb1aa9-d5f0-4002-9b23-0d489c714dd3` 的 Lead 回复中明确确认。

改为使用既有 flag store 的临时四态开关 `off|split|role|shared`：`off` 为默认值，与合入前的 runner spawn 行为逐字节相同；`role` 强制启用本单的项目+角色记忆；`shared` 强制保留原生项目共享记忆；`split` 对 issue 标识做确定性 50/50 分流，同一 issue 在重跑、换 runner 和返工时永远落在同一侧。不新建 flag 机制或告警层。

## 保留的器官

revision 14 的挂载、项目+角色单射目录编码、短索引+按需读正文、有界且超界可见的 prompt 注入、settings 来源存在即冲突、fail-closed 处置与结构化可见性全部保留。QA 真机证明 Claude 在 worktree 启动时仍会读取主仓的 project-local 设置，因此策略探测同时覆盖 runner worktree `cwd` 与主仓 `projectRoot` 的 `.claude/settings.json`、`.claude/settings.local.json`；两条独立回归用例证明任一根上的设置都会在任何角色记忆写入前触发冲突。受控的一次性 HOME 枚举实验（阳性对照三道均成立）证明 Claude CLI 2.1.259 启动枚举不包含 `HOME/.claude/settings.local.json`，因此本单不探测该文件；这是钉在 CLI 2.1.259 的枚举级阴性结论，不声称适用于未来版本，升级 Claude CLI 时必须重跑 `~/.flywheel/artifacts/fly2147/probe-debug-settings.sh`。已覆盖的 HOME 用户级来源仍是 `HOME/.claude/settings.json`。

该 flag 是临时实验器官，不是长期产品旋钮。注册表必须写明退役条件：founder 根据 split 对比得出 role/shared 定论后，将默认行为收口到胜出侧，删除 `split` 路由和该四态 flag。

## Founder 原话

> 我们不是有一个 split run 吗?也就是同时开 multiple issues,有的 issue 用 A,有的用 B,我希望开的时候是一个 split 的状态,比如 50% 用 A、50% 用 B
