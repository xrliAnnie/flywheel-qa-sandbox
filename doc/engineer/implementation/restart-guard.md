# Restart Guard — 部署护栏运维页(FLY-913)

Issue: FLY-913
日期: 2026-07-06
相关设计: `engineering/doc/FLY-913-restart-guard-hook/`(exploration / research / plan)

## 是什么

全局 PreToolUse hook(matcher: Bash)`flywheel-restart-guard.py`:任何 Claude session 里
匹配「手动重启/杀 Flywheel 服务」的 Bash 命令被**硬 deny**,报错给出 founder 紧急入口
(`scripts/request-restart.sh`)。该入口只负责向 `self-ship-urgent.d` 原子写 token 并 nudge
独立的 `com.flywheel.updater`;正常变更则只等本地 00:00/12:00 班车。真正的全量重启由 updater 发起,发起 Lead 因而也在
被重启集合里。根因:手动 `launchctl kickstart` / kill+重拉会漏
pnpm build(跑旧代码)、漏 core 频道部署播报、无健康检查回滚(2026-07-06 事故,
一天 4 次)。口头承诺和 agent memory 都不强制行为,只有结构护栏强制。

拦截矩阵(case-insensitive,详见 plan §1):

| # | 模式 | 例子 |
|---|------|------|
| P1 | launchctl 变更类子命令 + `com.flywheel.` 同串 | `launchctl kickstart -k gui/501/com.flywheel.bridge` |
| P2 | kill 族 + flywheel 进程标识 | `pgrep -f run-bridge \| xargs kill -9`、`pkill -f claude-lead.sh` |
| P3 | 段首执行器直启 run-bridge(含 `bash -c "…"` 递归一层) | `nohup npx tsx scripts/run-bridge.ts &` |

**唯一即时入口**:`request-restart.sh`,且每次都要 founder 单独授权;merge 永不即时重启。
`restart-services.sh`(仓库/部署副本两个路径)仍不会命中 hook,但只作为 updater 内部实现,
不是 Lead 兜底入口。`update-flywheel.sh`、`launchctl print/list`、裸 `pgrep`、grep/rg/sed/cat
读源码、QA slot 的 worktree 直跑进程操作(不带 com.flywheel 标签)、无关 kill 也放行。

## Bypass(唯一成文处 — 别处不宣传)

真急救(如 updater/紧急票入口都不可用、Bridge 已死需要非常规操作)时,经 founder 单独拍板后在命令前
加**行首 env 赋值**:

```
FLYWHEEL_RESTART_GUARD_BYPASS="<非空理由>" <你的命令>
```

放行前置**缺一即 deny**(fail-closed):

