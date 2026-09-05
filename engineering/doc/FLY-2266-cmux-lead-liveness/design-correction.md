# FLY-2266 Lead 面板重连可见性 — 设计修正
Issue: FLY-2266 (https://linear.app/geoforge3d/issue/FLY-2266/cmux-先于全舰重启时v2-lead-面板会全体孤儿且无自愈-昨夜-1115-冻结-12h45m-无人发现潜伏缺口非每日发作)
日期: 2026-09-04
基于: plan.md

## 权威与生效范围

`plan.md` 的 R2 verdict 为 `APPROVED`，保持冻结，不再改写或重开 design gate。Lead Tadashi 通过
`[lead-instruction e14df5ba-4312-4d29-9a1e-838f57c67bbe]` 批准把 R2 的六条 advisory 作为实现期增量约束；
与 `plan.md` 冲突处以本文为准。本文不授权新依赖、新状态文件、新配置开关、新 episode kind 或新告警通道。

## 废除概念

- 废除 literal `K=3`；census 告警门槛改为 `K = $(_attach_retry_limit) + 1`，与
  `recover_attach_surface` 使用同一份合法化后的 retry budget，确保最后一次重连已发生后才由 census 兜底。
- 废除用 `stat -f '%m'` 只包住 FLY-1884 的隔离证明；它既不覆盖最危险的新 suite，也不具备跨平台与内容级强度。
- 废除把 mutation latch 的 `return 0` 改成 `break`；census 前置已完整保证只读对账不被 latch 跳过，该改动是 no-op。
- 废除把 `roster_rearm_absent_subjects` 的 `current` 理解为 missing 集；这里的 `current` 固定为本轮 derived roster
  中全部 `claude-private` Lead subject。

## 保留器官

- 私有 socket 的 `main` client count 仍是唯一健康判据；旧画面内容永远不参与 attached 判断。
- mutation loop 之前的完整只读 census、固定 `lead-attach census` tag、expected/attached/missing 列表全部保留。
- `recover_attach_surface` 的 v2 bare-budget 终局告警保留，作为跨 watcher restart 已落盘 retry state 的即时兜底。
- census-only 的残余静默路径保留同一个 `lead-attach-missing` episode kind 与既有 `cmux_cleanup` channel；恢复和 roster
  缺席均 re-arm，不引入新通道。
- 新 hermetic shell suite、`.github/workflows/ci.yml` 字面枚举、sandbox 内的 `ROSTER_EPISODE_STATE` 与
  `ATTACH_HEAL_STATE` 隔离继续保留。

## R2 advisory 逐项处置

1. `k3-census-preempts-retry-budget`：每轮先 census、后 mutation 的顺序不变；门槛使用
   `K = $(_attach_retry_limit) + 1`。轮间隔受 watcher 的 15/30/60/300 秒退避影响，K 表示连续 pass 数，不表示固定时长。
2. `recover-attach-v2-alert-branch-untested`：RED suite 增加一个独立场景，按既有 state schema 预置
   `kind=v2, attempts=max, phase=retrying` 的 bare surface；在 census streak 尚未到 K 时调用恢复函数，断言该分支产生
   `lead-attach-missing` e1。GREEN 后做一次局部 mutation proof：临时删除测试副本中的 v2 alert block，必须只让该断言转红；
   不改生产文件完成 mutation proof。
3. `k-counter-volatile-across-watcher-restart`：接受进程内计数的限制，不把 streak 持久化。watcher restart 会从零重新计数；
   若 watcher 每次都在 K 轮前重启，surface-ref 缺失、ensure deferred 与 unreceipted early-return 三条 census-only 路径不会告警，
   但每轮 census 日志仍在。bare 路径继续由持久化 `ATTACH_HEAL_STATE` 兜底。
4. `episode-isolation-check-targets-wrong-suite`：实现节点在运行**新 suite**前创建 marker，记录
   `PROD_ROSTER_EPISODE_STATE="$HOME/.flywheel/state/cmux-roster-episodes"`；运行后断言
   `find "$PROD_ROSTER_EPISODE_STATE" -newer "$MARKER" -print` 无输出（生产文件不存在时同样视为未触碰）。该 portable
   check 留在实现验证命令，不把 BSD `stat -f` 写入 Linux CI suite。
5. `rearm-current-set-unspecified`：传给 `roster_rearm_absent_subjects lead-attach-missing` 的 `current` 明确定义为
   本轮 census 的 derived roster 内全部 private Lead title；streak 同样删除所有不在该集合中的旧 subject。
6. `latch-break-edit-is-a-noop`：不改现有 latch return；census 能运行的全部因果来自它位于 mutation loop 之前。

## 修正后的 TDD 证据

- 主事故序列使用动态 K：cmux restart 时 2/2，fleet restart 后保留旧画面但 client=0；A 恢复、B 连续缺席，完成全部
  retry passes 后下一轮 census 才告警并点名 B。
- 独立预置-state 场景证明 v2 bare-budget 终局分支本身可观测，删除该分支会使测试转红。
- roster 删除 B 会同时清其进程内 streak，并经 `roster_rearm_absent_subjects` re-arm episode；B 回归后必须重新走满动态 K。
- client query 失败归 missing，命令赋值显式 `|| count=""`；`kind == v2` 使用完整 `if`，两处都不能触发 `set -e` 退出。
- 新 suite 前后的 portable `find -newer` 证明生产 episode 账本未被触碰；CI enumeration gate 证明新 suite 已被执行面收编。

## Lead 指令原文引用

> [lead-instruction e14df5ba-4312-4d29-9a1e-838f57c67bbe] FLY-2266 design R2 APPROVED；plan is pinned，
> no further design round。六条 advisory 通过本 `design-correction.md` 落地；随后按 TDD、单 package/单线程、PR early、
> exact-head code review 与 review 期间 freeze 的纪律实施。
