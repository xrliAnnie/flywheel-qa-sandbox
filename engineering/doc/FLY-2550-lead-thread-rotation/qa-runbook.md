# FLY-2550 常驻 Lead 线程轮换 — QA 路书
Issue: FLY-2550 (https://linear.app/geoforge3d/issue/FLY-2550/2355e-常驻-lead-记忆蒸馏真拦点-codex-threadsid-current-thread-id-排除常驻-lead-永不换)
日期: 2026-09-14
基于: plan.md

> 对应 plan §7 的 E1–E8。生产家一律**只读拷贝**;需要写的一切都在 529 房或 scratchpad 拷贝里做。不得运行 `**/tmux-viewer.macos.test.ts`。

## 0. 台架

- 529 房(`scripts/test-deploy.sh <slot> --generalized --no-lead --expect-head <sha>`)+ 一个隔离 `CODEX_HOME`(从任一 keyed 家 rsync,排除 `auth.json`,软链主机凭据,见 FLY-2460 exploration §2.6)。
- 用 `packages/teamlead/scripts/codex-lead.sh <lead-id> <project-dir> <project>` 起 TUI 运行时;`FLYWHEEL_CODEX_LEAD_STATE_DIR` 指向房内 state dir。
- 证据先拷后拆:`thread-rotation.jsonl`、`thread-id`、`thread-id.history`、`state_5.sqlite*`、`memories_1.sqlite*`、`logs_2.sqlite*`、tmux `list-windows -F '#{window_name} #{pane_start_command}'`。

## 0.5 E0 前置:turns/list 延迟(C0)

把 `~/.codex-mufasa` rsync 到 scratchpad(排除 `auth.json`,软链主机凭据),起隔离 daemon,对 `019eaf5d…` 连续两次 `thread/turns/list {limit:1, sortDirection:"desc", itemsView:"notLoaded"}`,记 wallMs 与 `status`;两次均 <10s 才继续。已测 590.55 / 865.26 ms,均 completed;证据见 `codex-review/turns-list-latency.md`。

## 1. E1 轮换发生

1. 起 Lead(全新 state dir ⇒ 首启回执 `reconciled:pristine`;已有 `thread-id` 而无账本 ⇒ `reconciled:ledger_missing`);发 ≥1 条 Discord 消息让它有一轮(`countCompletedSince ≥ 1` 是到期前提)。
2. 停 Lead;把账本 `startedAt` 改成 8 天前(`python3 -c` 读改写,保持 0600);起 Lead。
3. 静置 ≥30 分钟(quiet)且不发消息。
4. 判据:`thread-rotation.jsonl` 依次出现 `rotation_requested` → `rotated` → `rotation_bootstrap` → `rotation_ready`;fence 期间(`rotation_requested.at` 前 ≤70s)`tmux list-windows` 无该 Lead 窗口重建;`thread-id` 变为 `rotated.to`;`thread-id.history` 追加一行;`tmux list-windows` 里该 Lead 的窗口命令行含新 id;新线程 rollout 首个 developer 消息逐字等于 `rotationDeveloperNote`(以 `[系统换页 ·` 开头,不含任何旧对话);**旧线程 rollout 零追加**:在 `rotated.at` 时刻记 `wc -l <old rollout>` 与 `tail -1 <old rollout> | jq -r .timestamp`,24h 后两者不变。
5. 再发一条 Discord 消息:journal `completed`,回复来自新线程(rollout 文件名含新 id)。

## 2. E2 旧线程进候选

`T = rotated.at + 6h` 之后:

```sh
cp -p "$CODEX_HOME"/state_5.sqlite* "$CODEX_HOME"/memories_1.sqlite* "$SCRATCH/"
# 逐谓词(eligible)
sqlite3 "$SCRATCH/state_5.sqlite" "select id, source, archived, memory_mode, preview<>'' as has_preview,
  updated_at_ms<=(strftime('%s','$T')-6*3600)*1000 as idle_ok,
  updated_at_ms>=(strftime('%s','$T')-10*86400)*1000 as age_ok from threads where id='$OLD';"
# Codex 同款候选 SQL(current = 新线程)
sqlite3 "$SCRATCH/state_5.sqlite" "select id from threads where archived=0 and memory_mode='enabled' and id!='$NEW'
  and updated_at_ms >= (strftime('%s','$T')-10*86400)*1000 and updated_at_ms <= (strftime('%s','$T')-6*3600)*1000;"
# 实际 claim(与 eligible 分开记)
sqlite3 "$SCRATCH/memories_1.sqlite" "select job_key,status,retry_at,last_error from jobs where kind='memory_stage1' and job_key='$OLD';"
```
判据:第一条输出 `vscode / 0 / enabled / 1 / 1 / 1`;第二条包含 `$OLD`;第三条如实记录(可为空)。

## 3. E3 真摘要

- 生产:等下一次 `summary_due`(每 6h);529 房:按 FLY-2460 §2.6 在**同一隔离家**起 `codex exec --skip-git-repo-check -c memories.min_rollout_idle_hours=1 -c memories.max_rollouts_per_startup=4 --json "sleep 420 then reply done"`。
- 判据:`sqlite3 memories_1.sqlite "select job_key,status,worker_id from jobs where kind='memory_stage1'"` 有 `$OLD` 行 `done`;`stage1_outputs` 该行 `length(raw_memory)>0 and length(rollout_summary)>0`;`ls memories/rollout_summaries/` 新文件,正文非模板(不含 "No raw memories yet")。

## 4. E4 崩溃/中断按耐久 cut 分段

- 529 房:`tail -f thread-rotation.jsonl` 看到 `rotation_requested` 后随机时刻 `kill` daemon 进程(PID 见 `$CODEX_HOME/app-server-daemon/`)。事后**先判段**:先保留 `$OLD` 快照;`thread-id` 已变 ⇒ (c);仍为 `$OLD` 且 `pending.attemptStartedAt` 有值或 `lastAttemptOutcome=reconciled:pending_attempted` 或对应 reconcile 回执 ⇒ (b);仍为 `$OLD` 且 pending 无 attempt 标记 ⇒ (a)。不能仅凭 pending 已清认定 (a);无法判段须报告原始证据。
- 判据:(a) 最终恰一次 `rotated`、`thread-id.history` 恰一行;(b) 零 `rotated`、`thread-id` 不变、启动回执 `reconciled:pending_attempted`、6h 内无新 `rotation_requested`、state_5 里多出的无 turn 线程 ≤1;(c) 新 id 为真相、`thread/start` 无第二次(state_5 只多一条线程)、`rotated` 行可缺;history 缺失记为 P5 写失败事实,若账本 `readinessPending` 在则后继代写 `rotation_ready`/`rotation_degraded` 恰一次。
- `thread/start` 失败与 `thread-id` 写失败由 vitest(C7)覆盖,真机不重复。

## 5. E5 阴性

通过现有 flag stage/apply 将测试项目的 `codex_lead_thread_rotation` 设为 `0`（附 reason），在下一 generation 重跑 E1 步骤 2–3:无 `rotation_requested`,账本不变;若账本已有 pending,启动后仍在(不消费);预置 readinessPending 也不结清。

## 6. E6 崩溃窗 W3

(a) W3:停 Lead;账本手工写 `pending={requestedAt: now, fromThreadId: <current>, reason: "period", attemptStartedAt: null}`,再把 `thread-id` 改成另一条已存在的线程 id;起 Lead。判据:`reconciled:thread_id_ahead_of_ledger`,无 `rotated`、无 `thread/start`;账本 `currentThreadId` = thread-id 内容、`pending=null`。
(b) W2:账本 pending 带 `attemptStartedAt: now`;起 Lead。判据:`reconciled:pending_attempted`,无 `thread/start`,`lastAttemptAt` = 该值。
(c) `thread-id` 写成 `garbage`(或软链、空文件);起 Lead。判据:启动失败日志含 `[codex-lead-thread-rotation]` 与分类(`unsafe`/`symlink_or_irregular`/`empty`),无新线程,`thread-id` 未被改写(首启失败由 launchd 重拉,不是 supervisor backoff)。
(d) W5:账本 `readinessPending={to:<current>, requestedAt: now−200s, degradedAt: null}`;起 Lead。判据:wire 完成后恰一次 `rotation_ready{late:true}`(pane 活)或 `rotation_degraded`(pane 死),账本相应更新。

## 7. E7 / E8 生产一周

- 上线后每天一次(只读拷贝):`ls ~/.codex-mufasa/memories/rollout_summaries/`;`thread-rotation.jsonl` 尾 20 行;`logs_2.sqlite` `memories/%` 最近 20 行;Codex 额度告警计数。
- 窗口 `[rotated.at + 6h, rotated.at + 7d]`(`W0/W1` 为毫秒 epoch):
```sh
S_journal=$(sqlite3 journal.db "select count(*) from journal where state='completed' and created_at>$W0 and created_at<=$W1")
S_boot=$(python3 - "$W0" "$W1" <<'PYBOOT'
import sys, json, datetime as d
w0, w1 = map(int, sys.argv[1:])
seen = set()
with open('thread-rotation.jsonl') as rows:
    for line in rows:
        row = json.loads(line)
        if row.get('event') == 'rotation_bootstrap' and row.get('outcome') == 'completed':
            at = d.datetime.fromisoformat(row['at'].replace('Z', '+00:00')).timestamp() * 1000
            if w0 < at <= w1:
                seen.add(row['to'])
print(len(seen))
PYBOOT
)
S=$((S_journal + S_boot))
Q=$(sqlite3 logs_2.sqlite "select count(*) from logs where file='memories/write/src/guard.rs' and ts>$W0/1000 and ts<=$W1/1000")
J=$(sqlite3 memories_1.sqlite "select status||'|'||coalesce(last_error,'') from jobs where kind='memory_stage1' and job_key='$OLD'")
O=$(sqlite3 memories_1.sqlite "select rollout_slug from stage1_outputs where thread_id='$OLD' and length(raw_memory)>0 and length(rollout_summary)>0")
```
- 七类结果(先确认有 rotated,再按序判定):`summary_done_for_old`(`J` 以 `done|` 开头 ∧ `O` 非空 ∧ `ls memories/rollout_summaries/ | grep -F "$O"` 命中);`claimed_but_not_done`(`J` 非空但不满足上条;**失败**,附 `J`);`blocked_by_quota_gate`(`J` 空 ∧ `S > 0` ∧ `Q == S`);`eligible_but_unclaimed`(`J` 空 ∧ `Q < S` ∧ E2 谓词全真;**失败,开单**);`not_eligible`(E2 谓词有假 ⇒ 回 E2);`no_rotation`(无 `rotated`);其余无法归类或 `Q > S` ⇒ `measurement_inconsistent`(附 raw counts 上报,不判成功或失败)。
- E8:同一 `logs_2.sqlite`,上线前后各 7 天,比 `guard.rs` 跳过行 / 该窗口 `S`(比率),并列 raw counts;`#flywheel-alerts` 的 Codex 额度类告警逐条列出对照。

readiness 先落账本再发回执,在两者之间崩溃可能缺回执;以账本 cut 如实分类,不可推断整轮重放。
