# FLY-2922 QA stub 身份隔离 — 探索
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: 无

## Problem

本轮不重新设计 FLY-2922 的产品恢复行为。统一恢复口、真实派发账本、complete 顺序和 carrier-close 边界已经完成实现与复审；当前缺口在 529 generalized QA harness。

为解除房内 QA 等待外层 529 最终证据造成的递归等待，candidate 增加了 `--qa-stub-runner`。但装房把包含 `claude` stub 的 `stub-bin` 前置到整个 Bridge 的 `PATH`。Bridge 的跨家族设计评审也以默认 `binary=claude` 启动，并继承同一环境；评审进程没有 `FLYWHEEL_EXEC_ID`，于是误进 `scripts/qa-529-generalized-stub.mjs`，在身份前置条件处退出。结果是设计节点等不到真实 Claude 评审，外层 driver 空等。

成功定义：同一组 `--generalized --codex-runner --qa-stub-runner` 参数下，设计/实现仍是真 Codex，跨家族评审仍是真 Claude，只有 QA execution 进入 deterministic stub。QA standby 恢复后仍应落入 stub；任何模糊、伪造或跨 execution 的 QA 身份都不得误路由。生产 QA prompt、产品状态机、review coordinator 和 evidence judge 不改。

## Constraints

- 只改 QA harness、其定点测试和操作手册；不改 `StateStore` 产品事务、workflow dispatcher、review coordinator、runner adapter 或 QA 角色文件。
- `--qa-stub-runner` 保持显式 opt-in，且只能与 `--generalized --codex-runner` 合用；不能用去掉该 flag 回避递归等待。
- selector 必须在装房时钉死真实 Claude 的绝对路径，不能在运行时再次从已被 shim 前置的 `PATH` 解析自己。
- `codex` 不能出现在 QA-only shim 目录；producer 节点继续使用真实 Codex。
- 当前 activation 可直接按 exact tuple 分类；same-execution standby resume 没有 activation 时，只能从 slot-local StateStore 的 `workflow_execution_binding` 只读判定。
- 所有输入都在边界校验。shell/SQL 不拼入未验证的 execution id；模糊 QA 归属 fail closed。
- 本地只跑具体相关测试文件、lint 和受影响 build；不跑全仓或全包测试。

## Options

### A. 身份选择型 `claude` shim（推荐）

安装一个 owner-only `claude` selector，而不是把 raw QA stub 直接伪装成所有 Claude 调用。selector 的规则是：

1. 没有 Runner 身份：原参数 `exec` 装房前钉死的真实 Claude；
2. 有 exact `activation:<same-exec>:<run>:qa:<attempt>`：进入 QA stub；
3. 只有 execution id 的 standby resume：只读 slot StateStore；唯一节点为 `qa` 才进 stub，非 QA 回真实 Claude，QA 与其它节点并存或查询失败则拒绝；
4. malformed / foreign activation 绝不进入 stub。

优点：修改集中在 harness；评审、版本探测和 producer fallback 都保留真实 Claude；standby resume 有持久归属证据；无生产协议变化。缺点：selector 需要严格处理真实二进制自引用、StateStore 不可读和多节点歧义。

### B. 给 runner adapter 增加 per-node binary override

Bridge 把 QA node 的绝对 stub binary 传给 adapter，其他节点和 review coordinator 不变。

优点：进程边界最纯。缺点：需要修改生产 `AdapterExecutionContext`、Blueprint/run-infra 和 Claude/Codex adapter，只为测试房引入一条产品级 binary seam；范围和回归面明显更大。拒绝。

### C. 去掉 QA stub 或让 review coordinator 使用特殊绝对路径

去掉 stub 会回到 inner-QA 递归等待；只钉 review binary 则仍让版本探测、Claude producer fallback 等所有非 QA 调用暴露在 raw stub 下，并保留错误的全局语义。拒绝。

## Chosen Direction

选择 A。`stub-bin/claude` 是 selector，不是无条件 QA stub。它只在正向证明当前调用属于 QA execution 后 `exec node <qa-stub>`；所有明确的非 QA 调用都用原 argv `exec <pinned-real-claude>`。`stub-bin/codex` 必须缺席。

当前 activation 是第一身份来源，因为它同时绑定 execution、run、node 和 attempt。standby resume 的 activation 缺席是允许的既有形态，因此用装房时钉死的 slot `teamlead.db` 查询 exact execution 的 distinct node ids；只有唯一 `qa` 可放行。selector 不把“有 `FLYWHEEL_EXEC_ID`”等同于 QA。

## Negative Guards

1. identity-free review / `claude --version`：必须进入真实 Claude。
2. design / implement activation：必须进入真实 Claude。
3. activation 的 execution 与 `FLYWHEEL_EXEC_ID` 不同：不得进入 stub。
4. `qa-extra`、attempt 0、非法字符：不得被正则近似命中。
5. standby execution 仅绑定 `qa`：进入 stub；仅绑定 producer 或无 binding：进入真实 Claude。
6. standby execution 同时绑定 `qa` 与其它节点、DB 不可读：exit 70，不能猜。
7. 真实 Claude 必须是绝对、可执行、位于 shim 目录外且不是 shim 的 symlink、hardlink 或带 marker 的 copy。
8. QA-only 目录已有 `codex` 文件或链接：安装失败。
9. selector 以原 argv `exec` 目标，不能吞参数、衍生第二个 model process 或留下 wrapper parent。

## Honest Boundary

本设计只修复 529 测试房的 binary 选择，使真实评审与 QA stub 可以共存。它不证明 FLY-2922 产品行为正确，不把 stub 结果算作 strength-two evidence，也不放松生产 QA 的 529 要求。下一轮 QA 仍需在 exact head、mergeable、full CI 绿的前提下，用两个真实 Lead 跑完整 driver，并证明设计评审由真实 Claude 完成、held → unified recovery → new dispatch 全链走通。
