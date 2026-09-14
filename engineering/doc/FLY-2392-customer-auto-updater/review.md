# FLY-2392 客户自动更新器 + 止血 — 设计评审收口记录(leadAcceptance)

Issue: FLY-2392 (https://linear.app/geoforge3d/issue/FLY-2392/1143b5-客户自动更新器-止血定时更新器查-customer-release-装-即时失败回滚单飞-central)
日期: 2026-09-13
基于: plan.md(v6)

## 1. 评审轨迹

| 轮 | Codex 结论 | 条目 | 处置 |
|---|---|---|---|
| R1 | CHANGES REQUESTED | 7 HIGH + 3 MED | 全部折入 v2 |
| R2 | CHANGES REQUESTED | 6 HIGH + 1 MED | 全部折入 v3 |
| R3 | CHANGES REQUESTED | 4 HIGH + 1 MED | 全部折入 v4;安全阀 → Lead(`12c767ea`)批受限 R4 |
| R4 | CHANGES REQUESTED | 2 条 R3 残留 + 1 新 HIGH + 1 LOW | 全部折入 v5;新 HIGH 上报 → Lead(`7e62f2d4`)批只验 3 条的 R5,并裁定「R5 后无论结果收口」 |
| R5 | CHANGES REQUESTED | 1 HIGH(R3#4 残留)+ 1 MED follow-up | 阻断项折入 v6;MED 措辞收窄;按裁定 leadAcceptance |

Codex thread:`01a09cfc-2033-7010-b89b-001eb73ca2ea`(xhigh,同线程五轮)。

## 2. R5 条目(逐字)

### HIGH — held-current self-reapply 的崩溃结算仍会删除 `current`,第三项尚未完全关闭。

> 反例严格来自 v5 合同:held 且 verify 通过的 current 进入 self-reapply,耐久状态为 `operation="install_version"`、`fromPkgRoot=null`、`targetCreated=false`;restart 失败后 f1 成功写出 `phase="recovering"`,随后进程在 f4 前退出。下次 `settleInflight` 命中 `recovering + current=target`,§3.3 要求“继续 f2–f4”;通用 f3 对 `fromPkgRoot` 不可用的定义却是 `rm current`。同样地,`flipped + target` 重启再次失败后“按 f1–f4”也可进入该分支。这与 §3.7 的 self-reapply “只走 f1→f4、current 不动”直接冲突,会在客户机上留下仍存在的版本目录但没有 canonical `current` symlink。C6 当前列了普通 restart-failure 与 verify-failure 的边界断言,却没有明确锁住上述 recovering settlement。**建议:**把 self-reapply 的 recovery policy 作为耐久且可验证的 applying intent(或由 `operation/install_version + fromVer===ver + fromPkgRoot===null + targetCreated===false` 唯一派生),在 §3.2 f3 以及 §3.3 的 `flipped|target`、`recovering|target` 两行明确分支为“绝不 rm/flip current,receipt 后直接清 applying,outcome=degraded”。新增真进程 kill:f1 receipt/phase commit 后、f4 前退出;重启结算后断言 current symlink 与目录均保留、attempts 仅增一次且 outcome 永不为 rolled_back;另覆盖 f1 写失败后由 `flipped|target` 重结算的同一性质。

**处置(v6,阻断级)**:完全按建议落实——`isSelfReapply(applying)` 由耐久 applying 四字段唯一派生;§3.2 f3 首分支、§3.3 `flipped|target` 与 `recovering|target` 两行、通用规则、§3.7、护栏 14、C6 测试(真进程 kill 于 f1 后 f4 前;`flipped|target` 重结算)全部更新。

### MEDIUM(follow-up)— 收窄 inode 比对的表述。

> `fstat(fd).ino === stat(path).ino` 只能检测本次 open 与 stat 之间发生的替换;若旧 holder 完成比对后文件被 unlink,而新 opener 随后创建并打开新 inode,新 opener 的两者仍相等。由于 v5 明确规定实现永不删除锁文件,并把人工 unlink/网络文件系统排除在承诺外,这不恢复 Round 4 的阻断问题;建议把 §7 的“inode 比对拒绝新开者”改成“安全性前提是持锁期间无人 unlink;inode 比对只覆盖 open→stat 窗口”,避免运维文档高估该检查。

**处置**:措辞已按建议收窄(plan §7/§8、research §2.2 v5);非阻断,顺手折入。

## 3. Lead 裁定(逐字,question `7e62f2d4-9eca-4ee8-98f7-2a3c3e65fffe`)

> 裁定: A) 批 R5, 只验 3 条: 新 HIGH assertOwned 原子性(darwin O_EXLOCK 内核锁, 锁文件不删, 取锁后比对 inode; 非 darwin mkdir 锁不自动回收 dead-pid, 边界写明), #2 attempts 重放计数绑 attempt id, #4 verify 失败的 current 不删 fail-closed. LOW 进 follow-up. R5 后无论结果都收口: APPROVED 即交; 否则 leadAcceptance 按 FLY-2443 先例, R5 条目逐字进 review.md, 只修阻断级, 不开 R6.

## 4. leadAcceptance 判定

- Codex 最终 verdict:`CHANGES_REQUESTED@R5`,R5 明确确认内核锁与 attempts 两项已闭合,剩余唯一阻断是第三项的一个结算分支,已在 v6 按 Codex 建议逐字落实;R5 未提出任何新 HIGH。
- 依据 Lead 裁定,记 leadAcceptance,不开 R6。residue = R5 MED(措辞,已折入)。
- 实施节点验收线:plan §9 完成定义 + §5 护栏(含 14 的 self-reapply 结算断言)+ C6/C8 测试。

## 5. 实施代码审查与 Lead follow-up 裁定

代码 review round 2：APPROVED，reviewedHeadSha
`504c6c090dd448ae7e818b60e9eaf16f9b3cff10`，request
`8302680b-8603-41c8-8638-0be360d3ddc2`，无 HIGH。
Lead question `56f2a00a-2160-4b17-91c6-3d1897e0bfdf` 裁定：仅补计划 guard16 的
SCAN_ROOTS 遗漏；其余七条不在本单修改，由 Lead 跟进，不再开启 advisory 闭合轮。

四条 MED 子单标题（由 Lead 立单，本节点未创建或派发）：

1. damaged-current-blocks-update：损坏 current 的更新/指定安装应提供明确恢复路径。
2. withdrawn-current-stuck-when-fallback-held：中央 fallback 被本地 hold 时，明确撤版 current 的止血策略。
3. explicit-install-undone-by-timer：明确显式降级与后续自动升级的用户选择持久性。
4. auto-update-on-failure-disables-default：开启失败后明确告知自动更新已关闭及恢复步骤。

三条 LOW follow-up 标题：

- prune-failure-reports-error-after-success：修剪失败不应覆盖已成功更新的结果。
- timer-reinstalled-while-off：关闭状态下人工命令重新加载 timer 的状态解释。
- ci-red-at-reviewed-sha：保留 diff 外 harness 红回执，按限定重跑与精确头 CI 完成验收。

已补的计划遗漏：consumers-lint-root-not-extended；扫描根加入
`packages/onboard-shell/lib`。临时违规 channel 探针在补丁前未被发现、补丁后被拒绝；
删除探针后 consumers-lint 3/3 与 Biome 通过。该补丁需新的精确头 review 与 CI。
