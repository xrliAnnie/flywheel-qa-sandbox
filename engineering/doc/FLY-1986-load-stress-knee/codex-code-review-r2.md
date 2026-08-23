# Code Review — FLY-1986 PR #924 head e31719573 (真 Codex,第 1 轮 / 重跑令)

Reviewer: **Codex**(评审记录本体)
Date: 2026-08-23
Status: CHANGES REQUESTED → **7 项全部复核成立、全部已修**

> 背景:founder 裁定 Antigravity 那轮作废;Codex 额度恢复后按「评审重跑令」在冻结 head
> `e31719573` 上用真 Codex 重跑。环境注意:本 runner 继承了 `CODEX_HOME=~/.codex-infra-bot`,
> 必须显式 `CODEX_HOME=$HOME/.codex` 才读得到正确凭据。

## Summary(reviewer 原文)

The endpoint table is GET-only, the SQLite query is engine-read-only, and the hermetic TERM
replay stopped subsequent requests; I found no direct Bridge mutation path. However, the new
monotonic-clock implementation can corrupt or drastically extend a run, while incomplete and
mixed-process blocks can still be certified. CI wiring is structurally correct, but the added
suite fails on `ubuntu-latest`.

## 7 项发现与处置

| # | 级别 | 发现 | 本仓复核 | 处置 |
|---|---|---|---|---|
| 1 | **HIGH** | `CLOCK_PROC` 没用上,每次 `now()` 都起一个新解释器;而 macOS 系统 python3.9 的 `time.monotonic()` 是**进程相对**的,新进程每次都返回 ~0 ⇒ 栅格彻底失效,sleep 变成 2s/4s/6s…,10 秒的区块能跑几小时;且 `main()` 忽略 `detect_clock` 的失败 | **实测确认**:`/usr/bin/python3` (3.9.6) 三次读数 `0.008364 / 0.008391 / 0.008207`;`/usr/local/bin/python3` (3.14.6) 是 `232076.x`。**我之前的真机跑之所以没炸,纯粹是 PATH 恰好解析到 3.14** | 改为**探测「跨进程共享」的单调时钟**(两次独立读数须 >1000 且非递减,进程相对的必然被拒),选中后起**一个常驻 helper 经 FIFO 应答**(不再每 tick fork);`main()` 改为 `detect_clock \|\| die`;读数畸形即失败 |
| 2 | **HIGH** | 期望 tick 数的守卫是**死的**:`expected` 默认 0,`main()` 从来不传;子进程失败状态也被 `\|\| true` 吞掉 | **实测确认**:`summarise_block` 只用 4 个参数调用 | 按区块时长与**有效** interval(A/A 会缩放)算出期望值并传入;逐个 `wait` 不吞失败;`expected<0` 作为「本块作废」的显式信号 |
| 3 | **HIGH** | Bridge 身份只在区块**之前**校验,之后从不校验 ⇒ 期间 launchd 重启会把两个实例混在一起却仍出 valid;`BUILD_SHA` 也没写进证据 | 读码确认 | 采集后、认证前**重新解析** listening PID / 进程身份 / buildSha / shuttingDown,任一变化即作废本块;`build_sha` 写入 meta |
| 4 | MEDIUM | 默认 L1-only 路径在 `unset` 之前就 `return` 了 ⇒ 那条路径下 token 仍被所有子进程继承 | 读码确认(第 8 行 return,第 26 行才 unset) | 无认证需求的路径也先 `unset` 再返回 |
| 5 | MEDIUM | 新增的 CI step 跑在 Ubuntu,但断言要求 macOS `vm_stat` 产出数值 ⇒ `ubuntu-latest` 上必红 | 复核成立 | 有 `vm_stat` 才要求数值,没有则要求 `NA`;另加一条**把 vm_stat 打桩成不可用**的契约,证明缺它时仍能跑且回落 NA |
| 6 | LOW | 所谓 bash 3.2 覆盖只测了间接展开;用 `/bin/bash` 3.2 真跑 `--self-test` 会因 cleanup 断言里嵌套 eval/awk 的引号解析而失败 | **实测确认**:`/bin/bash ... --self-test` 确实红。⚠ 我之前报的「bash 3.2 51/51」测的是**套件**在 3.2 下跑,而**被测脚本仍是 PATH 上的 bash 5** —— 又一次「量的不是我声称的那个东西」 | 嵌套 eval 换成 helper 函数;三种环境(normal / CI 形态 / `/bin/bash` 3.2)全部纳入常规验证 |
| 7 | LOW | 诊断「行为」测试从不调用 `summarise_block`,而是自己手写一段 awk 复述期望值 ⇒ 生产分支坏掉它照样过 | 复核成立 | 脚本底部加 `BASH_SOURCE` 判断的 **source seam**(不引入任何新 env var),测试直接 `source` 后调**真** `summarise_block` |

