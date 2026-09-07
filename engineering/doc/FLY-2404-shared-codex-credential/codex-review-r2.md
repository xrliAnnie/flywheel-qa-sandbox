# Design Review — plan.md (Round 2)

Date: 2026-09-06
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已实质性关闭 Round 1 的大部分问题：普通文件不再由 provision 热切、应急刷新改为 `codex login` 后置 gate、READ_DENY 不再复活，文件安全、健康分类、Raya 范围和 fallback 也明显更完整。仍有几处会使班车切换不可执行或让健康/清理结论失真的生命周期缺口，尤其是 keyed lease 的真实路径与持久语义、launcher 内 launchd 自检顺序、健康 home 枚举范围及 sweep 的 mutation-time fence，因此本轮仍不能批准实现。

## What's Good (Keep)

- `auth.json` 缺失才由 provision 建链接、普通文件保持副本并打 `.credential-copy-pending`，正确拆开了“新生默认”与“存量迁移”。
- 9/12 应急路径已改成 `codex login`，并用 `last_refresh` 与 exp 前进作为后置 gate；明确否定普通 `codex exec` 能提前刷新，修正准确。
- READ_DENY 已从生产设计和测试要求中完全移除，没有削弱 FLY-1241 sentinel。
- `lstat` + `O_NOFOLLOW` + `fstat` + 0600、legacy home 目录守卫、自指拒绝、临时链接后 rename，以及先 unlink 再回滚旧代码，整体文件系统方向正确。
- launcher 已收窄到三个真实生产形态，使用自身脚本路径并保留 dry-run 零副作用合同。
- credential 分类与 binary 分类分离、固定跨域优先级、有界重读/两 tick debounce、逐 reason remediation，解决了 Round 1 的误报与错误恢复指引。
- 配置变量注册、Raya 跨仓依赖与验收缩小、默认不留原始备份、旧链只盘点不声称已失效，边界现在诚实得多。
- `codex-with-fallback` 将 usage/rate-limit 置前并对健康真身下的 `refresh_token_reused` 降级，和并发实验结论一致。

## Issues & Recommendations

1. **[HIGH] keyed drain proof 检查了错误的 lease 路径，而且“停 Bridge ⇒ lease 归零”与 FLY-2358 的持久 lease 设计相反。** Plan WS-B 检查 `<home>/leases/`，实际常量是 `.flywheel-leases`，读写点也全部位于 `<home>/.flywheel-leases/<executionId>`。若按计划实现，脚本会在 live lease 存在时仍允许迁移。反过来，runbook §4.1 假定停 Bridge 会清空 lease，但这些文件正是为 Bridge crash/restart reown 而持久化的，停止进程本身不会调用每个 handle 的 `releaseCodexAgentHomeLease()`。建议改成真实 `.flywheel-leases`，先通过正常终态/显式 retire 排空所有 reownable sessions 并证明目录为空，再停 Bridge；补“Bridge 停止后 lease 仍在则拒绝”和 crash/reown 用例。

2. **[HIGH] 即使修正目录名，keyed home 的“检查为空 → rename”仍未与准入使用同一把锁，存在 check-to-write 竞态。** `admitCodexAgentHome()` 会在 `agents/<project>/.locks/<role>` 的 `withMkdirLock` 临界区创建 lease；bash 脚本在空检查后、rename 前可以被一次新准入穿入。runbook 停 Bridge 能降低生产窗口风险，但脚本合同本身允许独立调用，launcher/Raya 接入也不能把这个假设当原子 fence。建议让 keyed 迁移走一个 claude-runner Node helper，在同一 `withMkdirLock` 内重验 marker、`.flywheel-leases` 和目标后完成 rename；shell 只负责外部 process/launchd gate。增加“检查后并发 admit”确定性栅栏测试，必须证明 admit 或迁移只有一方成功。

3. **[HIGH] launcher 中的 launchd guard 会把当前正常启动的 job 当成活体，且计划把幂等判断放在 guard 之后。** 迁移脚本由 launcher 自己执行时，`launchctl print gui/$UID/<label>` 已会显示该 job 为 running；按步骤 2→3，它甚至在 `auth.json` 已是正确链接时也先退出 3，所以 runbook 首次手工迁移成功后，下一次正常 launchd 启动仍会失败。建议先安全校验真身并检查“已经指向真身”的只读幂等状态，命中就立即返回 0；只有确实要写时才执行 process/lease/launchd drain。首次存量迁移仍必须在 job bootout/disabled 的窗口手工完成。测试需模拟“当前 launchd job=running + 正确链接 ⇒ already/0”和“running + 普通文件或错链 ⇒ refused/3”。