1. 审计日志成功落行(`~/.flywheel/logs/restart-guard.log`,JSON lines);
2. `lead-alert.sh --strict-delivery` 的机器可读结果为 `sent` / `queued_transient`
   之一 —— 即 **Annie 在 #flywheel-alerts 必然看见一条 severe alert**
   (kind=`restart_guard_bypass`,per-invocation 唯一签名,每次 bypass 都响,
   不受日去重折叠)。`dead_lettered` / `config_error` / `duplicate` / 输出不可解析
   一律 deny —— claim 先于投递,`duplicate` 不能证明响过(Codex R2 #1)。

这是「响-bypass」形态;若 founder 在 ship gate 拍「完全封死」,实现侧删 bypass
分支即可(单测矩阵已隔离该路径)。

### Lead 救援(FLY-1602)

Lead 禁止用 `launchctl kickstart -k`、`flywheel-daemon.sh restart` 或直接强杀做救援；这些路径绕过 replacement intent、body sweep、identity lease 与 storm gate，可能留下「body 活着但 supervisor 已死」的孤儿态。正常部署等 updater 班车;即时重启只有 founder 单独授权的 `scripts/request-restart.sh` → `com.flywheel.updater` 紧急票。`scripts/restart-services.sh` 只供 updater 调用,不得作为 Lead 兜底第三路。

v2 scheduler 只会对精确 Lead launchd target 发 bounded `SIGTERM`，让 supervisor 自己 cleanup 后由 KeepAlive 重生；它和 `restart-services.sh` 通过 global/subordinate restart mutex 排他。SIGTERM 无响应时 scheduler 只 backoff，不升级 `SIGKILL`。此时等待当前 deploy wave 收敛,或请 founder 拍板后运行 `scripts/request-restart.sh`,由 updater 走 bootout → body sweep → controlled arm → bootstrap。若上轮留下 replacement marker，下一轮会先 reconcile；不需要也不应手工 `resume` lease。

审计日志:每次 deny 与 bypass 各落一行(ts / session_id / cwd / pattern /
decision / 命令截断 2KB / bypass 理由)。普通放行不记。

## 部署(Tier-1,零服务重启)

```bash
bash ~/Dev/flywheel/scripts/hooks/install-restart-guard.sh          # 安装/收敛
bash ~/Dev/flywheel/scripts/hooks/install-restart-guard.sh --uninstall  # 回滚(秒级)
```

= cp 到 `~/.flywheel/bin/flywheel-restart-guard.py` + jq merge 进
`~/.claude/settings.json` 的 `hooks.PreToolUse`(matcher "Bash",保 sibling)。
此后 `claude-lead.sh` 在每次 Lead 启动时收敛安装(防漂移)。hook 文件本体
per-invocation 现读,后续更新 = 重新 cp,真·零重启。

### 生效时机(诚实承诺)

- **新 session**:立即生效。
- **已运行 session**:依赖 Claude Code 的 settings file-watcher(官方文档:
  「Direct edits to hooks in settings files are normally picked up automatically」)。
  **真机实测(2026-07-06,implement 自测)**:向运行中 session 现装 hook
  (settings.local.json 写入后数秒内),同 session 内敲
  `launchctl kickstart -k gui/501/com.flywheel.nonexistent-…` **立即被 deny**
  —— file-watcher 对运行中 session 即时生效,无需重启。ship 时 QA 对全局
  `~/.claude/settings.json` 安装再复核一次。保守下限仍为:老 session 最迟在其
  下次正常 flow 重启后生效。

## 真机自测留证(implement 阶段,2026-07-06)

| 项 | 结果 |
|----|------|
| 手动重启命令(无害 target)| 被 deny,报错给出 request-restart.sh;审计落行(session `3a123b98`,pattern P1)|
| `restart-services.sh --dry-run` | 放行,正常输出计划 |
| `launchctl print` / 裸 `pgrep -f run-bridge` | 放行 |
| bypass 连发两次 | 两次都放行且**两条真实 severe alert 落 #flywheel-alerts**(msg `1523798719731077294` / `1523798724923363490`,间隔 1.2s —— per-invocation 签名击穿日去重)+ 两条 bypass 审计行 |
| file-watcher | 运行中 session 现装即时生效(见上)|

注:implement 阶段**未**安装进全局 `~/.claude/settings.json`(plan §3.1:PR merge
前不碰生产;且「响-bypass vs 封死」由 founder 在 ship gate 终拍)——上表用的是
worktree-local settings + 直接驱动 hook,测毕已移除。

## 已知盲区(接受理由见 plan §5)

| 盲区 | 说明 |
|------|------|
| 裸 `kill <pid>`(串内无 flywheel 标识) | 不可分类,拦会误伤;非事故形态 |
| 命令写进临时脚本再 `bash /tmp/x.sh` | 蓄意绕过,靠审计+纪律,非本护栏目标 |
| P1/P2 引号内研究型误报(grep needle 同串凑齐两标识) | 极罕见;deny 消息可读,改用 Read/分开 grep 即可 |
| 人在裸终端手动操作 | 不过 hook —— 天然的人类逃生口(设计如此) |

## 测试

- `python3 scripts/hooks/test-flywheel-restart-guard.py` — 模式矩阵 + bypass 契约
  + fail-open/fail-closed 不变量 + 真 lead-alert.sh 集成(77 例)
- `bash scripts/hooks/test-restart-guard-install.sh` — install/uninstall merge 矩阵
  (含现网 PreToolUse sibling 保全)
- `bash scripts/__tests__/lead-alert-strict-delivery.test.sh` — `--strict-delivery`
  五种结果 + 不带 flag 逐字节 reverse-compat + kind 平价(shell ↔ TS)

三者均已接入 CI(`.github/workflows/ci.yml`)。
