# FLY-2265 切号失败诊断 — QA 交接

Issue: FLY-2265 (https://linear.app/geoforge3d/issue/FLY-2265/切号器-flywheel-claude-profile-use-name-在凭证两侧健康时仍-flywheel-manual-switch)
日期: 2026-09-02
基于: plan.md

## 1. 当前结论

根因是 FLY-2240 引入的公开 Bash trampoline 没有把解析到的自身绝对路径导出为 `FLYWHEEL_CLAUDE_PROFILE_BIN`。Node 切号执行器脱离父进程后回退到裸命令 `flywheel-claude-profile`；当该命令不在 `PATH` 时，spawn 在 Bash 审计 `entry` 之前以 `ENOENT` 失败，外层又只输出 `reasonCode=apply_failed`。

本实现把绝对路径显式传进 Node 子进程，保留公开 `use <name>` 的同一入口；同时让 `apply_failed` 的非秘密错误文本进入 stderr 和失败审计，并把新建审计文件强制收紧为 `0600`。对已启动、会自行写审计的 Bash apply 子进程，通用 `apply_failed` 路径不再追加重复 fallback 记录。

本单没有切换任何生产账号，没有修改生产 Keychain/账号账本，没有重启服务，也没有 merge 或 deploy。

## 2. QA 必须判定的四项标准

1. **隔离 store 的真实 `use` 红绿对照**：在临时 HOME、临时账号 store、假 Keychain 和假 freshness/identity 依赖下，通过公开 `packages/claude-runner/bin/flywheel-claude-profile use <healthy-name>` 复现修前 `apply_failed`；同一命令、同一 fixture 在修后必须 rc=0，目标凭证与 active marker 一致。不得用生产 `personal1` 或真实 Keychain 做验证。
2. **无环境兜底回归**：显式 unset `FLYWHEEL_CLAUDE_PROFILE_BIN`，并从 `PATH` 移除任何 `flywheel-claude-profile` 可执行文件；仍从公开 trampoline 发起健康账号 `use`，必须成功。该用例必须证明 Node 子进程收到 trampoline 解析出的绝对路径，而不是偶然命中开发机 PATH。
3. **daemon 自动路径同入口覆盖**：执行 `quota-monitor-runtime` 的自动切换测试，确认其最终经过与手动切换相同的 `executeSwitch -> applyProfile -> flywheel-claude-profile` 入口，并在 scrubbing PATH 的条件下完成 apply。不得启动或重启生产 daemon。
4. **四条失败出口的审计与权限**：分别制造 `keychain_preimage_conflict`、`live_identity_unavailable`、`identity_rollback_failed`、`freshness_unavailable`；每次调用只能产生一组对应的 `phase=entry` / `phase=exit, exitCode!=0`，`details` 必须包含去敏后的原因，且首次创建与已有日志两种场景的文件 mode 都必须是 `0600`。出现零组或重复组均判定 QA 不通过。

## 3. 已实现的审查补强

- 已 rebase 到最新 `main`，并删除与 FLY-2258 重复的 kill/inventory 改动；本分支只保留 FLY-2265 诊断和切号路径修复。
- Node fallback 与 Bash 原生审计的首次文件创建都显式 `fchmod(0600)`；严格 umask 测试证明权限不会被调用者 umask 放宽。
- 通用 `apply_failed` 在 Bash apply 子进程已启动时不再追加 Node fallback，正常失败集成用例断言恰好一组两条审计记录。

## 4. 第二轮代码审查已知项

第二轮代码审查已 APPROVED；下列六项是非阻塞 advisory，按 Lead 指令不在本轮继续修改，QA 应如实记录结果：

1. `keychain_preimage_conflict`、`live_identity_unavailable`、`identity_rollback_failed`、`freshness_unavailable` 四条类型化失败分支仍可能追加重复 fallback 审计。
2. 当前去重信号表示 apply 子进程“已启动”，并不严格等价于 Bash 已成功写入 `entry`；若失败发生在 `begin_audit` 前，可能漏掉 fallback。
3. 审计首次创建的 `O_EXCL` 与后续 open 分离存在窄竞态；当前策略是拒绝 mutation（fail closed），不会放宽文件安全检查。
4. `apply_failed` 会透出并记录 child stderr 全量文本；虽有凭证结构/令牌去敏，仍需关注其他潜在敏感输出。
5. `FLYWHEEL_AUDIT_ACTOR=""` 时，Bash 与 Node fallback 的 actor 默认行为不完全一致。
6. freshness 预检的 exit 31 路径目前不可达。

## 5. 自动化证据

- `pnpm lint`：通过，只有 14 条既有 warning。
- `pnpm -r build`：22 个 workspace project 通过。
- `packages/claude-runner` profile suites：125/125 通过。
- TeamLead 相关单测和集成测试：206/206 通过，其中真实公开 CLI 集成 11/11。
- Core 非 GUI：219/219 通过；完整 `pnpm test:packages:run` 唯一失败是无 GUI 环境中 Terminal.app/AppleEvents 的 `Connection Invalid`（2 个既有 GUI 测试），其余路径通过。
- 第二轮跨家族代码审查在实现 head `8c5bd317d02d719fc7ea44bd99b5e3e232030655` APPROVED；本地 `codex:rescue` companion 两次均在访问仓库前因 macOS sandbox helper status 71 失败，未使用 raw `codex exec`。

## 6. QA 边界与回填

- QA 只能使用隔离 HOME/store/Keychain stub，不得把真实账号切到 `personal1` 或任何其他账号。
- 不得 merge、deploy、重启 Bridge/Lead/daemon，也不得把自动化 fixture 结果描述成生产切号成功。
- 将四项标准逐条回填为 PASS/FAIL，并附命令、退出码、审计记录数、日志 mode 与去敏后的 stderr；任一项缺证即保持 QA pending。
