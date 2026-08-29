# FLY-1117 对既有记录的更正注记 — 更正注记块（可嫁接）

Issue: FLY-1117 (URL 不可得,只写 issue 号)
日期: 2026-07-10
基于: research.md、forensics-report.md(同文件夹)

> 背景:FLY-1082 的两份文档存在与本次取证结论相悖的记述。经 Tadashi 裁决(2026-07-10,ask 3da5ae7d 答复):**不改写 FLY-1082 原文**,由本单提供带日期的更正注记块;因 FLY-1082 文档不在本分支上(其 PR #538 在本单 implement 期间才 merge 进 main),注记块以本文件形式随本分支交付,原文保留作历史记录。后续任何人可把下面两个注记块原样贴到对应文档的对应小节尾部。

---

## 注记块 1 — 贴至 `engineering/doc/FLY-1082-fleet-alerts-arc-repair/exploration.md` §1(事故描述行之后)

> **更正(2026-07-10,FLY-1117 取证)**:本节「swap 打满(16384MB 用 14815MB)→ Bridge StateStore `sql.js corruption unrecoverable … out of memory — exiting` → tmux server 整个消失」中的 FATAL 归因有误。经查该 FATAL 字符串在 bridge.log(6/28 起全量)**仅出现一次**,紧跟六月底 `16:08:23 Starting Bridge` 的 boot,属六月底旧事故,与 2026-07-09 14:27 无关。7/9 14:26:20 的 Bridge 死因是其自带 event-loop 看门狗自杀(SIGKILL 自身,forensic 行 + wrapper 同秒重启双证)。另,「16384MB 用 14815MB」的 swap 数字无一手测量记录(无时间戳、无命令、无测量者),应视为二手转述。证据:`engineering/doc/FLY-1117-forensics-0709-failure-chain/evidence/bridge-watchdog-log-snapshot.log`、`evidence/bridge-restart-history-linenos.txt`、`evidence/transcripts/swap-figure-provenance.txt`;完整论证见同仓 `engineering/doc/FLY-1117-forensics-0709-failure-chain/forensics-report.md` §E2/§更正。

## 注记块 2 — 贴至 `engineering/doc/FLY-1082-fleet-alerts-arc-repair/incident-bridge-2329-analysis.md`(结论节之后)

> **更正(2026-07-10,FLY-1117 取证)**:本报告两处需精化。① 「生产 Bridge(pid 48951)被回收」——48951 是 23:29:59 重启后的**现任 launchd 顶层进程**(实为 `npm exec tsx`,真正的 Bridge node 是其子进程);当晚 stall 的是 21:35:24 出生的前任(launchd 记录 pid 73504,`ran for 6875094ms` 倒推出生时刻闭环)。**精确进程树**:wrapper 末行 `exec npx tsx …` 使 launchd 跟踪的顶层是 npm 进程,真正被 watchdog `SIGKILL` 的是它的 Bridge node 子进程;npm 父进程把子进程 signal-9 死亡折算为 exit(137) 上报 launchd——存在一层退出码传播,但 137 仍唯一对应 Bridge 本体被 SIGKILL。② 「37 秒够不上 60s 看门狗阈值,所以是内核 OOM」——推测有误:看门狗的 stall 计时从主循环最后一次心跳起算,不从 vitest 启动起算。实际链条 = 23:28:37 全量 vitest 启动 → ~23:28:56 主循环停跳 → 23:29:59 看门狗记 stall 63.1s 后 SIGKILL 自身(watchdog forensic 行与 launchd `exited due to exit(137)` 同秒双证);该窗口 memorystatus 导出内**无任何内核 jetsam kill 记录**(当晚全部 jetsam kill 都是 Apple 遥测 daemon 的 per-process-limit/idle-exit,与本机 fleet 进程无关)。本报告「全量 vitest 是触发」的自认**成立且被独立证实**——同一行为模式当天共出现三次(14:2x FLY-1062 打包管线、21:30 FLY-1018 runner、23:28 本 QA)。证据:`evidence/bridge-watchdog-log-snapshot.log`、`evidence/launchd-flywheel-2320-2335-0709.log.gz`、`evidence/transcripts/step5-memorystatus-classification.txt`、`evidence/transcripts/kill5-vitest-trigger-hunt.txt`。
