# Companion Lead Ship 纪律 — merge 后 repoint 回 main + 纳入 launchd

**Issue**: FLY-250 (Mufasa repoint 到 main + launchd 收编)
**Date**: 2026-06-10
**Source**: FLY-250 Mufasa cutover 实录;FLY-224 (PR #244) / FLY-231 (PR #239) ship 漏项教训;Belle repoint 先例 (2026-06-09)

## 规则

> **凡是从 feature worktree 跑起来的 companion/vendor Lead,其 PR merge 后必须 repoint 回主仓 main dist 并纳入 launchd 管理。这一步是 ship 流程的标准一环 —— 没做完,ship 不算收尾,feature worktree 不许删。**

FLY-224 和 FLY-231 都漏过这一步:merge 后 Belle 继续从 fly-231 worktree 错跑(后被发现重配),Mufasa 继续以手动进程从 fly-224 worktree 跑(无 KeepAlive,残留进程难清)。FLY-250 即为补这两笔欠账而立。

## 为什么

- **worktree 是临时物**:生产 Lead 钉在 worktree 上,worktree 就清不掉(清理被进程引用阻塞);且 main 前进后 worktree 的 dist 停在旧代码,Lead 与生产代码静默漂移。
- **手动 launch 没有 KeepAlive**:crash / 重启机器后 Lead 不自起;retire 时容易漏杀(FLY-250 开题时疑似 3 个 `claude-lead.sh mufasa-lead` 残留进程)。
- **已知坑**:手动跑 `claude-lead.sh` 会注入空 `DISCORD_BOT_TOKEN`("Real env wins" 跳过 .env)→ Lead 必须走 launchd plist 生产路径(2026-06-03 joycon/sub 上线经验)。

## 经过验证的 cutover 流程(FLY-250 Mufasa 实录,2026-06-10)

1. **建 thin wrapper**(`~/.flywheel/bin/flywheel-codex-lead-wrapper-mufasa.sh` 模式):
   - `set -a` source `~/.flywheel/.env` —— bot token 进 env 不进 plist 明文(FLY-199 教训:launchd argv 明文 token 要轮换);
   - 扩 `PATH`(launchd 只给 `/usr/bin:/bin:/usr/sbin:/sbin`,node/codex/jq 都在外面);
   - 把运行时 pin 到主仓(Mufasa 例:`FLY224_WORKTREE=/Users/xiaorongli/Dev/flywheel`);
   - `exec` 主仓 launcher(exec 替换 wrapper 进程,launchd 直管真实进程的 PID/signal);
   - 头注释写明回滚路径(bootout job → 按旧方式手动 launch)。
2. **写 plist** `com.flywheel.lead.<dept>-<lead>.plist`:`ProgramArguments` = wrapper、`KeepAlive=true`、`ThrottleInterval=30`、`RunAtLoad=true`、stdout/stderr 落 `/tmp/flywheel-lead-<dept>-<lead>.log`。旧 plist 不删,改名留 `.pre-FLY-XXX.bak`。
3. **先改配置再杀进程**(与 [bridge-ship-discipline](bridge-ship-discipline.md) 同款原则)。kill 旧手动进程前**核 PID 命令行**,逐个精准杀,绝不裸 pattern sweep(红线:不碰 Bridge / 其他 Lead / QA slot)。
4. **bootstrap launchd job**,验 KeepAlive 自起(Mufasa 实测 kill 后 1s 内拉起)。
5. **健康验证(机器面)**:
   - `launchctl list | grep <lead>` 有 job 且 exit status 0;
   - `ps` 命令行确认进程路径 = **主仓 dist**(非 worktree);
   - per-Lead 隔离 env 实查(Mufasa 例:`ps eww <pid>` 见 `CODEX_HOME=~/.codex-mufasa`);
   - Discord 连接 ESTABLISHED;
   - 会话连续性铁证(Mufasa 例:thread-id 与 cutover 前逐字一致 = 记忆延续);
   - `ps` 全表无残留旧进程(退役进程必须 ps 验证,不许"收工对话 ≠ 进程死")。
6. **硬停止点(用户面验证)**:删 worktree 前必须等 Annie 在真实频道(如 #mufasa)聊天确认 Lead 正常回话。**机器面全绿 ≠ 用户面 OK**,这一步不可跳。
7. **清 worktree**:删前 `git worktree list` + `ps`/`lsof` 复核无活进程引用;`--force` 仅用于带 `.myco_state` 等垃圾的 worktree;**merged 分支不删**(默认,只删 worktree)。
8. **流程文档/记忆更新**:本文档 + MEMORY.md 同步,Linear issue 收尾。

## 先例

| 日期 | Lead | 问题 | 处置 |
|------|------|------|------|
| 2026-06-09 | Belle (personal-assistant) | FLY-231 merge 后没 repoint,从 fly-231 worktree 错跑 | 改 plist wrapper 回标准版(指 main) |
| 2026-06-10 | Mufasa (growth, Codex Lead) | FLY-224 merge 后仍手动 launch + fly-224 worktree,无 KeepAlive | FLY-250 全套 cutover(本文档流程) |