4. **[HIGH] credential health 的 home 枚举范围与 A6 的“受管活跃家”不一致，当前机器上无法达到计划声称的全绿。** `~/.codex-*` 是历史/QA/手工 home 的宽泛命名约定，不是生产 Lead 注册表；当前主机实际匹配 19 个目录，其中 17 个持普通 `auth.json`、2 个测试目录没有 `auth.json`，而 runbook 只迁移 Mufasa 与 infra-bot。deadline 后这些目录会持续产生 `copy-pending`/`link-drift` severe，甚至前置条件“只报 copy-pending warning”也会被缺 auth 的测试目录打破。`agents/*/*` 的实现若用 `readdir` 还必须显式排除 `.locks`，不能依赖 glob 默认。建议从权威清单发现 homes：keyed home 必须带有效 `.flywheel-agent-home.json`，Lead home 来自 `lead-address`/运行配置的明确生产映射，Raya 只来自 EXTRA_HOMES；历史 `~/.codex-*` 可进 inventory 指标但不能进入受管健康 verdict。非法 EXTRA_HOMES 也应产生配置 severe，而不是 warn 后忽略，否则 Raya 可被静默漏检。补 `.locks`、QA home、无 auth 测试 home 和非法 extra 的负面用例。

5. **[HIGH] provision 仍会在活体 home 上自动修复“指向别处的 symlink”，继续违反 A4 的存量只经 drain 脚本切换。** 决策表只保护普通文件；已有错链/悬空链在多 lease keyed home 或 reown legacy home 中会被 `placeCredentialLink()` 原子但热态地换目标。原子替换不等于生命周期安全。建议 provision 对任何非真身链接只记录/抛出 `credential_link_drift`，由 health 告警并要求 WS-B 脚本排空后修复；只有 auth 路径完全缺失的新家可直接建链接。相应把现有“错链自动重建”测试改为“provision 拒绝零写，drained script 修复”。

6. **[HIGH] sweep 仍只有观察时检查，没有 mutation-time fence；活体可在最后一次快照后、`unlink(auth.json)` 前重新出现。** 全 CommDB + Bridge + ps + lease 的 fail-closed 组合解决了“检查失败当无活体”，但没有解决检查成功后的 TOCTOU：Bridge 可以在 `/sessions` 返回后 reown/start 同一 legacy execution，随后 sweep 删除其正在使用的凭据。建议定义一个能阻止新 start/reown 的维护 fence，或通过 Bridge/StateStore 的原子操作为候选 execution 取得删除授权，并在 unlink 紧前于同一权威下重验；至少加入“最终检查后并发 reown”测试。还应写清真实接口是带认证的 `GET /api/sessions?mode=active`、Bearer token 的来源和响应完整性；否则生产 Bridge 开启 apiToken 时 sweep 只会全量 skip。

7. **[MEDIUM] `--keep-backup` 的“move 副本”破坏了默认路径所建立的原子替换保证。** 若先把 `<home>/auth.json` 移到隔离目录，再执行临时 symlink + rename，二者之间 home 没有凭据；崩溃或第二步失败会留下不可启动的 home，跨文件系统时 move 还可能直接失败。建议以 `O_NOFOLLOW` 已验证的字节创建 `O_EXCL` 0600 备份并 fsync，保留原 auth 在位，然后仍用临时链接 rename 原子覆盖；备份失败则零改动。增加“备份完成后、链接 rename 前故障”测试，后置条件必须是原 auth 仍在或正确链接已在，不能缺失。

8. **[MEDIUM] 9/12 runbook 没有盘点仍活着的 legacy execution homes，健康全绿也看不到它们。** FLY-2358 明确保留并 reown 部署前的 `<root>/<executionId>` home；A5 又规定 sweep 跳过活体，而 WS-C 只探 keyed/Lead/Raya。founder 登录换链后，这些 runner 仍持旧副本并可能在到期时失败，但 §4 的绿色信号不会暴露这一风险。无需扩大 A6 到迁移所有历史目录，但 runbook 至少应在切换前列出 active legacy executions，并要求它们完成/显式重启到新 home，或记录逐 execution 的接受风险与 owner；验收证据应证明列表为空或每个例外都有处置。

## Verdict

CHANGES REQUESTED — address items above
