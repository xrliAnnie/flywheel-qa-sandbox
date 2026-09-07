# Design Review — plan.md (Round 4)

Date: 2026-09-06
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 已把 Round 3 的六项意见全部落实到明确的工作流、API、authority 与故障测试中，整体设计已经接近可实施。仍有四个会破坏预期安全语义的生命周期问题，以及两个文件系统/审计完整性问题；其中 health debounce 会按当前接线永远无法跨 tick 累积，owned pause 在主动停 Bridge 后也失去其续租与恢复通道，因此本轮仍需修改。

## What's Good (Keep)

- 保留 owned pause 的真实 API body、`leaseId` 续租/同租约 resume、quiescence 与 keyed lease 双重排空，以及 sweep 使用独立 pause 的方向。
- 保留 sweep 改用 `TEAMLEAD_API_TOKEN`，并在每次 unlink 前重查 comm shards、Bridge sessions、process、lease、quiescence、pause ownership 与 uptime；首写前零写、首写后明确 partial progress 的语义是正确改进。
- 保留把 keyed migration 收进 `codex-home.ts` 导出的类型化 API，并让 CLI 只做薄包装；并发测试现在描述的两个串行化结果与现有 `withMkdirLock`/lease 结构一致。
- 保留 `inventoryRoots` 与 `deletionTargets` 的严格拆分，以及 keyed、Lead、Raya、profile pool 永不进入删除集合的负面 fixture。
- 保留备份文件 fsync → 备份目录 fsync → rename → home 目录 fsync 的顺序，以及默认不产生凭据备份的边界。
- 保留 provision 的 missing-only 建链策略、错链/悬空链接 fail-closed、truth 的 `lstat + O_NOFOLLOW + fstat + 0600` 校验，以及回滚先恢复副本再部署旧代码的原则。
- 保留 Lead home 从经过 manifest/plist/projects 校验的 resident authority 推导，而不是从 `~/.codex-*` glob 猜测；probe 失败显式 severe 也优于静默漏检。

## Issues & Recommendations

1. **[HIGH] credential debounce 的状态按计划中的 `plugin.ts` 接线会在每次检查时被重建，因而永远到不了“连续两个 tick severe”。** §3 WS-C 写明 probe 保存上一 tick，但随后又让 boot 与 `onHealthTick` 每次都内联调用 `createCredentialProbe(...)`；这会为每个 tick 创建新实例并清空计数。现有 GatePoller 还会 fire-and-forget `onHealthTick`，boot check 与首个 tick、或慢 probe 与下一 tick，都可能重叠。建议在创建 GatePoller 前只创建一个长期存活的 `credentialProbe` 实例，boot 与所有 tick 复用它，并给 report/probe 加 single-flight（重叠调用共享同一个 Promise 或跳过，不得把同一观测计两次）。测试必须从真实 composition 层证明：同一个实例第一次 unparseable 为 warning、下一 cadence 才 severe、healthy 会复位，boot 与 tick 注入的是同一引用。另外补上 managed home 的 `auth.json` 缺失/`readlink` ENOENT 分类；当前 reason 表只覆盖错链和普通副本，Codex `logout` 删除家内 symlink 后没有定义结果，至少应归入 severe `link-drift`（或独立 `link-missing`）并有窗口 relink remediation。

2. **[HIGH] owned-pause driver 在主动停 Bridge 后会同时失去续租、quiescence 与 resume API，当前失败状态机不可执行。** §4.1 规定每 600 秒续租且“续租失败即中止”，但步骤 c 又主动停掉唯一提供该 API 的 Bridge；停机恰逢续租 tick 会被当成故障，而且“lease 仍在则回到 b”在 Bridge 已停时无法轮询 quiescence或续租。若脚本/主机在停机后崩溃，持久 state file 也没有规定 rerun 是接管原 lease、恢复 Bridge、继续还是安全 resume；TTL 在 Bridge 重启前过期还会让新 Bridge 短暂重新开放 admission。对 keyed migration，最简单的修复是不要停 Bridge：active owned pause + `quiescent=true` + lease 为空 + 与 admission 同一把锁已经构成充分 fence，可在 Bridge 存活并持续续租时迁移。若仍坚持停机，必须在停机前立即续满、定义最大 downtime/最小剩余 TTL、暂停预期中的网络续租错误、为 state file 定义原子持久化和 crash-resume 状态机，并在任何可能 lapse 的情况下禁止 Bridge 重新接受 admission。回滚还需在正文中显式 `bootout` 每个 Lead job 后再 `--unlink`；仅引用 a→b→c（其中只停 Bridge）会被 launcher 的 launchd guard 拒绝。

