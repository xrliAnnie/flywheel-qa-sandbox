# FLY-1285 — QA 复验报告(round 2)

Issue: FLY-1285
日期: 2026-07-15
基于: qa-report.md(round 1 = FAIL)、PR #611 @ **830482f41**

## 结论：**PASS**(代码修复) + **一条 ship 硬前提**(非代码缺陷,但不做会让 fleet 起不来)

Round 1 的两个缺陷都真修好了,且**每条守卫都经突变验证是承重的**。
另外真机复验发现一条**部署顺序硬前提**:生产的 default socket **此刻就是 split_brain**
(93009 + 事故孤儿 3738),而修好后的代码在 split_brain 下 `ensure` 一律 hold ——
**3738 不先收掉,激活重启后没有 Lead 能起来。**

---

## 1. 复验判据(Tadashi 定的两条)

| 判据 | 结果 |
|---|---|
| 真 tmux 守卫 6/6 全绿 | **6/6 PASS** |
| hermetic 套件 FAKE_PS_ROWS 改真 macOS 格式后仍绿 | **24/24 PASS** |

其余套件:lock 2/2、supervisor 5/5、fly241-lead-model-override 26/26 —— 全绿。

真机 E1/E2/E3 全场景(我 round-1 的完整 E2E 脚本):**8/8**
—— E1 饱和→`hold_saturated` socket 不变;E2 孤儿→真 SIGUSR1 同世代复活;E3 split_brain→rc=3 拒动。

## 2. 突变验证 —— 绿测必须能变红(本票的核心教训)

Round 1 的病根就是「28 条绿测在为错误前提背书」。所以这轮每条守卫都**反向验证**:
把它守的行为改回去,测试**必须**变红。全部在 lib 的副本上做,验完 `git diff` 干净。

| 突变 | 真 tmux 守卫 | hermetic |
|---|---|---|
| baseline(未突变 830482f41) | **6 pass / 0 fail** | **24 pass / 0 fail** |
| ① ps 匹配式改回只认 `tmux: server`(=复原 round-1 缺陷) | **3 pass / 3 fail** ✅变红 | **14 pass / 10 fail** ✅变红 |
| ② lsof 归一化改回精确比对 | **5 pass / 1 fail** ✅变红(symlink 用例) | — |
| ③ 让 `saturated` 落到会启动 server 的 create | **5 pass / 1 fail** ✅变红(事故断言) | — |
| 还原后 | **6 pass / 0 fail**,lib 与 830482f41 逐字节一致 | — |

**突变 ① 的意义最大**:hermetic 套件现在也跟着变红了。
Round 1 时同样的缺陷在场,hermetic 却是**全绿**的 —— 说明 fixture 改真格式**不是装饰,是真的补上了探测能力**。

## 3. 修复本身(与我 §5 的方向一致,已逐行看过)

- `_tmux_rescue_server_pids`:改用 argv[0] basename(`tmux|*/tmux`),保留 Linux `tmux: server` 兼容,非 tmux 的 argv0 走原路径不误收。
- `_tmux_rescue_pid_has_socket`:逐条 lsof 报告路径**先归一化再比**;**不可归一的路径 → `return 2`(证据缺失)而非 `1`(确定无 owner)**。
  这一条是关键语义修正 —— round 1 的病就是「比对失败」被读成了「证明没有」。

生产实证(bash 下跑,5 次采样稳定):

```
修前: {"verdict":"reachable",   "reachablePid":93009, "candidatePids":[],     "scanComplete":true}   ← 瞎的
修后: {"verdict":"split_brain", "reachablePid":93009, "candidatePids":[3738], "scanComplete":true}   ← 看见了
```

修好后的代码**认出了此刻真实存在于生产机上的 split-brain**。

## 4. 🔴 Ship 硬前提:激活重启前必须先收掉孤儿 3738

**不是代码缺陷 —— 是 fail-closed 设计的正确行为带来的部署顺序约束。**

用**与生产完全同形**的场景实测(老 server 被孤儿化 + 新 server 持路径 + 目标 session 健康存在):

```
inspect: {"verdict":"split_brain","reachablePid":64012,"candidatePids":[63957],"scanComplete":true}
ensure_tmux_session 等价调用 -> rc=3 {"action":"hold_split_brain",...}
==> 即使目标 flywheel session 存在且健康,ensure 仍 hold
```

原因:`_tmux_socket_ensure_locked` 先 inspect,verdict=split_brain 直接落 `case` → return 3,
**根本不会走到 verify 分支**。所以「session 明明好好的」不影响判定。

**后果**:PR #611 合入 + supervisor 批量重启,若 3738 仍活着 →
每个 Lead 的 `ensure_tmux_session` 都 hold_split_brain → **全 fleet 起不来**
(外加每个 socket 一条 durable tmux_hold + split_brain ticket + 10min 升级告警)。

plan §4 step 6 原文把这件事写成「**建议**在激活批次前由 Tadashi/founder 执行」。
**本次实测把它从「建议」升级为「硬前提」** —— 顺序必须是:

1. 先按 research §4 runbook 收掉 3738(逐个核 argv/lstart → 先 13 个旧 Lead → 再 runner/codex → 最后 3738 本体)
2. 收完确认 `inspect(default)` 返回 `reachable + candidatePids:[]`
3. **再**做激活重启

铁律不变(research §4 + E3 实证):**绝不对 3738 发 SIGUSR1** —— 会反向抢占 default 路径,
把承载 30 个 session 的 93009 打成孤儿 = 事故二次上演。

## 5. 我自己的守卫测试修了一处假阴性(诚实记录)

Round 1 交付的 `tmux-server-rescue-real-tmux.test.sh` 里,「扫描认得真 server」那条断言写的是:

```bash
_tmux_rescue_server_pids | grep -qx "$PID_A"     # 错
```

`grep -q` 命中即退出 → 上游 while 循环收到 SIGPIPE → 叠加文件头的 `set -o pipefail`
→ 整条管线 rc=141 → 报「scan is BLIND」。**实测 rc=141、而扫描输出里 pid 明明在**。

也就是说:**这条断言自己就在冒充事实报假失败** —— 和本票要抓的 bug class 一模一样,出现在我自己的测试里。
已改成先 capture 再 grep(`SCAN_OUT="$(...)"`),并把原因写在注释里防复发。

修前它在 830482f41 上误报 5/6;修后 6/6。**这个假阴性只影响我的测试,不影响产品判定** ——
产品侧的证据(saturated 正确识别 + socket 不被顶替)独立于这条断言。

## 6. 环境卫生

- 全程私有 socket(`/private/tmp/fly1285-*`);**从未触碰 default socket**;**绝未对 3738 发 SIGUSR1**。
- 突变验证只改 lib 副本,收尾 `git diff -- scripts/lib/tmux-server-rescue.sh` **干净**。
- 实验中库自建的 server 已逐个核 argv 后 reap;收尾 census 仅剩
  `1269`(atlas)/ `3738`(事故孤儿,待 runbook 处置)/ `93009`(生产,30 sessions)。
- 生产 Bridge / Lead / runner 未重启、未改配置。

## 7. 交接

代码修复 = **PASS**,可进 ship 批。
但 ship 序列必须写死:**先收 3738 → 验 inspect 回 reachable → 再激活重启**。
否则 fleet 起不来(这条我实测过,不是推断)。