## 这一轮暴露的两条模式

1. **第三次「上一轮的修复长出新缺陷」** —— 而且这次最严重:我为了修「墙钟」引入的单调时钟,在**默认的 macOS 系统 python 下会让探针跑几个小时**。我的真机验证没抓到,只因我的 PATH 恰好指向另一个 python。
2. **第五次「检查不会变红」** —— 期望 tick 守卫加了却没接线。加守卫和**接上守卫**是两件事;我做了前者就报了后者。

## Verdict

CHANGES REQUESTED(已全部折入,详见随附 commit)

---

# 第 2 轮(head `5ce1552c0`)—— 又 7 项,2 个 HIGH,全部已修

Status: CHANGES REQUESTED → **7 项全部复核成立、全部已修**

## 最重的两条,都是我修第 1 轮时新造的

| 级别 | 缺陷 | 复核 |
|---|---|---|
| **HIGH** | **常驻 FIFO 时钟 helper 不是并发安全的** —— fd 8/9 被协变量采样器和**所有**哨兵子壳继承,多个 `read` 在同一条 response FIFO 上互相截断字节,响应也没有请求方关联。reviewer 实测:两客户端 1,000 次读有 **36 次畸形**,八客户端 4,000 次有 **912 次**;helper 被暂停时 `now()` 还会**永久阻塞** | 改为**每个采集进程各起一个 helper**(一条流恰好一个读者)+ `read -t 10` 硬超时 + 读数畸形即失败。**新增双采集器并发测试:30 秒 25 行,畸形 0** |
| **HIGH** | **时钟 helper 与探测子进程在 token 被清除之前启动** ⇒ 它们继承了生产 bearer token,而常驻 helper 会把这份副本**留一整轮**;默认只测 L1 时也一样,非法 token 分支同样在清除前返回 | token 改为**参数解析后立刻在纯 shell 里捕获并无条件 `unset`**,任何外部命令/ helper 启动之前 |

## 其余五条

- post-block fence 只拒 `shuttingDown:true`,**不要求 `ok:true`** ⇒ 同 PID、同 SHA 下翻成 `{"ok":false}` 仍被认证。改为 preflight 与 fence **共用同一个严格谓词**。
- 已 reap 的 PID 仍留在 `SENTINEL_PIDS` ⇒ 后续 INT/TERM 可能**signal 到已被复用的无关进程**。改为 reap 一个移除一个。
- ⚠ **测试套件自己泄漏 mock**:EXIT trap 只删临时目录,从不 kill。**只读普查发现 18 个 PPID=1 的孤儿 Python listener(27–55 分钟龄)留在 founder 机器上**,外加 162 个残留 FIFO 目录 —— 而这恰恰污染了本单要测的负载基线。**已全部清理**(逐个先复核签名再 TERM),并改为统一 EXIT/INT/TERM cleanup 先 kill 再 wait,spawn 即登记,收尾断言零残留。**实测:跑前 0,跑后 0。**
- 时钟 helper 在 cleanup trap 安装**之前**启动 ⇒ 失败的 preflight 与成功的 dry-run 都会留下 FIFO 目录。改为先装 trap 再起 helper。
- `_clock_is_shared` 把整条命令塞进字符串再用未引用的 `$cmd` 执行 ⇒ argv 被错误拆分;而且 `>1000` 的判据隐含「开机已超 1000 秒」。改为**程序+参数**分开调用,判据改成**两个独立进程读数之差 ≥ 睡眠的一半**(无任何 uptime 假设)。

