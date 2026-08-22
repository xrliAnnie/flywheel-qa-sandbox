# FLY-1955 Codex Lead 81 秒崩溃循环 — 探索

Issue: FLY-1955 (https://linear.app/geoforge3d/issue/FLY-1955/infra活跃-两个-codex-lead-持续崩溃循环-235-小时精确每-81-秒已跨越两次全舰重启未自愈-remote-control)
日期: 2026-08-21
基于: 无

## 1. 问题陈述

`flywheel-codex-infra-bot-lead` 与 `growth-mufasa-lead` 两个 Codex 载体 Lead 自 2026-08-20 14:29:59 起精确每 81 秒崩溃重启一次,≥23.5 小时无间断,**跨越两次全舰重启(8-20 22:41、8-21 12:06)未自愈**。每轮失败日志一致:

```
Error: app server did not become ready on <home>/app-server-control/app-server-control.sock
Caused by:
    0: failed to connect to <home>/app-server-control/app-server-control.sock
    1: No such file or directory (os error 2)
[codex-lead-tui-home] ERROR: remote-control start failed
```

同时 issue 报了一条独立隐患(FLY-513 放大器):全局 `~/.local/bin/codex` 指向 infra-bot Lead 的私有 home。

## 2. 审计发现(现场证据,2026-08-21 14:0x PDT 实测)

### 2.1 崩溃链条(代码路径)

```
launchd (KeepAlive=true, ThrottleInterval=30)
  → ~/.flywheel/bin/flywheel-codex-lead-wrapper-{codex-infra-bot,mufasa-tui-fullaccess}.sh
    → packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js
      → packages/teamlead/scripts/codex-lead-tui-home.sh ensure-daemon
        → codex remote-control stop --json   (忽略失败)
        → codex remote-control start --json  ← ★ 这里失败
      → runtime fatal → 进程退出 → launchd 重拉 → 循环
```

`ensure_daemon` 是 `codex-lead-tui-home.sh:405-425`(FLY-259 PR-B 引入,FLY-398 加 full-access stop-before-start)。81 秒 = `remote-control start` 内部等 control socket 就绪的超时(~51s)+ 启动开销 + launchd ThrottleInterval 取整。

> **术语**:`codex remote-control start` 是 Codex CLI 自己的命令——它负责把 app-server daemon(Codex 的常驻服务进程)拉起来,然后连接 daemon 暴露的控制 socket(`app-server-control.sock`,一个 unix domain socket 文件)确认就绪。

### 2.2 两个 home 的镜像死状态

| 证据 | infra-bot (`~/.codex-infra-bot`) | mufasa (`~/.codex-mufasa`) |
|---|---|---|
| daemon pid 文件 | `{"pid":30942,"processStartTime":"Thu Aug 20 14:15:00 2026"}` | `{"pid":23609,"processStartTime":"Thu Aug 20 14:14:39 2026"}` |
| 该 pid 实际状态 | **`<defunct>` zombie**,父=4269 | **`<defunct>` zombie**,父=69840 |
| 父进程(还活着) | pid 4269 `codex app-server daemon pid-update-loop`,PPID=1,8-20 07:09 起 | pid 69840 同款,PPID=1,8-20 14:09 起 |
| control socket | **不存在**(目录里只剩 startup.lock) | 同 |
| pid 文件 mtime | **冻结在 Aug 20 14:15**(此后 800+ 轮循环从未更新) | 冻结在 Aug 20 14:14 |
| `app-server.stderr.log` | 0 字节 | 0 字节 |
| standalone 版本 | `current → 0.149.0`(**release 目录 mtime = Aug 20 14:14**,前一版 0.148.0 装于 8-18) | 同,0.149.0 |

### 2.3 时间线(精确到分)

```
8-20 07:09   infra-bot 的 updater(pid-update-loop, pid 4269)启动
8-20 13:45   0.149.0 二进制下载落盘(bin/ mtime)
8-20 14:09   mufasa 侧运维动作:settings.json 备份 + remoteControlEnabled=true;updater(69840)启动
8-20 14:14   0.149.0 release 安装完成;mufasa daemon 23609 spawn → 立即死 → zombie
8-20 14:15   infra daemon 30942 spawn → 立即死 → zombie
8-20 14:29:59  两个 Lead 进入 81 秒崩溃循环(≈ 前一个 Lead 会话失效后的首次重启)
8-20 22:41   全舰重启 → 循环不变
8-21 12:06   全舰重启 → 循环不变
8-21 13:35   两个 home 的 current symlink 又被 updater 重写(0.149.0 同版,updater 仍活跃)
8-21 14:02   Aunt Cass 止血:全局 ~/.local/bin/codex 换轴到中立拷贝 ~/.local/opt/codex-stable/codex
```

**升版(14:14)与 daemon 死亡(14:14:39 / 14:15:00)与循环开始(14:29:59)三点时序吻合** ⇒ 触发事件 = codex standalone updater 自动升级 0.148.0 → 0.149.0 时的 daemon 换代。

### 2.4 对照组(排除全机 / 排除版本本身)

- 其余 14 个 Lead 稳定;机器空闲(load 正常);Bridge health OK ⇒ 非全机问题。
- **同一台机、同一个 0.149.0 binary**,以显式 `codex app-server --remote-control --listen unix://<path>` 方式跑的 app-server(runner review gate、QA slot)全部健康存活 ⇒ 0.149.0 的 app-server 本身能跑;坏的只是「daemon 模式 + 默认 control socket」这条管理路径。

## 3. 根因假设空间

| # | 假设 | 判定 | 依据 |
|---|---|---|---|
| H1 | **stale pid 文件指着 zombie,`remote-control start` 判其存活故拒绝 spawn,直连不存在的 socket → ENOENT** | ✅ **实验 100% 复现**(见 research.md 四格实验) | zombie 可 `kill -0`、lstart 与 pid 文件 processStartTime 逐字匹配;pid 文件 mtime 冻结 + stderr 0 字节 = start 从未走到 spawn |
| H2 | 0.149.0 daemon 普遍性起不来 | ❌ 排除 | 隔离干净 home 实测:0.149.0 daemon 正常 spawn、socket 正常创建 |
| H3 | Codex.app malware 事件所致 | ❌ 排除(issue 已证) | 循环开始早于该事件 1h38m |
| H4 | 全舰/资源问题 | ❌ 排除 | 14 个 Lead 对照稳定 |
| H0 | (一次性诱因)14:14-14:15 换代时新 daemon 为何启动即死 | ⚠️ **未定,open question** | 无 stderr、统一日志已滚过、无 crash report;嫌疑=升级换代竞态(新旧 daemon 抢 startup lock)。**不阻塞修复**:修复针对的是持续性死锁机制,对任意 daemon 死因都有效 |

## 4. 为什么两次全舰重启救不了(结构性解释)

全舰重启管理的是 launchd 服务(Bridge / Lead)。而:

1. **updater(pid-update-loop)PPID=1、不属于任何 launchd label**,不在重启清单里 → 两次重启都没碰它;
2. updater 不 `wait()` 死掉的 daemon 子进程 → **zombie 永存**;
3. zombie 在进程表中占着 pid,`kill -0` 成功、进程 start time 可读且与 pid 文件匹配 → codex 的存活判定**结构性无法识别 zombie**;
4. 每轮 Lead 重启 → ensure-daemon → start 判「daemon 在跑」→ 不 spawn → 连 socket → ENOENT → fatal。

⇒ 重启 Lead 多少次都一样。唯一出路是让 zombie 消失(reap)或让存活判定失效。

## 5. FLY-513 放大器现状(临时止血,余下永久隔离)

- 8-21 14:02(21:02Z)Aunt Cass 把 `~/.local/bin/codex` 换轴到中立拷贝 `~/.local/opt/codex-stable/codex`(0.149.0 单文件拷贝),并验稳 3 个循环周期;15:22 又发现实验 updater 踩回 scratchpad,Tadashi 再次恢复。故这是临时止血,不是永久完成。
- Aunt Cass 勘误(21:08Z):「symlink 每 81 秒被翻写」不成立——翻写是偶发(updater flip 时),设计不按持续高频建模。
- 剩余工作:①所有 managed updater 显式设置 home-scoped `CODEX_INSTALL_DIR`,从源头禁止自动 installer 写真实全局轴;②布局固化(单文件拷贝 → `~/.local/share/flywheel-codex/<ver>/bin/codex` 版本化布局);③漂移告警。完整追溯见 research.md §8。

## 6. 关联单

- **FLY-1892**(codex-infra-bot 双向断路):Lead 指令「修复时一并验证,过则并单」。注意其入站断自 8-13 起,**早于**本循环(8-20)一周 ⇒ 同根性存疑,只承诺验证、不预设并单。
- **FLY-513**:全局 codex 中立化的原始告警来源(warning 文案在 `codex-lead-tui-home.sh:293-311`)。
- 8-21 早上 09:29-11:11 另有两段 **30 秒周期**的循环(进程立刻退出、自行停止)——失败时机不同,**不是同一个毛病**,本单不覆盖。

## 7. 设计方向(进入 research 的问题清单)

1. 止血 runbook:杀 updater → zombie 被 init reap → 下一轮 KeepAlive 自愈(对照组实验已证 pid 彻底死后 start 能正常 spawn)。
2. 结构修复:`ensure_daemon` 加 stale-daemon 证据驱动回收(zombie 检测 + 身份栅栏 + fail-loud),使**未来任何 daemon 死因**都不会演成不可自愈死锁。
3. updater 自动升级要不要禁(0.149 事故根源是无预告升级;今天 13:35 它还在活跃)→ research 查可行性。
4. 崩溃循环静默烧 23.5h 的告警缺口 → 最小 episode 告警或 follow-up,research 里定。
5. FLY-513 布局固化 + 防再踩。
