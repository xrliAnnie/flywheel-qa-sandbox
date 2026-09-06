# FLY-2358 角色级 Codex Home — 实现证据
Issue: FLY-2358 (https://linear.app/geoforge3d/issue/FLY-2358/2355b1-ic-层地基任务级-codex-home-改键-executionid-agent)
日期: 2026-09-05
基于: plan.md

## 交付结论

实现与获批裁定一致，采用路线 **(a) 共享持久家**：同一
`(project, workflow role)` 的 generalized Codex runner 解析到同一个
`<codexHomesRoot>/agents/<encode(project)>/<encode(role)>`，不同 project、role
（包括只差大小写的 role）不相撞。目录只在第一次准入时创建；无法解析 workflow
role 的旧执行继续使用 `<codexHomesRoot>/<executionId>`，部署前已起跑的执行在 reown 时也不迁移。

选择 (b) 的代价仍是 exploration.md / research.md 已记录的跨任务记忆回流、种回、冲突合并和节流联动新机制；本批没有引入这些机制。因此 [2355·B2] 可只负责种回与验收。

## 实现形状

- `flywheel-config` 提供大小写安全、可逆的路径编码器，并承接仓内既有 mkdir lock / pidfile 原语；teamlead 原导入路径保持再导出兼容。
- 键式家 marker 固化 `{project, role, assemblyArm, materializedArm}`。准入在短 mkdir 锁内完成 marker 决定和执行租约创建；provision 在同一锁内原子更新 config、累加仍存在的 worktree trust，并只在装配臂变化时重物化 skills / `AGENTS.md`。
- Blueprint 在 `started` 事件前完成准入；共享家已有活租约时，实际装配臂继承家级 marker，并写入现有 A/B 字段 `skill_framework_mode` 与 `skill_framework_mode_via=inherited`。生效臂探针失败会释放新租约且不发 started。
- adapter 在接管后 set-once 发布 `{home, project, role}` 反查记录，并在正常、失败与恢复路径退休本执行租约。最后一个租约退出时才擦除家内凭据。
- Bridge 启动清扫按 StateStore 的状态和可信身份回收终态/孤儿租约；活执行身份漂移时 fail-closed 告警。reaper 与 rollout probe 同时认识键式租约和 session 反查。
- 删除入口先把 execution 分类为 `keyed | prepublished | legacy | unknown`。键式家明确返回 `agent_home_protected` 并打 `refuse_remove_agent_home`；unknown 拒删；旧式 executionId 家保持原删除行为；删除失败从空 catch 改为 `remove_home_failed` 告警。

## TDD 与并发证据

各批均先补失败断言，再做最小实现并跑绿：

1. 路径/身份：同对连续两次同路，四组异对分离，大小写单射，非法和超长身份拒绝，环境覆盖根目录生效。
2. 准入/provision：懒建、marker 原子写、租约 token、装配臂继承、锁超时/死锁回收、symlink/常规文件敌意路径拒绝、skills 一次物化。
3. 生命周期：三态反查、set-once session 记录、两执行租约计数、provision-vs-retire、adapter 失败路径与 FLY-1269 退休顺序。
4. 清扫/reaper：活状态保留、终态/孤儿删除、身份漂移拒绝、单家失败隔离、键式 probe 和 inventory。
5. dispatch/reown：spawn、恢复、装配臂换体、无 role 回落、部署前 legacy 不迁移、prepublished 收养和失败释放。
6. 删除保护：真实 provision → retire → session cleanup 顺序下家仍在；键式/unknown 拒删可见，旧式删除不变。

真实并发回归使用 8 个独立 Node 子进程和共享释放栅栏，同时对同一 `(flywheel, implement)` 首次执行 `admit + provision`，请求臂轮换 `superpowers / matt / bare`。结果：8 个进程得到同一路径和同一 effective arm；`inherited` 与请求/生效差异一致；marker 唯一且 `materializedArm === assemblyArm`；租约恰好 8 个；config 可解析并保留 8 条 worktree trust。该测试在本机约 1 秒稳定通过，证明的是跨进程临界区，而非单进程 Promise 调度。

路线 (a) 的 Codex 自身并发安全依据仍以 exploration.md §4 的真实二进制双 app-server 实验、09-02 真凭据双臂和锁/软链复现实验为准；本实现没有重跑会触碰公共 `~/.codex` 的凭据实验。

## Code review R1 修复

request-driven cross-family review 在 `f638ccf72` 找到两项 blocking HIGH，均先以精确回归复现再修复：

- `.flywheel-leases/` 内被 SIGKILL 留下的原子写临时文件、`.DS_Store` 或目录不再让准入/退休/清扫永久报错；这些不可能成为 canonical execution lease 的条目不跟随、不删除、只忽略。新增用例先稳定复现 `unsafe codex agent home lease entry`，修复后 137/137 通过且归零仍擦除 GH_TOKEN。
- reaper 的 canonical home inventory 除活租约外，也从持久 `codex-sessions/<exec>/session.json` 反查仍存在的键式家；因此租约已在终态删除、两小时后才满足 orphan 年龄的 app-server 仍能走双轴身份核验。新增 retired-lease 用例先得到空 inventory，修复后 reaper 文件 21/21 通过。

同批收掉非 blocking findings：不可编码且无 keyed 记录的旧执行恢复继续判 legacy；ownership 拒绝分支的 lease release 失败回到可见告警 + failure result；Blueprint 先完整构造 adapter context 再交接 lease；删除 tautological marker 自比、不可达 probe 分支，并把两个兼容 shim 收窄为原符号的 named re-export。相关精确套件合计 claude-runner 257、teamlead 79、edge-worker 77 项全绿，四个受影响 package typecheck 全绿。

## 验证

- 定向：claude-runner `codex-home` / adapter / rollout 共 254 tests；teamlead reown / reaper / startup 共 61 tests；edge-worker Blueprint / generalized 共 69 tests；全部通过。
- 跨进程：8-child 同家并发测试通过。
- 格式与静态：变更文件 Biome、`git diff --check`、全仓 `pnpm typecheck` 通过。
- 全仓：`pnpm lint` 退出 0（仅仓库既有 warning/info）；`pnpm -r build` 的 21 个 workspace 全部通过。
- `pnpm test:packages:run` 的完整重跑验证了所有 FLY-2358 定向用例，并暴露两个随搬家而漂移的仓级合同：child-process census 的 pidfile 路径、全模块测试 mock 的新导出。最小更新后两项隔离回归 2/2 通过；先前 Blueprint constructor-tail 回归也已由 77/77 隔离回归覆盖。
- 完整命令在本机最终仍退出 1，唯一可重复失败是 branch 未修改的 `patrol-orphan-sweeper.test.ts`：tmux 3.7c 拒绝测试要求创建的 tab 字符 window name。该文件相对 `origin/main` 无 diff，隔离重跑稳定为 12 pass / 1 fail。另外两个全量并发下的超时/事件 flake（StructuredInboxRouter、database retention）隔离重跑分别 19/19、14/14 通过。此平台基线例外已通过 flywheel-comm 提请 Lead 裁定，没有为本单偷偷放宽或跳过 gate。

## 边界与 QA 交接

本实现没有清理现存执行级 homes（包括唯一记忆证据），没有读写公共 `~/.codex`，没有改节流闸、部署、merge 或派发 QA。529/真机的 spawn → Bridge reown → daemon 换体属于获批 plan §5 A10 的 QA 阶段：需要 slot 部署，implement 节点按边界没有执行。实现节点已用可执行集成测试覆盖三条代码路径；QA 仍须按 A10 在同一键式家上完成至少一次真实路径验收，并检查存活/终态租约。
