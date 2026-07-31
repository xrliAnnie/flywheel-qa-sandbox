# FLY-1556 — v2 引擎故障隔离：单会话失败不再带崩整个引擎

**Issue**: FLY-1556（Urgent）
https://linear.app/geoforge3d/issue/FLY-1556
**Date**: 2026-07-30
**基于**: 2026-07-30 生产事故取证（founder + lead 双侧确认）

## 事故与放大链路

一个 runner 会话恢复时 `activate(sessionRef)` 校验说明书钉子抛
`RunnerLaunchConfigError` → `#syncCurrentRunners` 整体 reject → tick 失败 →
`cli.ts` 的 `onError → Promise.race → host.close()` → **进程退出** → launchd
重拉 → 同错再退 → crash-loop → `host.sock` 消失 → 出站服务陪葬 → 六个在跑
runner 全部失联。同类可致崩脏数据另有三类：已 ship 单的 ready 任务
（worktree 已删）、canceled 任务下的 started attempt、孤儿 `launch_claim`。

## 修法（红线：不加 flag / 守护 / 兜底 — 把局部失败从全局路径上摘下来）

1. **放大摘除**
   - `cli.ts` 删除 tick 错误致死接线；host 侧 `#recordEngineFault` 统一收口
     （stderr + 去重 durable `events` 行 + 观察者钩子），进程永不因 tick 死。
   - `#syncCurrentRunners` 逐会话 try/catch（启动期同样适用；Codex R6 HIGH-1
     收窄为「coordinator arm 不起来才致死」，静默僵尸由 health `degraded` 兜住）。
   - coordinator 四阶段（recovery / dispatch / closure / doorbell）各自为
     失败域，`phaseFailures` 入 tick 结果。
2. **钉子收敛为单一真相源**
   - 磁盘 per-session `runner-state/*.json` 整体删除（issue 验收 3 的
     「另一处不存在」）；DB `attempt_instruction:<attemptId>` 是唯一钉子。
   - `activate()` = probe + 写 release 文件，不再校验任何可变文件。
3. **钉子取自不可变来源**
   - `resolveRoleInstruction` 改从 worktree HEAD 的 **git blob** 读
     （admission 拒脏树 + writer chain 锚定 HEAD ⇒ HEAD blob 即 admission 态），
     证据记 `source_commit` + `source_blob`。
   - launcher 把内容物化为 `stateRoot/instructions/<sha256>.md`（内容寻址、
     engine-owned 0700、原子写 ⇒ 按构造不可变），`--append-system-prompt-file`
     与 bootstrap prompt 均指向它 ⇒ 「任务就是改说明书」的单不再自我毒化。
4. **脏数据枚举健壮化**
   - `recoverableClaims` 坏行 → 命名残留 `recovery_claim_unreadable`；
     closure 候选坏行 → `issue_closure_candidate_unreadable` 事件；doorbell
     settle 逐行隔离。
   - `reapLaunched`：只有仍 running 的任务才 CAS 回 ready — canceled 僵尸
     原来令 CAS 0 行必抛、永远清不掉（验收注入测试抓出的真 bug）。

## 验收

`packages/v2-host/src/__tests__/engine-fault-isolation.test.ts`（四注入 +
改说明书全程真 launcher 流）+ `fly1503-host-gaps.test.ts`（host/socket 存活
半边）。全仓 lint / build 绿；v2 全家 497 测绿。

## Ship 备注

- 生产 `~/.flywheel/v2/runner-state/*.json` 成为无害残留（无人再读）；不随
  本 PR 清理。
- 部署前创建的 in-flight attempt 若需 recovery 重启,其旧形 evidence 与新形
  proposed 不一致 → FenceViolation（已隔离 + 审计可见），操作员取消重派即可。
- runtime-config 形状零变化（`state_root` 继续使用，转为物化目录宿主）。