## 这一轮的模式

**第四次「上一轮的修复长出新缺陷」**,而且这次是**两条 HIGH 同时**:并发不安全的时钟、以及在清 token 之前就启动子进程。我为了消除「每 tick fork 一个解释器」的负载,换成常驻 helper —— 却没想过那对 fd 会被每个子壳继承。

**外加一次真实的机器污染**:我反复跑自己的套件,在 founder 机器上留下 18 个孤儿监听进程近一小时。讽刺的是,本单存在的理由就是「量机器负载」。

---

# 第 3 轮(head `51e1beec7`)—— 6 项,4 个 HIGH,全部已修

Status: CHANGES REQUESTED → **6 项全部复核成立、全部已修**

## 一条是**已提交代码里的真实危险**,不是理论问题

| 级别 | 缺陷 |
|---|---|
| **HIGH** | 我上一轮为了修「测试套件泄漏 mock」写的清理逻辑,**从不清空 `MOCK_PIDS`**。D6 kill+wait 之后套件又跑了一个 25 秒的探针,随后 EXIT trap **再一次 signal 那批已经可被复用的 PID** ⇒ **可能杀掉 founder 机器上不相干的进程**;INT/TERM 还会先调一次 cleanup、再经未解除的 EXIT trap 调第二次。已改为:进入即解除 trap、快照并清空、**signal 前逐个用 `ps` 复核仍是我们的 mock**、只 wait 快照。 |

**修泄漏的代码本身变成了比泄漏更危险的东西。**

## 另外三个 HIGH,全部来自我上一轮的「每进程一个时钟 helper」

- 子壳**继承**父进程的 `CLOCK_HELPER_PID` 与 fd,而 `start_clock_helper` 开头就调 `stop_clock_helper` ⇒ **把父进程的 helper 杀了**(reviewer 复现:父 helper 以 rc 143 死亡),协变量采样器的时钟随之失效,父进程还握着一个陈旧 PID 等着将来误 signal。改为:子进程**disown 继承来的状态**(只关闭继承的 fd,**绝不 signal 不是自己起的 PID**)。
- `now()` 超时会返回失败,但**调用方基本不看返回码** ⇒ `$(now)` 变空字符串喂进 awk,算出一个巨大的 sleep;诊断模式还会拿空 base 无限循环。改为每次读数单独捕获并检查状态,失败即中止该采集器。
- `run_diagnostic_block` 跑在**主 shell** 里却把主 EXIT trap 换成了自己的 ⇒ 第一个诊断区块之后的任何中止都会**绕过 cleanup**,把无限循环的协变量采样器变成孤儿。改为不再替换主 trap,由主 cleanup 统一负责。

## 两个 MEDIUM

- 「token 早清除」被 `--self-test` 绕过:它在 capture-and-unset 之前就跑了时钟探测、起了解释器;连正常路径都先 fork 了一个 `basename`。改为 `${0##*/}` 纯 shell,`--self-test` 延后到清除之后再执行。
- `health_is_serving` 只拒 `shuttingDown:true`,**没要求显式 `false`** ⇒ 字段缺失(无法报告 draining 状态的 Bridge)被当成健康。改为必须显式 `false`,并补了 serving / draining / ok:false / 字段缺失 / 畸形 五种行为断言。

## 累计模式

**第五次「上一轮的修复长出新缺陷」。** 各轮发现数:12 → 4 → 9 → 7 → 7 → 6。
这一轮尤其说明问题:**四个 HIGH 里有四个都出在我前两轮新写的并发 / 生命周期代码里**,而不是原始逻辑。
已就此向 Tadashi 提出范围问题(见 plan §12.3)。
