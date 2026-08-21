# FLY-1929 实施记录 — 实现期抓到的真问题

Issue: FLY-1929 (https://linear.app/geoforge3d/issue/FLY-1929/infra宿主-内核-panic-致-0135-全机重启-ipc-voucher-泄漏打满-ivac-entries)
日期: 2026-08-20
基于: plan.md

只记**实现期新发现、且会影响下一个人**的东西。设计层的推翻史在 plan.md 里。


> ## ⚠️ 这份记的是「路上踩到的坑」,不是最终形态
>
> 下面第 3、4 条讲的是**已被删除的那版**(内嵌 python 的单体 shell + 自建状态机)。
> 它们仍然值得留着,因为坑本身是真的、而且下一个人还会踩(Bash 3.2 的解析限制、
> `python3 - <<'PY'` 吃掉管道)。但**实现最终被砍到骨头,那些构造已经不存在了**。
>
> **最终形态见同目录 `as-built.md`。**

## 1. 两面漂移守卫**不**覆盖「union 有、shell 没有」这个方向

plan §4.1 假定 `kind-contract.test.ts` 的通用断言能兜住新 kind 的两面一致性。**实测不成立。**

我做了阴性对照:把 `host_voucher_incident` 从 `lead-alert.sh` 的允许列表里删掉,
`kind-contract.test.ts` 依然 **27/27 全绿**。

读源码确认原因:那套通用断言只做 **shell → TS union**(「每个 shell 允许的 kind 都在 union 里」),
**没有** union → shell 的反向断言;两面覆盖是靠 FLY-1309 / FLY-1364 这种**逐族显式列表**做的。

⇒ 后果:一个加进 TS union 却忘了加进 shell 的 kind,**能编译、能过测、能上线**,
然后在运行时被 `lead-alert.sh` 以 `unknown --kind` 拒掉 —— 告警永远发不出去,而且没人会知道。

⇒ 本单按既有惯例补了 `FLY-1929 host_voucher_incident exists on both faces` 断言,
并做了 RED→GREEN 验证(删 shell 那行 ⇒ 该断言精确报
`missing from lead-alert.sh allowlist`;恢复 ⇒ 绿)。

**给下一个加 kind 的人**:别指望通用守卫,老老实实加一条逐族断言。

## 2. `plutil -lint` 通过 ≠ plist 合法

新 plist 我先用 `plutil -lint` 验过,**OK**。但 `launchd-units-manifest.test.sh` 里的
Python `plistlib` 直接报 `not well-formed (invalid token)`。

根因:我在 XML 注释里写了 `--lead system`,而 **XML 注释内不允许出现 `--`**。
`plutil` 宽容,expat 严格。

⇒ 教训:plist 的合法性以**更严格的那把尺子**为准。仓库里的守卫用的是 plistlib,
所以本地自检也该用它,不能只跑 `plutil -lint`。

## 3. Bash 3.2 —— macOS 的 `/bin/bash` 会把整个脚本解析失败

脚本在 bash 5 下跑得好好的,`/bin/bash -n`(3.2.57)直接 `unexpected EOF`。逐个定位出**四类**构造,
3.2 全部解析不了(bash 5 都能过):

| 构造 | 例子 |
|---|---|
| 进程替换里含括号 | `{ read ...; } < <( ... python3 -c '...(...)...' )` |
| `$( )` 里嵌套单引号 | `raw="$(... python3 -c "st['a']['b']='$x'" )"` |
| `$( )` 里再套 `$( )` 且各自带双引号 | `"...threshold=$([ "$x" = y ] && echo "$A" || echo "$B")..."` |
| `$( )` 里放 heredoc | `out="$(python3 - <<'PY' ... PY )"` |

⇒ 全部改成:先写临时文件,再用**朴素的** `$(cat "$f")` 读回来。

**给下一个写 shell 的人**:`bash -n` 用的是 PATH 里的 bash(很可能是 homebrew 的 5.x),
**它不是生产会用的那个解析器**。要显式跑 `/bin/bash -n`。

## 4. 一个我自己造的真 bug,被测试抓住了 —— `python3 - <<'PY'` 会吃掉管道

为了绕过第 3 条,我把两处写回状态的代码从 `python3 -c "..."` 改成了 heredoc:

    printf '%s' "$raw" | VG_X=... python3 - <<'PY'
    st = json.load(sys.stdin)     # ← 读到的是脚本正文,不是管道里的 JSON
    PY

**`python3 -` 的 `-` 表示「从 stdin 读脚本」,而 heredoc 就成了 stdin —— 它把管道顶掉了。**
于是 `json.load(sys.stdin)` 解析的是 Python 脚本本身,直接抛
`JSONDecodeError: Expecting value: line 1 column 1`。

后果本来会很严重:**投递结果永远写不回状态 ⇒ 闩永远 arm 不上 ⇒ 同一条告警每分钟重发**。
测试精确抓到了(A2b 期望 1 条实得 3 条、A4 期望 1/1 实得 2/1、两条 E 用例)。

⇒ 正解:JSON 走 **argv**(`python3 - "$raw"` + `json.loads(sys.argv[1])`),和文件里其它几处一致。

**顺带一条关于纪律的**:那次全绿是在改造**之前**跑的,改造之后我只跑了 3.2 没跑 bash 5 ——
如果我把「之前绿过」当成「现在也绿」,这个 bug 就跟着上线了。**改完必须重跑,不能复用旧的绿。**

## 5. 变异测试:证明这套测试真的会红

绿测本身不是证据。逐个注入缺陷,确认对应用例变红:

| 注入的缺陷 | 结果 |
|---|---|
| severe 不再压制 warn | ✅ A3b / A3c 变红 |
| signature 去掉 `generation_id` | ✅ B1 变红 |
| 缺失的 zone 行静默当 0 | ✅ C2 变红 |
| `duplicate` 被当成 accepted | ✅ E duplicate 变红 |
| 续扫去掉块重叠 | ✅ D5 变红 |
| 闩无视投递结果直接 arm | ✅ 6 条 E 用例变红 |

**其中两次我自己的变异是无效的**(锚点没匹配上、把某行替换成了它自己),
第一次都显示成「未检出」。**变异测试自己也需要阳性对照** —— 先确认那行真的被改了,
否则「未检出」讲的是我的 harness 坏了,不是被测代码没被覆盖。

## 6. 测试耗时

在跑着生产舰队的宿主上约 **230 秒**(约 110 次真实调用 × 每次数个 python 启动)。
已把每 tick 的 python 启动数从 8 降到 4 —— 这不只是为了测试快,
**守卫每 60 秒跑一次,它自己 fork 出来的进程也在给这个泄漏喂料**,少一个是一个。
CI 的 shell 分片上限是 20 分钟,230 秒是安全的。
