# FLY-1648 热循环死账收口 — 执行手册

Issue: FLY-1648 (https://linear.app/geoforge3d/issue/FLY-1648/workflow-引擎批0-热循环收口held-rework-死账手术fly-1150fly-1596-恢复循环加退避与终态)
日期: 2026-08-06
基于: plan.md

## 0. 权限与完成边界

本手册只在 FLY-1648 PR 已合入 `main` 后、FLY-1572 r4 开始前执行。生产
`--apply` 是 operator 级动作，由 Tadashi/Founder 主持；实现 Runner 只交付和验证工具，
不得对 `~/.flywheel/teamlead.db` 运行 `--apply`。

这次操作只处理硬编码 allowlist 中的三条账：

- FLY-1150 held rework
  `rework:389336410732ec77c7b16fc53114f666d943e484d2aabbc8e0024621cb5ae8af`
- FLY-1596 held rework
  `rework:e26a21d89749cb7c2626d64ba74569c03ef31fece9003859f896d94e6fb5ef67`
- FLY-1596 runner-ship gate
  `workflow-gate:821322f6a508d3602064a49131a0030c3ef22abae2cd4b8475512f70eb3b2b4c`

两条冷账 `d90e10f0…` / `1eb8e15…` 不在 allowlist，也不在本窗口范围。脚本不跑
migration、不改 schema、不触网、不重启 Bridge。rework 收口到 `needs_lead`，不替
Lead/Founder 裁决对应 run 的业务终局；gate 只依据库内已持久化的 merge/批准证据完成
run，终态 carrier session 保持原样。

## 1. 合入后构建与只读预检

在干净的生产 checkout 上固定证据目录并验证合入版本。若分支不是 `main`、工作树非空，
或 HEAD 不是已批准的 FLY-1648 merge commit，立即停止。

```bash
FLY1648_REPO="${HOME}/Dev/flywheel"
FLY1648_DB="${HOME}/.flywheel/teamlead.db"
FLY1648_EVIDENCE="${HOME}/.flywheel/evidence/FLY-1648-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$FLY1648_EVIDENCE"
cd "$FLY1648_REPO"
git branch --show-current
git status --porcelain
git rev-parse HEAD | tee "$FLY1648_EVIDENCE/git-head.txt"
pnpm --filter flywheel-teamlead build
```

先跑物理只读 dry-run；它不会设持久 pragma、不会备份、不会写 event。输出中的
`gitHead` 必须与上一步一致；连接必须是 readonly + WAL + `foreignKeys=1` +
`busyTimeoutMs=5000`。三条 `preflight[].status` 可以是 `ready`，也可以是新 Bridge
在 operator 到场前已按本单正规终态自行收口、且脚本验证完 exact evidence 的
`already_applied`。

```bash
node scripts/fly-1648-hot-loop-closeout.mjs \
  --db "$FLY1648_DB" \
  --retire-held-rework rework:389336410732ec77c7b16fc53114f666d943e484d2aabbc8e0024621cb5ae8af \
  --retire-held-rework rework:e26a21d89749cb7c2626d64ba74569c03ef31fece9003859f896d94e6fb5ef67 \
  --complete-gate workflow-gate:821322f6a508d3602064a49131a0030c3ef22abae2cd4b8475512f70eb3b2b4c \
  | tee "$FLY1648_EVIDENCE/dry-run.json"

jq -e --arg head "$(git rev-parse HEAD)" '
  .mode == "dry-run" and
  .gitHead == $head and
  .connection.readonly == true and
  .connection.journalMode == "wal" and
  .connection.foreignKeys == 1 and
  .connection.busyTimeoutMs == 5000 and
  .integrityBaseline.quickCheck == [{"quick_check":"ok"}] and
  (.preflight | length == 3) and
  (.preflight | all(.status == "ready" or .status == "already_applied"))
' "$FLY1648_EVIDENCE/dry-run.json"
```

逐条人工复核 dry-run：两个 rework 的 run/route/node/attempt/execution ID 必须与
allowlist 精确相等，delivery 必须是 `held / persisted_target_missing` 且 target 已
`failed`/缺失；gate 必须是 `approved + bound`、run `active`、terminal carrier 的
question/head 精确匹配、authority/observation/claims 全有效。任何漂移都是 NO-GO，
不得为了让脚本通过而手改数据库。

`already_applied` 不是放宽身份检查：rework 必须同时有 exact route、
`rework_held_recovery_exhausted:<requestId>` event 和 severe alert；gate 必须有 exact
question/head 的 `run_completed` event。任一证据缺失时脚本会 fail-close。这样既允许
新 Bridge 在 operator 到场前合法自愈，也不会把任意状态漂移误认成已手术。

`integrityBaseline.foreignKeyViolations` 是**手术前基线**，必须把完整数组保存在
`dry-run.json`。生产库可能已有与本单无关的历史 FK 债；本单的硬门是手术前后数组逐项
相等（零新增/删除），不是假设基线必为空。不得借本窗口顺手修历史 FK 债。

为取得这份基线，dry-run 会执行 full-database `PRAGMA quick_check` 和
`PRAGMA foreign_key_check`。它们只读、WAL 下不阻塞 Bridge writer，但在大库上可能耗时
数秒并在运行期间保持 read snapshot、延后 checkpoint；operator 应预留该耗时，不能把
安静等待误判成脚本卡死，也不要在已知 WAL 压力尖峰启动。

## 2. Operator 执行

Founder/Tadashi 明确放行后，使用与 dry-run 完全相同的目标集合加 `--apply`。脚本会在
第一刀前重跑全量 preflight，然后以 SQLite online backup 创建
`~/.flywheel/backups/teamlead-pre-fly1648-<ts>.db`；备份成功后才按「每账一个事务」执行。

```bash
node scripts/fly-1648-hot-loop-closeout.mjs \
  --apply \
  --db "$FLY1648_DB" \
  --retire-held-rework rework:389336410732ec77c7b16fc53114f666d943e484d2aabbc8e0024621cb5ae8af \
  --retire-held-rework rework:e26a21d89749cb7c2626d64ba74569c03ef31fece9003859f896d94e6fb5ef67 \
  --complete-gate workflow-gate:821322f6a508d3602064a49131a0030c3ef22abae2cd4b8475512f70eb3b2b4c \
  | tee "$FLY1648_EVIDENCE/apply.json"

jq -e '
  (.backupPath | type == "string" and length > 0) and
  (.results | length == 3) and
  (.results | all(.result == "applied" or .result == "skipped")) and
  (.after | length == 3) and
  (.after | all(.status == "already_applied")) and
  .integrity.quickCheck == [{"quick_check":"ok"}] and
  (.integrity.foreignKeyViolations |
    sort_by([.table, .rowid, .parent, .fkid])) ==
  (.integrityBaseline.foreignKeyViolations |
    sort_by([.table, .rowid, .parent, .fkid])) and
  .integrityUnchanged == true
' "$FLY1648_EVIDENCE/apply.json"

jq -s -e '
  (.[0].integrityBaseline.foreignKeyViolations |
    sort_by([.table, .rowid, .parent, .fkid])) ==
  (.[1].integrityBaseline.foreignKeyViolations |
    sort_by([.table, .rowid, .parent, .fkid]))
' "$FLY1648_EVIDENCE/dry-run.json" "$FLY1648_EVIDENCE/apply.json"

test -f "$(jq -r '.backupPath' "$FLY1648_EVIDENCE/apply.json")"
```

预期结果：

- 两条 rework 的 `deliveryState=needs_lead`，各有一个
  `rework_held_recovery_exhausted:<requestId>` event UID 和一条 severe alert evidence；
  这是预期人工接手通知，不是新事故。
- gate run 为 `completed`，`run_completed` event 存在；carrier 仍为原来的 terminal
  状态，未被伪造回 `completed`。
- `quick_check=ok`，且 apply 前后的 `foreignKeyViolations` 与 dry-run 保存的历史基线
  完全相等；任何新增、消失或改序后的集合差异都 NO-GO。

脚本允许部分成功：每账独立事务，输出逐条 `applied / skipped / failed`。只要任一
`failed` 或 after 不是 `already_applied`，进程非零退出；保留 JSON 和 backup，修复明确
原因后用同一命令重跑。已成功账会 `skipped`，不会重复写 event/alert。不要回滚已合法
收口的账，也不要手动 UPDATE append-only 表。

## 3. 立即验证与幂等回放

用默认 dry-run 再读一次，三条都必须是 `already_applied`；随后可再跑一次 `--apply`
作为幂等控制，三条 `results[].result` 必须全为 `skipped`。第二次 apply 仍会先生成安全
备份，这是设计行为。

```bash
node scripts/fly-1648-hot-loop-closeout.mjs \
  --db "$FLY1648_DB" \
  --retire-held-rework rework:389336410732ec77c7b16fc53114f666d943e484d2aabbc8e0024621cb5ae8af \
  --retire-held-rework rework:e26a21d89749cb7c2626d64ba74569c03ef31fece9003859f896d94e6fb5ef67 \
  --complete-gate workflow-gate:821322f6a508d3602064a49131a0030c3ef22abae2cd4b8475512f70eb3b2b4c \
  | tee "$FLY1648_EVIDENCE/post-dry-run.json"

jq -e '(.preflight | length == 3) and
  (.preflight | all(.status == "already_applied"))' \
  "$FLY1648_EVIDENCE/post-dry-run.json"

jq -s -e '
  (.[0].integrityBaseline.foreignKeyViolations |
    sort_by([.table, .rowid, .parent, .fkid])) ==
  (.[1].integrityBaseline.foreignKeyViolations |
    sort_by([.table, .rowid, .parent, .fkid])) and
  (.[1].integrityBaseline.foreignKeyViolations |
    sort_by([.table, .rowid, .parent, .fkid])) ==
  (.[2].integrityBaseline.foreignKeyViolations |
    sort_by([.table, .rowid, .parent, .fkid]))
' "$FLY1648_EVIDENCE/dry-run.json" \
  "$FLY1648_EVIDENCE/apply.json" \
  "$FLY1648_EVIDENCE/post-dry-run.json"
```

## 4. 30 分钟热循环验收

`/tmp/flywheel-bridge.log` 没有逐行时间戳，因此验收以手术成功后的 inode + byte offset
为窗口锚。apply 成功后立刻记录；若 30 分钟内日志被 truncate/rotate（inode 改变或
size 变小），本证据窗口无效，重新开始 30 分钟观察，不能把空文件当 PASS。

```bash
stat -f '%i %z' /tmp/flywheel-bridge.log \
  | tee "$FLY1648_EVIDENCE/bridge-log-window-start.txt"
sleep 1800
stat -f '%i %z' /tmp/flywheel-bridge.log \
  | tee "$FLY1648_EVIDENCE/bridge-log-window-end.txt"
```

确认首尾 inode 相同且 end size 不小于 start size 后，从 start offset 后提取新增内容：

```bash
FLY1648_LOG_OFFSET="$(awk '{print $2}' "$FLY1648_EVIDENCE/bridge-log-window-start.txt")"
tail -c "+$((FLY1648_LOG_OFFSET + 1))" /tmp/flywheel-bridge.log \
  > "$FLY1648_EVIDENCE/bridge-log-30m.appended.log"

if rg -n 'rework_replacement_target_changed|carrier_session_mismatch' \
  "$FLY1648_EVIDENCE/bridge-log-30m.appended.log"; then
  echo 'NO-GO: FLY-1648 hot-loop signature recurred' >&2
  exit 1
fi
```

同时确认 Bridge health 可达；30 分钟内任一 `/health` 超时也不是 PASS：

```bash
curl -fsS http://127.0.0.1:9876/health \
  | tee "$FLY1648_EVIDENCE/bridge-health-after-30m.json"
```

本项由独立 QA 节点出具结论，不能由实现节点自报。只有以下证据全部成立，才向 Tadashi
报告 FLY-1648 验收通过：三账终态、完整性检查通过、30 分钟两种签名零新增、Bridge
health 正常。

## 5. FLY-1572 r4 硬前置

以上全部通过后，才在 FLY-1572 r4 runbook 的「热循环检查」项打绿，并附上：

- 合入 commit SHA；
- `dry-run.json`、`apply.json`、`post-dry-run.json`；
- online backup 路径；
- `bridge-log-window-start/end.txt` 与 30 分钟 appended log；
- 30 分钟后的 `/health` 响应。

任一证据缺失、日志窗口失效、三账未全部收口或健康检查失败，r4 继续保持 NO-GO。
