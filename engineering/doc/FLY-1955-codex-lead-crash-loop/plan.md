# FLY-1955 Codex Lead 81 秒崩溃循环 — 实施计划

Issue: FLY-1955 (https://linear.app/geoforge3d/issue/FLY-1955/infra活跃-两个-codex-lead-持续崩溃循环-235-小时精确每-81-秒已跨越两次全舰重启未自愈-remote-control)
日期: 2026-08-21
基于: research.md
版本: vNEXT(ship 时取当前空号)
Status: codex-approved(design review 4 轮,R4 APPROVED 2026-08-21)

实施期证据勘误(15:20-15:22 PDT):阶段 0 尚未发生,两个 Lead 仍在 81 秒循环;14:02 的 global codex stopgap 先被生产 updater 踩回 infra-bot home,随后又被本单设计实验遗留的 updater 踩到 scratchpad。Tadashi 15:22 再次恢复中立轴,并要求修复必须从源头保证 Lead/实验 updater 永不写真实全局轴。依该 Lead 指令,C2 增加 Codex 原生 `CODEX_INSTALL_DIR` 隔离;完整归因见 research.md §8。

QA 返工勘误(17:10 PDT):独立 QA 证明 zombie 回收主路径在 macOS 真机有效,同时发现 full-access 正向 allowlist 会洗掉统一告警路由,导致 G3 只能本机 dead-letter。依 Lead 裁决,G3 改为 runtime 投影现有 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`,并将 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 固定为已有的 `DISCORD_BOT_TOKEN`;不引入第二份 secret,成功输出写回 Lead 日志。告警频道缺失时保留 Lead 可用性并沿用脚本的 skip + log 语义。

## 0. 一句话

`codex remote-control start` 的存活判定被「挂在不 reap 的 updater 名下的 zombie daemon」骗过而永不 spawn(四格实验 E3 100% 复现);修法 = 止血 runbook(证明后杀 updater 让 zombie 被 reap,分钟级恢复)+ `ensure_daemon` 证据驱动的 zombie 回收(让未来任何 daemon 死因都在一轮内自愈),外加 FLY-513 守卫从「刷日志」升级为「真告警」。

## 1. 目标 / 非目标

**目标**
- G1(止血,operator):两个 Lead 在不等代码 merge 的前提下恢复,含验收判据。
- G2(根治,代码):`ensure_daemon` 遇到 E3 形态(stale pid → zombie)时证据驱动回收并自愈;证据不齐保持现状 fail-loud。健康路径 byte-compat(golden 对照,见 §5)。
- G3(可见性):回收路径按**结果**经 `lead-alert.sh` 发告警(recovered / stuck 两形态,episode 级),终结「静默烧 23.5h」。
- G4(FLY-513 收尾):所有 managed updater 的 installer 写目标固定在各自 Lead home(`CODEX_INSTALL_DIR="$HOME_DIR/.local/bin"`),从源头不再写真实全局轴;warn-only 升级为 warn + 告警;中立全局布局经**既有 reviewed 工具** `fly-513-repoint-global-codex.sh` 固化(operator 步骤)。
- G5(验证):部署后跑 FLY-1892 双向通路验证,通则并单、不通则回报其独立继续。

**非目标**
- 不修 codex 上游的 zombie 误判(另行报 bug,与本修复幂等不冲突);
- 不禁/不钉 standalone updater 的自动升级(research Q2 未找到旋钮;列 follow-up);
- 不做通用 Lead crash-loop 检测(FLY-1687 巡检 / launchd 层职责);
- 不覆盖 8-21 早上的 30 秒周期循环(失败形态不同,非同病);
- 不动 Claude Lead 路径、不动 `remote-control` 之外的任何 codex 调用面;
- **不做宽泛的 stale 文件/socket 清理**:非 zombie 的 missing-socket 形态(daemon+updater 双亡、pid 死透)由第一次 `remote-control start` 按 E2 自愈;若它仍失败且 zombie 证明不完整,fail-loud 交还 launchd 重试就是正确行为——实现者不得追加任何超出 §3 证据链的清理动作。

## 2. 改动清单

| # | 文件 | 改动 | 性质 |
|---|---|---|---|
| C1 | `packages/teamlead/scripts/codex-lead-tui-home.sh` | `ensure_daemon` 加 start 失败后的 zombie 回收 + 恰一次重试;新增 `reap_zombie_daemon_if_proven` | 代码(主修复) |
| C2 | 同上 | ①每次 `remote-control start` 传原生 `CODEX_INSTALL_DIR="$HOME_DIR/.local/bin"`,隔离 updater 的 installer 可见命令目标;②`ensure_home` 的 FLY-513 warning 分支追加 `lead-alert.sh` 调用(既有 kind `bin_integrity_drift`,见 §4) | 代码 |
| C3 | `packages/teamlead/scripts/__tests__/codex-lead-tui-home-zombie-reap.test.sh` | 新 bash harness,与 SUT 既有邻位 harness(`codex-lead-tui-home.test.sh`)同目录同约定 | 测试 |
| C4 | `.github/workflows/ci.yml` + `scripts/__tests__/ci-structure.test.sh` | ①ci.yml 字面添加 C3 的执行 step(enumeration 只扫根 `scripts/__tests__`,对 package-local harness 不可见,必须手登);②ci-structure.test.sh(always-on quick gate 恰跑一次、own exact script-step inventory)的 inventory 断言扩展这条新 step,把「登记被移除」变 CI 红 | 测试基建 |
| C5 | 本文件夹 runbook 段(§6)+ CLAUDE.md 里程碑 | 止血/固化 operator 步骤留档 | 文档 |

无 TS 改动、无 schema、无新 Flywheel 配置 env(只给 Codex 子进程设置 installer 已有原生 `CODEX_INSTALL_DIR`;告警 seam 复用已治理的 `FLYWHEEL_LEAD_ALERT_SH`)、无新 kind、无新常驻进程/timer。按 FLY-1959,merge 不部署;后续 updater 班车部署后,循环中的两个 Lead 下一轮吃到新脚本。其他存量 Codex updater 须按 §6 受控换代一次,才能继承安全 installer 目标。

## 3. C1 详细设计 — `ensure_daemon` zombie 回收

### 3.1 控制流(改动后)

`reap_zombie_daemon_if_proven` 返回**四态 outcome**(经全局变量或 stdout 单词,穷举、无缺省分支):

| outcome | 含义 | 调用方行为 |
|---|---|---|
| `not_proven` | 证据链任一步不满足 / 探针错误(未发任何信号) | die(原文案 + " (stale-daemon evidence incomplete)"),**无告警**(非本病,不制造噪音) |
| `race_self_healed` | P2 复检发现 socket 已出现(他愈竞态,未发任何信号) | 直接重试 start 一次;成功**且 socket 复验仍在** → return(零告警);exit 0 但 socket 已消失、或重试失败 → die(fail-loud,不得按成功返回) |
| `reaped` | 证据齐、信号完成、zombie 已被 init reap | 重试 start 一次 → 成功且 socket 在 → §3.4 恢复断言 → 过:发 recovered、return;断言败:发 stuck、仍 return(socket 已在,Lead 可跑,告警留人查) → 重试失败**或 exit 0 但 socket 缺失**:发 stuck、die |
| `action_stuck` | 已发信号后的一切不确定:reap 超时 / kill 失败且目标仍逐字匹配 / TERM 后 KILL 前身份漂移或探针错误 | 发 stuck 告警 → die(不重试;绝不无控升级) |

```
ensure_daemon:
  codex_bin 校验(不变)
  full-access → remote-control stop || true(不变;companion/read-only 无 stop,不变)
  CODEX_INSTALL_DIR="$HOME_DIR/.local/bin" remote-control start --json
    ├─ 成功 → 校验 socket → return          ← 健康路径,与现状一致(golden 对照,§5)
    └─ 失败 → reap_zombie_daemon_if_proven → 按上表四态穷举处置
```

设计原则:回收**只挂在失败路径**(零预防性动作、零新 timer);证据驱动、sensor 不确定即 hold(FLY-1634/1659);重试恰一次,再败回落 launchd 循环(fail-loud 不变);告警按**结果**发(recovered 只在 socket 验证 + 恢复断言之后;动手前不发,防「宣布修好但没修好」)。`set -e` 纪律:所有 `kill`/`ps` 调用显式捕获返回值(`if kill …; then / else`),失败后**复探目标**——确认 absent = 良性(计入当前流程继续),仍逐字匹配 + 信号错误 = `action_stuck`;绝不让未检查的非零中途 abort 掉 stuck 告警。

### 3.2 `reap_zombie_daemon_if_proven` 证据链(单次 fresh proof,全部满足才授权动手)

| 步 | 证据 | 读法 | 不满足时 |
|---|---|---|---|
| P1 | pid 文件是 regular file、可解析 JSON;`pid` 为 int 且 >1;`processStartTime` 为非空 string | `python3` 读 `$HOME_DIR/app-server-daemon/app-server.pid` | return `not_proven` |
| P2 | control socket **此刻仍缺失** | `[ ! -S "$sock" ]`(动手前重验,不复用 start 之前的观察) | return `race_self_healed` |
| P3 | 该 pid 处于 **Z 态** | `/bin/ps -o state= -p $pid`,`case` 匹配 `Z*` | return `not_proven`(活/死透/不存在都不是本病;死透→E2 已证 start 自愈) |
| P4 | zombie 的启动时间与 pid 文件**逐字相等** | 定义**唯一 canonical lstart 归一化**(`LC_ALL=C /bin/ps -o lstart=`,仅剥 ps 显示 padding 的前后空白,不做其他变换),P4 与 P6 所有复核共用同一函数;归一化后与 `processStartTime` 字符串全等 | return `not_proven`(pid 已被复用) |
| P5 | zombie 的父是**本 home** 的 pid-update-loop | `ppid=$(/bin/ps -o ppid= -p $pid)`;`ppid > 1`;`LC_ALL=C /bin/ps -o command= -p $ppid` 判定**禁用 ERE 拼接**(home 路径含 `.` 等元字符,`^${HOME_DIR}/…` 形态会把 `.codex-mufasa` 的 `.` 当通配,近邻路径可穿透):改为**结构化字面比较**——①整串必须恰以固定尾串 ` app-server daemon pid-update-loop` 结尾(quoted `case`/`[[ == ]]` literal 匹配);②剥掉尾串后剩余为可执行路径,须**不含空白**;③该路径经 quoted 字面前缀比较必须以 `"$HOME_DIR/packages/standalone/"` 开头(shell 字符串比较,零正则语义) | return `not_proven`(父身份不明,绝不杀) |
| P6 | 身份栅栏快照 | 记录 updater 的 `pid + LC_ALL=C lstart + command` 三元组 **以及** child 关系(`ps -o ppid= -p $daemon_pid` 仍 == updater pid) | — |

**匹配合同不为 harness 放松**(R1 #2):fixture updater 必须以生产 argv 形态呈现——在 fixture home 的 `packages/standalone/…` 下由宿主 `cc` 编译一个名为 `codex` 的最小程序,fixture 控制量全部走环境变量,进程只带 `app-server daemon pid-update-loop` 三个生产参数;程序 fork 即死子进程且不 wait,造出真 zombie + 真 PPID。macOS/Linux 走同一合同;仅执行器 sandbox 明确拒绝 `/bin/ps` 时本地 skip,CI 强制执行,**绝不以放宽 P5 判定代偿**。

### 3.3 动手序列(TERM→KILL tri-state,FLY-1759 语义;所有 kill/ps 显式捕获返回值)

1. **TERM 前**:逐字复核 P6 三元组 + child 关系;任何漂移/探针错误 → return `not_proven`(**零信号零告警**——尚未动手,按未证处理);
2. `kill -TERM $ppid`(显式 if 捕获);失败 → 复探穷举:目标 confirmed absent = 视作已死继续步 4;仍逐字匹配 / 身份漂移 / 探针错误 = return `action_stuck`(**已尝试信号后的一切不确定都不再发信号**);
3. 有界等待 2s(200ms 轮询)→ **KILL 决策(tri-state)**:
   - updater **absent** → 成功,不 KILL;
   - updater 存在且三元组+child 关系**逐字复核通过** → `kill -KILL`(显式捕获,失败同步骤 2 的复探穷举语义);
   - 探针错误 / 三元组漂移 / child 关系漂移 → **不 KILL**,return `action_stuck`(TERM 已发出,不能再按 not_proven 静默);
4. 有界等待 zombie 被 init reap:`/bin/ps -p $daemon_pid` 轮询,200ms 间隔、10s 上限(真机验证该值;E 系列实验中 reap 均 <1s);
5. 超时未消失 → return `action_stuck`(绝不无界等待);
6. 消失 → return `reaped`(调用方重试 start)。

### 3.4 恢复后断言(重试 start 成功 + socket 验证之后、发 recovered 之前)

- 老 updater 三元组不复存在;
- **恰一个**新的本 home updater(P5 同款**结构化字面 matcher** 扫全进程表)+ pid 文件指向**存活非 Z** 的新 daemon;
- 任一断言失败 → 不发 recovered,发 stuck(带实测形态),仍 return 成功(socket 已在,Lead 可跑;告警留给人查)。

### 3.5 兼容性

- 脚本已有 FLY-694 re-exec 到 modern bash(≥4);`python3`/`ps`/`kill`/`perl(仅测试)` 均为既有依赖或系统自带;
- companion(read-only)与 full-access 两 profile 同受益:回收逻辑在 start 失败分支,与 profile 无关;profile 差异(stop-before-start 仅 full-access)保持不变并进 golden(§5)。健康路径的 stdout/stderr/命令序列不变;唯一刻意变化是 Codex 子进程多继承 home-scoped `CODEX_INSTALL_DIR`。

## 4. C2/G3 详细设计 — 告警(钉死 lead-alert.sh 真实合同)

### 4.1 updater 写目标隔离

Codex 0.149.0 的 `pid-update-loop` 会继承 `remote-control start` 的环境,周期性以 `/bin/sh -s` 执行 installer;installer 的 `BIN_DIR` 原生选择为 `${CODEX_INSTALL_DIR:-$HOME/.local/bin}`(research §8)。因此两个 start 点(首次 + zombie 回收后的唯一重试)都内联设置 `CODEX_INSTALL_DIR="$HOME_DIR/.local/bin"`。这只改变 installer 的 visible-command symlink 目的地;`CODEX_HOME`、真实 `HOME`、daemon state 与 standalone `current` 布局不变。无需 helper、timer、额外依赖或自动修链逻辑。

### 4.2 告警合同

`scripts/lead-alert.sh` 实测合同(2026-08-21 现读):必填 `--lead --project --kind --severity --title --body`,可选 `--signature`;kind 走 **allowlist**(lead-alert.sh:190),无 `--message` flag。**不加新 kind**,复用:

| 场景 | kind(allowlist 内) | signature(episode 去重) | severity(合法值仅 info\|warning\|severe) |
|---|---|---|---|
| 回收成功(§3.1 recovered) | `crash_loop` | `fly1955-zombie-recovered\|YYYYMMDD` | warning |
| 回收失败/超时/恢复断言失败(stuck) | `crash_loop` | `fly1955-zombie-stuck\|YYYYMMDD` | **severe**(`critical` 会被 parser exit 1 拒收) |
| FLY-513 检出(C2) | `bin_integrity_drift`(FLY-954 先例即全局 bin 漂移) | `fly513-global-codex\|YYYYMMDD` | warning |

- signature 日期用 **UTC**(`LC_ALL=C date -u +%Y%m%d`),与 lead-alert.sh 内建默认签名同一约定;
- 脚本路径解析(镜像 `tui-window-alert.ts:274-296` 先例):`ALERT_SH="${FLYWHEEL_LEAD_ALERT_SH:-<repo-root>/scripts/lead-alert.sh}"`,repo-root 由**定义文件路径 `${BASH_SOURCE[0]}`** 上溯三级派生(`packages/teamlead/scripts/` → repo 根;不用 `$0`——sourced 时 `$0` 是 harness);`FLYWHEEL_LEAD_ALERT_SH` 仅作 harness seam,生产走 repo-root default;
- full-access runtime 从 launcher 原始 env 投影既有 unified channel,将 sender env 名固定为本来就供 lead_actions 使用的 `DISCORD_BOT_TOKEN`;频道缺失时省略 route 而不阻断 Lead 启动,不增加 secret 或共享 allowlist;健康/自愈成功 stderr 由 runtime 写入 Lead log;
- `--lead "$FLYWHEEL_LEAD_ID" --project "$FLYWHEEL_PROJECT_NAME"`;两 env 任一为空 → 跳过告警只 log(告警是增强,非正确性依赖);
- 调用 `|| log "alert emit failed (non-fatal)"`,不阻塞主流程;
- title/body:一行事实 + home 路径 + 指向 FLY-1955(便于值守直达 runbook)。

## 5. C3/C4 测试计划(TDD,bash harness)

位置:`packages/teamlead/scripts/__tests__/codex-lead-tui-home-zombie-reap.test.sh`(SUT 邻位,随 `codex-lead-tui-home.test.sh` 同约定)。**C4 接线如实合同**:`ci-shell-suite-enumeration.test.sh` 只扫根 `scripts/__tests__/*.test.sh`,**不会**自动发现 package-local harness——因此 ①C3 必须**字面**添加进 `.github/workflows/ci.yml`;②在 always-run 的结构守卫(enumeration/structure 测试族)里**显式断言该 ci.yml entry 存在**(把「漏登记」从静默变 CI 红);两个文件都列入改动清单。不靠 `pnpm test:packages:run` 兜。

测试架构(R2 #4 / R3 #3):SUT 脚本改为 **sourceable 无副作用**——dispatch 包进 direct-execution guard(`if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then case "${1:-}" in … esac; fi`),harness `source` 后单独调函数(与既有 FLY-694 re-exec 兼容);repo-root 派生一律用 `${BASH_SOURCE[0]}`(**不用 `$0`**——sourced 时 `$0` 是 harness 自己);`ps`/`kill`/`sleep` 收进**可覆写 shell 函数**(生产默认体 = 绝对路径真工具 `/bin/ps` 等,零行为变化;harness 对 T8b/T11 覆写注入确定性故障),真进程覆盖保留给 T1/T3/T6/T7/T10。

fixture 通用件:mktemp 短路径 CODEX_HOME;假 codex bin =shell stub 按场景脚本化 start/stop(打印生产同款文案);真 updater fixture 用宿主 `cc` 编译成 fixture home standalone 路径下名为 `codex` 的小程序,仅以环境变量接收 fixture 控制量,故 `ps` argv 保持生产形态并造出真 zombie + 真 PPID(macOS/Linux 同合同;仅 runner sandbox 明确拒绝 process-table inspection 时本地 skip,CI 仍强制);假 alert 经 `FLYWHEEL_LEAD_ALERT_SH` 注入并记录全部 argv(另有一条 case 盖 env 未设时 repo-root default 解析);**每个真进程 fixture 注册 trap,断言失败也回收全部记录的父进程**。

| # | 场景 | 断言 |
|---|---|---|
| T0 | fake `HOME` 下的中立 global link + fake Lead standalone 执行 `ensure-daemon` | stub 观察到 `CODEX_INSTALL_DIR=<Lead home>/.local/bin` 与 `CODEX_HOME=<Lead home>`;调用前后 fake global link 目标逐字不变;测试不读取/改写真实 `~/.local/bin` |
| T1 | **RED→GREEN 主场景**(E3 复刻):zombie+匹配 pid 文件,stub start 首败、回收后二次成功 | 旧代码 die;新代码:updater 被杀、zombie 消失、恰一次重试成功、恢复后断言过、alert 恰一次且为 recovered 签名 |
| T2 | **golden byte-compat**:pre-change 捕获 companion 与 full-access 两形态的 golden(exit code/stdout/stderr/stub 收到的命令序列与次数),change 后逐字对比 | 健康路径零漂移;回收函数零调用;alert 零调用 |
| T3 | 阴性:pid 活着(真活进程)且 start 失败 | 不杀、die evidence-incomplete;进程存活断言 |
| T4 | 正例 E2-a:pid 死透 + stub start 一次成功 | 零回收零告警零二次 start |
| T5 | 正例 E2-b:无 pid 文件/无 updater + stub start 一次成功 | 同 T4 |
| T6 | 阴性:processStartTime 与 zombie lstart 不符(pid 复用形态) | P4 拒,不杀 |
| T7 | 阴性:父 argv 带前导杂词(如 `bash <path> …`)或非本 home 路径 | P5 拒,不杀 |
| T8a | 阴性:**TERM 前**最终栅栏检出漂移(注入确定性漂移) | 返 `not_proven`,零信号零告警 |
| T8b | 阴性:TERM 成功后、KILL 前检出身份/child/探针漂移(注入,含 barrier) | 返 `action_stuck`,不 KILL,stuck 告警 |
| T9 | 竞态:动手前 socket 已出现 | P2 返 `race_self_healed`,不杀,直接重试 |
| T10 | 另一 home 的 updater 同机存活,**且路径为含 `.`/`[`/`+` 元字符的近邻 home**(如 `.codex-mufasa` vs `Xcodex-mufasa` 穿透形态) | 全程不被触碰(P5 字面比较,零正则穿透) |
| T11 | 回收失败:zombie 10s 未消失(经可覆写 `ps`/`kill` 函数注入「杀不死」形态——真 SIGKILL 杀得死自有进程,故必须 scripted) | `action_stuck` → die + stuck 告警,无二次 start |
| T12 | governed unified route 三元组到达 alert bin,且 alert bin exit 1 | 三元组逐字可见;回收与重试照常,恰一次重试 |
| T13 | 恰一次重试:二次 start 仍失败 | die + stuck,无第三次 |
| T14 | full-access stop→start→(失败)→reap→start 命令序列;companion 无 stop | stub 序列逐字断言 |
| T15 | FLY-513 分支:全局 codex 指进 fixture home / 不指进 | alert 恰一次 kind=`bin_integrity_drift` 签名 `fly513-global-codex|…` / 零调用 |
| T16 | resolver default 路径:unset `FLYWHEEL_LEAD_ALERT_SH`,source SUT 调解析函数 | 断言派生出的**确切路径** = `<repo-root>/scripts/lead-alert.sh`(经 `${BASH_SOURCE[0]}` 上溯;不真调投递脚本) |
| T17 | race_self_healed 分支:P2 检出 socket 已在 → 重试;含「重试 exit 0 但 socket 又消失」变体 | 前者零告警 return;后者 die(不得按成功返回) |
| T18 | socket 恢复但 `assert_recovery_shape` 失败 | service return 0,发 stuck 而非 recovered |
| T19 | hostile inherited Codex/alert env + runtime unified route | harness 隔离 inherited override;runtime 将 sender 固定为 `DISCORD_BOT_TOKEN`,缺 channel 时保留启动并记录成功 stderr |

真机 E2E(独立 QA 节点,529 房不需要):隔离 CODEX_HOME + 真 0.149.0 binary,按 research §1 E3 配方造死锁 → 跑新 `ensure_daemon` → 断言 socket 出现、daemon 活、pid 文件更新、老 updater 换代;并复跑 E2/T3 阴性对照 + §3.3 reap 等待值实测。**验收采样窗一律 >81s。**

全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + C3 harness + CI enumeration 绿。

## 6. 部署顺序与 operator runbook

**阶段 0 — 止血(不等 merge;若设计评审期间已被执行则跳过,验收判据不变)**
逐 home(`~/.codex-infra-bot`、`~/.codex-mufasa`)独立执行,**全部目标现读现证,禁用本文或任何历史记录里的字面 pid**:
1. 读该 home `app-server-daemon/app-server.pid` → 得 daemon pid;
2. 完整证明(= §3.2 P1-P6 手工版):pid 为 Z 态、`LC_ALL=C ps lstart` 与 pid 文件逐字相等、PPID>1、父 command 从 byte 1 匹配本 home standalone pid-update-loop、socket 缺失;
3. TERM 前**再次**逐字复核父三元组+child 关系 → `kill -TERM <父>`;若两次检查之间目标消失(他人/代码修复已 reap)→ **视为良性 no-op**,不追杀任何 pid;
4. 等 ≤81s 下一轮 KeepAlive;
5. 验收:`app-server-control.sock` 存在(srw)、`app-server.pid` mtime 更新且指向存活非 Z 进程、**旧 updater/zombie 元组消失且恰一个新 home-scoped updater 在跑**、Lead pid 采样窗 **≥5 分钟(>3 个 81s 周期)** 稳定、`/tmp/flywheel-lead-*.log` 无新 ENOENT、Discord @ 回话。

**阶段 1 — 代码(C1-C4)**:先捕获 T2 golden(改前)→ TDD → 全仓门 → codex code review → PR。
**阶段 2 — 部署**:按 FLY-1959 merge/deploy 解耦合同,merge 本身不触发 `git pull`、部署或重启;后续常规 updater 班车部署到生产 checkout 后,若阶段 0 仍未执行,Lead 下一轮 81s 循环才会自动吃到新脚本并各发一条 recovered 告警。部署窗口内还须对每个既有 Codex Lead updater 做一次**现读身份栅栏后的受控换代**,再由新脚本启动/确认 updater;验收新 updater 继承 home-scoped `CODEX_INSTALL_DIR`,真实 `~/.local/bin/codex` 在 **>65 分钟**(跨过 5 分钟首检 + 一次 60 分钟周期)观察窗内仍解析到 Lead/实验 home 之外的中立稳定路径。任何真实实验同时隔离 `HOME/CODEX_HOME/CODEX_INSTALL_DIR/PATH`,退出前按 pid 文件清 daemon 与 updater。只有 founder 单次明确授权才走紧急部署票,本 implement 节点不投票、不重启。
**阶段 3 — FLY-513 固化(operator,一次性,用既有 reviewed 工具,禁手写 cp/ln、禁 PATH trick)**:
0. **显式前置条件(现读现判)**:`command -v codex` 的 realpath 解析到一棵**完整 standalone release 树**(`*/releases/*/bin/codex` 形态)——工具的 `resolve_source` 只认这个;14:02 时的 stopgap(`~/.local/opt/codex-stable` 单文件拷贝)不满足该形态,但 15:20 live recheck 已显示它被踩回 infra-bot 的完整 release 树,所以 operator 必须再次现读,不可引用任一历史点态;工具的 `install` 子命令同样从 `resolve_source` 起步,不是独立安装器;
1. 前置条件为**真** → `packages/teamlead/scripts/fly-513-repoint-global-codex.sh all`(默认 dry-run)审读 → `all --apply` → `verify`;`codex --version` + 任一 runner review gate 冒烟;`codex-stable` 保留一个观察期后再清(工具自带 backup/rollback);
2. 前置条件为**假** → **安全停止并回报 Lead 决策**(选项:操作员按 FLY-513 spike notes 先恢复一个合规 managed release 作 source;或另开小单给工具加 tested fail-closed 的显式 source 模式)。15:20 已证明旧 stopgap 不耐下一次 updater flip;仍然**宁可显式升级优先级并交还 operator,不可绕过工具的 source-stability 检查**;
3. FLY-1892 双向验证(入站 core @ + 出站 `flywheel-comm ask`,均落库可查)→ 通则在 FLY-1892 留证并单;不通则把新证据回报 FLY-1892。
**阶段 4 — 上游**:给 codex 报 bug(remote-control start 把 zombie 判活;updater 不 reap 子进程),附 E1-E3 复现配方。

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 回收误杀非目标进程 | P1-P6 单次 fresh proof + byte-1 argv 锚定 + tri-state 复核;T3/T6/T7/T8a/T8b/T10 阴性对照;证据不齐一律不动手 |
| 二次 start 引入新失败形态 | 重试恰一次(T13),失败回落原 die(行为=现状循环,不更坏) |
| 健康路径被扰动 | 回收只挂失败分支;T2 golden 逐字对照(companion+full-access 双形态) |
| updater 继续踩全局轴 | 两个 start 点均传 Codex 原生 `CODEX_INSTALL_DIR`;T0 fake-HOME 断言;部署时换代全部存量 updater并跨 updater 周期观察 |
| 告警误报「已修好」 | recovered 只在 socket 验证 + §3.4 恢复断言之后;其余一律 stuck |
| lead-alert 通路故障 | `\|\| log` 非阻塞;T12 |
| 阶段 0 与代码修复竞态 | 双侧 absence=benign no-op(§3.3 tri-state / §6 步 3);幂等 |
| 回滚 | C1/C2 单文件加性改动,`git revert` 即回现状(循环重现但不更坏);无状态迁移;阶段 3 用工具自带 rollback |

## 8. Follow-ups(不在本单)

- 评估禁用/钉版本 standalone updater(research Q2;0.149 无预告升级是诱因源头);
- codex 上游 bug 修复跟踪;
- 通用 Lead crash-loop 检测归 FLY-1687 / launchd 层。
