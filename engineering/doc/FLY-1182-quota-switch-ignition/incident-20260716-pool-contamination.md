# FLY-1182 事故完整证据档案 — 2026-07-16 账号池交叉污染 + keychain 静默漂移

Issue: FLY-1182 (https://linear.app/geoforge3d/issue/FLY-1182/enable-claude-账号-quota-自动切换点火-开关配置-fly-696-8-真机-qa-go-卡-常开)
日期: 2026-07-16
基于: evidence/incident-2026-07-16-keychain-drift.md(初版取证档案,本文件为其完整原始证据版)
用途: FLY-1252 设计的动机证据 + Annie 存档(Tadashi 执行令 ②,回复 3457da60)
取证纪律: 全程只读(keychain 只 find -w、从未写入;usage/profile 只 GET;DB 只 SELECT)。
例外: 本档案 §7 记录的止血冻结(Tadashi 执行令 ①,他担责)是唯一的写操作,且不碰凭据。

## 0. 一句话结论

不存在「某个组件在 10:00–10:17 PDT 把账号切到 shopping」的单一动作;真相是
**账号池凭据文件已交叉污染 + 整条切换链路(capture_back / use / monitor 标签)
零 token→身份核验**。shopping 是 08:43 PDT 一次 `use personal` 把被污染的
pool:personal 槽(内容实为 shopping 的 token)写进 keychain 时现身的;
10:14:52 与 10:53:10 两次 claude 进程侧写回反而把 personal 修了回来(误打误撞自愈)。

## 1. 身份实锤表(/api/oauth/profile,逐 token 直问身份;2026-07-16 ~18:14Z 取证)

请求形态与 daemon usage 探针同契约:GET https://api.anthropic.com/api/oauth/profile,
header = Authorization: Bearer <token> + anthropic-beta: oauth-2025-04-20。

| token 来源 | profile 返回 email | uuid(前 12) | 判定 |
|---|---|---|---|
| keychain(当时现值) | xrliannie@gmail.com | f2caedf8-4d28 | = personal ✅(Annie 10:32 切回有效) |
| pool school/.credentials.json | xrliannie@gmail.com | f2caedf8-4d28 | ❌ 槽名 school,内容是 personal |
| pool personal1/.credentials.json | xrliannie@gmail.com | f2caedf8-4d28 | ❌ 槽名 personal1,内容是 personal |
| pool personal/.credentials.json | HTTP 401 | — | 死快照(family 已轮转;时间线证明内容曾是 shopping 系) |
| pool business/.credentials.json | HTTP 401 | — | 死快照 |
| pool shopping/.credentials.json | HTTP 401 | — | 死快照(Jul 4 12:27 捕获) |

**⇒ 池子 5 槽:2 个错身份 + 3 个死。自愈引擎实际切换能力 = 0**(下次触发要么把
personal 自己再写一遍、要么全灭 no_target),尽管遥测(monitor 日志/store/告警)全绿。

辅证:usage API 指纹(同时刻)——keychain-now 与 pool:school、pool:personal1 三个
token 的 5h/7d utilization 与 resets_at 完全一致(5h=35% reset 20:30Z;7d=26% reset
07-17T06:00Z,微秒级差异为服务端按请求计算),先于 profile 直证指向同一账号。

## 2. 污染机制(设计缺陷,非单次误操作)

`packages/claude-runner/bin/flywheel-claude-profile`:

- `capture_back()`(:333–358):每次 `use <target>` 前把**当前 keychain 凭据**按
  **.active 标签**写回旧账号 pool 槽——「当前 keychain 是谁」全凭标签,无核验。
- :373 注释自认 "The opaque token cannot be decoded to an identity"——前提错误:
  /api/oauth/profile 一行 GET 即可解码(§1 即为方法)。
- 脚本头注释(:24–26)自己点名已知外部写入者:"a claude re-login recreating the item"。
- ⇒ 任何 out-of-band keychain 写入(claude re-login / 陈旧 session token-refresh 写回 /
  人手 login)都让 标签 ≠ 实际;下一次切换 capture_back 就把错误账号凭据捕进错误槽位,
  并随每次切换继续扩散。**一次静默漂移 = 全池级联污染。**
- 陈旧会话面(持续污染源):全舰 14 个 Claude Lead 均为 Jul 15 01:24–01:34 PDT 启动
  (ps lstart),出生时读到什么 keychain 凭据就永远持有该 token family,其后每次
  OAuth refresh 都会把该 family 写回 keychain。

## 3. 精确时间线(PDT;每行括号为证据)

| 时刻 | 事件 | 证据 |
|---|---|---|
| Jul 14 ~14:30 | business 真 weekly 封顶事故;Annie 老公手切 keychain → shopping(当时有配额) | FLY-1252 issue 描述 |
| Jul 15 01:24–01:34 | 全舰 14 Claude Lead 启动(shopping 时代出生 → 持 shopping family 的嫌疑群体;实际首个可证 personal-era 写回见 10:14:52 行) | ps -o lstart |
| Jul 15 ~02:29 | personal1 侧活动(池 personal1/.claude.json、backups mtime)——推断为手动恢复窗口 | 池目录 mtime |
| Jul 15 23:06:35 | FLY-1256 外部 quota daemon 上线(pid 10747)+ CUTOVER=1 写入 .env | wrapper log 首行;.env mtime 23:06:37 |
| Jul 16 01:16:43 | gen2:daemon 正常切换 "personal1→business";capture_back 把当时 keychain 凭据按标签捕进 personal1/ 槽 | claims.db account_switched 08:16:43Z;store personal1.quotaExhaustedUntil=09:30Z |
| 04:56:49 | gen3:daemon 正常切换 "business→school"(store mtime 04:56:53;state.lastSwitchAt=1784203009910=11:56:49Z 精确吻合) | claims.db account_switched 11:56:55Z;~/.flywheel/quota-monitor-state.json |
| 05:16:58 | "school" 标签 5h=100%,候选全灭 → quota_no_target severe **发出一次**,之后同日同签名去重静默 | claims.db 12:16:58Z;monitor log 100% 平台期 12:37–14:27Z |
| 07:27 | 封顶期间 verifyCandidate probe-refresh personal1 槽,写回的是 **personal family** token(⇒ personal1 槽污染在此之前已存在,最早可指向 gen2 的 capture_back) | personal1/.credentials.json mtime 14:27Z;§1 身份实锤 |
| 07:30 | 该账号 5h 窗口重置,100% 解除(引擎全程没能切出去 =「engine 没干活」第 4 例,根因=候选池全废) | monitor log 14:37Z 骤降 4% |
| **08:43** | **某人/某物执行 `use personal`**:capture_back 把当时 keychain 凭据(personal family)按标签捕进 school/ 槽(⇒ school 槽污染);随后把 pool:personal 槽内容(**实为 shopping family**)写进 keychain。.active→personal | school+personal 槽 mtime 15:43Z;monitor 标签 15:57Z 起变 personal;7d=3→8% 轨迹全池唯一吻合 shopping;**执行者无法确定——脚本无 audit log(结构缺口),zsh history 无记录,非 daemon(state 无记录);Tadashi 将问 Annie 是否她本人** |
| 09:57–10:17 | Lead/Annie 观察到三方不一致:store=school / monitor 标签=personal / 实际=shopping | Lead 指令 8694375d 原文;上行为机制解释 |
| **10:14:52** | keychain item 被**删除+重建**(cdat 重置)= claude 进程侧写入(profile 脚本用 add-generic-password -U 原地更新,不会重置 cdat)→ 某 personal-era 活进程 token refresh 写回,**把 personal 写回**(数字跳到 11/22,与此后 personal 轨迹连续) | security cdat=20260716171452Z;monitor 17:17Z 数字突变 42/8→11/22 |
| 10:32:02 | Annie `use personal` 手动切回:再次把 pool:personal 槽的**死 shopping 快照**写进 keychain(她无从得知槽被污染) | .active mtime;~/.claude.json oauthAccount=personal |
| 10:37:30 | daemon 读 keychain 得 401/过期 → `quota_read_blind` 告警(死快照的直接后果) | claims.db 17:37:30Z;monitor log 该 tick 无 quota 行(17:17→17:57Z 空档) |
| **10:53:10** | 又一次 claude 进程侧写回(mdat),活的 personal token 回到 keychain → 此后稳定 | security mdat=20260716175310Z;monitor 17:57Z 起恢复读数 26/25 |
| 11:01+ | 取证时点:keychain=personal(§1 直证);mdat 18:01:44Z = personal-era 进程正常续 token | 本档案 |

### 监控轨迹对账(monitor log /tmp/flywheel-quota-monitor.log 全量,标签 vs 实测)

| 区间(Z) | 标签(.active) | 5h% 轨迹 | 7d% 轨迹 | 实际账号判定 |
|---|---|---|---|---|
| 06:06–08:16 | personal1 | 37→98 | 8→19 | 标签期账号(gen2 前) |
| 08:36–11:56 | business | 25→93(09:30Z 5h 重置 45→6) | 5→26 | 标签期账号(gen3 前) |
| 12:06–15:17 | school | 95→100(平台期)→4(14:30Z 重置)→27 | 27→32 | 标签期账号 |
| 15:57–16:57 | personal | 14→42 | **3→8** | **shopping**(7d 个位数全池唯一吻合;=08:43 污染写入的直接观测) |
| 17:17–17:57 | personal | 11→26 | **22→25** | **personal**(7d 无法在 20 分钟内 8→22;此轨迹与 §1 keychain-now 身份连续) |
| 17:37(无 quota 行) | personal | — | — | 死 shopping 快照(401)→ quota_read_blind |

## 4. keychain 元数据(security find-generic-password,只读)

| 字段 | 值 | 含义 |
|---|---|---|
| cdat | 20260716**171452**Z(10:14:52 PDT) | item 在事故窗内被**删除+重建**——profile 脚本用 -U 原地更新不重置 cdat ⇒ claude 侧写入 |
| mdat | 20260716**175310**Z(10:53:10 PDT)→ 取证复查时 180144Z | 最后写入者;18:01 那次 = personal 活进程正常续 token(与 §1 身份吻合) |

## 5. 告警投递账本(claims.db = ~/.flywheel/alerts/claims.db,quota-monitor 当日全量 6 条)

| 时刻(Z) | kind | 对应事件 |
|---|---|---|
| 06:05:36 / 06:06:35 | quota_monitor_down ×2 | daemon 上线自检 |
| 08:16:43 | account_switched | gen2 personal1→business |
| 11:56:55 | account_switched | gen3 business→school |
| 12:16:58 | quota_no_target(severe) | school 标签 100% + 候选全灭(首条;此后同日同签名去重) |
| 17:37:30 | quota_read_blind | Annie 切回后死快照 401 |

投递成功的反证:sendQuotaMonitorAlert 对非 sent/duplicate/queued 结果直接 throw 且会
打死 daemon 主循环——daemon 自 23:06 起连续存活、日志零 error ⇒ 每条都被
lead-alert.sh 接收投递(→ #flywheel-alerts)。

### 为什么 Annie 体感 = 零通知

1. `account_switched` 在 lead-alert.sh 是 INFORMATIONAL_KINDS(root 消息、无 ticket
   头、**不 @ 任何人**)→ 淹没在 #flywheel-alerts 流量里;
2. `quota_no_target`(severe)同日同签名只发第一条,两小时封顶期后续全部去重静默;
3. **#flywheel-notify 的 FLY-929 digest 位点挂在 Bridge 切换面上,CUTOVER=1 后整条
   死路**(PR #615 honest boundary 亦有记载)——Annie 订阅期望的频道永远安静;
4. 窗口内 shopping 现身本就不是引擎动作(引擎侧无事件可发),唯一间接反应 =
   10:37 的 quota_read_blind。

## 6. 四个候选裁决(Lead 指令 8694375d 的 (a)–(d))

| 候选 | 裁决 | 证据 |
|---|---|---|
| (a) FLY-1256 daemon 静默路径 | **排除**(窗口内零切换;它的两次切换均有 claims 记录且账本一致;但其测量与切换建立在被污染池 + 零身份核验之上,是共犯非元凶) | state.lastSwitchAt 停在 11:56:49Z;claims.db |
| (b) FLY-1182 CUTOVER=1 B 段 | **排除**(结构性无 keychain 写入面) | quota-daemon-cutover.ts truth table:cutover 下 attachAccountSwitch=false / watchdog=false / route 退役 / pending 隔离,唯一活面 runner-quota-scan 只发告警 |
| (c) flywheel-claude-profile 调用 | **部分坐实**(08:43 的 use personal 是 shopping 现身的直接机制;执行者不明 = 脚本无 audit log 的结构缺口) | 槽 mtime + .active + monitor 标签三重吻合;zsh history 空 |
| (d) runner 级 fallback | claude 侧无此机制;**其变体「陈旧 claude session OAuth refresh 写回」= 10:14:52 / 10:53:10 两次写入的最佳解释,也是池污染初始来源头号候选** | cdat 删建模式;fleet 出生时间;脚本头注释自认该写入者存在 |

## 7. 止血记录(Tadashi 执行令 ①,2026-07-16 12:41 PDT 执行,他担责)

- 动作:`~/.flywheel/quota-monitor.json` 原子改写 `order: []`(jq → temp → mv)。
  CLI 每 tick 重读 config,空 order = monitor-only:**检测/测量/告警全保留,切换面关死**
  (pollOnce 对空 order 走 quota_no_target 分支)。生效 = 写后下一 tick(accelerated
  节奏 ≤10 分钟)。
- 冻结时上下文:personal 5h=81% 且在爬(19:37Z tick),距 trigger(100)约 1 小时内
  ——不冻结则大概率触发一次「必错的切换尝试」。
- 另记录:config 的 trigger5hPct 在本日早些时候由 **Tadashi 本人**从 90 改为 100
  (配置层缓解;FLY-913 护栏拦了进程级路径)。**两个改动叠加**:trigger=100 只抬高
  触发线(5h 真到 100% 仍会尝试切换),`order: []` 才是「只看不切」硬冻结。
  **恢复链(顺序敏感)**:① 还原本 runner 的备份(得到 order 五账号 + trigger=100
  的状态)→ ② Tadashi 单独 revert trigger 100→90(他记录在案,池子重建后执行)。
- 备份:`~/.flywheel/quota-monitor.json.pre-freeze-fly1182-20260716`
  - 备份 SHA256 `1c26820b7748e582f3be47e9bb36e1ed9a357d2c8a38b6ff308ff5c8647e80fa`
  - 冻结后 SHA256 `8aeaa8858b8336c1e0e6e113e5658ba19b3a4801de4ca626beb51c73e5ce589a`
- **恢复一行**(池子重建完成、Annie 拍板后才执行):
  `cp ~/.flywheel/quota-monitor.json.pre-freeze-fly1182-20260716 ~/.flywheel/quota-monitor.json`
  (下一 tick 生效,无需重启 daemon。)

## 8. 修复归属(已在 plan.md Rev 3 定稿,Codex 10 轮 APPROVED)

- **FLY-1182(bash/脚本面 + 点火流程)**:identity-anchor 资产 + /api/oauth/profile
  断言三接线点(capture / capture_back / use)+ audit log + 双层 founder-only bypass +
  7.7 rebuild 维护命令(durable journal / offline cutover / promote-enabled)+ Task 8
  事务化池子重建(Annie 在场)+ R3-G GO 卡判据。
- **FLY-1252(TS daemon 运行时面)**:switchAccount 内 switch-verify 身份断言、每 tick
  keychain 身份漂移侦测、通知路由表、exit 86/87/88 与 drift marker 消费(契约 =
  plan.md Rev 3 §7.6)。
- 陈旧会话写回治本源 = fleet Lead 重启窗(Tadashi 调度)。
- **池子重建等 Annie 在场,任何人不得先动凭据**(Tadashi 令)。
