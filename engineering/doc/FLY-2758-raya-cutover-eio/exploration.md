# FLY-2758 Raya 割接 bootstrap EIO — 探索
Issue: FLY-2758 (https://linear.app/geoforge3d/issue/FLY-2758/raya上线阻塞-09-19-0009-班车割接失败-cutover-failed15-项-preflight-全-pass但)
日期: 2026-09-22
基于: 无

## 现场（2026-09-22 03:05Z 实读，本 runner 只读取证）

| 项 | 实测 |
| --- | --- |
| `launchctl list \| grep raya` | 零结果 |
| `launchctl print gui/501/com.flywheel.lead.raya-raya` | `Could not find service` |
| `launchctl print-disabled gui/501` | `com.xrli.raya.brain => disabled`、`com.xrli.raya.voice => disabled` |
| `~/.flywheel/raya/deploy-receipt.json` | `outcome=failed state=failed failure=cutover-failed carrier=standard-lead deployed_sha=null`，`checked_at=1790045771`（= 2026-09-22T02:56Z，**今晚又失败了一次**） |
| `~/.flywheel/raya/deployed-sha` | `0f77e977`（未变） |
| 迁移账本 `migrations/FLY-2445-standard-lead/manifest.json` | `checkpoint=P4b cursor.status=preexisting lead_restart_installed_at=null activated_at=null unresolved=[]`，`legacy_owner` 两条都已 `disabled_at/stopped_at`（2026-09-19T07:08Z） |
| `ps` 中 Raya 相关进程 | 只剩 `~/.codex-raya` 的 `codex app-server` 守护（不是 Lead 本体）；无 brain / voice / raya-raya supervisor |

结论：**Raya 现在完全停摆**。既无标准 Lead（raya-raya），旧壳 brain/voice 也在 launchd 里是 disabled。

## 时间线（`/tmp/flywheel-updater.log`，本地 PDT）

同一模式重复了三次：

| 班次 | restart 窗口把 raya-raya 拉起 | 班车 P4b `install` | 结果 |
| --- | --- | --- | --- |
| 09-19 00:0x | 08:39 才首次 restart 成功（之前 FLY-2496 修 manifest） | 00:09:08 `Bootstrap failed: 5: Input/output error` | cutover-failed |
| 09-21 00:05 | 00:05:15 supervisor 58901 | 00:07:09 同样 EIO | cutover-failed；12:23 census `lead_unloaded: com.flywheel.lead.raya-raya`；12:23 班车 `FAIL #7 launchd job is not loaded` → `awaiting_standard_lead_pre_restart` |
| 09-21 19:54 | 19:54:24 supervisor 79672 | 19:56:11 同样 EIO | cutover-failed（本 runner 开工前 10 分钟） |

19:56 那一班的完整顺序（日志 1857–1952 行）：

1. restart 窗口 `Lead raya restarted via launchd (supervisor 79672)`。
2. 班车进入 P4b（`cursor.status=preexisting` 臂）：`verify --stage live` 全 PASS，其中 `PASS #7 launchd running pid=79672`。
3. 按 FLY-2657 设计执行「受控 install 重启到本轮 artifact」：`flywheel-lead.sh install --project raya --lead raya`。
4. `install` 再跑一遍 preflight（全 PASS），然后 `_sup_darwin_install` 执行 `launchctl bootout gui/501/<label>` **紧接着** `launchctl bootstrap gui/501 <plist>` → `Bootstrap failed: 5: Input/output error`。
5. `raya_fail cutover-failed`：写 failed 回执、发 severe 告警、释放锁。**没有任何恢复动作**。此时 bootout 已经把 raya-raya 卸掉，brain/voice 又是 disabled → 谁都不在。

## 三个问题的答案

### 1. bootstrap 为什么 EIO

不是 plist 路径/权限（同一 plist 在 restart 窗口 2 分钟前刚 bootstrap 成功），不是 print-disabled（raya-raya 不在 disabled 表里），不是 socket/state 残留（preflight `#8 Codex inbox socket` PASS）。

是 **label 半占用**：`scripts/lib/supervisor.sh:_sup_darwin_install` 的最后两行是

```bash
launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$plist" || { _sup_err "bootstrap failed: $label"; return 1; }
```

`bootout` 对一个正在运行、且会处理 SIGTERM 的 KeepAlive 服务是异步返回的（Codex TUI Lead 收到 SIGTERM 后要杀 TUI 窗口、停 daemon，日志里有 `SIGTERM → stopping` / `tui-window: killed`）。在 launchd 还没把 label 从 domain 里摘干净之前立刻 `bootstrap` 同一个 label，launchd 返回 EIO(5)。

对照证据（同一天同一台机）：`restart-services.sh` 的 Lead 换代路径是 `bootout` → `lead_restart_wait_quiescent`（轮询 `launchctl print` 报 unloaded **且**旧 pid 已死，30×1s）→ `bootstrap`（失败再重试一次），00:05:11 bootout、00:05:15 bootstrap 成功。同一 label、同一 plist，差别只在「等没等 label 消失」。

本 runner 想用一次性 label 在 gui domain 里实测复现，被 FLY-913 部署护栏按命令文本硬拦（`launchctl bootstrap` + 路径含 flywheel），不绕护栏；实测复现留给 QA/founder 路径（见 plan 的 QA 建议）。

### 2. brain / voice 为何割接前就 absent

账本 `legacy_owner`：brain `loaded:false, pid:null`，voice `loaded:true, pid:null`，两者在 2026-09-19T07:08Z（PDT 00:08）被 P2 quiesce 一次写齐 `stop_started/disabled/stopped` 并发了 `absent before quiesce` 警告。

也就是说 **旧壳在 09-19 割接之前就已经死了**，不是被某轮 bootout 停掉没起回来：

* brain 的 `~/.flywheel/raya/data/logs/brain.stderr.log` 最后一行是 09-04 18:30 的 `ENOSPC: no space left on device`，stdout 自 08-26 起为空；
* voice 的 stdout 最后写于 09-17 10:23，且 launchd 里 loaded 但没有 pid。

所以「Raya 停了多久」：brain（对话主体）自 **09-04** 起就没有正常在跑；`deployed-sha=0f77e977` 的 285h 漂移只是壳没换，实际对话能力断得更早。P2 把它们 disable 是迁移设计（FLY-2445：旧壳退役后不许 RunAtLoad 复活），这一步本身是对的。

### 3. 失败后回滚有没有把旧壳拉回来

没有，也没有任何代码尝试这么做。回执里的 `rollback_sha: 0f77e977` 只是 `deployed-sha` 文件的当前值，`raya_fail` 只写回执 + 告警 + 释放锁。
现状 = 标准 Lead 被 install 的 bootout 卸掉、旧壳 disabled → **谁都不在**，直到下一次 restart 窗口（每天 00:00 / 12:00 PDT 及 urgent 重启）再把 raya-raya 拉起来 2 分钟，然后班车再把它杀掉。

## 需要修的两个断点

1. **`_sup_darwin_install` 的 bootout→bootstrap 竞争**（根因）：bootout 后必须等 label 真正离开 domain（且旧 pid 退出）再 bootstrap，bootstrap 失败要有界重试。这是通用 supervisor 修复，所有走 `flywheel-lead.sh install` 的 Lead 都受益。
2. **P4b install 失败后的恢复路径**：install 失败后如果标准 Lead 已不 live，必须立刻把它拉回来（同一 plist 重新 bootstrap，并按既有 30×2s 节拍等 live），回执写 `rolled_back`、告警正文说明「已恢复/未恢复」；恢复失败时告警必须明确写出 **Raya 离线**，不能静默。旧壳 brain/voice 不复活（已在 P2 按授权退役，且早已自死）。

## 不在本单范围

* restart 窗口与班车在同一次 updater 周期里对 raya-raya 做两次换代（19:54 restart、19:56 install）——浪费但不致错；修掉 EIO 后第二次换代会成功。可另开单合并为一次。
* 生产恢复动作（重新 install、推进 P4b→P7、拿到 `deployed_sha` 非 null 的回执）由合并后的班车或 founder 授权的一次 install 完成；本节点不碰生产 launchd。
