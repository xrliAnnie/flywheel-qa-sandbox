# FLY-1507 restart 换管家不换真身 — 调研

Issue: FLY-1507 (https://linear.app/geoforge3d/issue/FLY-1507/基建卡点-restart-换管家不换真身-孤儿-lead-本体被收养旧-modelopus-4-8-永不落地)
日期: 2026-07-27
基于: exploration.md

本文是代码事实全录:每个断言给 file:line,供 plan 与 implement 直接引用。brainstorm gate 已过(Tadashi 批准方案 A,附加要求:①保护性机制表供 founder 裁砍;②newborn 判据对 codex backend 同样适用;③假阳性+假阴性双向测试)。

## 1. 现状代码地图

### 1.1 restart-services.sh 的 Lead 停止/启动/验证路径

`scripts/restart-services.sh`(`#!/usr/bin/env bash`,1456 行):

| 位置 | 内容 |
|------|------|
| 79-92 | 时间参数:`LEAD_STOP_WAIT_SECONDS=60`、`LEAD_VERIFY_ATTEMPTS=30`、`LEAD_VERIFY_INTERVAL=2`(env 可覆盖) |
| 899-914 | `launchd_lead_outcome_ready()` 验证器:launchctl print 取新 PID → 非空且 ≠ old_pid → `tmux display-message -p -t "=flywheel:=${window}" '#{window_name} #{pane_dead}'` 窗口活着即成功。**不看 pane 本体身份/出生时刻/argv** |
| 918-1087 | `restart_lead()`:读 manifest(922-931,**当前不读 `leadBackend.backendId`**)→ pidfile 定位 supervisor → TERM + 等 ≤60s(977-1001)→ `rm pidfile`(1002)→ launchd 分支 `launchctl kickstart -k`(1025)→ 验证循环 30×2s + 最终复验(1030-1046)→ 假阳性日志 `restarted via launchd (PID X, responsive session verified)`(1033) |
| 1053-1086 | legacy nohup 分支(非 launchd 管理时):直接 nohup claude-lead.sh,3s 存活检查 |
| 1149-1241 | `do_restart_all_leads()`:遍历 `~/.flywheel/manifests/*.json`,`_classify_restart_manifest` 分 restart/skip-test/fail 三类;stdout 契约 `skipped:N failed:M`(日志全走 stderr) |

**结论 1**:停止路径唯一的终结对象是 supervisor PID;claude 本体之死完全依赖 supervisor 的 `cleanup()` trap。孤儿(supervisor 已死)与 hold 中的 supervisor(`LEAD_WINDOW_ID` 未设,cleanup 对窗口无操作,claude-lead.sh:2012)都让本体逃过终结。

**结论 2**:验证器对"本体是谁"零检查 → 孤儿窗口满足全部条件 → 假阳性(实锤日志:`Lead flywheel-cos-lead restarted via launchd (PID 77218, responsive session verified)`,而 77218 是 hold 中的新 supervisor,真身仍是 7/24 的 60964)。

### 1.2 claude-lead.sh 的三层 fail-closed 守卫(新 supervisor 为何永不 launch)

`packages/teamlead/scripts/claude-lead.sh`(3387 行),主循环 3110-3385:

1. **FLY-1309 identity lease**(3120-3153):`lead_identity_prepare_lease` → flywheel-comm CLI → `packages/flywheel-comm/src/lead-lease.ts`。`acquire()` 在 `existing.holder_pid` 进程活着(pid+lstart 双验,368-378 行)时返回 `denied_holder_alive` → supervisor hold 30s 重试。**关键:`bind()`(419-441)在 launch 成功时把 holder 改写为 pane 本体的 pid+lstart** —— 所以孤儿本体活着 = lease 永远拒绝新 generation。**这是生产现场实际卡住的层**(`/tmp/flywheel-lead-geoforge3d-ops-lead.log` 每 30s 一条 `Lead identity HOLD (denied_holder_alive)`)。holder 死 → 下一轮 acquire 直接成功(368-378 行唯一拒绝条件是 `isProcessAlive(holder_pid, holder_start)`)。
2. **FLY-1285 tmux takeover 守卫**(`_prepare_lead_launch` 1439-1486):archive 里的本体活着且 `TMUX_RELAUNCH_PROVEN=0`(新 supervisor 初始值,1253 行)→ hold `existing_archived_lead_alive`(同代)或 `split_brain`(异代);无 archive 的活 pane → hold `unarchived_live_lead_window`(1479-1481)。takeover 授权(`TMUX_RELAUNCH_PROVEN=1`)只能来自:pane 死亡实证(1946)、窗口消失实证(1962/1977)、cleanup 自己杀窗(2026)——新 supervisor 对活本体无任何授权路径(by design)。
3. **identity 进程表 preflight**(3183-3202):`lead_identity_preflight_first_conflict` 在进程表发现 `claude ... --agent <lead_id>` 精确匹配 → hold `lead_dual_active`。

三层锚点一致:**本体进程活着与否**。本体死 → 三层全部自然放行(lease 上文;archive `tmux_supervisor_archived_process_alive` 失败 → rm archive → 继续,1461-1465;preflight 无匹配 → 通过)。

### 1.3 FLY-1496 模型热解析的执行位置

`_launch_claude`(1530-1648):每次**物理 launch** 时经 `packages/teamlead/dist/lead-model-launch.js` 的 `resolveLeadModelLaunch(project, lead)` 从 projects.json 热解析 model/effort,替换 argv(1589-1605),并把 `rawModel/resolvedModel/rawEffort/resolvedEffort` 写回 manifest 作 launch 证据(1619-1636,**write-only,永不读回**)。hold 循环到不了这里 → 解析根治但不落地。**推论:只要本次重启物理 launch 发生,model 自动正确;manifest `.resolvedModel` 可作为验证器的比对基准(同一次 launch 写入)。**

### 1.4 可复用的库函数(source-only,bash 3.2 安全,无 trap/无 shell opts)

`packages/teamlead/scripts/lib/tmux-supervisor-guard.sh`(107 行):

- `tmux_supervisor_process_start_identity <pid>` → `ps -o lstart=` 修剪后的出生时刻字符串(pid+lstart = 防 PID 复用的进程身份,全库统一用法)
- `tmux_supervisor_archive_read <file>` → 解析 `~/.flywheel/pids/<project>-<lead>.claude.tmux`(TAB 分隔:server_pid, pane_pid, pane_start, window_id;实样:`5952	62473	Sat Jul 25 00:00:57 2026	@2223`)
- `tmux_supervisor_archived_process_matches <file> <lead_id>` → pid 活 + lstart 一致 + argv 经 `lead_identity_command_matches` 验明正身
- `tmux_supervisor_reap_archived_process <file> <lead_id>` → **现成的"验身份→TERM→等待→复验→KILL→清 archive"递进 reaper**,每次发信号前重跑全套身份证明;身份不符时绝不发信号只清档
- 注意:argv 验身要求可执行名 `claude|claude-code`(lead-identity-preflight.sh:151)→ **codex backend 本体会被判"身份不符"而只清档不发信号**,codex 本体的终结必须走窗口 pane 路径

`packages/teamlead/scripts/lib/lead-identity-preflight.sh`(188 行):

- `lead_identity_command_matches <command> <lead_id>` → 精确 token 匹配 `claude --agent <lead_id>`(可执行名先验,防 wrapper/prompt/子串冒充,140-167)
- `lead_identity_first_conflict <lead_id>`(stdin 喂 `pid command` 行)/ `lead_identity_preflight_first_conflict <lead_id>`(自带 `ps -axo pid=,command=` 快照)→ 进程表找本体
- **跨项目 lead_id 撞名注意**:匹配键只有 lead_id,不含 project。现役 fleet 的 lead_id 全局唯一(flywheel 侧带前缀:flywheel-cos-lead vs geoforge3d 的 cos-lead),但设计不得假设永远唯一 → 进程表匹配需 project 级旁证(本体 argv 的 `--append-system-prompt-file .../lead-rules-bundles/<PROJECT>-<LEAD>.<pid>-lstart-<hash>.md` 内嵌 `<project>-<lead>.` 前缀,可作判别;实样见 exploration.md)

### 1.5 wrapper 与 launchd 配置

`scripts/flywheel-lead-wrapper.sh`(201 行,`#!/bin/bash` → macOS bash 3.2):

- 126-138:已有 pidfile 双启动护栏——pidfile 存在且 PID 活 → `exit 0` 让路(注释明言 launchd ThrottleInterval 30s 后重试)。**stale pidfile(PID 已死)时照样放行** → restart 过渡窗口内 KeepAlive 重生的 wrapper 会真的启动 supervisor
- 36-38:`FLYWHEEL_STATE_DIR`(默认 `~/.flywheel`)、`PID_DIR`(默认 `${FLYWHEEL_STATE_DIR}/pids`,env 可覆盖 `FLYWHEEL_WRAPPER_PID_DIR`)
- 110 + 177-201:读 manifest `leadBackend.backendId`,`codex-app-server` → codex-lead.sh,否则 claude-lead.sh

生产 plist(`~/Library/LaunchAgents/com.flywheel.lead.<project>-<lead>.plist`):`KeepAlive=true`、`ThrottleInterval=30`、`RunAtLoad=true`。**含义:supervisor 无论怎么退出,launchd 都会重拉**(距上次 start ≥30s 则立即)。`launchctl kickstart -k` 对正在跑的实例是强制终结(无 cleanup 机会)——restart 过渡窗口内如果 KeepAlive 间隙的 supervisor 已抢先 launch 了新本体,kickstart -k 会把它无 cleanup 终结 → **制造一个新孤儿**(模型正确但无人管理)。现状 restart_lead 的 TERM→kickstart 间隙 <2s,加入清场后会拉长到 ~15s+,该竞态从理论变现实 → 过渡锁的必要性来源(保护性机制表 §4)。

### 1.6 孤儿历史成因的时间戳考证(UTC 陷阱)

`~/.flywheel/logs/lead-*-startup.log` 用 `date -u`(claude-lead.sh:1258)。ops-lead 的 `2026-07-25T07:00:59 dialog-poller: start window=@2223` 是 UTC = 本地 7/25 00:00:59,与本体 lstart 00:00:57、archive mtime 00:00 完全吻合(@2223 即孤儿所在窗口)。读日志考证时区必须换算。

## 2. 现场证据链(2026-07-27 采集,设计依据)

见 exploration.md「实锤证据」全表。要点:9 个冻结本体(7/22-7/25 出生,8× `claude-opus-4-8[1m]` + reflection-lead 旧拼写 `sonnet`),对应 supervisor 全部 16:3x 新生且卡 `denied_holder_alive`;对照组 5 个 Lead 本次真换身、模型全对;tmux server 5952 自 7/20 同一代;`lead_dual_active` 告警持续发但被 receipt 去重成噪音。

## 3. 方案 A 的机制可行性核验(逐条已读码确认)

| 设计动作 | 依赖机制 | 核验结果 |
|----------|----------|----------|
| 杀本体 → lease 放行 | lead-lease.ts:368-378 唯一拒绝条件 = holder 活 | ✅ holder 死即 acquire 成功 |
| 杀本体 → archive 守卫放行 | claude-lead.sh:1461-1465 死进程 → rm archive → 继续 | ✅ 自愈 |
| 杀本体 → preflight 放行 | 进程表无匹配 → rc=1 → 继续(3195) | ✅ |
| 杀本体后新 supervisor 多久 launch | hold 退避封顶 30s(3163-3165) | ✅ ≤30s 进入 launch |
| 新 launch 模型必对 | _launch_claude 热解析(1547-1617) | ✅ FLY-1496 已 ship |
| 换身不失忆 | SESSION_ID_FILE 不动 → `--resume` 同 session(3218-3232) | ✅ 孤儿的 session id 就在文件里 |
| 递进终结的身份安全 | reap_archived_process 每信号前全套复验 | ✅ 可复用;codex 本体走窗口路径 |
| 验证器比对基准 | manifest `.resolvedModel` 由同次 launch 写入 | ✅ 同机同源 |

## 4. 保护性机制表(Tadashi 要求单列,供 founder 裁砍)

| # | 机制 | 防的场景 | 为什么 (1)(2) 根治不够 | 砍掉的后果 |
|---|------|----------|------------------------|------------|
| P1 | wrapper 过渡锁(`<pids>/<key>.restart-transition.lock`,TTL 10min) | 清场把 TERM→kickstart 窗口拉长到 ~15s+;KeepAlive(30s 节流,supervisor 已跑多日=立即重拉)间隙重生的 supervisor 抢先 launch 新本体,随后 kickstart -k 无 cleanup 终结它 → 新孤儿(模型正确但无人管理,下次重启前失管) | 清场(1)发生在 kickstart 之前,管不到清场之后诞生的本体;验证器(2)会把这个"清场后出生"的孤儿判为 newborn 通过 → 假阳性复发(变种) | 每次重启有概率留下失管本体;症状轻(模型正确)但"supervisor 真正管理本体"的不变量破坏,问题会以新形态回来 |
| P2 | 全部信号发出前 pid+lstart 身份复验(复用 `tmux_supervisor_archived_process_matches` 模式) | 清场记下 PID 后、发信号前,本体恰好自死且 PID 被无关进程复用 → 误杀无辜进程 | (1)(2) 不含身份复验时,竞态窗口真实存在(清场含多次等待循环) | 极低概率误杀任意进程(可能是别的 Lead/Runner/用户进程);库里所有 reaper 均带此复验,砍掉即降级于既有标准 |
| P3 | 锁 TTL(过期锁视为无效并放行) | restart 脚本在落锁与删锁之间崩溃 | 无 TTL 时锁永久残留 → 该 Lead 被 KeepAlive 拉起后永远 exit 0 → Lead 长期下线 | 不砍——这是 P1 自身的止血阀;P1 若砍则 P3 一并消失 |

## 5. 测试与验收基础设施

- `scripts/test-restart-services.sh`(1702 行,`bash scripts/test-restart-services.sh` 直跑):现有模式 = 提取/内联被测函数 + mktemp 隔离 + PASS/FAIL 计数。新逻辑应抽成可 source 的库(建议 `scripts/lib/`,注意 classify_changes 把 `scripts/lib/*` 归为 Bridge 重启触发,1749 行附近——对本单无碍,restart 类改动本来就该触发重启)以便直接单测。
- **平台事实**(memory:FLY-1285):生产 = macOS(/bin/bash 3.2、BSD ps/date),CI = Linux。语法检查必须 `/bin/bash -n`;`ps -o lstart=`/`kill -0` 等在测试中需 stub(现有测试已这么做)。设计上避免 lstart→epoch 的日期解析(BSD/GNU date 不兼容),newborn 判据用集合差 + 身份串比对即可(见 plan)。
- 双向测试要求(Tadashi ⑥):假阳性(孤儿存活 → 验证器必须拒绝)+ 假阴性(无孤儿的正常 Lead → 全流程照常成功,newborn 判据不误伤)。
- 真机 E2E(验收):合入部署后 founder 跑一次 `restart-services.sh`,断言全部 Lead 本体 ps 出生时间刷新 + 无 `claude-opus-4-8` + 日志成功与真身替换一致。FLY-270 自托管纪律:本仓 ship 走 :cool: / detached `self-ship-restart.sh`,绝不 inline 重启。
- 运维注意:FLY-913 部署护栏 hook 会按关键词硬拦含终结/重拉字样的 Bash 命令文本 —— implement/QA 阶段跑测试脚本本身不受影响(命令行无触发词),但交互调试时需绕开触发词。

## 6. 范围外(明确不动)

- claude-lead.sh 三层守卫与 hold 语义(两次重启之间 supervisor 崩溃 → 旁观活本体,仍是正确的防 split-brain 行为;此时本体失管至下次重启,已知接受)。
- Runner 收养(FLY-1399 by-design)。
- Bridge / cmux / LeadWatchdog / 模型解析。
- codex-lead.sh(codex backend 的清场经窗口 pane 路径覆盖,无需改其脚本)。
