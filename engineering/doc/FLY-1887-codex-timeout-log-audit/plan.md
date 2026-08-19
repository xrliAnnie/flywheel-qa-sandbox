# FLY-1887 宿主机卡死善后 — 实施计划

Issue: FLY-1887 (https://linear.app/geoforge3d/issue/FLY-1887/宿主机卡死善后codex-调用加硬超时-日志轮转-写盘审计)
日期: 2026-08-19
基于: 无

> **修订状态**:v6。v5 的 Codex 设计复审返回 `CHANGES_REQUESTED`;v6 修复 BSD/macOS `mv` 跟随目录 symlink 导致 `current` 永不升级的阻塞缺陷,给 stale-lock quarantine 补身份重验,让无 `.bak` 的新宿主机也能真实禁用 guard,并把 cmux 的人工审计与 CI 证据分层写清。评审记录见 §11。

---

## 0. 一句话

三件事:给一次性 codex 调用加**有预算的硬超时 + 只认带启动身份注册表的清道夫**(P0)、给 flywheel 自己按次打开并追加的日志加**轮转**(P1-a)、把 cmux watcher 每天 5.7 GiB 的写盘量**降到接近零**(P1-b);P2 两条(并发上限、重启编排)只摆数据不做决定,留给 Annie。

---

## 1. 审计推翻的前提(先说,因为它决定落点)

### 1.1 codex 调用点的**完整**枚举(v1 只扫了 `scripts/`,结论错了)

issue 说的范围是「`~/Dev/flywheel/scripts/` 中所有调用 codex 的位置」。那个集合**确实为空**(全仓 `scripts/*.sh` + `scripts/lib/*.sh` 零个生产调用点;唯一 grep 命中是 issue 正文自己被注入进 `.claude/skills/linear-issue-context/SKILL.md`)。但据此说「仓库零调用点」是**错的**。按调用族重新枚举:

| 族 | 位置 | 谁在用 | 现状 | 关机快照对应 |
|----|------|--------|------|-------------|
| **A** 全局 wrapper | `~/.local/bin/codex-with-fallback:21` | `peer-review`、`codex-image/generate.sh` 与按全局规则手工走 wrapper 的一次性 `codex exec`;code/design review 的正文实际走族 C,`codex-relogin` 走裸 `codex login` | 无仓库、无测试、无 review;`codex "$@" > >(tee …) 2> >(tee …)` **两个 tee/次**,无时间上限 | `tee×30` 中的一部分、`bash×18` 中的一部分 |
| **B** 仓库自建 twin | `packages/claude-runner/bin/flywheel-codex-with-fallback:56` | ⚠️ **长生命周期 Codex Runner daemon 的载体** —— `CodexTmuxAdapter.ts:497` 把 `flywheelCodexBin()` 作为 `codexBin` 传给 daemon runtime,`codex-daemon-runtime.ts:256-258` 白纸黑字:「`opts.codexBin` 是 rotation shim,真正的 `codex app-server` 是它的**子进程**」 | A 的 repo-owned fork,**逐字同形的 tee 缺陷**;但它承载的是**天级**存活的 daemon,**绝不能加一次性超时** | 每个活 runner daemon 贡献一条 `bash + codex + 2×tee` |
| **C** companion → broker | `~/.claude/plugins/cache/openai-codex/codex/1.0.0/scripts/lib/broker-lifecycle.mjs:59-67`(`detached:true` + `child.unref()`)→ `lib/app-server.mjs:188` `spawn("codex", ["app-server"])` | **每一轮 code/design review 的真实主路径**(两个 command 走 `node "$COMPANION" task`) | **一个字节都不经过 A 或 B**;companion 只有 240s 的**状态轮询**等待,超时不杀任务,任务继续在脱管 broker 里跑 | `codex-code-mode-host×16` |
| **D** QA harness | `scripts/qa-fly-1395-codex-mode-visibility.sh:114,131` | 手工 QA | 裸 `codex exec`,非生产路径 | — |

**v1 最严重的错误**:引用关机快照时只写了 `tee×30 + codex×19 + bash×18`,**漏掉了同一行里的 `codex-code-mode-host×16`** —— 而那 16 个恰恰是唯一不被 A/B 覆盖的族 C。v1 因此得出「wrapper 是天然的唯一收口」,这个论断**不成立**:按 v1 落地后,下一次关机 stall 的进程清单里 broker 族会原样出现(约占僵死进程的 19%)。

补充证据(说明「全局规则强制走 wrapper」只是提示词约定、不是机制):chezmoi 管理的 `~/.claude/skills/codex/SKILL.md` 教的是裸 `codex exec … 2>/dev/null`,压根没提 wrapper。

**关于 `tee×30` 的归因更正**:v2 写「≈ 2×15 全归族 A」是过度归因。族 B 的每个活 runner daemon 也贡献一条 `bash + codex + 2×tee` 链。快照里的 30 个 tee 是 A 与 B 的**混合**,不能全算在 A 头上 —— 这也是为什么 §3.6 的去 tee 必须**两个 wrapper 都做**(而族 B 只去 tee、不加超时)。

**关于 `codex-resume` 的更正**:v2 说族 B 由 `codex-resume.ts:421` 「在每个 Codex Runner cycle 上调用」——**这是错的**。`:421` 的默认值是**全局** wrapper(族 A),而 `flywheel-comm codex-resume` 只能经 CLI 显式派发(`packages/flywheel-comm/src/index.ts:308`)触达;两位评审与作者三方分别扫描,**未找到任何活的生产 composer**(FLY-123 遗留路径,已被 FLY-1188 daemon 取代)。族 B 的**活**调用形态只有一个:daemon 载体。

### 1.2 交接文档建议的清道夫一行命令会**杀掉生产 Codex Lead**

```bash
# 交接文档 §3 P0 的建议 —— 不要按原样实施
ps -eo pid,etimes,comm | awk '$2 > 86400 && /codex|tee/ {print $1}' | xargs -r kill -9
```

`codex-infra-bot-lead` 与 `growth-mufasa-lead` 是**按设计长期运行**的 Codex Lead(FLY-1814 记录 infra-bot 连续运行约 7 天 = 604800s,远超 86400s 阈值)。按进程名 + 存活时长筛选会把它们一起 `kill -9`。

清道夫必须**只按正向识别的注册表**工作,见 §3.3。

---

## 2. 已实测的证据

测量在生产宿主机完成,工具 `proc_pid_rusage(RUSAGE_INFO_V4)`,读 `ri_diskio_byteswritten`(物理)与 `ri_logical_writes`(逻辑)。

### 2.1 cmux watcher 的写盘量 —— 带对照组

120 秒采样,`flywheel-cmux-sync.sh --watch`(PID 44455)对比同机 4 个长期运行的 bash:

| 进程 | 物理写 | 逻辑写 |
|------|--------|--------|
| **cmux watcher** (44455) | 15,974 B/s = **1,316 MiB/天** | 69,222 B/s = **5,704 MiB/天** |
| `atlas/start.sh` (1885) | 0 B/s | 0 B/s |
| `lead-body.sh` eng-lead (6987) | 0 B/s | 0 B/s |
| `lead-body.sh` tidal-echo-cos (6785) | 0 B/s | 0 B/s |
| `stkLaunchAgent.sh` (1857) | 0 B/s | 0 B/s |

对照组全 0 —— 不是「长期 bash 都这样」,是 watcher 独有。2 GiB ÷ 69,222 B/s ≈ **8.6 小时打满配额**,与交接文档「每天精确打满 2147.48 MB」的四份诊断报告吻合。

### 2.2 写盘去向不在任何可见文件里

50 秒轮询全部 cmux 状态文件 + flywheel 日志,总增长约 5 KB(≈9 MB/天),只占实测量的 **0.2%**。

### 2.3 根因:bash here-string(`<<<`)—— 2×2 对照矩阵

| 实验 | 物理写 | 逻辑写 | 作用 |
|------|--------|--------|------|
| A 自身写 8 MiB(builtin printf) | 8,388,608 B | 8,962,048 B | **仪器阳性对照**:能看见自身写 |
| B 子进程 `dd` 写 8 MiB | 0 B | 0 B | 子进程写盘**不计入**父进程 |
| C 2000 次 `read -r x <<< "…"` | 8,192,000 B | 32,804,864 B | **每次 4,096 B 物理 / 16,402 B 逻辑** |
| D 同样 2000 次循环,去掉 `<<<` | 0 B | 0 B | 阴性对照:不是循环的锅 |

A 排除「仪器瞎了」,D 排除「循环本身」,B 说明那 5.7 GiB 是 watcher **自己**写的(不是 tmux/cmux 子进程)。

**交叉验证(两个独立计数器同时同意)**:逻辑写 69,222 ÷ 16,402 = **4.22 次/秒**;物理写 15,974 ÷ 4,096 = **3.90 次/秒**。两条独立算得的频率一致(约 4/秒 ≈ 每 15 秒 tick 约 60 次)。`scripts/flywheel-cmux-sync.sh` 里有 **130 处 `<<<`**,大量在 per-Lead 循环中。

机制:bash 对每个 here-string 在 `TMPDIR` 建临时文件、写入、立刻 unlink。**代价与字符串长度无关**(20 字节的字符串照样 4 KiB),因为 APFS 按块 + 元数据放大。文件建了就删,所以任何按文件大小的审计都看不见。

### 2.4 替换方案也已实测

| 候选 | 物理写 | 逻辑写 | 语义 |
|------|--------|--------|------|
| `while …; done <<< "$v"`(现状) | 8,192,000 B | 32,804,864 B | — |
| `while …; done < <(printf '%s\n' "$v")` | **0 B** | **0 B** | ✅ 循环留在当前 shell |
| `printf … \| while read` | — | — | ❌ **禁用**:循环进子 shell,累加的变量静默丢失 |

v3 曾把 `IFS='|'; set -- $line` 当作零 fork 优化。设计门禁在 Bash 3.2 上证实它会吞掉末尾空字段、展开 glob,并覆盖调用方 `$@`;在 `set -u` 下随后访问缺失字段还会直接退出。v4 **全量禁用 `set --` 拆数据**,包括顶层单次 `read`:一律用 `< <(printf '%s\n' "$value")`。

**关键陷阱**:最直觉的替换(改成管道)会把循环体推进子 shell,循环里累加的状态在循环结束后消失 —— 这类改动测试可能仍然全绿(状态在循环内是对的),但生产行为错。

### 2.5 关于 `timeout` 二进制的预先警告

本机 `timeout` / `gtimeout` 都来自 Homebrew coreutils(`/usr/local/bin/`),macOS 基础系统**没有** `timeout`。而这次事故的根因恰恰是「brew 升级删掉 Cellar 目录,留下一个存在但跑不起来的二进制」。guard 绝不能假设它存在或可用 —— 见 §3.4。

---

## 3. P0 — 给一次性 codex 调用加硬超时

### 3.1 只覆盖能证明身份的族,不拿 PID 猜进程

> **v2 → v3 的反转(必须先说)**:v2 把族 B 定为「超时的首要落点」。**这是错的,而且会造成生产事故** —— 族 B 承载的是天级存活的 Codex runner daemon,给它加 3600 秒的一次性超时 = 每个 daemon 执行到一半被 SIGTERM。作者与评审 A 都误以为族 B 是「一次性 cycle 载体」,评审 B 往下多查了一层调用链(`CodexTmuxAdapter.ts:497` → `codex-daemon-runtime.ts:256`)才发现真相。v3 据此反转:**族 B 明确列为禁止加超时的边界**。

| 族 | 做法 |
|----|------|
| **A**(全局 wrapper) | **本仓能安全拥有的唯一超时落点**。超时 + 注册表做成可 source 的 lib(`scripts/lib/codex-guard.sh`),repo-owned wrapper 与 lib 一起部署到稳定版本目录,全局 shim 只引用稳定部署物。活调用面是 `peer-review`、`codex-image/generate.sh` 与按全局规则手工走 wrapper 的一次性 `codex exec`,无一常驻;code/design review 正文属于族 C,不再虚报覆盖。部署合同见 §3.5。 |
| **B**(仓库 twin) | 🚫 **DO-NOT-TOUCH 边界:绝不加一次性超时。** 它是 daemon 载体。只做两件事:(1) 去 tee(§3.6),(2) 加一条**哨兵测试**断言 daemon spawn 路径字节不变、且该文件不含超时逻辑。**并且禁止把 `FLYWHEEL_CODEX_BIN` 指向新 guard** —— 这条要写进文件顶部注释,因为「把两个几乎一样的 wrapper 合并掉」正是本团队「删的比加的多」的直觉会做的事,而那个动作会静默杀掉所有 daemon。 |
| **C**(companion→broker) | **明确作为主要残余,不发任何 PID 信号。** 它是 code/design review 的真实主路径。durable JSON / `broker.pid` 只有 pid,本机已有 2 个 PID 复用到系统进程;brokerless fallback 更无 pidfile。v5 也评估了 endpoint/cancel 方向:本仓没有稳定、文档化、repo-owned 的 broker shutdown/cancel API,而插件在 `~/.claude/plugins/cache/` 是可覆盖的 vendored 缓存;“socket 存在”本身不能臆造协议级取消语义。因此本单不把未验证协议写成安全阀,保留为需在插件源仓单独设计的 P0 follow-up,也不声称本单覆盖主要 review 路径。Lead 已确认由 **FLY-1900** 追踪 companion/broker 路径的无界调用,并归入需 Annie 拍板的 P2 决策包;PR body 必须把它列为 open risk。 |
| **D**(QA harness) | 点名归类,不改(手工 QA,非无人值守)。 |

**为什么 lib 落在本仓库**:(a) `~/.flywheel/bin` 的安装/部署机械在本仓库已存在且每次重启都在跑;(b) 清道夫需要「哪些是 Flywheel 长生命周期 Lead / daemon」的知识,这份知识在本仓库;(c) 两仓时序有前科(FLY-880 的 13 个 vendored skill 至今未落地)。

**为什么包一层而不是逐个改调用方**:族 A 的调用方是全局 skill / slash command,分散且部分不在任何仓库里。

### 3.2 长生命周期进程为什么不受影响(v2 的理由是错的,这是更正后的)

v2 写的理由是「Lead 走 `codex app-server` / `codex resume` 直接 spawn,不经过 wrapper」。**这个理由对 Lead 成立、对 runner daemon 不成立** —— 而 v2 把两者混为一谈,是它把族 B 选错成落点的根源。分开说:

**生产 Codex Lead(Mufasa / infra-bot)**:两个 TUI launcher 用 `${FLYWHEEL_CODEX_BIN:-<standalone>}` 软默认到**裸 standalone 二进制**(`packages/teamlead/scripts/run-codex-infra-bot-tui.sh:73`、`run-codex-lead-mufasa-tui-fullaccess.sh:67`),`codex-lead-runtime.ts:522→1223` 直接 spawn 它。实测活进程也确认:两个生产 app-server 直接从 `~/.codex-infra-bot/…` 与 `~/.codex-mufasa/…` 起,**没有 bash shim 父进程**。安装器与 restart convergence 都不得 export / 改写共享的 `FLYWHEEL_CODEX_BIN`;测试钉住这条边界。

**Codex Runner daemon**:**经过族 B**(见 §3.1 表)。所以它的保护不能靠「不经过 wrapper」,只能靠 §3.1 的 DO-NOT-TOUCH 边界 + 哨兵测试。

**最终的结构性保证**:清道夫**只对族 A 自己写入且带启动身份的注册表动手**。Lead、runner daemon 与 broker 的 pid 都不会进入这个注册表,所以不是候选。这不是「判断得准」,是候选集里根本没有它们。

### 3.3 三条硬要求

**(0) 默认预算是 issue 指定且有实测依据的 1800 秒。** 可用的时长语料来自族 C companion state,不是族 A 自身遥测:对 3,048 个 `status=completed` 且起止时间完整的历史任务重新计算,中位数 284s、p95 884s、p99 1,172s;3,043 个(**99.84%**)在 1,800s 内完成,5 个超过。这里明确把它当作同机同类一次性 Codex 工作的**跨族代理分布**,不伪称族 A 实测。族 A 默认总预算 `FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=1800`,默认单次上限 `FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=1800`;每次实际预算仍取 `min(单次上限,总剩余)`。有明确长任务可逐次覆盖。两个 env 只接受正整数;非法值打印固定配置错误并退出 125,绝不退化成无界执行。

**(1) 预算是总的,不是每次的。** 现状 wrapper 最多轮转 5 个 profile;若每次都给满额,最坏 5 倍。设计:启动时算一次总截止时间,每次 Codex 尝试拿 `min(单次上限, 剩余预算)`,预算耗尽即停止轮转。边界需诚实:`codex-profile status/next/use` 是短小本地文件操作,不在 Codex 子进程 timeout 内;“总预算”指所有 Codex attempts 共享的预算,不扩大成整个 wrapper 每条辅助命令的墙钟证明。

**(2) 超时是可分辨的终局,不能被当成限流去重试。** 超时必须映射为显式的、带类型的错误,**不轮转 profile、不重试**。否则一次卡死被放大成 5 次。

**退出码合同(写死,调用方要靠它分辨)**:保留 GNU `timeout` 的 **124**,并在 stderr 打一行固定前缀标记;纯 bash 兜底路径也返回 124。`codex-review-trigger` hook 与 rescue 流程按此判定。

**(3) 清道夫只认正向注册表,永不按进程名。**

- guard 启动时写 `~/.flywheel/state/codex-oneshot/<pid>.json`(`pid`/`pgid`/`start_epoch`/`deadline`/`label`),正常退出用 trap 删除。
- 每次**新的** codex 调用先做一次机会式清扫(**不新增任何 launchd job / timer** —— 卡死堆积的前提本来就是调用在持续发生)。
- **PID 复用围栏**:核对进程真实启动时间与登记值一致,不一致就删条目、**不杀**。
- **任何不在注册表里的进程一律不碰。**
- 族 C 的 pid-only 记录永不进入这套逻辑;见 §3.1 的显式残余。

**(3b) 进程组归属陷阱 —— 按组杀会杀掉调用它的 Claude Lead。**(评审 B 在本机实测)

`/bin/bash` 3.2 的非交互脚本里,**不加 `set -m` 时后台子进程共用调用方的 pgid**(实测:脚本 pgid 59404 = 调用 shell 的组;子进程 pgid 也是 59404)。于是:

> Claude Lead(常驻 tmux pane)跑 `/codex-code-review` → guard 把 pgid 登记成 **Lead 自己 shell 的组** → guard 被中断(Esc,家常便饭)留下残条目,而 codex 真的挂住了 → 几天后清扫,PID 复用围栏**通过**(codex 还活着、启动时间也对)→ `kill -TERM -pgid` → **连 Lead 的 pane shell 和同组的一切一起杀**。

围栏挡不住这个:它校验的是 pid,不是**组的归属**。三条修法(缺一不可):

- (a) guard 必须**拥有**这个组:纯 bash 兜底路径在后台化之前 `set -m`(实测:加了之后子进程拿到自己的 pgid,`kill -- -pid` 正常工作);走真 `timeout` 时,把 timeout 子进程的 pid 同时登记为 pid 与 pgid。
- (b) 清道夫**拒绝**按组杀,除非登记的 `pgid == pid`(即组由该进程自己领衔);否则退化为只杀 pid。
- (c) **每次发信号之前**立刻重验一次围栏(见 3c 的 TOCTOU)。

**(3c) 注册表的残余攻击面**(评审 B 逐条提出,全部接受):

- **crash-before-write**:先 fork 后登记会漏掉一个永远无人认领的挂死 codex。改为**写前置条目**(guard 自己的 pid + label)再 spawn,拿到 pid 后补写;残余窗口写进文档。
- **围栏数据源**:macOS 的启动时间取 `ps -o lstart=`(1 秒粒度、受 locale 影响)。登记与清扫**两侧都钉 `LC_ALL=C`** 并逐字比较;否则 locale 变化 → 假不匹配 → 条目被静默删除 → 挂死进程反而永生(失败方向对 Lead 是安全的,但清道夫失效)。
- **清扫 TOCTOU**:围栏检查与杀之间有窗口;两个并发清扫 + PID 回收(事故当时约 700 进程/秒)可能对一个被复用的 pid 发信号。每条目 `mkdir` 锁 + 发信号前重验围栏。
- **state 目录不可写**:必须 **fail-open**(codex 照跑、仍然有界,只是没登记),绝不阻塞调用。
- **`exec codex -m gpt-5.5` 逃逸**:两个 wrapper 的最后一档 fallback 都是 `exec codex …`(族 A `:56`、族 B `:83`)。**照抄移植会让这一发彻底无界** —— 正是本次事故的缺陷类。总预算必须覆盖它。

### 3.4 不依赖未验证的外部二进制(这次事故的同一课)

按 `timeout` → `gtimeout` → 纯 bash 看门狗 解析,且**必须真的跑一次**验证可执行 —— `-x` 只验权限位,那正是 myco-mcp 的缺陷本体。(注:现有 `packages/claude-runner/test/codex-shim.test.ts:71` 用 `accessSync(bin, X_OK)`,是同一模式;新 guard 不得沿用。)

纯 bash 兜底需要正确处理:`set -m` 起独立进程组(见 §3.3(3b),这不是可选项)、记录 pgid、到点 `kill -TERM -$pgid` 再 `kill -KILL -$pgid`、SIGCHLD 与 wait 的竞态。**永不无界地跑 codex。**

**关于真 `timeout` 的实测结论(评审 B 在本机测的,coreutils 9.11)**:默认模式**会**把子进程放进它自己的进程组并按组发信号 —— 后台孙进程被杀、rc=124(实测);在 wrapper 那个 `> >(tee …)` 形状下 `${PIPESTATUS[0]}` 确实等于 124(实测);两个 tee 也**被回收**了(写端关闭 → EOF)。

> 🚫 **禁止使用 `--foreground`** —— 实测它会破坏上述全部性质:孙进程活了下来,还带着调用方的 pgid。

残余风险:若 codex 的后代逃出该进程组(快照里 16 个卡住的 `codex-code-mode-host` 暗示可能会),按组杀就收不干净 —— 这正是 §3.6 去 tee 仍然值得做的原因。

### 3.5 部署合同(v1 留白,是 P0 的机器级单点)

改写 `~/.local/bin/codex-with-fallback` 不属于任何现有安装流程(不在 `~/.flywheel/bin`、不在 chezmoi、不在 restart-services 的 install 集)。shim 换坏 = 全机所有 codex exec 调用瞬间断。合同:

- **稳定 vendoring**:repo 中的 wrapper + `codex-guard.sh` 一起复制到 `~/.flywheel/libexec/codex-guard/releases/<content-hash>/`;完整写入、chmod 与自检通过后,才用不跟随目标目录 symlink 的原子 rename 切换 `current`(`GNU mv -fT`;BSD/macOS `mv -fh`)。普通 `mv -f staged current` 会在 macOS 把 staged link 静默移进旧 release,**禁止使用**。`~/.local/bin/codex-with-fallback` 在安装时把目标解析成绝对路径字面值,运行时不读通用 `FLYWHEEL_STATE_DIR`、不 source 活 git checkout。
- **fail-closed 缺件合同**:stable wrapper/lib 缺失、不可读或自检失败时,shim 打固定错误并退出 125;绝不为「可用性」偷偷运行无界 codex。
- **幂等 install 步**:内容校验(已是同一 hash 就 no-op)+ 原子切换 + `.bak` **只写一次**(不覆盖已有备份)。失败时 `current` 与全局 shim 都保持旧版本。
- **无条件挂载点**:install 函数接到 `scripts/lib/converge-nonlead-daemons.sh` 的 convergence seam,而不是 restart-services 的 build-only 分支。这样同 SHA、build 被跳过时仍会修复丢失/漂移的部署物。本 issue 的 `plan_only` doc tier 禁止另造实施文档,因此下方操作段就是随分支长期保留的 authoritative runbook,PR body 也要复述。
- **规避已知事故形态**:本仓库有「自部署跑的是旧脚本字节,脚本内的一次性迁移必被跳过」的前科 —— install 步必须能被**独立于重启**地手工跑一次,并有幂等重跑保证。
- **验证命令**:改写后实证走的是新链路(而非只看文件内容),并确认超时确实生效。
- **持久回滚 runbook**:单独复制 `.bak` 会被下一次无条件 convergence 撤销,因此不是回滚。禁用时先 `touch ~/.flywheel/libexec/codex-guard/DISABLED`,再运行 `/bin/bash scripts/install-codex-guard.sh`;有 regular-file `.bak` 就原子恢复它,新宿主机从未有 legacy wrapper、因而没有 `.bak` 时则发布 `exec codex "$@"` passthrough。这个 passthrough **没有** legacy wrapper 的 429 `codex-profile` 换号能力,遇到限流会直接失败;它是紧急关闭 guard,不是功能等价替代。以后每次 same-SHA convergence 都维持这个禁用结果。重新启用只能显式 `rm -f ~/.flywheel/libexec/codex-guard/DISABLED` 后重跑 installer。最后用 `readlink ~/.flywheel/libexec/codex-guard/current` 与一次隔离 fake-codex smoke 验证:禁用时 wrapper 真正 passthrough;启用/升级时 `current` 指向本次 content hash 且实际执行新 release 字节。`.bak` 若存在但不是 regular file 则 fail-close,不覆盖可疑路径。保留策略只会额外删除旧 buggy installer 遗下且严格匹配 `.current-*` 的 symlink;任何其他未知条目都让该 release fail-closed 保留。

### 3.6 顺带修掉 tee(含行为变化说明)

关机快照里 tee 数量最多(30 个),来自进程替换 —— 那两个 tee 不是 `timeout` 的子进程,杀 codex 不保证收走它们。两个 wrapper 都改为把 stdout/stderr 分别落到临时文件、执行结束后再读取;族 A 每次 attempt 都通过 guard,族 B 保持无限生命周期且只改变输出捕获。

**这是一处行为变化,必须写明**:现状经 tee **实时透传** stdout;改后调用方在运行期间看不到增量输出。正常结束时读取两份捕获;TERM/INT/HUP 中断时必须先通过预先保留的原始 caller fd 发布已经产生的部分 stdout/stderr,再删临时文件,不能把 capture file `cat` 回它自己(会无限自追加)。子进程与 watchdog 关闭这些额外 fd,避免 wrapper 退出后仍把调用方 pipe 持开。若实测有调用方依赖真正的逐行流式输出,改用单一管道 + `${PIPESTATUS[0]}` 保留退出码,而不是落文件。

---

## 4. P1-a — 日志轮转

### 4.1 写入点(v4 扩大到 shell、Python 与 TypeScript 的全仓扫描)

扫描口径:shell 的 `>>` / `exec >>` 重定向、Python append **与** TypeScript 的 `appendFileSync`,目标在 `$HOME` 或 stateDir 下且无上限。

| 文件 | 写入点 | 状态 |
|------|--------|------|
| `~/.flywheel/logs/tmux-rescue-audit.log` | `scripts/lib/tmux-server-rescue.sh`(`_tmux_rescue_audit`) | **曾达 350 MB**,已手动截断 |
| `~/.flywheel/logs/restart-guard.log` | `scripts/hooks/flywheel-restart-guard.py` | **533 KB,今天仍在写** |
| `~/.flywheel/logs/runner-stop-notify.log` | `scripts/hooks/runner-stop-notify.sh`(`exec >>`,每次 Runner turn-end) | 今天仍在写 |
| `~/.flywheel/logs/lead-lease-audit.log` | `packages/flywheel-comm/src/lead-lease.ts` | append-only JSONL |
| `<stateDir>/lead-actions-audit.jsonl` 及同族 | `lead-actions-main.ts`、`discord-send-core.ts`、`gateway-main.ts`、`publish-broker/wire.ts` | append-only JSONL |
| `<geminiAuditDir>/sessions.jsonl` | `packages/gemini-agent/src/audit.ts` | 跨 session 的单一 append-only 索引(v3 漏) |
| `~/.flywheel/bridge-loop-guard.log` | `packages/teamlead/src/bridge/BridgeEventLoopGuard.ts` worker | 单一全局 append-only 日志(v3 漏) |
| `~/Library/Logs/flywheel/codex-log-guard.log` | `scripts/codex-log-guard.sh` | 每轮 monitor append |
| `~/.flywheel/logs/lead-*-startup.log` | `packages/teamlead/scripts/claude-lead.sh` | 每次 startup 事件 append |
| ~~`~/.flywheel/logs/cmux-sync-watch.log`~~ | ~~cmux-sync 自身~~ | 全仓零写入方,mtime 停在 Jul 20;现役 watcher 日志在 §4.3 排除区 |

行号会漂移,实现时按 symbol / string 重定位,不照抄旧行号。

### 4.2 设计

新增 `scripts/lib/flywheel-log.sh`,提供 `flywheel_log_rotate_if_needed <path> [max_bytes] [keep]`,默认 **10 MiB 上限、保留 3 代**。

- **fail-open**:轮转出任何问题都不能让调用方失败(审计日志是尽力而为的旁路,现有代码已是 `|| true` 语义,必须保持)。
- **并发**:多进程同时 append;轮转用 `mkdir` 原子锁(macOS bash 3.2 没有 `flock` 二进制),近期锁拿不到就跳过轮转直接 append。锁目录 mtime 超过 **300s** 视为前任在同步短临界区中崩溃留下的残余;读取 `(device,inode,mtime)` 后原子 rename 到 quarantine,再重读被隔离目录并与观察身份逐字比较。身份变化说明检查与 rename 之间已有新 owner,必须搬回并放弃,不得抢新锁;身份一致才 reacquire。这样一次 SIGKILL/掉电不会永久关闭轮转,也不会用 check-then-act 偷走替代锁。shell 与 TS helper 同合同。
- **不丢行**:用 rename,不用 truncate。
- **TS 侧**:在相关 package 都已依赖的 `flywheel-config` 新增 `rotateLogIfNeeded` / `appendRotatedLogSync` 公共 seam(同上限、同 fail-open)。Gemini 的 per-session 文件继续直接写,只有跨 session 的 `sessions.jsonl` 走 helper;Bridge loop guard 由 parent 每次启动 worker 前轮转,不把 import 塞进 worker source string。
- **消费方口径**:无生产 tail/cat/grep 消费这些日志;但 `tmux-server-rescue.test.sh` 与 instrumentation tests 会 grep audit 内容。测试要验证 active file / `.1` 的证据连续性,不能再写「无任何消费者」。

### 4.3 明确不做:持有长生命周期 fd 与 per-session 文件

- `/tmp/flywheel-*.log` 与 `~/.flywheel/logs/quota-monitor.log` 是 launchd `StandardOutPath` / `StandardErrorPath`,**fd 由 launchd 持有**。rename 后 writer 仍写旧 inode,truncate 会留下 NUL 空洞;本单不伪装成安全轮转。`quota-monitor.log` 当前 16 KiB,先保留为显式残余。
- `packages/voice-bridge/src/eleven/wiring.ts` 的 transcript 与 Gemini `session-<sid>.jsonl` 是每 session 独立文件,生命周期本身分片;不把它们误归成单一无限增长文件。
- 同理排除 `sync-gbrain-docs.sh`、`xiaohongshu-learning-tick.sh`(后者自带 1 MB 截断)、restart-services detach log。
- 族 B daemon wrapper 的 `mktemp` capture 是既有天级 TMPDIR 残余(旧 tee 形态同样写这份文件),不属于本节 `$HOME/stateDir` 的轮转集合。它只去掉两个常驻 tee,不在本单顺手改变 daemon 输出保留策略;若实测该 capture 增长显著,应在 daemon 协议中决定丢弃/轮转,不能拿当前通用 per-append helper 套长生命周期 fd。

这些是明确边界,不是「扫描完整」的遗漏;若未来要 cap launchd stdio,应单独引入能主动 reopen 的 logger/daemon 协议。

---

## 5. P1-b — cmux 写盘

### 5.1 改法:全文件清零,不区分冷热

v1 说只换「实际会执行到的」`<<<`,守卫是「热路径函数内不得出现」—— 但「热路径函数」需要一份人工维护的名单,名单本身就是下一个漂移点。改为:

- **全文件 130 处 `<<<` 清零**(冷路径替换同样零成本、同样逐点测)
- 守卫退化为一行:`grep -c '<<<' scripts/flywheel-cmux-sync.sh` 必须为 **0** —— 最 boring、零维护、不可绕
- 确有必须保留的例外,逐条点名列 allowlist(并说明理由)

替换形式:

- `while …; done <<< "$v"` → `while …; done < <(printf '%s\n' "$v")`
- 顶层单次 `read` / 字段切分 → `IFS='|' read -r a b c < <(printf '%s\n' "$line")`
- **禁用** `printf … | while read`(§2.4 的作用域陷阱)
- **禁用** `IFS=…; set -- $line`(末尾空字段、glob、`$@` 与 `set -u` 四重陷阱)

逐点改、逐块 review,**不许 sed 批量替换**。验收不再夸称 130 个深层站点都有可单独驱动的前后对拍:证据由三层组成——(a)人工 diff review 审计每个删除的 `<<<` 都落在允许的 process-substitution/`printf '%s\n'` 类别,(b)四类高风险语义各有自动 parity case,(c)owning script 的 canonical `/bin/bash` 3.2 harness 当前全套。未被现有 harness 动态触达的冷站点仍由 transformation audit + review 覆盖,明确不是逐站点运行时证明。

### 5.1b 四类**不能**机械替换的站点(评审 B + Codex 门禁实测)

**(1) `done <<< "$(cmd)"` 不能简化成 `done < <(cmd)`** —— 命令输出为空时,前者跑 **1 次**空迭代,后者跑 **0 次**(实测)。受影响:`:832`(`$(awk …)`)、`:6390`(`$(printf … | tr ',' '\n')`)、`:4458`(嵌 `head -1`,同类)。正确做法:保留命令替换,写成 `< <(printf '%s\n' "$(cmd)")`;或逐站点证明「0 次迭代」也安全(`:832` 恰好有 `[[ -n "$subject" ]] || continue` 兜着,但那是巧合,必须逐点证明而不是假定)。

**(2) `%s\n` 的换行是强制的,不是风格** —— 实测:从**没有末尾换行**的进程替换里 `read`,返回 **rc=1**(变量其实已经赋好值)。而顶层裸 `read` 的站点(`:685`、`:1074`、`:1460`、`:1479`、`:3538`、`:3565` …)都在 `set -e` 的函数里,现在之所以永远 rc=0,**正是因为 `<<<` 会自动补一个换行**。写成 `%s` 少个 `\n` → watcher 当场挂掉。必须加一条单测断言改写后的形式 rc=0。

**(3) 错误返回路径上的 rc 语义要逐字保留** —— 例如 `:685` 在 `derive_lead_roster` 的 `|| { …; return 1; }` 链里。这条支持了「不许 sed」的规定,但计划必须点名「EOF 处 rc=1」这个具体陷阱,否则实现者不会知道要防什么。

**(4) `set --` 不是合法的字段解析替代。** `IFS='|' read -r a b c < <(printf '%s\n' "$line")` 才保留 read 的末尾字段合同,也不会对 `*` / `?` / `[…]` 做 pathname expansion,不会覆盖函数原有 `$@`。新增 RED parity cases:末尾空字段(`a|b|`)与 cwd 中确实能命中的 glob literal(`*.json`)必须逐字保留;在 `/bin/bash` 3.2 + `set -u` 下也不得 abort。

**评审 B 同时实测确认成立的**:watcher 跑的确实是 `/bin/bash` 3.2(plist + 活进程双证);`flywheel-cmux-autostart.sh` 里 0 个 `<<<`,改对了文件;130 处的计数属实;在 3.2 + `set -euo pipefail` 下,指定形式**保住了外层变量赋值**(`:845-897` 的循环真的在改 `current_missing` / `current_config` / `legacy_expected` —— 禁用管道这条是**承重的**)与**空串 → 1 次迭代**的语义(实测 1);`:286`/`:296` 的 `grep -q` 站点安全(printf 的 SIGPIPE 状态在 `if` 里不被观察)。

### 5.2 验收判据是**实测速率**,不是站点计数

- 用同一套仪器在真机测改前 / 改后的 watcher 写盘速率,各 ≥5 分钟,**同时带对照组**(其他长期 bash 应仍为 0)
- 目标:逻辑写从 69 KB/s 降到 **< 2 KB/s**(< 170 MiB/天,远低于 2 GiB 配额);剩余应约等于 §2.2 的真实状态/日志写入(约 9 MB/天)
- 同一窗口同时记录 watcher CPU time 与子进程创建/存活数量;process substitution 虽然在本机 `/dev/fd` 路径为 0 写盘,仍增加 `printf` fork,不得用「写盘下降」掩盖明显的 CPU / 进程数回归
- `proc_pid_rusage` 是 macOS-only,CI(Ubuntu)测不了 → 这条判据路由到 §7.4 真机独立 QA。机器 CI 只跑 `grep -c '<<<' == 0`、高风险类别 parity 与 canonical harness;逐个删除点的 transformation audit 属于人工 diff review 层,不伪装成自动门禁,也不把它写成 130 个站点逐一被动态驱动
- 现有 `test-cmux-sync.sh` 全套保持全绿(改前先跑一遍拿基线,避免把既有失败算到本单头上)

### 5.3 附带说明:CPU 报告可能一起变好

诊断报告是 bash **资源诊断**(CPU + 写盘)。每个 here-string 是一次建文件 + 写 + unlink 的系统调用序列,去掉后系统调用量同步下降。但这是推论 —— 只承诺写盘量,CPU 变化如实观测后再说。

---

## 6. P2 — 摆数据,不做决定

按 issue 与交接文档的明确要求,以下两条**需要 Annie 拍板,本单不实施、不预设结论**:

**并发上限**:8/17 18:37 实测峰值 1106 进程 / 62.7 GB 内存需求(物理内存 48 GB)。16 Lead 冷启会拉起 60–80 个 MCP 子进程。

**重启编排**:上次连续开机 17.2 天;三次内存耗尽在 8/14、8/16、8/17,间隔从两天缩到一天。交接文档建议每 3–7 天重启宿主机(而非仅重启服务),可接进 `com.flywheel.updater` 的 00:00 流程。

本单发现的相关事实供她判断:P1-b 若达成目标会移除一个持续的写盘压力源,但**不会**改变内存侧的劣化曲线 —— 两条 P2 的必要性不因 P1-b 而降低。

---

## 7. 测试计划(TDD,RED → GREEN)

### 7.1 `scripts/__tests__/codex-guard.test.sh`

- 假 codex 睡过截止时间 → 被杀,退出码 **124** + stderr 固定标记
- 超时**不**触发 profile 轮转(反例:限流输出**要**触发轮转,证明区分是真的)
- 总预算耗尽后停止重试
- 注册表:启动写入、正常退出清除、异常退出的残条目被下次清扫收走
- **清道夫阳性对照**:同时起一个**未登记**的、名字含 `codex` 的长寿进程 → 清扫后必须**仍然活着**(防误杀 Lead 的那条断言)
- PID 复用围栏:伪造 pid 相同但启动时间不符的条目 → 只删条目,不杀进程
- 族 C 安全哨兵:生产代码不得从 pid-only `broker.pid` / durable job JSON 发信号;测试夹具中的 recycled PID 即使 endpoint 不可达也必须仍然活着
- `timeout` 缺失 / 存在但跑不起来(`-x` 为真但 exec 失败)→ 降级路径生效,且**仍然有界**
- 默认值合同:总预算与单次上限均为 1,800s;非法 env → rc=125 且绝不调用 fake codex
- 部署合同:install 步幂等(重跑 diff 为空)、`.bak` 不被二次覆盖、stable release 同时含 wrapper + lib、缺件 fail-closed、同 SHA / build-skip 仍通过 unconditional convergence 修复漂移;另做 v1 install → 改 wrapper 字节 → v2 install,断言 `current` 真正切到新 hash、执行新字节且旧 release 内无 `.current-*` 残留
- 持久回滚:`DISABLED` 有 `.bak` 时恢复它,无 `.bak` 时发布 direct-codex passthrough;再跑 unconditional convergence 仍保持禁用;删除哨兵才重新启用。ambient `FLYWHEEL_STATE_DIR` 不得改写 shim 的安装目标
- 信号中断:已捕获的 stdout/stderr 必须发布一次,临时文件清理,子进程仍由 identity record 留给下轮安全 sweep
- **进程组归属**(§3.3(3b)):纯 bash 路径起的子进程 pgid **必须等于自己的 pid**;伪造一条 `pgid != pid` 的条目 → 清道夫**只杀 pid、拒绝按组杀**
- **`exec codex -m gpt-5.5` 逃逸**:最后一档 fallback 也必须在预算内(反例测试:让前 N 个 profile 全报 not-supported,断言最后那发仍被超时收住)
- **daemon 边界哨兵**:断言 `packages/claude-runner/bin/flywheel-codex-with-fallback` 不含超时逻辑、且 daemon spawn 路径(`CodexTmuxAdapter.ts` → `codexBin`)未被改指向 guard
- launcher / installer 哨兵:不得 export、写入或全局设置 `FLYWHEEL_CODEX_BIN`
- 围栏数据源钉 `LC_ALL=C`:locale 变化下登记/清扫两侧比较结果一致
- state 目录不可写 → fail-open(codex 照跑且有界,只是未登记)

### 7.2 `scripts/__tests__/flywheel-log-rotate.test.sh`

- 到达上限触发轮转、保留代数正确、超出的被删
- 并发 append 不丢行
- 目录不可写 → fail-open,调用方不失败
- 轮转用 rename 而非 truncate(断言旧内容完整存在于 `.1`)
- `flywheel-config` TS helper 的等价测试;Gemini `sessions.jsonl` 与 Bridge guard parent 接线测试
- tmux audit 消费测试在 active / `.1` 两代都能找到预期证据
- recent lock 仍 fail-open 跳过;伪造超龄 lock residue 后下一次 append 必须恢复轮转(shell + TS);再确定性注入「检查旧锁后、新 owner 在 rename 前替换」竞态,两侧都必须识别 identity drift、恢复替代锁并放弃轮转

### 7.3 cmux

- 现有 `test-cmux-sync.sh` 全绿(先拿基线)
- 静态守卫:`grep -c '<<<' == 0`
- 高风险类别行为测试:空串、末尾空字段、cwd 可命中的 glob literal、含反斜杠、含分隔符的输入,改前改后输出逐字相同;顶层 read 仍 rc=0;再跑 canonical `/bin/bash` 3.2 当前全套(不把会漂移的 case 数写死)

### 7.4 真机 QA(交独立 QA 节点)

- watcher 写盘速率改前 / 改后对比(含对照组),≥5 分钟;同窗记录 CPU time 与子进程数量
- 注入一个真的挂死 codex(假二进制 sleep 4 小时)→ 被清道夫收走,且同机 Codex Lead(Mufasa / infra-bot)**未受影响**(前后 PID 与 thread 连续性)
- 族 C 只做观察:真跑一次 review 记录 broker 生命周期与 brokerless fallback 残余,确认本单从未对它发信号
- 往审计日志灌 20 MB → 轮转发生,tmux rescue 功能不受影响
- 全局 shim 部署后的实证验证(§3.5)

---

## 8. 风险与被否决的备选

| 风险 | 处理 |
|------|------|
| 超时误杀合法长 review | 只对族 A 使用明确的 1,800s 默认值;历史成功任务 99.84% 在窗口内,p99=1,172s。明确长任务逐次覆盖两个正整数 env;族 B 永不加此超时 |
| 清道夫误杀 Codex Lead | 结构性排除:只认正向注册表,不在表里一律不碰 |
| pid-only broker 记录误杀复用 PID | 删除族 C reaper;endpoint dead 也不发信号,把未覆盖 broker / brokerless fallback 诚实列为残余 |
| **给族 B 加超时 = 杀掉所有 Codex runner daemon** | §3.1 的 DO-NOT-TOUCH 边界 + 文件顶部注释 + 哨兵测试;特别防「合并两个重复 wrapper」这个看似正确的清理动作 |
| **按组杀误杀调用方(Lead 的 pane)** | §3.3(3b):`set -m` 自有组 + 仅当 `pgid == pid` 才按组杀 + 发信号前重验围栏 |
| **`%s` 少个 `\n` 让 watcher 当场挂掉** | §5.1b(2):强制 `%s\n` + 断言 rc=0 的单测 |
| **`done <<< "$(cmd)"` 机械替换少跑一次迭代** | §5.1b(1):保留命令替换形式,或逐点证明 0 次迭代安全 |
| `<<<` 机械替换改变作用域 | 禁用管道形式,指定 `< <(…)`;逐点改 + 逐点测 |
| `timeout` 二进制不可用 | 三级解析 + **真跑一次**验证(不用 `-x`),纯 bash 兜底 |
| 全局 shim 换坏 = 全机 codex 断 | §3.5 部署合同:幂等 + 原子替换 + `.bak` + `DISABLED` 持久回滚;同 SHA convergence 不得撤销回滚 |
| 去 tee 改变流式输出 | §3.6 写明;若有调用方依赖流式,改单一管道而非落文件 |
| 轮转破坏日志消费方 | 无生产消费方,但有 tmux audit 测试消费者;rename 而非 truncate并补 active/`.1` 测试。launchd 持有 fd 的 `/tmp` 与 quota-monitor 明确不动 |

**被否决的备选**:

- **就地改 `~/.local/bin/codex-with-fallback` 而不进仓库**:没有仓库、测试、review —— 正是这次事故的同类形态。
- **逐个 skill / command 加 timeout**:调用方分散;族 C 绕过且本单没有安全身份可回收。
- **按进程名 + 存活时长清理**:见 §1.2,会杀 Lead。
- **从 broker.pid / durable job JSON 清理**:只有 pid 无 incarnation;本机已有记录复用到系统进程,即使 endpoint dead 也不能 signal。
- **给 `<<<` 换成管道**:见 §2.4,静默改变作用域。
- **改插件代码给 broker 加 TTL**:`~/.claude/plugins/cache/` 是 vendored 缓存,`claude plugin update` 会覆盖 —— 改了留不住。
- **放到 flywheel-skills 仓库**:两仓时序有前科,且清道夫需要本仓库的 Lead 生命周期知识。
- **靠「热路径函数」名单做守卫**:名单本身是下一个漂移点,改为全文件清零。

---

## 9. 本设计明确**不**做什么

- 不改 Codex Lead 的启动路径(`codex app-server` / `codex resume` 一行不动)
- 不改 Codex 插件代码(vendored 缓存,改了会被覆盖)
- 不从插件的 pid-only broker 记录或 brokerless fallback 猜身份、发信号;族 C 是已知残余
- 不动 `~/.codex/config.toml`、不碰 codex 的 SQLite 库(上游 bug,本机版本已含修复;复发按交接文档 §4 处理)
- 不恢复 myco 任何一环
- 不删归档目录(`~/.codex/_cleanup-*`、`~/LaunchAgents-backup-*`)—— 唯一回滚路径
- 不决定并发上限、不决定重启频率(P2 归 Annie)
- 不轮转 launchd 持有 fd 的 `/tmp/flywheel-*.log` / `quota-monitor.log`,也不轮转 per-session transcript(§4.3)
- 不承诺 CPU 诊断报告消失(只承诺写盘量,§5.3)
- 不改族 D 的 QA harness 裸调用(手工 QA,非无人值守)

---

## 10. 交付顺序与单 PR 裁定

本节点用**一个 PR 交付整单**。Tadashi 对 question `92e7e088-86c9-42f4-9217-948eac449f08` 的裁定是:P0 硬超时、P1-a 轮转与 P1-b cmux 审计共享同一套 full-repo / founder QA 验收,拆 PR 会让批准与 QA 重跑两遍。实现 commit 仍保持可分离:

1. TDD + P0 guard / stable deployment / 去 tee(族 B 只去 tee)
2. TDD + P1-a 日志轮转
3. TDD + P1-b cmux 130 处重写
4. full-repo gates + 真机证据 + 单 PR

PR body 按三片分别列验收证据,并显式注明「已按 Lead 裁定由原计划两 PR 合并为单 PR」。这是对 v3 §10 的正式替代,不再保留相互矛盾的两 PR 指令。

---

## 11. 设计评审记录

**本轮设计评审的收口方式**:Codex 通道于 2026-08-18 夜间全号打满(至 23:24Z),Gemini 免费层已停服。Tadashi 的轮级政策(`[lead-instruction 8765ac96-66b4-4d03-aa8f-c34ea57dc03b]`)指定:worktree 内预写 sanctioned skip.json,**用独立上下文 Claude 做交叉设计评审作为本轮收口**(cross-family 先例),blocking 发现修完即结案,**不记 PENDING**;不自行试 Codex 各号、不用 Gemini。

**评审 A(独立上下文 Claude,问题匹配度 / 遗漏 / 简洁性)—— 结论 `CHANGES REQUESTED`,7 项,全部已折入:**

| # | 严重度 | 发现 | 处置 |
|---|--------|------|------|
| 1 | HIGH | companion→broker 路径完全绕过 wrapper,「唯一收口」被证伪;v1 引用关机快照时漏掉 `codex-code-mode-host×16` | 接受。§1.1 重写为四族枚举;§3.1 族 C 用 broker 自己的 pidfile 做正向识别 |
| 2 | HIGH | 仓库自带同缺陷的 wrapper twin(`flywheel-codex-with-fallback`),走生产 Codex Runner 流量 | 接受(作者亦独立发现)。族 B 成为首要落点;补充评审提供的缓解事实:`CodexTmuxAdapter.ts` 已有 24h budget |
| 3 | MEDIUM | §4.1 漏 4+ 个活跃无界写入点,且表内一行指向无写入方的死文件 | 接受。§4.1 全表重写,补 restart-guard / runner-stop-notify / lead-lease-audit / lead-actions-audit 族,删死行,写明扫描口径 |
| 4 | MEDIUM | 全局 shim 的部署缝未设计(机器级单点) | 接受。新增 §3.5 部署合同 |
| 5 | LOW | 「三块共一个 PR、每块独立可回退」与 squash merge 冲突 | 接受。§10 改为两个 PR |
| 6 | LOW | 「热路径函数」未定义会漂移,守卫应是全文件清零 | 接受。§5.1 改为全文件清零 + 一行守卫 |
| 7 | LOW | 去 tee 改变流式语义;超时退出码合同未写 | 接受。§3.6 写明行为变化;§3.3 定死退出码 124 + stderr 标记 |

评审 A 同时**逐项核实并确认成立**的 v1 声称:wrapper 的两个 tee 与非 chezmoi 管理、清道夫误杀 Lead 的结构论证、`/tmp` 排除边界、以实测速率而非站点计数作验收、P2 两条确实只摆数据未预设结论。

**作者自查另外发现(与评审独立)**:族 B 的存在(与评审 #2 重合)、超时默认值需按调用方分档、现有 `codex-shim.test.ts:71` 用 `X_OK` 判可执行是与事故根因同类的模式、以及「无消费方 tail 这些日志 → rename 轮转安全」的核实结果。

**评审 B(独立上下文 Claude,正确性 / 爆炸半径)—— 结论 `CHANGES REQUESTED`,6 项,全部已折入:**

| # | 严重度 | 发现 | 处置 |
|---|--------|------|------|
| 1 | HIGH | **族 B 是天级 daemon 的载体,不是一次性 cycle 载体**;v2 把它选作超时首要落点会 SIGTERM 掉每个 Codex runner daemon。v2 §3.2「Lead 不经过 wrapper」的理由对 daemon 路径**是错的**,而这个错误是承重的 | 接受,**反转 v2 决定**。§3.1 族 B 改为 DO-NOT-TOUCH 边界 + 哨兵测试;§3.2 理由重写为 Lead / daemon 分开论证;§1.1 更正 `codex-resume` 与 tee 归因 |
| 2 | HIGH | **按组杀会杀掉调用它的 Claude Lead**:bash 3.2 非交互脚本不加 `set -m` 时后台子进程共用调用方 pgid(本机实测),围栏校验 pid 而非组归属,挡不住 | 接受。新增 §3.3(3b) 三条修法:`set -m` 自有组、仅 `pgid == pid` 才按组杀、发信号前重验 |
| 3 | HIGH/MEDIUM | 三类 `<<<` 不能机械替换,含具体行号:`done <<< "$(cmd)"` 空输出时 1 次 vs 0 次迭代(`:832`/`:6390`/`:4458`);`%s\n` 的换行是强制的(无换行 → `read` rc=1 → `set -e` 下 watcher 挂掉,`:685`/`:1074`/`:1460`/`:1479`/`:3538`/`:3565`);错误返回路径的 rc 语义 | 接受。新增 §5.1b,三类逐条点名 + 强制单测 |
| 4 | MEDIUM | 真 `timeout` 的组语义实测澄清(默认会按组杀、tee 被回收、PIPESTATUS=124);**`--foreground` 会破坏全部性质**;`tee×30` 归因应更正(族 B 也贡献 tee) | 接受。§3.4 补实测结论 + 显式禁用 `--foreground`;§1.1 补归因更正;§3.6 去 tee 扩到两个 wrapper |
| 5 | MEDIUM/LOW | 注册表残余攻击面:crash-before-write、`ps -o lstart` 的 locale/粒度、清扫 TOCTOU + PID 回收、state 目录不可写、**`exec codex -m gpt-5.5` 的无界逃逸** | 接受。新增 §3.3(3c) 逐条 + §7.1 对应测试 |
| 6 | — | P1-a 的 choke point、fail-open 语义、`/tmp` 排除边界**逐项核实成立** | 无需改动 |

评审 B 同时**逐项核实并确认成立**的声称:生产 Codex Lead 确实两个 wrapper 都不经过(TUI launcher 把 `FLYWHEEL_CODEX_BIN` 钉在裸二进制 + 活进程无 bash shim 父进程 双证);`scripts/` 下确实零调用点;watcher 确实是 bash 3.2;130 处计数属实;外层变量赋值与空串语义在指定形式下确实保住(禁用管道是承重的)。

**两轮评审的净效果**:v1 的两条覆盖前提(族 C 绕过、族 B 存在)被评审 A 推翻;v2 据此新增的族 B 落点又被评审 B 推翻(方向刚好相反 —— 族 B 不是要加超时,是要明确禁止加)。**作者与评审 A 都在族 B 上判断错了同一件事,评审 B 多查一层调用链才发现。** 这条记录留着,是因为下一个读计划的人很可能会重犯:两个 wrapper 长得几乎一样,而「合并重复代码」的直觉恰好是最危险的动作。

**评审 C(Codex 设计门禁,question `123a2ab4-7548-4a63-b9f4-e757a8fc9a5d`)—— 结论 `CHANGES_REQUESTED`,2 项 HIGH + 9 项 advisory;v4 处置如下。** 上面 A/B 表是历史决策轨迹,其中「族 C 用 broker.pid 回收」已被本轮证据推翻,不再是现行方案。

| 严重度 | 发现 | v4 处置 |
|--------|------|---------|
| HIGH | Bash 3.2 的 `IFS=…; set -- $line` 会吞末尾空字段、展开 glob、覆盖 `$@`,并在 `set -u` 下 abort | §2.4 / §5.1 / §5.1b 全量删除 sanctioned form;统一 process substitution,补 trailing-empty + glob RED tests |
| HIGH | broker durable 记录只有 pid;225 个记录里已有 2 个复用到 macOS 系统进程,旧方案会误杀 | 删除族 C reaper 与所有 signal 测试;§3.1/§9 诚实列为残余 |
| MEDIUM | §8 仍暗示族 B 有宽超时 | 删除 stale clause;族 B 只有去 tee + DO-NOT-TIMEOUT sentinel |
| MEDIUM | 缺少 timeout 默认值 / env 合同 | §3.3 写死总预算与单次默认 1,800s;记录 3,048 个成功任务的 p50/p95/p99 与覆盖率 |
| MEDIUM | build-only install 在 same-SHA 会被跳过 | §3.5 改挂 unconditional `converge_nonlead_daemons` seam,补 same-SHA test |
| MEDIUM | global shim source 活 checkout | §3.5 改成 versioned stable vendoring + atomic `current`;缺件 rc=125 fail-closed |
| MEDIUM | brokerless direct spawn 无 pidfile | §3.1/§7.4 列入族 C 未覆盖残余,不夸大覆盖 |
| MEDIUM | 日志扫描漏 Gemini sessions、voice transcript、Bridge loop guard | §4.1 补前两类 global append;§4.3 对 per-session transcript 做有理由排除 |
| LOW | 「无任何日志消费者」不实 | §4.2 更正为无生产消费者、存在 tmux audit 测试消费者 |
| LOW | launcher 被描述成 hard pin | §3.2 更正为 env soft default,并加 installer 不得设置 `FLYWHEEL_CODEX_BIN` 哨兵 |
| LOW | process substitution fork 成本未测 | §5.2/§7.4 同窗记录 CPU time 与子进程数量 |

另有 Lead 裁定:本节点不按 v3 的两 PR 拆分,改为单 PR 完整交付;§10 已同步,PR body 必须复述该裁定。

**评审 D(Codex 恢复后设计门禁,question `4e15811a-48d2-416a-9fde-ca3a8caad42b`)—— 结论 `CHANGES_REQUESTED`,1 项 HIGH + 8 项 advisory;v5 处置如下。**

| 严重度 | 发现 | v5 处置 |
|--------|------|---------|
| HIGH | `.bak` 手工恢复会被下一次 unconditional convergence 自动装回 guard,是假回滚 | §3.5 改为 persistent `DISABLED` sentinel;installer/convergence 在哨兵存在时反复恢复 `.bak`,删除哨兵才重启用;新增 RED→GREEN convergence test |
| MEDIUM | §1.1 / §3.1 对族 A 的 code/design review 调用面自相矛盾 | 更正真实活调用面;明确 code/design review 正文属于族 C,不虚报覆盖 |
| MEDIUM | 族 C 是主要路径,不能把“pid 不安全”偷换成“无需探索其他办法” | §3.1 记录 endpoint/cancel 方向的评估与缺失的 repo-owned 稳定协议 seam;保留为插件源仓 P0 follow-up,不臆造未验证取消协议 |
| MEDIUM | `mkdir` lock crash residue 会永久关闭轮转 | §4.2 加 300s stale quarantine/reacquire;shell + TS 各有 RED→GREEN test,recent contention 仍 fail-open |
| MEDIUM | 去 tee 后中断会删光已捕获输出 | §3.6 改为 signal trap 通过原 caller fd 发布 partial output;测试同时抓出并修掉“cat capture 回自身”无限自追加陷阱 |
| MEDIUM | 130 站点“逐点测”没有可执行机制 | §5.1/§5.2/§7.3 改为诚实的三层证据:人工 diff transformation audit + 四类自动 parity + canonical harness 当前全套;不再把冷站点写成动态逐点证明 |
| MEDIUM | machine-global shim 被通用 `FLYWHEEL_STATE_DIR` 重定向 | §3.5 改为安装时固化绝对 target;冲突 ambient env 的行为测试通过 |
| LOW | `codex-profile` 辅助调用不在 Codex attempt timeout 中 | §3.3 明确预算边界,不把本地辅助命令虚报成受 Codex timeout 覆盖 |
| LOW | daemon 天级 TMPDIR capture 不在日志扫描表 | §4.3 点名为既有残余;本单只去常驻 tee,不拿 per-append helper 误套长 fd |

**评审 E(Codex 设计复审 R2,question `fc176e64-b8f4-4c90-ba9f-d7e95293d315`)—— 结论 `CHANGES_REQUESTED`,1 项 HIGH + 6 项 advisory;v6 处置如下。**

| 严重度 | 发现 | v6 处置 |
|--------|------|---------|
| HIGH | BSD/macOS `mv -f staged current` 跟随指向目录的 symlink,把 staged link 移进旧 release 并返回成功;`current` 永不升级 | 接受。改成 GNU `mv -fT` / BSD `mv -fh` 的不跟随原子 rename;新增 v1 → 改字节 → v2 RED→GREEN,同时断言新字节真的执行且无 `.current-*` 残留 |
| MEDIUM | stale lock recovery 的检查与 rename 之间可被新 owner 替换 | 接受。shell + TS 都钉 `(device,inode,mtime)` 身份,quarantine 后重验;确定性竞态测试先红后绿 |
| MEDIUM | 应急流程只藏在计划中,缺独立 runbook deliverable | 部分接受。动态 `plan_only` doc tier 明确只产 `plan.md`,不另造实施文档;§3.5 已升级为可直接执行的 authoritative runbook,且本任务 doc-flow 禁止归档子目录,PR body 还会复述 |
| MEDIUM | §5.2 把人工 diff audit 写成 CI 会运行的检查 | 接受。§5.1/§5.2 分开 review layer 与 machine-CI layer,不再伪装自动化 |
| LOW | 新宿主机没有 `.bak` 时 `DISABLED` 无法真正禁用 | 接受。无 `.bak` 时发布 direct-codex passthrough;有可疑非 regular `.bak` 仍 fail-close;新增 RED→GREEN |
| LOW | 族 C P0 follow-up 没有 issue 号 | Lead 已回复由 **FLY-1900** 追踪,归入 Annie P2 决策包;PR body 作为 open risk |
| LOW | canonical harness 的写死 case 数已经漂移 | 接受。所有证据改成“当前全套”,保留真实命令与退出码而不写死易漂移计数 |

**评审 F(Codex 设计复审 R3,question `42517c9a-ef10-4f1d-b0ca-7a25b4a65805`) —— 结论 `APPROVED`,3 项 LOW advisory 均已在实现与文档中收口。**

| 建议 | 处置 |
|------|------|
| 旧 release 可能遗留 `.current-*` 临时 symlink | retention 在确认 release 只含两个精确的 regular script 与 `.current-*` symlink 后清理;其他未知项仍 fail-closed;新增 fixture 验证 |
| fresh host 无 `.bak` 时 passthrough 丢失 legacy 429 profile rotation | 在 §3.5 明确该 rollback 只保证 direct `codex` passthrough,限流时直接失败,不虚报 legacy fallback 语义 |
| 应急步骤需靠近安装入口 | `install-codex-guard.sh` 顶部注释已列出 disable / re-enable / verify 步骤 |
