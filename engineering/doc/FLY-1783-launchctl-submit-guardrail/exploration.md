# FLY-1783 launchctl submit 旁路补拦 — 探索

Issue: FLY-1783 (https://linear.app/geoforge3d/issue/FLY-1783/infraguardrail-补拦-launchctl-submit-旁路-detached-重启只许走-request-restartsh)
日期: 2026-08-15
基于: 无

## 1. 事故背景(为什么开这张单)

2026-08-14 23:33,Tadashi 想发一个「能活过自己本体换代」的 detached 全量重启:

1. 先试 `nohup setsid bash restart-services.sh --force` → macOS 没有 `setsid` 命令,失败;
2. fallback 改用 `launchctl submit -l com.flywheel.restart-bus-manual -- /bin/bash .../restart-services.sh --force`。

`launchctl submit` 的语义是 **KeepAlive**:job 每退出一次,launchd 就再拉起一次(最小间隔约 10 秒)。而 `restart-services.sh --force` 本身只是 detach 出真正的重启进程后几秒就退出 → 每约 10 秒 spawn 一个新重启,累计 66+ 次,连环触发 FLY-1501 restart-storm gate 自锁,Bridge down 20 分钟(23:35–23:55)。止血靠 Annie 手动 `launchctl remove` 拆源 + 按 runbook resume storm gate。

完整报告:`~/.flywheel/incidents/2026-08-14-restart-loop.md`。本单只治**根因①(submit 旁路)**;storm gate 自锁(根因②)是另一张单,不在本单范围。

## 2. 现状审计(greenfield 禁令 — 先读真实代码)

### 2.1 FLY-913 护栏现状(`scripts/hooks/flywheel-restart-guard.py`)

PreToolUse hook(matcher: Bash),部署在 `~/.flywheel/bin/`,经 `~/.claude/settings.json` 挂到**本机所有 Claude Code 会话**(Lead + Runner),每次 Bash 调用前执行。三个 block 模式:

- **P1**:`launchctl` + mutating 子命令 + 命令串含 `com.flywheel.`。mutating 列表 = `kickstart|bootout|bootstrap|kill|stop|unload|load|enable|disable|remove` — **没有 `submit`**。这就是事故命令穿过护栏的直接原因:`launchctl submit -l com.flywheel.restart-bus-manual …` 的 label 含 `com.flywheel.`,第二条件本来是命中的,只差子命令一词。
- **P2**:kill 家族 + flywheel 进程标识(`run-bridge|claude-lead.sh|flywheel-bridge-wrapper|flywheel-codex-lead-wrapper|com.flywheel`)。注意 `restart-services` **不在**标识表里 — `pkill -f restart-services`(杀在飞 wave,事故 runbook 明令禁止)今天不会被拦。
- **P3**:executor 首 token + `run-bridge` 的裸手 Bridge relaunch。

bypass 记账合同(audit 行 + strict alert 双前置,fail-closed)已经很完善,本单不动。

### 2.2 restart-services.sh 的 detach 现状 — **issue 假设需要修正**

Issue 交付项 2 写的是「restart-services 自身的 detach fallback 链修正:macOS 无 setsid 时不得落到 launchctl submit」。**实际审计结果:restart-services.sh 里根本没有 setsid,也没有 launchctl submit fallback 链。** 它的 self-detach(`scripts/restart-services.sh:1233-1242`)是:

```bash
set -m
FLYWHEEL_RESTART_FOREGROUND=1 nohup "$0" "${RESTART_ARGS[@]}" </dev/null >>"$detach_log" 2>&1 &
disown "$detach_pid"
```

`set -m`(独立进程组)+ `nohup` + `&` + `disown` — 这条链在 macOS 上是完备的,child 能活过发起 Lead 的 pane 换代。**事故里那条 setsid→submit 链是 Tadashi 在自己 shell 里手拼的**,不是脚本的代码路径。

所以交付项 2 的真实含义要翻译成:
- (a) **防未来倒退**:用测试合同物理禁止任何人往这三个重启脚本里加 `setsid` / `launchctl submit`;
- (b) **fail-loud 补强**:self-detach spawn 失败目前是静默的(child 秒死没人知道),补 spawn 验活;
- (c) **结构性自卫**:就算护栏被绕过(裸终端的人、没装 hook 的新 agent),restart-services 自己要能认出「我被 launchd 直接当 job 拉起」这个必然错误的形态并拒跑 — 把「灾难性无限重启循环」降级成「无害的嘈杂拒绝循环」。

### 2.3 正路(request-restart.sh,FLY-1671,已在 main)

`scripts/request-restart.sh` 只做两件事:解析 origin/main 精确 SHA → 复用 FLY-270 `self-ship-pending.d` marker 入队 + nudge `com.flywheel.updater`。真正的重启由 updater(`scripts/update-flywheel.sh`,舰队之外的 launchd job)收敛 origin/main 后执行:

```
launchd(QueueDirectories 触发)→ /bin/bash update-flywheel.sh   [ppid == 1]
  └── FLYWHEEL_RESTART_FOREGROUND=1 restart-services.sh --reason updater   [ppid = updater 的 bash ≠ 1,且 FOREGROUND=1]
```

关键实测(2026-08-15,本机):launchd 直生进程 ppid==1 已在活 Bridge 上确认(`ps -o ppid= -p <bridge>` → 1);而正路链条里 restart-services 的 ppid ≠ 1 **且** FOREGROUND=1 — 双重豁免,详见 research.md。

### 2.4 Lead rules 现状

`packages/teamlead/lead-rules-base/founder-only-authority.md` 对每个工程型 Lead(cos + dept、Claude + Codex 两 vendor)普适装载(claude-lead.sh:2599 + FLY-350 Codex role-aware rule-bundle)。目前没有任何 restart 纪律条款。Codex Lead **没有 PreToolUse hook**(那是 Claude Code 机制)— 对 Codex Lead 唯一的约束层就是这份合同(FLY-350 既定的 contract-only 信任形态),所以红线必须落进这个文件。

## 3. 方向探索

### 方向 A:只加 `submit` 一个词进 P1(最小改)

一行改动,事故命令被拦。**否**:label 换成非 `com.flywheel` 前缀(`-l com.foo.x -- bash …/restart-services.sh`)就穿了 — P1 第二条件只认 label 串。护栏哲学(FLY-913 plan)是拦「形态类」不是拦「那一条命令」。

### 方向 B:护栏扩展(P1 补词 + 第二条件扩成 label∨restart-脚本名)+ restart-services 结构性自卫 + 测试合同 + rules 红线 ← **选定**

四层互补,每层独立成立:

| 层 | 拦什么 | 覆盖谁 |
|----|--------|--------|
| ① 护栏扩展 | agent 发出的 submit/等价 scheduler 旁路命令 | 本机所有 Claude 会话(Lead+Runner) |
| ② restart-services 自卫(ppid==1 拒跑) | 任何已经建成的 launchd 直跑 job(护栏被绕过后的最后一道) | 所有调用方,含裸终端的人 |
| ③ 测试合同(source-level 静态断言 + 行为回归) | 未来有人往脚本里加 setsid/submit 链的倒退 | 代码库本身 |
| ④ rules 红线 | 没有 hook 的 vendor(Codex Lead)+ 行为层教育 | 全部工程 Lead |

### 方向 C:再进一步 — 拦掉一切 launchctl bootstrap/load 非标准 plist

**否**:两步旁路(先 Write 一个 plist 再 load)本来就看不见 plist 内容(PreToolUse 只见 Bash 命令串),把 bootstrap/load 全拦会误伤 QA slot、fleet 安装等大量合法路径。诚实边界:两步旁路记为 residual,由第②层(ppid 自卫)+ 第④层(红线)兜底。

## 4. 选定方案(交给 research 验证的假设清单)

1. `launchctl submit` 无法给 job 设置任意环境变量(只有 `-o/-e` stdout/stderr 路径)→ submit job 不可能带上 `FLYWHEEL_RESTART_FOREGROUND=1` 来绕 ppid 检测,除非把 env 写进 `bash -c '…'` 载荷 — 而那个载荷串含 restart-services,会被扩展后的护栏拦。
2. launchd 直生进程 ppid==1(已实测 Bridge);XPC_SERVICE_NAME 在本机**未观测到**(`ps eww` 无该变量)→ 检测信号只能用 ppid,不能用 XPC_SERVICE_NAME。
3. updater 链对 restart-services 的调用是**子进程 + FOREGROUND=1**(update-flywheel.sh:95 实读)→ ppid 检测对正路零影响。
4. self-detach 的 child 带 FOREGROUND=1 → ppid 检测必须只作用于 entry mode(FOREGROUND≠1),否则 parent 秒退后 child 被 reparent 到 pid 1 会误拒。

## 5. 明确不做(边界)

- storm gate 自锁(事故根因②)— 另一张单。
- Bridge plist KeepAlive 节奏 — 不动。
- bypass 记账合同 — 不动。
- 两步 plist 旁路的内容级检测 — 做不到(工具边界),记 residual。
- 人在裸终端手敲 — hook 管不到,靠 rules 红线 + restart-services 自卫层。
