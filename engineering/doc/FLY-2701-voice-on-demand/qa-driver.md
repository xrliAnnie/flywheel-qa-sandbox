# FLY-2701 语音按需启动 — QA 驱动手册
Issue: FLY-2701 (https://linear.app/geoforge3d/issue/FLY-2701/语音按需启动-语音进程平时不常驻开耳机模式-会议到点时才由系统启动空闲后自行退出founder-2026-09-17)
日期: 2026-09-21
基于: plan.md

本文件给 QA 节点用：每一项都写明「跑什么命令、看什么证据、什么算不通过」。
⛔ 估算不算证据；所有时间必须是实测。真机项必须记录 build SHA、host、service label、bootId、sessionId、scheduleId+revision。

## 0. 本轮交付范围（决定哪些验收项可跑）

本 PR 交付的是设计的**前两半**：按需生命周期（上一半，已在分支上）+ 会议排程预热 / 耳机模式唤醒 / 失败预算（本半）。

**未交付、QA 不要按已完成对待**：

| 计划章节 | 内容 | 状态 |
|---|---|---|
| §8 slice F | 班车 drain fence（update-flywheel.sh / restart-services.sh / voice-deploy-drain.sh） | **未实现**，独立后继 |
| §6 | wrapper 侧提交 actualBootId / spawnObservedAt 给 Bridge | **未实现**，失败预算目前只用 Bridge 自有证据（见 §4） |
| §2 | FLY-2655（DAVE 解密）合入后的联调 | 2655 尚未合入 main |

对应地，§10 的第 7 项（班车/drain 真机验证）本轮**不可验**。

## 1. 平时不常驻（阴性对照）

```sh
launchctl print "gui/$(id -u)/com.flywheel.voice" | sed -n '1,12p'
pgrep -fl 'packages/voice-codex/dist/cli.js' || echo "no voice process"
```

通过：`state = not running`、无 `pid =` 行、无 voice 进程、无子 Codex。
连续观察 ≥2 轮巡检（≥10 分钟）仍未被拉起。安装、重启 Bridge、idle 部署三种情况各做一次。
不通过：出现任何未经需求触发的 voice 进程。

## 2. 耳机模式冷启动（≥3 次，实测）

每次开始前先证明无 PID（§1）。然后：

```sh
node packages/flywheel-comm/dist/index.js voice-session start \
  --mode rg --project flywheel --lead <lead> --json
```

记录（全部来自 `~/.flywheel/voice/sessions/<id>/events.jsonl` 与 `voice_sessions`）：

| 指标 | 取法 |
|---|---|
| request→`session_starting` | CLI 发出时刻 → 事件 `session_starting` |
| 进程冷启动 C_i | wrapper 进程起 → 日志 `Starting standalone voice daemon` |
| request→roomReady / frontendReady | 分段事件，两条支路分别记 |
| request→`session_live` | 事件 `session_live` |
| request→首次真实双向语音 | 人工确认能说能听，记时刻 |

对照基线：常驻模式 52.046s（会话 5142f2ab）。逐次写出 `52.046 + C_i` 的对比。
⛔ 不许用估算填进房 / Codex / realtime 任一段。

## 3. 会议预热（提前量）

提前 ≥120s 下单，下单后**关掉调用方进程**：

```sh
node packages/flywheel-comm/dist/index.js voice-session start \
  --mode meeting --project flywheel --lead <和谁开会的那个 Lead> \
  --evidence-dir <meeting state dir> \
  --scheduled-at 2026-09-2XTHH:MM:00Z \
  --request-id "$(uuidgen | tr 'A-Z' 'a-z')" --json
```

观察点：

1. T−120s 附近 Bridge 自行触发（无调用方在场），`voice-schedules` 状态 `scheduled → prewarming`。
2. T 之前：bot **已在房内**，`GET /api/voice/schedules/<id>` 为 `ready`，而 `voice_sessions.state` 仍是 `warming`。
3. **T 之前在房里说话**：不得出现任何 transcript、不得送 Lead、bot 不得出声。查 `events.jsonl` 无 `realtime_transcript`。
4. T 到点且本人在房：可以说能听；`voice_sessions.state = live`，`voice_schedules.state = live`。
5. 本人缺席：到 `presence_deadline_at`（T+10min）才结束，reason `no_human`，**不得**在此之前判定。
6. 晚下单（距 T < 120s）：收据 `lateAdmission: true`，**不算准时通过**。

改期 / 取消（在 provision / claim / ready 三个边界各做一次）：

```sh
node packages/flywheel-comm/dist/index.js voice-session reschedule \
  --schedule-id <id> --expected-revision <n> --scheduled-at <ISO> --request-id <uuid>
node packages/flywheel-comm/dist/index.js voice-session cancel-schedule \
  --schedule-id <id> --expected-revision <n> --request-id <uuid>
```

通过：旧 revision 的会话不出声；同房冲突不抢占正在通话的人；取消响应带 `activeCleanup: true` 直到旧会话终态。

## 4. 空闲退出与竞态（founder 2026-09-22 口径）

「空闲」= 房里没人。founder 在房里**永不退出**；她退房后才进入空闲计时。

1. 拉起后她不来：等 10 分钟（`presenceGraceMs`）才 `no_human`。
2. 她在房里待 >10 分钟：会话必须仍然 live。
3. 她退房 → 会话 `ended/she-left` → daemon 连续 120s 成功空读 → `exit 0`，`launchctl print` 回到未运行。
4. 竞态阴性对照：在退出临界点（最后一次空读之后）注入新 desired，证明**不丢**——保留两个 boot 的日志与同一个 desired→claim 的证据链。中途重启 Bridge 再做一次。
5. 短命实例退出后 0/1/3/10/29 秒各再请求一次，记录 kickstart 受理时刻与真正 wrapper 入口时刻，证明 `ThrottleInterval=1` 的实际等待已计入 ≤5s 目标。⛔ 不能用假 launchctl 证明无 30s 尾延迟。

## 5. 失败与告警

| 注入 | 期望 |
|---|---|
| kickstart 明确失败 | FLY-2693 工程频道真实回执 + 固定页；同一 episode 不刷屏 |
| 单元缺失 / disabled | configuration unavailable；**不得**偷偷安装或 enable |
| 进程起来但从不 claim | 3 次「已受理但无 claim」后预算耗尽，会话 `failed/startup_retry_exhausted`，停止唤醒并告警 |
| 起来后进房失败 | 现有失败路径告警 |
| 无需求休眠 | 阴性：不告警 |

本轮的失败预算只用 Bridge 自有证据（命令结果 + 是否在 60s 内被 claim）。unknown 命令结果与被合并（coalesced）的请求**不消耗**预算——QA 可用重复快速触发验证这一点。

进程锁冲突：当 `launchctl print` 显示本机确有运行中的 voice job 时记 `benign_owner_conflict` 并 exit 0、保留 desired 补扫；证明不弹 founder。无法证明持锁者时仍走原来的响亮拒绝。

## 6. 回归命令（合入前已跑，QA 可复跑）

```sh
pnpm lint
pnpm --filter "flywheel-teamlead..." build
pnpm --filter "flywheel-voice-codex..." build
pnpm --filter "...flywheel-comm" typecheck
pnpm --filter flywheel-voice-codex test:run
pnpm --filter flywheel-comm test:run
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/StateStore.voice-schedule.test.ts \
  src/__tests__/StateStore.voice-launch-budget.test.ts \
  src/__tests__/StateStore.voice-session-schema.test.ts \
  src/__tests__/StateStore.voice-health-demand.test.ts \
  src/__tests__/fly-2413-retention-migration.test.ts \
  src/bridge/__tests__/voice-schedule-routes.test.ts \
  src/bridge/__tests__/voice-schedule-runtime.test.ts \
  src/bridge/__tests__/voice-session-routes.test.ts \
  src/bridge/__tests__/voice-session-runtime.test.ts \
  src/bridge/__tests__/voice-session-services.test.ts \
  src/bridge/__tests__/voice-launchd-waker.test.ts
bash scripts/__tests__/flywheel-voice-wrapper.test.sh
bash scripts/__tests__/restart-voice-on-demand.test.sh
bash scripts/__tests__/qa-fly1501-brake-missing-alert.test.sh
bash scripts/__tests__/launchd-units-manifest.test.sh
bash scripts/__tests__/launchd-census.test.sh
bash scripts/__tests__/supervisor.test.sh
bash scripts/__tests__/converge-nonlead-daemons.test.sh
bash scripts/__tests__/restart-storm-gate.test.sh
node --test scripts/__tests__/install-voice-launchd.test.mjs
```

## 7. 验收口径

工程侧全部通过后，报告只能写「工程已测、待 founder 亲测」。
按 PRD FLY-2642 v2 §2.3 语音五格的 ⑤，**founder 亲测一场之后**才算产品验收通过。

## 8. 变异验证（合入前已做，计划 §9 要求）

| 变异 | 被杀的测试 |
|---|---|
| 去掉调度补扫的唤醒 | `voice-schedule-runtime.test.ts` — rescans a Bridge restart backlog |
| 去掉 live 的 schedule revision 核对 | `StateStore.voice-schedule.test.ts` — refuses live when the schedule moved |
| 去掉提前进房的音频门 | `session.test.ts` — holds every byte of media |
| 唤醒改用 `kickstart -k` | `voice-launchd-waker.test.ts` — bounded non-destructive kickstart |

四个变异各自让对应测试转红，恢复后全绿。
