# FLY-1285 — QA 复验报告(round 3,R5 HIGH 后)

Issue: FLY-1285
日期: 2026-07-15
基于: qa-report.md(R1 FAIL)、qa-report-round2.md(R2 PASS)、PR #611 @ **2a8124f29**

## 结论:**PASS**

R5 HIGH 修得对:**真机证明缺陷真实存在,且修复没有重新打开 round-1 的洞。**
ship 硬前提(先收 3738)与 round 2 一致,**未变**。

## 1. 两条验收判据

| 判据 | 结果 |
|---|---|
| ① unsandboxed 真 tmux 跑 real-tmux 守卫 | **6/6 PASS** |
| ② focused mutation:unresolved-path=>rc2 改回去 → hermetic 回归测试变红 | **变红 PASS**(24/24 → 23/1,恰好该条 fail) |

其余:hermetic 24/24、lock 2/2、supervisor 5/5、fly241 26/26、我的完整 E1/E2/E3 **8/8**。CI:FLY-1062 pass,Build & Test pending(非我阻塞)。

## 2. R5 HIGH 是什么 + 为什么这次要特别小心

R5 的修法是**删掉**「任何不可归一化的 lsof 路径 → rc=2(证据缺失)」。

**这正是我 round-1 报告 §3 主张的语义**(「比对失败」不等于「确定无 owner」)。
所以我没有只跑 Tadashi 给的两条判据 —— 必须回答:**治好毒化,是不是把事故的洞又打开了?**

## 3. 真机对抗测试(判据之外,我自己加的)

场景:一个**无关**的孤儿 tmux server,其 socket 所在目录被删 → lsof 报的路径无法归一化。

**A. R5 HIGH 真实存在吗?(fix 是否承重)**
用 pre-R5 语义的 lib 副本跑真 tmux:

```
无关孤儿 pid=94183(socket 目录已删);健康目标 server pid=94223
PRE-R5 inspect(健康目标): {"verdict":"unknown", "reachablePid":94223,
                            "candidatePids":[], "scanComplete":false}
```
⇒ **一个毫不相干的孤儿把一个健康目标毒化成 unknown → 永久 hold。** R5 HIGH 属实,fix 承重。

**B. 🔴 关键:治好毒化有没有重新打开事故洞?**
同时存在「不可归一化的无关孤儿」+「饱和的活 server」:

```
inspect: {"verdict":"saturated", "candidatePids":[80174], "scanComplete":true}
ensure : rc=2 {"action":"hold_saturated"}
inode  : 237495874 -> 237495874(未变)
```
⇒ **saturated 仍被正确识别、事故仍被挡住、socket 未被顶替。洞没重开。**

**C. 无关路径会不会遮蔽目标的真 owner?**
・真 owner 仍被正向识别(rc=0)
・孤儿被正确判为「非目标 owner」(rc=1,不是假 rc=0 也不是毒化 rc=2)

**为什么 skip 是安全的(机制,非猜测)**:`tmux_socket_inspect` 会先归一化 target;归一化成功 ⇒ target 的父目录可解析。
一条**归一化失败**的 lsof 路径,其父目录不可解析 ⇒ 与 target 不可能是同一个文件。
故「跳过它」不会漏掉 target 的 owner —— 这条已由 C 的两个正/反断言实测,不是推理。

对抗测试 **5/5 通过**。

## 4. ship 硬前提(与 round 2 相同,未变)

生产 default socket 在本 head 下仍稳定报(bash 下 5 次采样):

```
{"verdict":"split_brain","reachablePid":93009,"candidatePids":[3738],"scanComplete":true}
```

⇒ **先收 3738 → bash 验 inspect 回 reachable + 空候选 → 再激活重启**。
否则每个 Lead 的 ensure 都 hold_split_brain,全 fleet 起不来(round 2 已用生产同形场景实测)。
铁律:**绝不对 3738 发 SIGUSR1**。

## 5. 实现方还修了我测试的一个真问题

`start_server` 之前在 `-z` 判空**之前**没把 pid 计入 `SPAWNED`,极端情况下会漏 reap。
实现方在本 head 修了(`SPAWNED="$SPAWNED $PID_A"` 提前)。合理,我确认采纳。

## 6. 环境卫生

全程私有 socket;**从未触碰 default socket**;**绝未对 3738 发 SIGUSR1**。
突变/pre-R5 副本只改 lib 拷贝,收尾 `git diff -- scripts/lib/` **干净**。
所有实验 server(含库自建的)已 reap;收尾 census 仅剩 1269(atlas)/ 3738(事故孤儿,待 runbook)/ 93009(生产,26 sessions)。
生产 Bridge / Lead / runner 未重启、未改配置。
