# FLY-1659 supervisor 锁风暴根治 — 独立 QA 验证报告

Issue: FLY-1659 (https://linear.app/geoforge3d/issue/FLY-1659/supervisor-锁风暴根治外部重启后无收养分支15-supervisor-带锁死循环互相饿死-建窗验收噪声自杀-全舰)
日期: 2026-08-07
基于: plan.md

**被测 head**: `ad382ebe71dcbb429ba4d61d90ad86e200da2503`（PR #793，验收前后各核一次，`packages/ scripts/ .github/` 与 PR head 逐字一致；本地多出的两个 commit 只有我自己的 QA 记账文件）

**判决: FAIL** — 核心锁风暴根治（Fix 1-4）真机全部通过且效果显著；**Fix 6（restart preflight 残留审计）在生产机上误判生产 socket，会在每次全量重启时 @Annie 发一条 `deploy_failed` 级严重告警**，必须先修。

---

## 1. 一句话给 Annie

供养 Lead 的「保姆层」这次是真修好了：15 个保姆冷启动，47 秒全部认领了正在跑的 Lead，**一个 Lead 都没被误杀**，锁抢占次数从 91 次降到 0；杀掉一个 Lead 身体 54 秒内自动拉回来。但顺手加的那个「重启前扫一眼有没有测试残留」的小功能认错了人 —— 它把**生产自己的 tmux** 当成了要清理的垃圾，每次重启都会 @ 你一条「部署失败」级别的红色告警，说生产环境是残留、请去删掉。这条必须先修。

---

## 2. 验收矩阵（issue 验收 ①-④ + plan §3 真机项）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 阳性对照 | 未修代码复现 | **复现** | 见 §3 四格对照 |
| ① | 15 supervisor 冷 bootstrap（身体已在）→ ≤2min 全监护、零 kill 新窗、稳态零 lock_unavailable | **PASS** | 15/15 收养用 **47s**（deadline 120s）；body tuple 前后逐字相同；`lock_unavailable=0`；180s 稳态零窗口变动；15/15 supervisor 存活 |
| ② | 杀一个 lead 身体 → supervisor ≤90s 拉回 | **PASS** | 15 supervisor 舰队下 **54s** 拉回（trial 场 15s）；新 body argv 身份正确；archive 已换代 |
| ③ | atlas + q96 残留在场仍收敛 | **PASS** | 全部 run 期间 `tmux -L atlas`(pid 1825) 与 `/tmp/q96/tmux.sock`(pid 99116，session 名恰为 `flywheel`) 均在线，记录在每份 RESULT.txt 抬头 |
| ④ | fly1285 套件全绿 + 新增 storm 回归 | **PASS** | 见 §4 |
| plan §3 | TERM-during-lock 回归 | **PASS**（自带阳性对照） | 外部持锁 + 冷 socket → supervisor 真打出 `lock_unavailable` 后再 TERM，**1s 退出**，零 wedge |
| plan §3 | 双 successor TERM（launcher / adopter 两形态） | **PASS** | adopter TERM → body 逐字幸存并打印「no graceful teardown authority」；launcher TERM → body 按既有语义拆除；双 adopter 同时收养 → 零破坏动作，两个都 TERM 后 body 仍逐字幸存 |
| plan §1(6) | Fix 6 restart preflight 只读审计 | **FAIL** | 见 §5 |

---

## 3. 阳性对照（同一台机、同一套 harness、同样 N）

台架：隔离 HOME + 隔离 tmux socket（`FLYWHEEL_TMUX_SOCKET_OVERRIDE`）+ 隔离 comm.db/lease + PATH-shim 假 claude（`exec -a` 重写 argv[0]，`ps` 呈现与生产 Lead 同形，能过 `lead_identity_command_matches`）+ 告警全部本地截获（**零 Discord 出网**，见 §6）。
阳性对照栈 = `git archive 4857d999`（事故当期栈）原样落盘，只把未受本单改动的 `dist/` 软链复用；`_prepare_lead_launch` 函数 sha256 = `56c879bf…3fa46e`，与仓库里冻结 fixture **逐字一致**。

阶段设计：A 起 N 个 supervisor 各自建 body → B `SIGKILL` 全部 supervisor（身体活着、archive 与 lease 行留下 = `holder_orphaned`）→ C 冷启 N 个新 supervisor（这就是事故形态）。

| 指标 | 修前 4857d999 | 修后 ad382ebe |
|---|---|---|
| Phase A（N=15）把 15 个身体拉起来 | **11/15，386s 仍未齐**（超时中止） | **15/15，67s** |
| Phase A `lock_unavailable`（N=15） | **91 次**（单 lead 最高 11 次，`retrying in 3s→6s→12s`） | **0 次** |
| Phase C 收养（N=5） | **0/5**，129s 无一收养 | **15/15，47s**（N=15） |
| Phase C 身体存活（N=5） | **1/5 保住**，4 个健康活体被杀后重建 | **15/15 逐字保住** |
| Phase C `lock_unavailable` / `takeover hold (ambiguous)` | 14 / 1 | 0 / 0 |

> 四格数字互不相同 → 不是「台架坏掉造出来的假绿」。修前 N=15 连 Phase A 都跑不完，所以 Phase C 的收养对照取 N=5（plan 要求「3+ supervisor」）；这一点如实标注。

---

## 4. 测试套件（被测 head 上实跑）

| 套件 | 结果 |
|---|---|
| `scripts/__tests__/supervisor-adoption.test.sh` | 6 passed, 0 failed |
| `scripts/__tests__/supervisor-storm-regression.test.sh` | 27 passed, 0 failed |
| `packages/teamlead/scripts/__tests__/fly1285-tmux-supervisor.test.sh` | 8 passed, 0 failed |
| `packages/teamlead/scripts/__tests__/test-lead-identity-preflight.sh` | 23 passed, 0 failed |
| `scripts/__tests__/restart-storm-gate.test.sh` | 24 passed, 0 failed |
| `scripts/__tests__/tmux-server-rescue.test.sh` | 49 passed, 0 failed |
| `scripts/__tests__/lead-body-hard-clear.test.sh` | 19 passed, 0 failed |
| `scripts/__tests__/ci-structure.test.sh` | PASS（两个新套件已登记 ci.yml + 结构守卫） |
| `bash -n` 五个改动脚本 | 全部通过 |

注：这两个新套件是**函数抽取式**单元台架（`sed` 取函数体 + mock 依赖），跑完只要 ~5s。它们证明分支逻辑，不构成真机端到端；真机端到端由本报告 §2/§3 承担 —— 这与 plan §3「真机 QA 由独立 QA 节点做」的分工一致。

---

## 5. FAIL 项 — Fix 6 在生产机上把生产 socket 判成 QA 残留

**现象（真机实跑，`restart-services.sh` 的 `audit_tmux_qa_residue_read_only` 函数体逐字抽出、打真实进程表）**：

```
[log] WARNING: non-production tmux server audit pid=1825  socket=/private/tmp/tmux-501/atlas   sessions=atlas-growth
[log] WARNING: non-production tmux server audit pid=51104 socket=/private/tmp/tmux-501/default sessions=…,flywheel,flywheel-keepalive,…
[log] WARNING: non-production tmux server audit pid=99116 socket=/tmp/q96/tmux.sock            sessions=cmux-FLY-9998-implement,flywheel
[SEVERE] tmux-qa-residue-flywheel-session | 检测到非生产 tmux socket /private/tmp/tmux-501/default (PID 51104) 使用保留 session 名 flywheel。…请按 operator 手册核实并移除残留。
[SEVERE] tmux-qa-residue-flywheel-session | 检测到非生产 tmux socket /tmp/q96/tmux.sock (PID 99116) …
```

只有第 3 条（q96）是对的。第 1、2 条把 **atlas（Mufasa 的活 Lead）** 和 **生产默认 socket（整支舰队 14 个 Lead 身体所在）** 判成了「非生产」，并对生产 socket 发了严重告警，正文让 operator 去「移除残留」。

**根因**：allowlist 用未解析路径拼，比对用字面相等：

```bash
default_root="${TMUX_TMPDIR:-/tmp}/tmux-${current_uid}"      # → /tmp/tmux-501
allowlist="${default_root}/default:${default_root}/atlas"     # → /tmp/tmux-501/{default,atlas}
...
socket="${line#n}"          # lsof 报的是 /private/tmp/tmux-501/default
[[ "$socket" == "$allow" ]] && allowed=true                   # 永远不相等
```

macOS 上 `/tmp` 是 `private/tmp` 的 symlink（`ls -ld /tmp` 实测），`lsof -Fn` 只报解析后路径 → **allowlist 在生产平台上完全失效**。

**反事实闭环**（同一函数、同一台机、只换 allowlist 取值）：

| 运行 | 结果 |
|---|---|
| A：生产默认 env（= restart-services 真实运行形态） | 3 条 warning，**2 条 severe**（含生产 socket） |
| B：`FLYWHEEL_TMUX_AUDIT_DEFAULT_SOCKET=/private/tmp/tmux-501/default` + `..._ALLOWLIST=/private/tmp/tmux-501/atlas` | 1 条 warning，**1 条 severe**（只剩 q96）= 设计意图 |

**为什么影响是 HIGH 而不是「日志噪声」**：`restart-services.sh` 的 `alert_severe()` 把第一个参数只当签名 slug，**kind 硬编码 `deploy_failed`，并 `--mention-user $FLYWHEEL_FOUNDER_USER_ID` @ 创始人**（该 env 在 `~/.flywheel/.env` 与活进程里都已配置，实测存在）。脚本里其余 19 处 `alert_severe` 全是真故障（deploy failed / restart aborted / lead 需人工恢复）。于是：

- **每次**全量重启（成功的重启也一样）都会给 Annie 推一条 `deploy_failed` 严重告警；
- 告警正文点名生产 tmux socket 是残留、建议移除 —— operator 若照做会清掉整支舰队；
- 这正是 FLY-218 / FLY-220 刚刚花两单根治掉的「误报刷屏」类别。

**为什么单测没抓到**：`scripts/__tests__/restart-storm-gate.test.sh:508-514` 把 `lsof` mock 成返回 `n/tmp/tmux-501/default`（未解析形态）—— 真实 macOS `lsof` 永远不会这么报。fixture 干净 → 永远绿。修复时这条 mock 必须换成解析后路径（或另加一条 `/private/tmp/...` 的 case），否则同一个错误会再犯一次。

**建议修法（不替实现者做决定，供参考）**：在比对前对 `socket` 与 allowlist 两侧都做一次有界的真实路径归一（`_tmux_rescue_normalize_socket` 已有同类能力），或直接把 `default_root` 用 `cd … && pwd -P` 解析一次。另外建议把这条**观察性**审计从 `alert_severe`（=deploy_failed + @founder）降级为 `log` + 非 founder-ping 的通道；把一条纯审计观察塞进 `deploy_failed` 语义，即使路径修对了、q96 那条真残留也会在每次重启把成功的部署报成失败。

---

## 6. 台架卫生 / 对生产的影响

- **零 Discord 出网**：`FLYWHEEL_TMUX_RESCUE_ALERT_BIN` / `FLYWHEEL_ALERT_BIN` 指向本地捕获脚本，`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` 清空、`FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 指向不存在的变量。实测 supervisor 日志里是 `refusing per-lead fallback` + `delivery receipt is dead-lettered`，无一条 `HTTP 200`。
  （诚实记录：第一次 smoke 前我还没装这层隔离，误发了 2 条真实告警进生产 alerts 频道 —— `tmux_rescue_hold`(lead=flywheel-eng-lead) 与 `rules_bundle_legacy`(lead=qa1659-lead-01)，时间 21:54:58 / 21:55:01。之后所有 run 零出网。）
- **零生产变更**：全部 supervisor 跑在隔离 HOME + 隔离 socket；收尾核对残留 QA 进程 = 0；生产 tmux server census（atlas / default / q96）跑前跑后逐字相同；14 个生产 Lead body 全在；Bridge `/health` 全程 `ok:true`。
- 峰值 load 约 22（15 supervisor 冷启动），Bridge 未受影响。

---

## 7. 诚实边界（没测的、和为什么）

1. **真 Discord 529 N-to-N 未跑**。本 diff 的 Discord 面只有一处：Fix 6 新增的一个 `alert_severe` 调用点；投递链路（`lead-alert.sh` → 频道）本单 **零 diff**。我在真机上验到了**调用点**层面的真实载荷（并因此抓到 §5），渲染侧留到修复后的复验一起做 —— 现在跑 529 alerts 镜像只会渲染出一条本来就错的告警。这是显式取舍，不是遗漏。
2. **未在生产 `restart-services.sh` 顶层入口跑 Fix 6**（那会真的重启舰队）。用的是把该函数体逐字抽出、打**真实**进程表/lsof/tmux 探针的方式，函数 sha256 记录在 `scenario5/RESULT.txt`。
3. **rename 跳过后的长期形态未测**：建窗后若 `_tmux_target_matches_archive` 不过，窗会长期保留 `<name>.p-<nonce>` 保留名（设计上允许）。我没有构造「健康 body 长期顶着保留名」再触发 pre-launch 隔离门的场景，不知道会不会互相绊住。（我第一次 smoke 观察到保留名残留，追查后确认是我的假 claude argv[0] 是 `/bin/bash` 造成的身份不匹配 —— **台架问题，不是产品 bug**；修 shim 后 rename 正常。）
4. **假 claude 不是真 Claude**：body 只是一个 idle 进程，argv 与生产同形、能过身份匹配，但没有真实的 Claude 崩溃/compact/额度行为。KeepAlive 的「进程死了拉回来」这一层证到了，Claude 特有的死法没证。
5. **未做老栈 backport 核对**（plan §4 列的 backport 清单）—— 那是交付路径决策，属 Lead/founder 范围。
6. 顺带记录一条不阻塞的现实矛盾：`packages/qa-framework/README.md` 新增「QA tmux session 一律 `qa-` 前缀」，但 `claude-lead.sh` 把 session 名硬编码成 `flywheel`（:1530）。任何**用隔离 socket 跑真 Lead supervisor** 的 QA 台架（包括我这套）都无法遵守这条规则，会被 Fix 6 判成残留。529 slot 走默认 socket 所以不受影响。建议把规则写成「QA 自建的**非 Lead** session 用 `qa-` 前缀」，或让审计按 socket 归属而非 session 名判定。

---

## 8. 证据留档

`/Users/xiaorongli/.flywheel/qa/fly1659/`（不在 repo 内，跨 session 保留）

| 路径 | 内容 |
|---|---|
| `harness/lib.sh` | 隔离沙箱脚手架（HOME / socket / lease / 告警截获 / PATH-shim claude） |
| `harness/scenario1-cold-adoption.sh` | 验收 ① 冷启动收养（A/B/C 三阶段） |
| `harness/scenario2-keepalive.sh` | 验收 ② KeepAlive |
| `harness/scenario3-term-provenance.sh` | TERM adopter vs launcher |
| `harness/scenario4b-term-during-lock.sh` | TERM-during-lock（自带阳性对照） |
| `harness/scenario5-restart-audit.sh` | Fix 6 真机审计 |
| `harness/scenario6-dual-successor.sh` | 双 successor 双收养 |
| `storm15/logs/RESULT.txt` | 修后 N=15 完整结果 + 15 份 supervisor 日志 |
| `prefix15/logs/`、`prefix5/logs/RESULT.txt` | 阳性对照（老栈 4857d999） |
| `scenario5/RESULT.txt` + `census-{before,after}.txt` | Fix 6 告警载荷 + 零变更取证 |
| `oldstack/` | `git archive 4857d999` 落盘的事故当期栈 |

---

# 复验 Round 2 — head `23ff97aa6b0ddea2e08c977a35520c088f5bcd94`

日期: 2026-08-07（同一 QA session,FLY-752 fix-loop 复用）
修复 commit: `8ec1043b fix(FLY-1659): canonicalize restart audit sockets`

**判决: 仍 FAIL** —— Round 1 报的误报**已修好并复验通过**;但同一处引入了**新的漏报**:归一化后的 socket 路径超过 macOS AF_UNIX 104 字节上限,`tmux -S` 连不上,`/tmp/q96` 这个 issue 自己点名的残留**不再触发**保留名严重告警,而且是**静默**退化。

## R2-1 Round 1 的误报:已修复 ✅

同一台机、同一脚本(`scenario5-restart-audit.sh`,函数体逐字抽出打真实进程表):

| | Round 1 (ad382ebe) | Round 2 (23ff97aa) |
|---|---|---|
| 生产默认 socket 被判 non-production | 是 ❌ | **否** ✅ |
| atlas(Mufasa 活 Lead)被判 non-production | 是 ❌ | **否** ✅ |
| severe 告警条数 | 2（含生产 socket,@founder） | **0** |
| 零变更(tmux census 前后对照) | OK | OK |

`_tmux_rescue_normalize_socket` 实测把 `/tmp/tmux-501/{default,atlas}` 解析成 `/private/tmp/...`,与 `lsof` 报的形态一致 → allowlist 生效。单测也补了 `/private/tmp` 形态的 lsof mock,能守住这条回归。

## R2-2 新问题(BLOCKING):归一化把真残留变成漏报,且静默 ❌

`scenario5-restart-audit.sh` 在同一台机复跑,针对真实的 `/tmp/q96`:

```
[log] WARNING: non-production tmux server audit pid=99116 \
      socket=/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-1596/…/scratchpad/rig/tmux.sock \
      sessions=<unreadable>
severe alerts: (none)
```

Round 1 时这台机上 q96 是**正确报出**保留名 severe 的;Round 2 之后**不报了**。

**根因链**（全部实测,非推断）:

1. `/tmp/q96` 本身是个 symlink，指向一个 scratchpad rig 目录；
2. `_tmux_rescue_normalize_socket` 只解析父目录，于是 `/tmp/q96/tmux.sock`(18 字符) → `/private/tmp/claude-501/…/rig/tmux.sock`(**125 字符**)；
3. 两者 `ls -i` 同一 inode（495291040），但 macOS `sun_path` 上限是 **104 字节**：
   - `tmux -S /tmp/q96/tmux.sock list-sessions` → `cmux-FLY-9998-implement` / **`flywheel`**
   - `tmux -S /private/tmp/claude-501/…/tmux.sock list-sessions` → `error connecting … (File name too long)`
4. 审计把探针也换成了归一化路径 → `session_rows="<unreadable>"` → 后面按行找 `flywheel` 永远找不到 → **不发 severe，也不报错**，只留一行 warning。

**确定性复现**（不依赖本机 q96，`harness/scenario7-symlink-socket-repro.sh`，跑完自清理）:
短 symlink `/tmp/qa1659sym`(socket 路径 24 字符) → 真实目录 155 字符；起一个 session 名为 `flywheel` 的 tmux server：

```
sessions via SHORT path : flywheel
sessions via RESOLVED   : error connecting to … (File name too long)
shipped audit           : sessions=<unreadable>
severe alerts           : (none)   <-- 保留名没被检出
```

**影响**：Fix 6 唯一的可执行产出就是这条保留名 severe 告警；对**它的主要目标人群**（`/tmp/q96` 这类短 symlink 指向长 scratchpad 的 QA rig / test-slot socket）现在完全失效。issue 验收 ⑥ 点名的 `/tmp/q96` 正是这一类。而且是静默失效——`<unreadable>` 不 fail-loud，运维看到的是"扫过了、没事"。等于把 Round 1 的误报换成了同一处的漏报。

**建议修法（供参考，不替实现者决定）**：归一化只用于**allowlist 比对**（比对时两边都归一化，或同时比对原始形态与归一化形态），**探针与告警正文继续用 `lsof` 报的那个路径** —— 那才是 server 实际绑定、能连上的路径。另外把 `<unreadable>` 做成显式的降级信号（至少 warning 里点明"保留名检查未能执行"），否则任何探针失败都会伪装成"干净"。

**单测为什么又没抓到**：新 fixture 把 `_tmux_rescue_normalize_socket` mock 成「`/tmp/tmux-501/*` 加 `/private` 前缀，其余原样返回」，于是 `/tmp/q96/tmux.sock` 在测试里归一化成它自己、tmux mock 照样答得出 —— 等于假设「QA socket 不是 symlink」，而这恰恰是失败的那一类。建议补一条走**真实文件系统**的用例（真建 symlink + 真起 tmux server + 真探针），或至少让 mock 对 QA socket 也返回一个超长路径。

## R2-3 本轮其它检查

- 核心文件 `packages/teamlead/**`、`scripts/lib/**`、`.github/**` 相对 Round 1 已测 head `ad382ebe` **diff 为空（逐字一致）**，故本轮未重跑 15-supervisor 真机全链；Round 1 的 ①②③ 结论对本 head 继续成立。**最终 PASS 前会在真正要 ship 的 head 上重跑一遍完整 N=15**。
- 套件复跑（本 head）：`restart-storm-gate` 24/24、`supervisor-adoption` 6/6、`supervisor-storm-regression` 27/27、`ci-structure` PASS、`bash -n restart-services.sh` ok。
- 零生产变更：审计只读，tmux server census 前后逐字相同；scenario7 的临时 server 与 symlink 已清理，`ls /tmp/qa1659sym` = No such file。
- 非阻塞遗留（Round 1 §5 末段提过，本轮未变）：这条纯观察性审计仍走 `alert_severe` → kind 硬编码 `deploy_failed` + @founder。路径修对之后它只会对**真**残留发，但成功的部署仍会被推成一条 "deploy_failed" 语义的红色告警。plan Fix 6 写的是"既有 alerts 位点"，所以这属设计既定、不阻塞;仅建议将来分一个非 founder-ping 的观察通道。

---

# 复验 Round 3 — head `f08fab7f6ae9fba3db44a4ab8566e1882989ea02` · **判决 PASS**

日期: 2026-08-08（同一 QA session）
修复 commit: `036fd0b1 fix(FLY-1659): preserve raw tmux audit sockets`

修法正是 Round 2 建议的形态:归一化后的路径**只用于 allowlist 比对与去重**(`normalized_socket`),`tmux` 探针与告警正文继续用 `lsof` 报的**原始**路径(`socket`)。

## R3-1 两轮问题都已闭环(同机同脚本三轮对照)

| 真机审计输出 | R1 `ad382ebe` | R2 `23ff97aa` | R3 `f08fab7f` |
|---|---|---|---|
| 生产默认 socket 被判 non-production | 是 ❌ | 否 ✅ | 否 ✅ |
| atlas(Mufasa 活 Lead)被判 | 是 ❌ | 否 ✅ | 否 ✅ |
| `/tmp/q96` 真残留检出 | 是 ✅ | **`<unreadable>`,漏报** ❌ | 是 ✅(raw path,sessions 读到 `flywheel`) |
| severe 告警条数 | 2(1 假 1 真) | 0 | **1(只对真残留)** |
| 零变更(tmux census 前后) | OK | OK | OK |

确定性复现脚本 `scenario7`(短 symlink 24 字符 → 真实目录 159 字符 + `flywheel` session)在 R3 下正确报出 severe,点名 `/tmp/qa1659sym/tmux.sock`;跑完自清理无残留。
（诚实记录:R3 第一次跑 scenario7 我读成了"仍漏报"——那是我自己脚本里的 grep 还在按 R2 的 resolved 路径匹配,修了 grep 后复跑即正确。产品无此问题。）

## R3-2 在真正要 ship 的 head 上重跑的完整真机验收

| 项 | 结果 |
|---|---|
| ① 15 supervisor 冷 bootstrap | **15/15 收养 68s**(deadline 120s);body tuple 前后逐字相同;`lock_unavailable=0`;180s 稳态零窗口变动;15/15 存活 |
| ② KeepAlive | 稳态四次测量 **15s / 30s / 34s / 54s**,均 < 90s |
| ③ atlas + q96 噪声在场 | 全程在线仍收敛 |
| ④ 套件 | 8 套 **156 项**全绿 + `bash -n` 五脚本 |
| TERM-during-lock | 自带阳性对照,**1s 退出**零 wedge |
| TERM provenance | adopter 保 body 逐字幸存;launcher 按既有语义拆除 |
| 双 successor 双收养 | 零破坏动作;两个都 TERM 后 body 逐字幸存 |
| 529 真 Discord | 见 R3-3 |

**KeepAlive 的诚实数据**:另有一次测到 **96s**,发生在 15 supervisor 冷启动爆发后 **load ≈ 46** 的瞬间(这个负载是我的台架自己造出来的,生产是 15 个 supervisor 稳态巡检、不是同时冷启)。同一 head 在 load 24–27 下测得 30s / 34s。结论:稳态满足 ≤90s;**极端负载下会超**,这条如实记在这里。

## R3-3 529 隔离房真 Discord E2E(Round 1/2 承诺的那一项,已补做)

本 diff 唯一的 Discord 面 = Fix 6 新增的那个 `alert_severe` 调用点。做法(`harness/scenario8-529-alert-e2e.sh`,module-driven):真实审计函数打真实进程表 → 拿到真实载荷 → 用**真实** `lead-alert.sh` 投递到 FLY-529 隔离频道 `#test-flywheel-alerts`(测试 bot `TEST_BOT_TOKEN_1`,队列/死信/claims 全部指向沙箱)→ 回频道读回核对。

- 投递:`HTTP 200`,message id `1535550280450445343`,author `flywheel-test-1`
- destination 回读:渲染正确 —— 🚨 标题 + `(deploy / deploy_failed)` + 票据行 + 正文点名 `/tmp/q96/tmux.sock`
- Claude-in-Chrome 在 Annie 真实 Discord 会话里截到同一条消息(截图已嵌进 ship-report)
- **生产隔离**:`~/.flywheel/alert-queue`(1)、`alert-deadletter`(2595)、`alerts/claims.db` sha 三样跑前跑后**逐字未变**

## R3-4 判决与非阻塞事项

**PASS**。三轮共抓到 2 个真缺陷(误报 / 漏报),均已修复并各自复验;本轮无新问题。

非阻塞(不影响 ship,建议后续单独处理):
1. 这条纯观察性审计走的是 `alert_severe` → kind 硬编码 `deploy_failed` + @founder。真机截图里那行 `(deploy / deploy_failed)` 就是它 —— 只要机器上还有 `/tmp/q96` 这类真残留,**每次成功的重启也会推一条红色「部署失败」给 Annie**。plan Fix 6 明确写的是"既有 alerts 位点",属设计既定;建议后续给观察类提示分一个不 @ 人的通道。
2. 机器上现存的 `/tmp/q96` 残留(pid 99116,session 名 `flywheel`)建议 operator 清掉 —— 它正是本单要检出的对象。
3. `qa-framework/README.md` 的「QA tmux session 一律 `qa-` 前缀」与 `claude-lead.sh` 硬编码 session 名 `flywheel`(:1530)相冲突:任何用隔离 socket 跑真 Lead supervisor 的台架(包括本报告这套)都无法遵守、都会被审计判成残留(529 slot 走默认 socket 不受影响)。

## R3-5 诚实边界（未测的，与为什么）

1. 假 claude 只是 idle 进程(argv 与生产同形、过 `lead_identity_command_matches`),Claude 特有的崩溃 / compact / 额度死法没证。
2. rename 被跳过后窗口长期顶着 `<name>.p-<nonce>` 保留名、再撞 pre-launch 隔离门的长期形态没构造。
3. Fix 6 没从 `restart-services.sh` 顶层入口跑(会真重启整支舰队);用的是函数体逐字抽出打**真实**进程表/lsof/tmux 探针,每轮函数 sha256 都记在 `scenario5*/RESULT.txt`。
4. 老栈 backport 的逐 hunk 核对未做 —— 交付路径属 Lead/founder 决策。
5. KeepAlive 在 load≈46 下测到 96s(见 R3-2)。

## R3-6 交付物

- founder ship-report(交互式、可逐段留言、含三张 mmdc 预渲染 inline SVG 与真 Discord 截图):
  https://fw-reports-a53de2.vercel.app/r/c2e4e8222b6f35ce1430eaadd98f4cc3/ (`delivered:true`,已发到 FLY-1659 issue thread)
- 台架与证据:`~/.flywheel/qa/fly1659/`(harness/ 八个场景脚本、各轮 RESULT.txt、oldstack/、scenario5*/、scenario8/)
