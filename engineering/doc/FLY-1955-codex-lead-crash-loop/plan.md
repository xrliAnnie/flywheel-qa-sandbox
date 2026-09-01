# FLY-1955 Codex Lead 崩溃循环(第二轮:auth-dead)— 实施计划

Issue: FLY-1955 (https://linear.app/geoforge3d/issue/FLY-1955/infra活跃-两个-codex-lead-持续崩溃循环-235-小时精确每-81-秒已跨越两次全舰重启未自愈-remote-control)
日期: 2026-08-31
基于: research.md §R2(exploration.md §R2 → research.md §R2 → 本计划)
版本: vNEXT(ship 时取当前空号)
Status: draft(Codex design review R1/R2/R3 findings 已全数吸收,待 R4)

> **第一轮(zombie 死锁)已交付**:PR #915(2026-08-21 merge),其 plan 全文见本文件 git 历史
> (commit 2928785f8)。mufasa lead 已由该修复救活。本计划只覆盖第二轮:infra-bot lead
> 因 ChatGPT refresh token 被吊销而持续崩溃循环 ≥4.7 天,且该失败路径零告警。
> Lead 增量输入(2026-08-31 22:44-23:29Z 指令与回复):孤儿 broker pid 819 清除实验已证伪
> 「孤儿占注册位」假设;主攻方向确认为「连接为何 errored + recovery 为何收不敛」——即本计划
> 根因(凭据死亡);FLY-2211 互查约束见 §8。

## 0. 一句话

infra-bot 的 Codex 账号 refresh token 被 server 吊销(daemon stderr 401 `refresh_token_invalidated`/`token_revoked` 实证),`remote-control start` 每 ~30-37 秒失败一次且走的 `race_self_healed` 重试失败路径不发告警;修法 = auth-dead 证据驱动分类(发 `login_expired` 告警 + 15 分钟级 parking,token 修好自动恢复)+ ensure_daemon 全 die 路径连败计数安全网告警(终结「按失败类别挂告警必有缝隙」),外加执行第一轮遗留的 FLY-513 operator 收口与账号重登录 runbook。

## 1. 目标 / 非目标

**目标**
- G1(止血,operator):infra-bot 的 Codex 账号按 Lead/founder 对 Q-R2 的裁决处置(救回=按 §6 阶段 0 的 quiesce→重登录→restore 序列,退役=另单);救回后 Lead 在一个循环内自愈,含验收判据。runbook 双线并存(A 救回主线 + B 退役支线),不阻塞代码交付。
- G2(分类,代码):`ensure_daemon` 首次 start 失败后按**增量证据合同**(§3.1:文件身份快照 + 本轮新增字节 + 吊销签名集)分类 `auth_dead`:发 `login_expired` 告警(天级去重,body 只携带命中的固定 code 名),有界 hold(固定 900s,分片 + 父进程存活探测)后 die。热循环 ~37s/轮 → ~15.5min/轮;auth 修复后下一轮自动满血恢复。
- G3(安全网,代码):`ensure_daemon` **任何** die 路径推进连败计数(原子写),连败 ≥3 发 kind=`crash_loop` severity=severe 告警(天级去重),任一成功路径清零;**计数持久化自身失败立即发状态故障告警**——安全网不允许再有静默失效形态。
- G4(FLY-513 收口,operator):执行第一轮 plan 阶段 3(`packages/teamlead/scripts/fly-513-repoint-global-codex.sh` 中立化全局轴)——前置条件 2026-08-31 现读为真;保留工具自带「无 Codex review 进行中」前置门;>65 分钟跨 updater 周期观察窗验收。
- G5(验证):账号救回后跑 FLY-1892 双向通路验证,通则并单、不通则回报其独立继续(沿用第一轮合同)。

**非目标**
- 不自动重登录(浏览器 OAuth + 人持凭据;重登录是 operator 流程,不进本脚本);
- 不做 runtime 层 parked 状态机、不改 TS(research §R2.3.1 选项 B 已弃;R1 #3 后放弃 hold 可配置 env,连带免去 TS env 投影改动);
- 不 `launchctl unload` / 不改 launchd plist / 不动 Lead 生命周期(退役属 Lead 管理,另单);
- 不动 zombie 回收机制及其专用告警(第一轮交付物原样保留);
- 不动 updater 升级策略(第一轮 follow-up 不变);
- 不做舰队级通用 crash-loop 检测(FLY-1687 / launchd 层职责);
- 不新增 alert kind、不新增 secret、不新增 env、不新增常驻进程/timer。

## 2. 改动清单

| # | 文件 | 改动 | 性质 |
|---|---|---|---|
| C1 | `packages/teamlead/scripts/codex-lead-tui-home.sh` | 新增 `classify_auth_dead`(快照+增量扫描)+ auth-dead 处置分支(告警→分片 hold→die);`ensure_daemon` 在首次 start **前**采文件身份快照,失败后、`reap_zombie_daemon_if_proven` 前分类 | 代码(主修复) |
| C2 | 同上 | 新增 `daemon_die`(原子连败计数 + ≥3 触发安全网告警 + 计数 I/O 失败即时告警 + 转 `die`);`ensure_daemon` 内所有 die 站点换用;两个成功 return 点前受控清计数 | 代码 |
| C3 | `packages/teamlead/scripts/__tests__/codex-lead-tui-home-zombie-reap.test.sh` | 追加 A1-A11 场景(§5);复跑既有 T2 golden 断言健康路径 byte-compat | 测试 |
| C4 | 本文件夹 runbook 段(§6) | 重登录 quiesce 序列/收口 operator 步骤留档 | 文档 |

CI 无需改:C3 位于第一轮已登记进 `.github/workflows/ci.yml` 的同一 harness 文件(ci-structure inventory 已守卫该 step)。无 TS 改动、无 schema、无新 kind(`login_expired`、`crash_loop` 均已在 allowlist)、**无新 env**(R1 #3:hold 固定 900s,测试经 source 后覆写 `fly1955_sleep` seam,不开生产接口)、告警 seam 复用既有 `emit_lead_alert`。

## 3. C1 详细设计 — auth-dead 分类与 parking

### 3.1 `classify_auth_dead`(增量证据合同;R1 #1 修正)

**快照点**:`ensure_daemon` 在首次 `remote-control start` 之前,对 `$HOME_DIR/app-server-daemon/app-server.stderr.log` 采身份快照 `(存在性, st_ino, st_size, 旧内容 digest)`——digest 为旧 `[0, st_size)` 前缀的哈希(经 `python3 os.stat` + hashlib,与既有 pid 文件读取同工具链)。start 成功则快照弃用,零行为差异。

**分类点**:首次 start 非零退出后立即执行(先于 zombie 机制——auth-dead 时 reap/重试必然再败,还多杀一次 daemon)。

| 步 | 证据 | 读法 | 不满足时 |
|---|---|---|---|
| A-P1 | stderr log 现在是 regular file | `python3 os.stat` 复读 | 返回未分类 |
| A-P2 | **确定本轮新写的字节范围**(R2 #1 三态取证) | 与快照对比:①快照时不存在、或 inode 变了(新文件)→ 扫**整个当前文件**;②inode 同、size ≥ 旧 size 且旧 `[0, 旧size)` 前缀 digest **不变**(纯追加)→ 只扫 append suffix `[旧size, 新size)`;③inode 同但 size 变小、或同 size 内容变化、或旧前缀 digest 不同(**truncate/rewrite**——0.151.0 生产实测形态:inode 恒定、size 3758→0→2348→…循环)→ 扫**本轮整份当前文件**;④inode 同、size 同、digest 同(本轮未写)→ **返回未分类**(旧 `token_revoked` 残行不作数);任何 open/fstat/digest/read 竞态或异常 → 返回未分类 | 返回未分类 |
| A-P3 | A-P2 界定的本轮字节命中吊销签名集 | `grep -F` fixed-string,任一命中:`refresh_token_invalidated` / `refresh_token_reused` / `token_revoked` / `token_expired` / `Your access token could not be refreshed` | 返回未分类(纯网络断只有 "connection is errored",不含吊销 code,走既有路径) |

- stderr log 的生命周期(重建/追加/原地重写)是 Codex 侧行为而非本脚本可控合同——R2 实测(55s 只读采样)证明当前形态是**同 inode 原地 truncate+重写**;三态取证对「新文件」「纯追加」「truncate/rewrite」「未写」四形态都给出正确判定,不依赖任何单一观察;
- 分类结果携带**命中的 code 名**(签名集内固定字符串,如 `token_revoked`),供告警 body 使用;**不携带任何原始日志行**(日志内容不受本方净化控制,不得进入告警面);
- 签名集为 0.151.0 现场逐字采集 + `/codex-relogin` 既有触发词,全部凭据死亡专属;探针只读本地文件,不 spawn codex 进程,不采 `codex login status` rc(memory 在案:该 rc 会因 config 载入期冲突假报)。

### 3.2 分类命中后的处置(顺序固定;R1 #3/#4 修正)

```
ensure_daemon:
  快照 stderr log 身份 (§3.1)
  …
  start 失败
    ├─ classify_auth_dead 命中(得 $matched_code)→
    │    emit_lead_alert login_expired severe "fly1955-codex-auth-dead|$(LC_ALL=C date -u +%Y%m%d)" \
    │      "Codex Lead auth revoked — re-login required" \
    │      "<home 路径 + matched code 名 + 指向 FLY-1955 runbook §6 阶段 0>"
    │    auth_dead_hold        # 30 × { fly1955_sleep 30; 父进程存活探测 },见下
    │    daemon_die "remote-control start failed (home: $HOME_DIR) (codex auth revoked — re-login required)"
    └─ 未分类 → reap_zombie_daemon_if_proven → 既有四态处置(逐字不变)
```

**`auth_dead_hold`(分片 + 父身份探测;不新增 env)**:总时长固定 900s,实现为 30 次循环,每次 `fly1955_sleep 30` 后探测父进程。**探针合同(R2 #2)**:hold 进入时捕获原始 `orig_ppid=$(fly1955_ps -o ppid= -p $$)`;每片后复读,要求与 `orig_ppid` **逐字相等**——任何变化(含 reparent 到 1)或探针错误 → **立即 `exit 1`**(告警已在 hold 前发出,不重复;不再走 daemon_die——孤儿进程不该再写计数/发告警)。这使**父进程退出后**本 shell 的最坏遗留时间 ≤30s,不依赖任何未经证明的信号传播假设(R1 #4:runtime 经 promisified execFile 启动本脚本,无显式信号转发)。

- 告警先于 hold(值守第一时间看到,而非 15 分钟后);
- die 文案为新文案(新失败类,不与既有 golden 冲突);
- 恢复路径零特殊逻辑:token 修好 → 下一轮 start exit 0 → 健康路径 → 计数清零。

### 3.3 runtime 生命周期建模(R1 #4;两条路径都成立,均不改 TS)

| 路径 | 现行为(源码现读) | 加入 hold 后 | 验收口径 |
|---|---|---|---|
| **initial-boot 失败** | `DaemonConnectionSupervisor.start()` 首次 `ensureDaemon()` 失败 → main fatal → exit 1 → launchd(Throttle 30s)重拉 | 每轮 ≈900+37s,launchd 驱动 | 循环节奏 ~37s → ~15.6min |
| **post-start-loss** | 连接丢失后 supervisor rebuild loop(`DaemonConnectionSupervisor.ts:227`)反复调 `ensureDaemon()`,失败**被捕获不 fatal**,backoff 1/2/5/15s(cap 15s) | 每次 rebuild 内嵌 hold ⇒ 同一存活 runtime 内每 ≈900+15s 试一次;launchd 不参与 | runtime 进程 pid 不换,但 ensure-daemon 尝试节奏同为 15min 级 |

两条路径的恢复语义一致:重登录后下一次 ensure-daemon 尝试(≤ 一个 hold 周期)满血恢复。**部署验收两条都采**:若观察到 runtime 常驻但循环停了,按 post-start-loss 口径读数,不误判为「已修好/已卡死」。

**stop 语义上界(R2 #2,两条分开写)**:
- **initial-boot 路径**:`launchctl stop` → runtime 的 `supervisor.stop()` 会等待含 `ensureDaemon()` 的 in-flight promise,不假设子进程收到信号时 node 可存活到 plist `ExitTimeOut=30` 被 SIGKILL;父死后本 shell 可能刚进入一片 30s sleep ⇒ **保守上界 ≈60s**(30s ExitTimeOut + 30s 分片);
- **post-start-loss 路径**:runtime 主进程退出即父消失 ⇒ **上界 ≤30s**。
产品无「stop 起算 ≤30s」硬要求;若未来出现该要求,需显式 child cancellation(TS 改动),当前分片方案单独做不到——如实记为边界。stop/kickstart 语义由 §3.2 的父身份探测兜底,并纳入 A8 测试 + 部署后一次真机 stop drill(§6 阶段 2)。

### 3.4 兼容性

- companion(read-only)与 full-access 同受益:分类在 start 失败分支,与 profile 无关;
- 健康路径 stdout/stderr/命令序列零变化(golden T2′ 复验);唯一 fs 变化 = 快照读(只读)+ 成功时受控清计数文件(§4.1,无输出);
- 分类未命中时行为与现状逐字一致(A2/A2b/A3 阴性测试锚定)。

## 4. C2 详细设计 — 连败计数安全网(R1 #5 修正)

### 4.1 `daemon_die`

```
daemon_die(msg):
  io_fault = none                             # R3 #1:每次 daemon_die 至多一个 I/O 故障出口
  读态四分(R2 #3):
    counter 不存在 → count=0
    counter 是 regular file 且内容为合法数字 → count=该值
    counter 是 regular file 但内容损坏/截断 → count=0(容忍,不告警)
    counter 存在但【非 regular file】(目录/symlink,lstat 判定、不跟随)、或真正的 read I/O 错误
      → io_fault=read_state,count=0,**跳过下面的写入步骤**(不对已知坏目标再试 os.replace)
  count += 1
  if io_fault == none:
    原子写回(经 python3,单工具链):同目录 mktemp 写入 → os.replace(tmp, counter)
      (os.replace 对「目标是目录」直接报错,不会把临时文件挪进目录里假成功)
      → 成功后复验:目标是 regular file 且内容 == count
      → 任一步失败/复验不符:清理临时文件,io_fault=write
  if io_fault != none:                         # 统一单出口:恰一次告警
    emit_lead_alert crash_loop severe "fly1955-failcount-io|$(LC_ALL=C date -u +%Y%m%d)" \
      "ensure-daemon failcount persistence broken" <home + io_fault 类别>
    (安全网的状态存储坏了本身就是必须可见的故障;天级去重兜投递噪音)
  if count >= 3:
    emit_lead_alert crash_loop severe "fly1955-ensure-daemon-failing|$(LC_ALL=C date -u +%Y%m%d)" \
      "Codex Lead ensure-daemon failing repeatedly" \
      "<msg + consecutive=count + home 路径 + 指向 FLY-1955>"
  die "$msg"
```

- **不可写目标下的跨轮语义(如实)**:counter 为目录/symlink 期间,每轮读态都判 read_state 故障 → count 恒为 1、连败阈值**不可能**经计数达到——可见性由每轮的 failcount-io 告警(天级去重实发)承担,而非计数推进;原子失败(write)情形下,既有合法 numeric counter 保持旧值(或原本缺失保持缺失),不产生半写状态。

- `ensure_daemon` 内**全部** die 站点(codex_bin 校验、not_proven、action_stuck、race/reaped 重试失败、socket 缺失、auth-dead、unknown outcome)换 `daemon_die`;die 文案逐字不变(golden 与既有测试不受扰);
- **成功路径清零受控**:`if ! rm -f <counter> 2>/dev/null; then log + 尝试同款 fly1955-failcount-io 告警(非阻塞); fi` —— `set -e` 下不允许清零失败把健康 daemon 变成启动失败(R1 #5);清零失败**不阻断**健康 return;
- 计数文件放 Lead home 根(**不放** `app-server-daemon/`——那是 codex 管理目录,不塞外来文件);
- ≥3 后每轮都会尝试 emit,**天级去重由 lead-alert.sh claims 承担**(与 FLY-513 warn 告警同模式);
- 阈值固定 3(37s 节奏 ≈2min、81s 节奏 ≈4min 触发;单次瞬态 blip 下一轮自愈不响),不加配置面;
- zombie 专用告警(recovered/stuck)原样保留;auth-dead 停机日实发上界 = login_expired + crash_loop(+ 仅在存储坏时的 failcount-io)。

### 4.2 与既有告警语义的关系

第一轮把「要不要告警」逐失败类别决定,auth-dead 整层漏过 4.7 天(race_self_healed 重试失败路径零告警)⇒ 本轮方法论转向:**具体类别告警(zombie、auth)负责携带证据上下文;连败安全网负责穷尽性**——且安全网自身的持久化失败也有告警形态(R1 #5),不存在「安全网静默失效」的第二层缝隙。

## 5. C3 测试计划(TDD,追加进既有 harness)

既有基建复用:sourceable SUT、stub codex bin、`FLYWHEEL_LEAD_ALERT_SH` 假告警记录 argv、`fly1955_*` 可覆写 seams、trap 清理。新增场景:

| # | 场景 | 断言 |
|---|---|---|
| A1 | **RED→GREEN 主场景**(生产复刻,R2 #1 修正):stub start 失败并在失败前对 stderr log 做**同 inode truncate+重写**(`: > log` 后写 `token_revoked`) | 旧代码走 race_self_healed 重试失败静默 die;新代码:三态取证判 truncate/rewrite → 扫整份当前文件 → login_expired 告警恰一次(argv 三元组逐字,body 含 `token_revoked` 且**不含**日志原文行)、覆写的 `fly1955_sleep` 收到 30×30 分片序列、die 文案含 `auth revoked`、零 reap 动作(无 kill/无二次 start)、计数文件=1 |
| A1b | 正向变体:同 inode **纯追加** `token_revoked`(旧前缀 digest 不变) | 只扫 append suffix 命中 ⇒ 分类成立;与 A1 同断言 |
| A1c | 正向变体:快照时文件不存在/新 inode 重建后写 `token_revoked` | 扫整个新文件命中 ⇒ 分类成立 |
| A2 | 阴性:stderr log 与快照完全未动(同 inode 同 size 同 digest,含**陈旧**吊销行) | 四态之「本轮未写」⇒ 不分类;走既有 zombie 机制路径;零 login_expired |
| A2b | 阴性(R1 #1 专项):同 inode 纯**追加**非 auth 行(如 connection errored),快照**前**已有旧 `token_revoked` | append suffix 不含吊销签名 ⇒ 不分类(mtime/全文 grep 方案会在此误判,增量合同不会) |
| A3 | 阴性:本轮重建的 stderr log 只有 `connection is errored` 无吊销签名(网络断形态) | 不分类 |
| A4 | 连败计数:连续 3 轮 die(任意混合失败类) | 第 1、2 轮零 crash_loop emit;第 3 轮 emit 恰一次且 body 含 consecutive=3;第 4 轮再 emit(去重属 lead-alert,harness 只断言尝试) |
| A5 | 计数复位:die、die、成功、die、die | 成功轮后计数文件消失;后两轮不触发(计数 1、2) |
| A6 | 计数文件损坏(fixture 写非数字/截断) | 按 0 处理原子写回 1,不 crash,die 正常 |
| A7 | auth-dead 轮推进计数:A1 场景连续 3 轮 | 第 3 轮 login_expired + crash_loop 双 emit |
| A8 | **hold 中父身份变化**(R1 #4 / R2 #2):覆写 `fly1955_ps` 使第 N 片后 ppid 探测返回与 `orig_ppid` 不同的值(含 1 与非 1 两种);另一变体探针报错 | hold 提前退出,`exit 1`,无 daemon_die、无第二条告警、无计数推进;分片计数 = N |
| A9 | 计数持久化故障(R1 #5 / R2 #3 / R3 #1):三变体——①写/replace 注入失败;②counter 路径预置为**目录**;③counter 为 symlink | 三者均:**本次 daemon_die 恰一次** `fly1955-failcount-io` emit(统一单出口)、die 正常携带原文案;目录/symlink 变体另断言:目标未被跟随或改写、无临时文件遗留(含未被挪入目录);①变体另断言:既有合法 numeric counter 保持旧值(或缺失保持缺失)。**不**断言不可写目标的跨轮计数推进(§4.1 如实语义:该情形可见性靠每轮告警,不靠计数) |
| A10 | 清零失败(R1 #5):成功路径上 rm 被注入失败 | 健康 return **不被阻断**;log + failcount-io 告警尝试恰一次 |
| A11 | stat/read 竞态(R1 #1):覆写探针使 A-P2 复读抛错 | 返回未分类,走既有路径 |
| T2′ | 复跑既有 golden(companion + full-access 健康路径) | byte-compat 保持;计数文件不存在;快照只读不落盘 |

真机 E2E 边界(如实):**refresh token 吊销无法在台架伪造**(server 侧状态)。真机验收改挂部署后生产观察(§6 阶段 2,含一次 stop drill)+ 账号重登录后的恢复观察(§6 阶段 0),判据明确。QA 节点不得为造「假吊销」而篡改生产 auth.json(不可逆风险)。

全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + C3 harness + CI enumeration 绿。

## 6. 部署顺序与 operator runbook

**阶段 0 — 账号处置(operator,不等 merge;依 Lead/founder 对 Q-R2 裁决;R1 #2 修正)**

- **救回(裁决 A)— 严格按 FLY-1071 quiesce 合同执行,禁止在 crash-loop 活跃时并发写 auth.json**:
  1. `launchctl bootout gui/501/com.flywheel.lead.flywheel-codex-infra-bot-lead`(停掉 KeepAlive 循环;这是 operator 授权动作,非本 design 节点执行);
  2. **证明该 home 无残留**:进程表零个 argv 含 `/Users/xiaorongli/.codex-infra-bot/` 的 `app-server`/`pid-update-loop`/`remote-control` 进程(身份栅栏按 argv 字面前缀,不按进程名);有则按第一轮 §3.3 tri-state 语义收敛后再继续;
  3. **home-scoped 重登录**:显式 `CODEX_HOME=/Users/xiaorongli/.codex-infra-bot` + 该 home 的 standalone binary 执行 login 流程;可复用 `/codex-relogin` 的**浏览器 OAuth 部分**,但**跳过其全局 `codex-profile` 切换/保存步骤**(该 skill 原样调用会动全局登录态,与本步骤的 home 隔离目标冲突;R1 #2);
  4. 同一 `CODEX_HOME` 语境下验证登录态(status 类只读命令;rc 异常按 memory 前科用输出判,不用 rc 判);
  5. `launchctl bootstrap gui/501 <plist>` 恢复服务;
  6. 验收:`auth.json` mtime 更新 → 下一轮 `daemon OK` → TUI up → runtime started → Discord @ 回话 → 采样窗 ≥5 分钟 pid 稳定(>3 个循环周期)。
- **退役(裁决 B)**:本单只部署代码(舰队级防复发),Lead 下架另单;parked 节奏(15.6min/轮 + 每天 ≤2 条去重告警)是可接受的过渡态。
- 裁决未到时:代码照常推进(两者兼容),runbook 双轨留档。

**阶段 1 — 代码(C1-C3)**:先复跑既有 golden(改前基线)→ TDD(A1 RED→GREEN)→ 全仓门 → codex code review → PR。

**阶段 2 — 部署(R1 #6 修正验收口径)**:FLY-1959 merge/deploy 解耦,updater 班车部署生产 checkout;脚本被 runtime 每轮现读 ⇒ 自动送达,无需任何人碰该 Lead。部署后验收(若账号尚未救回):
- 循环节奏 ~37s → ~15.6min(采样窗 ≥3 个 hold 周期,>47min;若 runtime 常驻按 §3.3 post-start-loss 口径读数);
- **告警验收查投递不查 claim**:当日 `login_expired` 与 `crash_loop` 事件在 `alert_deliveries` 中状态为 `sent` 或 durable `queued` 才算过;`dead_lettered` 单列为**失败**(裸 `alert_claims` 存在不构成投递证据);
- `/tmp` 日志新轮次含 `auth revoked` die 文案;
- **一次 stop drill(R2 #2 修正判据)**:stop 前记录当前 ensure-daemon shell 的 `pid+lstart+argv` 三元组 → `launchctl stop` → 断言**该旧三元组**在保守上界内消失(initial-boot 形态 ≤60s = ExitTimeOut 30s + 一片 30s;post-start-loss 形态 ≤30s);**允许** KeepAlive 已产生的新一代 managed ensure shell 存在(按三元组区分新旧,不按进程名清点——「零 ensure-daemon/sleep」的裸判据会把合法新一轮误判为残留)。随后服务自行回归 parked 节奏。
若账号已救回:验收 = 健康路径持续 + 计数文件不存在。

**阶段 3 — FLY-513 收口(operator,第一轮阶段 3 原样执行;R1 #6 修正)**:工具固定为 `packages/teamlead/scripts/fly-513-repoint-global-codex.sh`;执行时**再次现读**前置条件(全局链 realpath 解析到完整 standalone release 树;不引用本文点态)且**保留工具自带的「确认无 Codex review 正在进行」前置门**(全局轴 repoint 会中途影响正在跑的 review gate,冒烟不能替代该门)→ `all`(dry-run 审读)→ `all --apply` → `verify` → `codex --version` + 任一 runner review gate 冒烟 → **>65 分钟**跨 updater 周期观察窗内全局链仍解析到中立布局。前置条件为假 → 安全停止回报 Lead(沿用第一轮合同)。

**阶段 4 — FLY-1892 验证(仅账号救回后)**:入站 core @ + 出站 `flywheel-comm ask` 双向落库验证;通则在 FLY-1892 留证并单,不通则回报其独立继续。

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 误分类(网络断/其他 401 被判 auth-dead) | 三态取证合同(§3.1)只认**本轮新写字节**里的凭据吊销专属 code,覆盖新建/追加/truncate-rewrite/未写四形态;A2/A2b/A3/A11 阴性锚定。即便误判,后果=15min 节奏 + 一条天级去重告警,系统仍每轮重试,诱因消失后下一轮自愈——不比现状更坏 |
| hold 阻塞 stop / 遗留孤儿 shell | 分片 hold + 每 30s 父**身份**探测(orig_ppid 逐字比对);父死后遗留 ≤30s,launchctl stop 起算保守上界 60s(initial-boot)/30s(post-start-loss),§3.3 如实分开;A8 + 阶段 2 真机 stop drill 双面验证;不依赖未经证明的信号传播 |
| 计数存储失败让安全网静默失效 | 读态四分(lstat 不跟随)+ python3 os.replace 原子替换(目录目标必报错)+ 写后复验;I/O 故障收敛为每次 die 恰一个统一告警出口(R3 #1);清零失败不阻断健康 return;A6/A9(三变体)/A10 覆盖 |
| 告警尝试每轮发(≥3 后) | claims 天级去重(既有机制);验收按 `alert_deliveries` 投递状态判,dead_lettered 单列失败 |
| 健康路径被扰动 | 分类/计数只挂失败分支;快照为只读;清零受控非裸 rm;T2′ golden 逐字对照 |
| 重登录与 crash-loop 并发写 auth.json | 阶段 0 强制 FLY-1071 quiesce 序列(bootout→证明无残留→登录→bootstrap),禁止带病写入 |
| auth 修好后 15min 内不恢复被误读为「没修好」 | runbook 写明恢复延迟上界 = hold 值;立即恢复路径 = `launchctl kickstart -k` |
| 回滚 | 单文件加性改动,`git revert` 即回现状(37s 循环、零告警;不更坏);无状态迁移(计数文件残留无消费者,可手删) |

## 8. 与 FLY-2211 / FLY-2090 的互查(Lead 指令 ce0b9f5c;证据由 Lead 代读 2211 评论区)

- **事实基线**(Aunt Cass 实测,经 Lead 转述):孤儿 broker pid 819 连穿四次全舰重启波(08-30 12:00 / 08-31 00:00 / 01:19 / 12:00)——重启波对 broker **既不保护也不回收,生命周期无归属人**;其「孤儿占注册位致 1955 boot 失败」假设已被 Lead 22:44Z kill 实验证伪(收掉后循环照旧),本单真根因 = 凭据死亡。
- **互查约束(写死)**:FLY-2211 若采「broker 不杀名单」方案,**豁免必须按身份栅栏(pid+lstart+argv 的 home 锚定三元组)而非进程名**——无条件豁免 `pid-update-loop`/`app-server` 进程名会:①让穿波孤儿更难收(Aunt Cass 已告诫);②直接废掉第一轮已 ship 的 zombie reap(它在 P1-P6 证据链完备后必须能杀 updater)。反向亦成立:本单第二轮**零新增杀进程逻辑**(只加分类+告警+分片 hold),不给 2211 增加新的误杀面。
- **间接增益**:parking 把 auth-dead Lead 的 daemon 换代频率降 ~25 倍,重启波撞上换代中间态的概率同步下降。
- FLY-2090(Retro)分析材料不在本仓库、本会话 Linear MCP 401 不可读;以上互查基于 Lead 转述证据完成,若 2211 评论区有推翻性证据,以 issue 为准并按增量修订本节。

## 9. Follow-ups(不在本单)

- updater 升级策略(禁用/钉版本)评估——第一轮 follow-up 原样顺延;
- codex 上游 bug(zombie 判活)跟踪——第一轮 follow-up 原样顺延;
- 舰队级 Lead crash-loop 检测归 FLY-1687 / launchd 层;broker 生命周期归属人问题归 FLY-2211;
- 若裁决退役 infra-bot:Lead 下架/账号清理另单。
