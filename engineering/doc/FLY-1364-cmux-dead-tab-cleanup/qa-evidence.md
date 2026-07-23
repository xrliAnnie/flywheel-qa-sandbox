# FLY-1364 cmux sync 整体修复 — 真机验收证据
Issue: FLY-1364 (https://linear.app/geoforge3d/issue/FLY-1364/修复cmux-总修-cmux-sync-整体修好-单写锁-fail-safe-反向根因-死条目不清-重派窗口不补条目-attach-不自愈)
日期: 2026-07-22
基于: plan.md

## 隔离真机 watcher

命令:`/bin/bash scripts/__tests__/fly1364-live-e2e.test.sh`

- 真实 cmux:`cmux 0.61.0 (73) [8caa5e9c9]`,socket `/tmp/cmux.sock`。
- 私有状态目录、私有 watcher lease、私有 tmux server;global ghost/dedup/stock/orphan/close-request hygiene 在 harness 中禁用,只允许本次 exact title/ref 的生命周期操作。
- malformed residual ledger lock 在已验证 sole-writer lease 下重建,同周期连续两次写入成功。
- 双 watcher contender:恰一名 owner,另一名 clean dedup exit。
- A0B1 新 runner tab:5 秒内生成 workspace、current-generation exact-ref receipt、独立 exact-one-window view 和真实 attach client。
- 杀 attach 后先跨过 bootstrap,清空全部 client;R12 fresh run 第 51 秒由 60 秒 additive reconcile 恢复真实 attach client。
- 删除 spawning runner session 后等待 20 秒,workspace 与独立 view 仍存在;寿命绑定 watched pane,不绑定 spawn 分组。
- watched pane 进入真实 `pane_dead=1` 后,第 27 秒由 watcher 的 delayed exact-ref path 自动关闭 workspace 并删除 receipt。
- 最终结果:`7 passed, 0 failed`。

## Discord 拒清告警实发实收

命令:`/bin/bash scripts/__tests__/fly1364-discord-e2e.test.sh`

- 发送路径:`_alert_cmux_cleanup` → shared shell alert adapter → `scripts/lead-alert.sh` → Discord HTTP 200。
- 隔离频道:`test-flywheel-alerts` (`1519421055805165842`)。
- QA marker:`fly1364-refusal-1784762638-38156`。
- Discord message id:`1529630115615604806`。
- Discord timestamp:`2026-07-22T23:23:58.716000+00:00`。
- Author id:`1493068669444427927`。
- 3 秒内从 recent-message API 找到 marker;随后按 message id 独立 GET,返回同一 marker/id。
- GET 正文逐字包含 QA 标题`[QA FLY-1364] cmux stock cleanup refused`、source kind `cmux_cleanup`、source title `cmux stock cleanup refused`及 production signature `cmux_cleanup|stock-adoption|generation=fly1364-discord-generation|ref=multiple|normalized=FLY-1364-qa-fly1364-refusal-1784762638-38156|evidence_sha256=c6d8ee97d64cd51536229e152af2ce025e032b2c636d58fc2146954454c4159c|reason=ambiguous-normalized-title`。
- 生产 `alert-queue`、`alert-deadletter`、`alerts/claims.db` 的文件名/mtime/size 快照前后一致。
