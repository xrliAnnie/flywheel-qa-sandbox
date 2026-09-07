# Design Review — plan.md (Round 1)

Date: 2026-09-06
Author: Codex
Status: CHANGES REQUESTED

## Summary

共享真身 + 绝对 symlink 的核心方向与 Codex 0.153.2 的原地 truncate 写入语义相容，也能消除新 spawn 持续复制轮换凭据的根因；现有并发实验足以支持继续采用这个方向。但当前计划在活体切换、Lead launcher、已移除的 READ_DENY 合同、清理权威性、健康探针和跨仓验收上仍有实施阻断或 fail-open 风险，尚不能进入实现。

## What's Good (Keep)

- 把设计锚定在 Codex 0.153.2 的实际 `save` / `logout` 行为和 6 进程轮换实验，而不是假设共享文件天然安全。
- 保留 FLY-2358 keyed home 的 key、lease、scrub 语义，并把 legacy / keyed 两条 provision 路径都纳入回归测试。
- `lstat` / `readlink`、真身 inode/bytes/mode、异向链接、删除 home 不解引用等验收点抓住了 symlink 方案最关键的 Node fs 语义。
- 将健康探针、Lead 误杀分类器、残留门、一次性 sweep 和班车窗口 runbook 一并纳入，整体 blast radius 意识是对的。
- 不扩展 MetaAlert reason、不改 Seatbelt 和 authority，符合当前代码库减少新状态机与耦合面的方向。

## Issues & Recommendations

1. **[HIGH] WS-A 会在没有排空活体的情况下自动迁移已有 keyed home，违反 A4，并可能在同一 home 的多 lease 之间热切凭据。** `provisionCodexAgentHome()` 每次准入都会持锁后调用 `provisionCodexHomeAt()`；锁只串行化 provision，并不证明该 home 没有其他活进程。部署 WS-A 后，只要已有普通 `auth.json` 的持久 home 再次 spawn/reown，就会立即换成链接；legacy home 也会被同一函数迁移，和 A5“旧 execution home 不迁移”冲突。建议把“缺失 auth 的新 home 建链接”与“已有普通文件迁移”分开：后者必须经过明确的 drain/lease/process 证明或停机脚本；补多 lease、reown、legacy 重 provision 的不热切测试。回滚也应先停/排空、原子 unlink，再部署旧代码，不能先 revert 后让旧 provision 写穿真身。

2. **[HIGH] 9/11 的应急命令不能保证提前刷新 9/12 的 business 链。** exploration 已确认 Codex 只在 access token 距到期约 5 分钟时主动刷新；9/11 执行一次普通 `codex exec` 时，9/12 03:27Z 到期的 token 通常仍不会刷新，因此 plan §4 的“让真身先于副本刷新”没有成立的后置条件。建议改为在已排空的班车窗口执行一次明确的 `codex login`，或在刷新窗口内运行经验证的受支持流程，并以真身的 exp/链元数据确实前进作为 gate；失败则停止切换并告警。

3. **[HIGH] Lead launcher 接入按现状不可执行，并且活体守卫会自我命中。** 七个 launcher 都是 `set -u`，但没有一个定义计划中的 `$REPO_ROOT`；只有三个调用 `derive_codex_lead_home`，所以“每个 launcher 在 derive 行后调用”的形状假设不成立。若链接调用放在 dry-run 分支之前，还会破坏现有 `FLYWHEEL_LEAD_DRY_RUN=1` 零副作用合同。更关键的是 launcher 已 `export CODEX_HOME` 后启动迁移子进程，通用 `ps -E` 搜索会看到父/子进程继承的同一环境并把空闲切换拒绝为“有活体”。建议逐 launcher 明确受验证的仓库根路径，只在真实启动分支调用；进程扫描仅识别真实 Codex 进程并排除调用者祖先，扫描不可用时 fail closed。测试需覆盖空闲时可切、真实 Codex 阻断、dry-run 零写、七个 launcher 的非零码传播。

4. **[HIGH] 计划重新引入了已经被 FLY-1241 明确删除并由 sentinel 禁止的 READ_DENY。** `read-deny-removed.sentinel.test.ts` 会扫描生产 `packages/` 与 `scripts/`，任何新增 `FLYWHEEL_CODEX_LEAD_READ_DENY` 都会失败；当前代码还锁定 infra-bot 不再发出该变量。建议从 WS-B、测试与负面守卫中删除 READ_DENY 分支，把历史 QA read-deny sandbox 明确列为不受支持的旧模式，不要为本单给 sentinel 加例外。

5. **[HIGH] 文件系统安全合同还不足以守住“唯一普通文件真身”。** `readCodexSourceAuth()` 当前只验证类型/非 symlink，没有验证 0600；legacy `provisionCodexHomeAt()` 对 home 只做 `mkdirSync` + `chmodSync`，并不存在计划声称的 home-symlink 现有守卫（Node 会跟随该目录链接）。脚本也未明确拒绝 `<home>` 等于 source home，错误调用 `~/.codex` 会备份真身后制造自指链接；unlink + symlink/copy 还有崩溃空窗。建议抽一个 provision/脚本共用的安全原语：对真身 `lstat` + `O_NOFOLLOW` 打开后 `fstat` 校验 regular/0600，所有 home 都先拒绝 symlink，拒绝 truth/home 同路径；在同目录构造临时 symlink 或 0600 普通文件并以 rename 原子替换。补 legacy-home-symlink、truth-home、自指、非 0600 和每个故障注入点的测试。

