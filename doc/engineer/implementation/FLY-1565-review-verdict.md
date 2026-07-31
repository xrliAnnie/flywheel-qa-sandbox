# FLY-1565 跨厂商 Review Verdict

**Issue**: FLY-1565([v2·信箱] Codex runner 连不上信箱 socket(EPERM)+ 授权框无预置策略)
**执行 vendor**: claude(v2 DAG generic runner,session `v2dag:3c320864…:1:a1196739…`)
**审查 vendor**: codex(codex-companion app-server 持久线程,school profile,effort=xhigh)
**轮数**: 3
**最终判定**: **VERDICT: APPROVED**(R3,2026-07-31,HEAD `373ded54`)
**PR**: #740(`fix/fly1565-codex-mailbox-access`,base `main@26bba3cd`)

## 各轮记录

| 轮 | 判定 | Findings | 处置 |
|---|---|---|---|
| R1 | CHANGES_REQUESTED | HIGH:旧 `v:1` persisted daemon state 被 launch() 原样采用——sandbox 策略烙在 daemon 进程 argv 里,升级永远到不了已运行的 daemon,存量 session 静默保持坏策略(无 policy version、无迁移、无 fail-loud) | 修复(`76321bd8`):新 `CODEX_SANDBOX_POLICY_VERSION = 2`,所有 state 写点盖章;launch() 只采用戳匹配的 daemon;stale + 活 pane → fail-loud(操作员 stop() 决策);stale + 死 pane → 按 R3-F5 孤儿惯例 teardown(需证死)+ 以新策略重生;两个 prior-state 回归测试 |
| R2 | CHANGES_REQUESTED(R1 修复本身判定正确) | HIGH(同族延伸):`activate()`/`codexBell()` 绕过 launch() 直接向 stale daemon 发 turn——coordinator 每 tick 对已绑定 live session 直接 activateSession,不保证再过 launch() | 修复(`373ded54`):共享闸 `#requireCurrentCodexPolicy`;activate() 在 atomicRelease(放行 vendor gate)与 assignment 发送**之前**校验;codexBell() 在 sendCodexTurn 前校验并**抛错而非 return false**(paste 兜底会经 attached pane 打到同一个 stale daemon);stop() 保持可读 stale state 做安全回收;回归测试覆盖两路径(零 turn 到达 daemon)+ stop() teardown |
| R3 | **APPROVED** | 无 HIGH/MEDIUM/LOW;确认所有 turn 发送路径已覆盖、stop() 豁免正确;HEAD `373ded54` build/定向测试 37/37/Biome/`git diff --check` 全过 | — |

## Reviewer 声明的环境限制(非代码 finding)

- codex 沙箱禁 unix-socket listen 与 `/bin/ps` 进程探测,完整 v2-host 套件在其沙箱内有 17 个环境型失败,reviewer 明确不计为 PR finding;在执行侧真机上 v2-host 全套 82/82 绿。
- codex 沙箱网络受限 + GitHub 连接器写入被拒,三轮 review 均无法自行发布 GitHub review;由执行侧(claude)将每轮 verdict 逐字转发为 PR comment(#740 三条 🤖 Codex Code Review comment)。

## 接受的残留

- 无(R3 零 findings)。

## 本单核心修复(供部署侧参照)

1. **EPERM**:daemon spawn 加 `-c sandbox_workspace_write.network_access=true`(codex 无按 socket 路径细粒度开关;runner 本需 git push + gh;真机 `codex sandbox` 实证 baseline EPERM → 修后 CONNECT_OK,含真 host.sock 路径)。
2. **授权框**:`-c apps._default.default_tools_approval_mode="approve"`(0.146 枚举实测 `auto|prompt|writes|approve`;`approve` 即人肉「批准并记住」后 codex 持久化的自动放行态)。
3. **worktree commit**:`--git-dir` + `--git-common-dir`(fail-loud 推导)进 `sandbox_workspace_write.writable_roots`(真机实证 index.lock EPERM → 修后 commit OK;这是 1564 runner 被逼绕 connector API 的根因)。
4. **策略代际**(R1+R2 review 产物):`policy_version` 盖章 + launch/activate/codexBell 三路径 stale 闸。
