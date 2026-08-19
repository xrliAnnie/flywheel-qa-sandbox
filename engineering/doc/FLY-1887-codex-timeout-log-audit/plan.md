# FLY-1887 宿主机卡死善后 — 实施计划

Issue: FLY-1887 (https://linear.app/geoforge3d/issue/FLY-1887/宿主机卡死善后codex-调用加硬超时-日志轮转-写盘审计)
日期: 2026-08-18
基于: 无

---

## 0. 一句话

三件事:给一次性 codex 调用加**有预算的硬超时 + 只认注册表的清道夫**(P0)、给 flywheel 自己写的日志加**轮转**(P1-a)、把 cmux watcher 每天 5.7 GiB 的写盘量**降到接近零**(P1-b);P2 两条(并发上限、重启编排)只摆数据不做决定,留给 Annie。

---

## 1. 审计推翻的两个前提(先说,因为它改变了落点)

### 1.1 「`~/Dev/flywheel/scripts/` 中所有调用 codex 的位置」这个集合是**空的**

全仓扫描 `scripts/*.sh` 与 `scripts/lib/*.sh`,零个 `codex exec` / `codex-with-fallback` 生产调用点。唯一命中是 `.claude/skills/linear-issue-context/SKILL.md:44` —— 那是 **issue 正文自己被注入进上下文**,不是代码。

真正的 `launchd → bash → codex → tee` 链条是 **`~/.local/bin/codex-with-fallback`**:

```bash
# ~/.local/bin/codex-with-fallback:21
codex "$@" > >(tee "$tmpfile") 2> >(tee -a "$tmpfile" >&2)
```

一次调用起**两个** tee。关机快照的 `tee×30 + codex×19 + bash×18` 正好是这个形状(30 ≈ 2×15)。而这个文件:

- 不在本仓库里
- 不在 chezmoi 管理内(实测 `chezmoi managed | grep codex-with-fallback` 为空)
- 没有测试、没有 review、没有版本

它被全局规则 `~/.claude/rules/codex-multi-account.md` 指定为**所有** Codex CLI 调用的必经入口,而 Flywheel 的 Runner 每轮 `/codex-code-review`、`/codex-design-review` 都走它。**所以 P0 的落点不是「改 flywheel/scripts」,是「把这个 seam 收进仓库并给它加超时」。**

### 1.2 交接文档建议的清道夫一行命令会**杀掉生产 Codex Lead**

```bash
# 交接文档 §3 P0 的建议 —— 不要按原样实施
ps -eo pid,etimes,comm | awk '$2 > 86400 && /codex|tee/ {print $1}' | xargs -r kill -9
```

`codex-infra-bot-lead` 与 `growth-mufasa-lead` 是**按设计长期运行**的 Codex Lead(FLY-1814 记录 infra-bot 连续运行约 7 天 = 604800s,远超 86400s 阈值)。按进程名 + 存活时长筛选,会把它们一起 `kill -9`。

清道夫必须**按注册表**(只杀本 guard 自己启动并登记过的一次性调用),不能按名字。见 §3.2。

---

## 2. 已实测的证据

所有测量在生产宿主机上完成,工具为 `proc_pid_rusage(RUSAGE_INFO_V4)`,读 `ri_diskio_byteswritten`(物理)与 `ri_logical_writes`(逻辑)。

### 2.1 cmux watcher 的写盘量 —— 带对照组

120 秒采样,`flywheel-cmux-sync.sh --watch`(PID 44455)对比同机 4 个长期运行的 bash:

| 进程 | 物理写 | 逻辑写 |
|------|--------|--------|
| **cmux watcher** (44455) | 15,974 B/s = **1,316 MiB/天** | 69,222 B/s = **5,704 MiB/天** |
| `atlas/start.sh` (1885) | 0 B/s | 0 B/s |
| `lead-body.sh` eng-lead (6987) | 0 B/s | 0 B/s |
| `lead-body.sh` tidal-echo-cos (6785) | 0 B/s | 0 B/s |
| `stkLaunchAgent.sh` (1857) | 0 B/s | 0 B/s |

对照组全 0,说明这不是「长期 bash 都这样」,是 watcher 独有。2 GiB ÷ 69,222 B/s ≈ **8.6 小时打满配额** —— 与交接文档「每天精确打满 2147.48 MB」的诊断报告完全吻合。

### 2.2 写盘去向不在任何可见文件里

50 秒内轮询全部 cmux 状态文件 + flywheel 日志,总增长约 5 KB(≈9 MB/天),只占实测量的 **0.2%**。状态文件全是 KB 级,且多数是原地重写(净增长 0)。

### 2.3 根因:bash here-string(`<<<`)—— 2×2 对照矩阵

| 实验 | 物理写 | 逻辑写 | 说明 |
|------|--------|--------|------|
| A 自身写 8 MiB(builtin printf) | 8,388,608 B | 8,962,048 B | **仪器阳性对照**:能看见自身写 |
| B 子进程 `dd` 写 8 MiB | 0 B | 0 B | 子进程写盘**不计入**父进程 |
| C 2000 次 `read -r x <<< "..."` | 8,192,000 B | 32,804,864 B | **每次 4,096 B 物理 / 16,402 B 逻辑** |
| D 同样 2000 次循环,去掉 `<<<` | 0 B | 0 B | 阴性对照:不是循环的锅 |

A 排除「仪器瞎了」,D 排除「循环本身」,B 说明 watcher 那 5.7 GiB 是**它自己**写的(不是 tmux/cmux 子进程)。

**交叉验证(两个独立计数器同时同意)**:

- 逻辑写 69,222 ÷ 16,402 = **4.22 次/秒**
- 物理写 15,974 ÷ 4,096 = **3.90 次/秒**

两条独立算得的 here-string 频率一致(约 4/秒 ≈ 每 15 秒 tick 约 60 次)。`scripts/flywheel-cmux-sync.sh` 里有 **130 处 `<<<`**,大量在 per-Lead 循环中(如 `done <<< "$LEAD_ROSTER_ROWS"` 出现多次)。

机制:bash 对每个 here-string 在 `TMPDIR` 建一个临时文件、写入、立刻 unlink。**代价与字符串长度无关**(20 字节的字符串照样 4 KiB 物理写),因为 APFS 按块 + 元数据放大。文件被立即删除,所以任何按文件大小的审计都看不见它。

### 2.4 替换方案也已实测(不是纸上推理)

| 候选 | 物理写 | 逻辑写 | 语义是否安全 |
|------|--------|--------|-------------|
| `while ...; done <<< "$v"` (现状) | 8,192,000 B | 32,804,864 B | — |
| `while ...; done < <(printf '%s\n' "$v")` | **0 B** | **0 B** | ✅ 循环留在当前 shell,变量赋值不丢 |
| `IFS='|'; set -- $line`(纯 builtin) | **0 B** | **0 B** | ✅ 零 fork 零写盘 |
| `printf ... \| while read` | 未测 | — | ❌ **禁用**:循环进子 shell,累加的变量静默丢失 |

**关键陷阱**:最直觉的替换(改成管道)会把循环体推进子 shell,导致循环里累加的状态在循环结束后消失 —— 这类改动测试可能仍然全绿(状态在循环内是对的),但生产行为错。因此指定 `< <(printf ...)` 形式,不是管道。

### 2.5 关于「timeout 二进制」的预先警告

本机 `timeout` / `gtimeout` 都来自 Homebrew coreutils(`/usr/local/bin/`),macOS 基础系统**没有** `timeout`。而这次事故的根因恰恰是「brew 升级删掉了 Cellar 目录,留下一个存在但跑不起来的二进制」。所以 guard 绝不能假设 `timeout` 存在或可用 —— 见 §3.1 的解析与自检要求。

---

## 3. P0 — 给一次性 codex 调用加硬超时

### 3.1 落点与形态

新增 `scripts/codex-oneshot.sh`(仓库内、有测试、随现有安装流程装到 `~/.flywheel/bin/`),`~/.local/bin/codex-with-fallback` 改为薄 shim 指向它,原文件留 `.bak`。

**为什么落在本仓库而不是 flywheel-skills**:(a) `~/.flywheel/bin` 的安装/部署机械在本仓库已存在且每次重启都在跑;(b) 清道夫必须知道「哪些进程是 Flywheel 的长生命周期 Lead」,这份知识(manifests / launchd label)在本仓库;(c) 两仓时序有前科(FLY-880 的 13 个 vendored skill 至今未落地),本单三件事合成一个 PR、一次 review、一次部署更稳。

**为什么包一层而不是逐个改调用方**:调用方是全局 skill、slash command、`codex:rescue` plugin —— 分散且部分不在任何仓库里。全局规则已经强制「所有 exec 调用走 codex-with-fallback」,这就是天然的唯一收口。

**为什么长生命周期 Codex Lead 不受影响**:Lead 走 `codex app-server` / `codex resume`,由 `packages/claude-runner/src/{codex-daemon-runtime,CodexTmuxAdapter}.ts` 直接 spawn,**不经过** codex-with-fallback。全局规则也明确「非 exec 命令直接用 codex」。这是一条干净的接缝 —— 超时只作用在一次性调用上。

### 3.2 三条硬要求

**(1) 预算是总的,不是每次的。** 现状 wrapper 最多轮转 5 个 profile;若每次都给 60 分钟,最坏 5 小时。设计:进程启动时算一次总截止时间,每次尝试拿 `min(单次上限, 剩余预算)`;预算耗尽就停止轮转。

- `FLYWHEEL_CODEX_TIMEOUT_SECONDS` 单次默认 **3600**
- `FLYWHEEL_CODEX_TOTAL_BUDGET_SECONDS` 总预算默认 **7200**

**关于 1800 秒**:交接文档建议 30 分钟。这里取 60 分钟,理由是本仓库的 xhigh code review 单轮可以合法地跑很久,30 分钟有误杀真实工作的风险;而事故里的僵死进程是 **4.66 天**,任何有界值都能解决问题 —— 所以往宽里取,零风险地达成目标。两个值都可通过 env 覆盖,若 Annie/Tadashi 想更严可直接调。

**(2) 超时必须是一个可分辨的终局,不能被当成限流去重试。** 超时退出码(GNU timeout 为 124)必须映射为一条显式的、带类型的错误,**不轮转 profile、不重试**。否则一次卡死会被放大成 5 次卡死。

**(3) 清道夫只认注册表,永不按进程名。**

- guard 启动时写 `~/.flywheel/state/codex-oneshot/<pid>.json`,含 `pid` / `pgid` / `start_epoch` / `deadline` / `label`;正常退出用 trap 删除。
- 每次**新的** codex 调用先做一次机会式清扫(不新增任何 launchd job / timer —— 卡死堆积的前提本来就是调用在持续发生)。
- 清扫时对每个条目做 **PID 复用围栏**:核对进程真实启动时间与登记值一致,不一致就当条目过期删掉,**不杀**。
- 超过 `deadline + 宽限` 才 TERM 进程组,再 KILL。
- **任何不在注册表里的进程,一律不碰。** 这是结构性保证 —— Codex Lead 不可能被误杀,不是因为我们判断得准,是因为它压根不在候选集里。

**(4) 不依赖未验证的外部二进制(这次事故的同一课)。** 按 `timeout` → `gtimeout` → 纯 bash 看门狗 的顺序解析,且**必须真的跑一次**验证可执行(`-x` 只验权限位 —— 那正是 myco-mcp 的缺陷本体),失败就降级到下一个。纯 bash 兜底:后台跑 codex、记 pid、循环检查用时、到点杀进程组。**永不无界地跑 codex。**

### 3.3 顺带修掉 tee

关机快照里 tee 是数量最多的一类(30 个)。它们来自第 21 行的两个进程替换 —— 那两个 tee 不是 `timeout` 的子进程,杀 codex 不保证收走它们。改为把输出落到临时文件再读取(或单一管道),消除这条孤儿链。这属于「解决 issue 所需」而非顺手清理:tee 占了僵死进程的 22%。

---

## 4. P1-a — 日志轮转

### 4.1 要修的写入点(已枚举完)

| 文件 | 写入点 | 曾到达 |
|------|--------|--------|
| `~/.flywheel/logs/tmux-rescue-audit.log` | `scripts/lib/tmux-server-rescue.sh:941` | **350 MB** |
| `~/.flywheel/logs/quota-monitor.log` | `scripts/flywheel-quota-monitor-wrapper.sh:44` | 16 K |
| `~/Library/Logs/flywheel/codex-log-guard.log` | `scripts/codex-log-guard.sh:35,46` | — |
| `~/.flywheel/logs/lead-*-startup.log` | `packages/teamlead/scripts/claude-lead.sh:1422,1424` | 45 K |
| `~/.flywheel/logs/cmux-sync-watch.log` | cmux-sync 自身 | 1.3 M |

`tmux-rescue-audit.log` 是唯一出过事的,而且它只有 `_tmux_rescue_audit()` **一个** choke point —— 改动面很小。

### 4.2 设计

新增 `scripts/lib/flywheel-log.sh`,提供 `flywheel_log_rotate_if_needed <path> [max_bytes] [keep]`。默认 **10 MiB 上限、保留 3 代**。

- **fail-open**:轮转出任何问题都不能让调用方失败。审计日志是尽力而为的旁路,不能因为轮转失败而把 tmux rescue 拖挂(现有代码已是 `|| true` 语义,必须保持)。
- **并发**:多个进程会同时 append。轮转本身用 `mkdir` 原子锁(macOS bash 3.2 没有 `flock` 二进制);拿不到锁就跳过轮转直接 append —— 下一次再轮。
- **不丢行**:轮转用 rename,不用 truncate。

### 4.3 明确不做:`/tmp/flywheel-*.log`

那些是 launchd 的 `StandardOutPath`,**fd 由 launchd 持有**。对一个活进程正在写的文件做截断会留下 NUL 空洞、证据作废 —— 这是本仓库记忆里已经踩过的坑。且 `/tmp` 重启即清空,当前最大的 `flywheel-bridge.log` 一天 510 KB,不构成威胁。**列为明确的边界外,不是遗漏。**

---

## 5. P1-b — cmux 写盘

### 5.1 改法

把 `scripts/flywheel-cmux-sync.sh` 中**实际会执行到的** `<<<` 换成:

- `while ...; done <<< "$v"` → `while ...; done < <(printf '%s\n' "$v")`
- 纯字段切分且不想 fork 的 → `oldifs=$IFS; IFS='|'; set -- $line; IFS=$oldifs`
- **禁用** `printf ... | while read`(§2.4 的作用域陷阱)

逐点改 + 逐点测,**不许用 sed 批量替换**:空串、含反斜杠的内容、`$?` 语义都要逐个核。

### 5.2 验收判据是**实测速率**,不是站点计数

130 处不等于 130 处都在热路径。把「改了多少处」当验收会给出假绿。判据:

- 用同一套仪器(`proc_pid_rusage`)在真机上测改前 / 改后的 watcher 写盘速率,各 ≥5 分钟,**同时带对照组**(其他长期 bash 应仍为 0)。
- 目标:逻辑写从 69 KB/s 降到 **< 2 KB/s**(即 < 170 MiB/天,远低于 2 GiB 配额)。剩余流量应约等于 §2.2 测到的真实状态/日志写入(约 9 MB/天)。
- 加一条静态守卫测试,防止 `<<<` 在热路径上回流。
- 现有 `test-cmux-sync.sh` 全套必须保持全绿(参照 FLY-1672 的 570/570)。

### 5.3 附带说明:CPU 报告可能一起变好

诊断报告是 bash **资源诊断**(CPU + 写盘)。每个 here-string 是一次建文件 + 写 + unlink 的系统调用序列,去掉后系统调用量同步下降。但这是推论,不是本单承诺 —— 只承诺写盘量,CPU 变化如实观测后再说。

---

## 6. P2 — 摆数据,不做决定

按 issue 与交接文档的明确要求,以下两条**需要 Annie 拍板,本单不实施、不预设结论**:

**并发上限**:8/17 18:37 实测峰值 1106 进程 / 62.7 GB 内存需求(物理内存 48 GB)。16 Lead 冷启会拉起 60–80 个 MCP 子进程。

**重启编排**:上次连续开机 17.2 天;三次内存耗尽在 8/14、8/16、8/17,间隔从两天缩到一天。交接文档建议每 3–7 天重启一次宿主机(而非仅重启服务),可接进 `com.flywheel.updater` 的 00:00 流程。

补一条本单发现的相关事实供她判断:本单 P1-b 若达成目标,会移除掉宿主机上一个持续的写盘压力源,但**不会**改变内存侧的劣化曲线 —— 两条 P2 的必要性不因 P1-b 而降低。

---

## 7. 测试计划(TDD,RED → GREEN)

### 7.1 `scripts/__tests__/codex-oneshot-guard.test.sh`

- 假 codex 睡过截止时间 → 被杀,退出码映射正确
- 超时**不**触发 profile 轮转(反例:限流输出**要**触发轮转,证明区分是真的)
- 总预算耗尽后停止重试(用短预算 + 多次假限流验证)
- 注册表:启动写入、正常退出清除、异常退出留下的条目被下次清扫收走
- **清道夫阳性对照**:同时起一个**未登记**的、名字含 `codex` 的长寿进程 → 清扫后必须**仍然活着**(这是防止误杀 Lead 的那条断言)
- PID 复用围栏:伪造一个 pid 相同但启动时间不符的条目 → 只删条目,不杀进程
- `timeout` 缺失 / 存在但跑不起来(`-x` 为真但 exec 失败)→ 降级路径生效,且**仍然有界**

### 7.2 `scripts/__tests__/flywheel-log-rotate.test.sh`

- 到达上限触发轮转、保留代数正确、超出的被删
- 并发 append 不丢行
- 目录不可写 → fail-open,调用方不失败
- 轮转用 rename 而非 truncate(断言旧内容完整存在于 `.1`)

### 7.3 cmux

- 现有 `test-cmux-sync.sh` 全绿(改动前先跑一遍拿基线,避免把既有失败算到本单头上)
- 新增静态守卫:热路径函数内不得出现 `<<<`
- 逐点行为测试:空串、含反斜杠、含 `|` 分隔符的输入,改前改后输出逐字相同

### 7.4 真机 QA(交独立 QA 节点)

- watcher 写盘速率改前 / 改后对比(含对照组),≥5 分钟
- 注入一个真的挂死 codex(假二进制 sleep 4 小时)→ 验证被清道夫收走,且同机 Codex Lead(Mufasa / infra-bot)**未受影响**(前后 PID 与 thread 连续性)
- 往审计日志灌 20 MB → 验证轮转发生,且 tmux rescue 功能不受影响

---

## 8. 风险与被否决的备选

| 风险 | 处理 |
|------|------|
| 超时误杀合法长 review | 默认取 60 分钟(远宽于典型值),env 可调;事故是 4.66 天,有界即达标 |
| 清道夫误杀 Codex Lead | 结构性排除:只认注册表,不在表里的一律不碰 |
| `<<<` 机械替换改变作用域 | 禁用管道形式,指定 `< <(...)`;逐点改 + 逐点测 |
| `timeout` 二进制不可用 | 三级解析 + **真跑一次**验证(不用 `-x`),纯 bash 兜底 |
| 轮转破坏日志消费方 | rename 而非 truncate;launchd 持有 fd 的 `/tmp` 日志明确不动 |
| 三件事互相牵连 | 一个 PR 但三个独立可回退的改动;guard 保留 `.bak` |

**被否决的备选**:

- **就地改 `~/.local/bin/codex-with-fallback`**:没有仓库、没有测试、没有 review,下次谁改都不知道 —— 正是这次事故的同类形态(一个没人管的裸脚本)。
- **逐个 skill / command 加 timeout**:调用方分散,`codex:rescue` plugin 路径绕过它们,必然漂移。
- **按进程名 + 存活时长清理**:见 §1.2,会杀 Lead。
- **给 `<<<` 换成管道**:见 §2.4,静默改变作用域。
- **放到 flywheel-skills 仓库**:两仓时序有前科,且清道夫需要本仓库的 Lead 生命周期知识。

---

## 9. 本设计明确**不**做什么

- 不改 Codex Lead 的启动路径(`codex app-server` / `codex resume` 一行不动)
- 不动 `~/.codex/config.toml`、不碰 codex 的 SQLite 库(上游 bug,本机版本已含修复;复发时按交接文档 §4 处理)
- 不恢复 myco 任何一环
- 不删归档目录(`~/.codex/_cleanup-*`、`~/LaunchAgents-backup-*`)—— 那是唯一回滚路径
- 不决定并发上限、不决定重启频率(P2 归 Annie)
- 不轮转 launchd 持有 fd 的 `/tmp/flywheel-*.log`(§4.3)
- 不承诺 CPU 诊断报告消失(只承诺写盘量,§5.3)

---

## 10. 交付顺序

1. P1-a 日志轮转(改动面最小、风险最低,先落地拿信心)
2. P0 codex 超时 + 清道夫(风险集中在「不能误杀 Lead」,测试最重)
3. P1-b cmux 写盘(改动点最多,靠实测速率验收)

三块共一个 PR、一次 review、一次部署;每块独立可回退。