6. **[HIGH] sweep 的“无活体”判据没有接上当前分片 CommDB 权威，而且进程枚举失败语义未定义。** 当前会话库位于 `~/.flywheel/comm/<project>/comm.db`，现有 cleanup 代码会扫描所有项目分片；只用一个假 CommDB/固定库无法证明跨项目 legacy home 不活跃。此次环境中 `ps` 本身也可能被 sandbox 拒绝，若错误等价于“未发现进程”就会删除活体 home 的凭据。建议 `--apply` 必须成功枚举全部 CommDB 分片及权威 StateStore/session 视图，并成功完成进程与 lease 检查；任一缺失、不可读、schema 漂移或权限错误都应 abort/skip，绝不能算 inactive。增加非默认项目分片活体、不可读 DB、进程扫描失败、畸形/链接 auth 的测试。

7. **[HIGH] 健康分类器缺少优先级、抗撕裂状态和逐原因 remediation，当前“登录一次、无需重启”不成立。** 现有 `classifyCodexGlobal()` 是首个命中即返回的单结果分类器；计划未定义 credential severe 如何避免被更早的普通 warning 遮蔽。计划又同时要求 malformed JSON severe 和“单次瞬时失败不判死”，但无二次稳定读取或跨 tick debounce 状态，两个合同无法同时满足。并且 `codex login` 不能修复错误链接或文件 mode，链接漂移按 A4 还需要停进程后重建。建议定义稳定的 severity/reason 优先级；对解析失败做有界重读，或首 tick warning、持续失败才 severe；按 reason 给 remediation：登录修复缺失/过期真身，chmod/替换修复 mode，停机 relink 后重启修复 drift。日志与 alert body 都应采用同一分类结果。

8. **[HIGH] 新环境变量与 Raya 验收没有交付闭环。** `FLYWHEEL_CODEX_EXTRA_HOMES`、`FLYWHEEL_CODEX_LINK_DEADLINE` 未加入 `packages/config/src/feature-flags/truth.ts` 的 FLYWHEEL env 注册/校验，也没有部署步骤设置 Raya home 或定义 deadline 为空时的精确语义；因此 Bridge 默认不会检查生产 Raya。与此同时 §4 说 Raya 接入不影响本单，而 §5 又要求 Raya 与 Lead 全绿，验收相互矛盾。建议把两个变量的注册、解析、配置传播与单测写进 WS-C，并把 Raya 仓 change 的 owner、版本/commit、部署顺序和观测证据设为阻塞依赖；否则明确缩小本单验收，不能同时声称已满足 Raya 条件。

9. **[MEDIUM] `source:"migrate"` 目前既不能通过类型检查，也会在运行时被拒绝。** `codex-account-core.d.mts` 和 `codex-account-core.mjs` 只接受 `status|use|save|provision`，运行时会对未知 source 抛错；计划未列出这两个文件。建议要么有意复用 `provision`，要么同步扩展运行时 allowlist、类型声明、snapshot/ledger 读取兼容与测试，并规定旧副本解析或 ledger 写入失败时必须在 unlink 前终止。

10. **[HIGH] “全机唯一普通凭据”与备份/旧 home 的实际范围冲突，且 §7 对旧 refresh token 的断言不正确。** 计划保留完整的 `auth.json.pre-fly2404.*`，现有 profile pool 也有普通 `auth.json`；A5 还让旧 execution home 留到一周后再 sweep。exploration 显示其余 767 个旧 home 含 school/personal 的多条独立链，它们不会因为 business 真身轮换而全部失效，所以“refresh token 已随真身轮换作废”不能成立。建议优先不保存原始凭据备份，只记 identity/hash 元数据；若必须保留，明确隔离目录、TTL、purge owner 与验收。并按链/内容指纹重新盘点残留（不输出 token），把独立有效链的处置纳入切换 gate，或把“一份凭据”的声明严格缩小到受管活跃 homes。`--purge-backup` 也应删除或补齐精确语义与测试。

11. **[MEDIUM] 共享真身后的 auth-race 修正只覆盖 Lead，通用 fallback 仍会误报。** `scripts/codex-with-fallback.sh` 仍把任何 `refresh_token_reused` 直接分类为 `AUTH_EXPIRED`，计划只改文案；这与共享真身下已经实证的良性竞争失败相冲突。建议复用同一真身健康判据，至少把该信号降为“可能是良性竞争，查看 credential probe”，且先区分 usage/rate-limit，避免继续指导 operator 做无效的 profile 轮换。

## Verdict

CHANGES REQUESTED — address items above