3. **[HIGH] active legacy execution 的验收 gate 仍在获取 pause 之前，存在可被真实 admission/reown 穿过的检查窗口。** runbook 第 0 步先做 dry-run，之后才设置 pause；在两者之间旧 legacy session 可以恢复/继续，`/api/admission/quiescence` 又只统计 readopt candidate、dispatcher inflight、launch claim 与 admission crossing，不统计已经运行的 legacy session，而 keyed lease 为空也捕获不到它。这样切换时仍可能留下一条持旧副本的 active execution，违反新增验收项。建议把第 0 步作为预检保留，但在 owned pause 已 active、`quiescent=true` 后再次运行同一套 legacy authority scan，并把第二次结果作为真正 mutation gate。与此同时，cutover driver 应枚举所有有效 marker/`.credential-copy-pending` 的 keyed homes、验证全部 lease 目录为空并逐个迁移或证明已链接；当前只硬编码 `agents/flywheel/implement`，与 WS-C/A6 声称覆盖所有受管 keyed homes 的合同不一致。增加“预检后、pause 前注入 legacy reown”和“出现第二个 pending keyed home”两个测试。

4. **[HIGH] Lead 的“同源 home→label authority”仍不是现有代码可调用的合同，而且选用 `--probe` 会把凭据探测错误地绑定到进程存活。** `resident-codex-lead-recover.sh` 当前只在函数内部把 plist wrapper 映射到 `codex_home_key`；label 来自调用参数组成的 `leadKey`，`lead-address.sh` 仅导出 `derive_codex_lead_home`，不存在计划所说可同时取得 `leadKey` 的三项共享映射。因此 WS-B 只能复制 case 表，不能真正与 patrol 同源。更重要的是，现有 `--probe` 在 `load_authority` 后还要求 launchd PID、argv 和进程环境完全匹配；Lead 被 bootout、因 auth 故障起不来或尚在启动时，health 无法取得 home，只会报未定义 remediation 的 `authority-unavailable`，恰好看不到应诊断的缺链/错链。建议在同一 helper 中新增纯 authority 模式（只执行 projects/manifest/plist/wrapper 校验，输出 `{codexHome,label,wrapper}`，不要求 live process），patrol 的 `--probe` 继续叠加进程证明；health 与迁移 guard 都调用前者。launcher/manual cutover 应传入明确的 project+lead tuple，避免按 home 反猜 label。补 stopped job 仍能解析并发现 link drift、wrapper/label 漂移拒绝、以及 `.codex-raya` 与跨仓 `~/.flywheel/raya/codex-home` 分别进入其声明 authority 的测试。

5. **[MEDIUM] sweep receipt 仍是 write-after-delete，崩溃窗口会产生“凭据已删但没有 durable receipt”的不可审计状态。** §3 WS-E 规定每次删除后立即 append receipt；进程或主机若恰在 `unlink` 与 append/fsync 之间失败，该 mutation 不会出现在 partial-progress 报告，重跑也只能看到文件已消失而无法区分“本次已删”与“原本不存在”。建议为每个目标先以 `O_APPEND` 写入并 fsync `phase:intent`（含 canonical path、inode/dev 或等价快照、chain sha8），再最终重验、unlink、fsync 被删除文件的 parent directory，最后 append+fsync `phase:applied`。启动时对未闭合 intent 通过 lstat 对账并输出 recovered/ambiguous；备份 TTL 删除使用同一协议。增加在 unlink 前、unlink 后但 applied receipt 前、以及目录 fsync 失败三个 kill/fault tests。相同地，migration 的 home-dir fsync 失败不应以普通成功退出 0 让 cutover 继续；应返回独立 partial/uncertain 状态并要求 health 重验后才能推进。

6. **[MEDIUM] “绝对 truth symlink”和 home 不得落入 truth 目录的合同仍可被当前路径定义绕过。** 现有 `sourceCodexDir` 原样接受 `FLYWHEEL_CODEX_SOURCE_HOME`，计划的 `codexCredentialTruthPath = join(sourceCodexDir(env), "auth.json")` 因而可产生相对 target，违背核心绝对链接要求；`resolve(home)` 只是词法规范化，最终 home 自身虽经 `lstat` 证明非链接，其任一祖先仍可能是 symlink，使 canonical home 实际位于 source dir 内。建议在边界要求 source home 为绝对路径，分别对已存在的 source directory 与 home 做 `realpathSync`，用 segment-safe `relative` 比较 canonical paths，并由 canonical/absolute source path 构造 symlink target；随后仍以 `lstat + O_NOFOLLOW + fstat` 校验最终 `auth.json`。测试加入相对 `FLYWHEEL_CODEX_SOURCE_HOME` 和“home 的祖先 symlink 指入 truth directory”两例。

## Verdict

CHANGES REQUESTED — address items above
