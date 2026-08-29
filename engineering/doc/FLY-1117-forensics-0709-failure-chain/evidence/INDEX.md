# FLY-1117 Evidence INDEX (chain-of-custody)

Issue: FLY-1117
维护规则: 每件证据一行；新取证先落 evidence/ + 记入本表 + 更新 SHA256SUMS.txt 再引用。
完整 SHA256 见同目录 `SHA256SUMS.txt`（`cd evidence/ && shasum -a 256 -c SHA256SUMS.txt` 全绿 = 完整性成立）。

**全局字段**（除非行内另注）:
- host: MacBook-Pro.local / macOS 26.3.2 / **Apple Silicon 硬件**（内核 ARM64_T6050；取证 shell 跑在 Rosetta 下，故各 transcript 头的 uname -m 报 x86_64——sysctl.proc_translated=1 实证见 step5 transcript）
- collector: FLY-1117 Runner（design 阶段 = 2026-07-10 00:20–00:33 PDT；implement 阶段 = 2026-07-10 01:19 PDT 起）
- 工具: macOS `log`(1)、`shasum -a 256`、`awk`/`sed`/`grep`（BSD）、`cp -p`
- provenance 等级: `verbatim` = exact command 逐字留存（见 transcripts/ 或本表行内）；`NCR` = not contemporaneously recorded（design 阶段命令未逐字留存，仅有描述性谓词——fail-closed，不补造）

## A. Design 阶段保全件（13 件，collected_at ≈ 2026-07-10 00:20–00:33 PDT，provenance = NCR）

| 文件 | raw/derived | source | 描述性谓词（非 exact command） |
|---|---|---|---|
| bridge-watchdog-log-snapshot.log | raw | ~/.flywheel/bridge-watchdog.log | 全文件快照（16 行 forensic 事件；UTC 时间戳） |
| catchall-142640-142750-raw.log.gz | raw | unified log | log show 无谓词全量 2026-07-09 14:26:40–14:27:50（10,082 行） |
| appdeath-per-second-142640-142750.txt | derived ← catchall-142640-142750-raw.log.gz | 同上 | appDeath 记录逐秒计数 |
| memorystatus-fullday-0709.log.gz | raw | unified log | log show memorystatus/jetsam 类谓词 7/9 全天（~110k 行） |
| launchd-flywheel-2320-2335-0709.log.gz | raw | unified log | log show launchd+flywheel 谓词 23:20–23:35 |
| remote-access-fullday-0709.log | raw | unified log | log show sshd/screensharingd/loginwindow 谓词 7/9 全天 |
| system-health-2026-07-09.log.gz | raw | ~/Library/Logs/system-health/2026-07-09.log | 60s 快照全天（load/进程数/top-RSS/vm_stat） |
| system-health-2026-07-10-partial.log.gz | raw | ~/Library/Logs/system-health/2026-07-10.log | 7/10 凌晨部分 |
| bridge-restart-history-linenos.txt | derived ← /tmp/flywheel-bridge.log | /tmp/flywheel-bridge.log | grep -n "Starting Bridge" 全史（行号在 append-only log 内稳定；implement 阶段 2026-07-10 01:21 PDT 用 sed 抽查 11 行全部对齐，见 session 记录） |
| bridge-boot-142620-segment.log.gz | raw(切片) | /tmp/flywheel-bridge.log | 14:26:20 boot → 14:40:37 段 |
| cmux-watcher-incident-window-0709.log | raw(切片) | ~/.flywheel/logs（cmux-watcher） | 事发窗口段（14:27:12 最后成功挂 hook + 14:27:44 重建） |
| diagreports-system-listing.txt | raw | /Library/Logs/DiagnosticReports | ls 清单快照 |
| diagreports-user-listing.txt | raw | ~/Library/Logs/DiagnosticReports | ls 清单快照 |

## B. Implement 阶段新采件（2026-07-10 01:19–01:25 PDT）——**provenance 按逐文件实际情况标注,见 Appendix D**（rt.sh 生成的 transcript 为 verbatim;.ips/scripts-snapshot 采集命令未同期存 transcript 故标 recon;分析产物标 derived）

> **chain-of-custody 粒度说明（回应 Codex R1–R5）**：完整性锁定逐文件——`SHA256SUMS.txt` 每文件一条 sha256，`shasum -c` 逐文件校验。**逐文件 provenance 见 Appendix D**（每文件一行,按实际标 verbatim/recon/derived/NCR）。**诚实边界**：.ips/.diag 与 scripts-snapshot 是 implement 阶段用 `cp -p` 采集,但采集命令**未同期存 transcript**——故标 `recon`（命令可从 session 复现,但硬证据是逐文件 mtime+SHA256,不声称逐字 verbatim）。B 区表格给可复现命令与源路径作参考。

### B1. 崩溃报告原件快照（`ips/`，27 件）

| 文件（ips/ 下） | raw/derived | source | exact command |
|---|---|---|---|
| OrcaSlicer-2026-07-09-*.ips ×18（issue 原文写 17，实数 18） | raw | ~/Library/Logs/DiagnosticReports/ | **recon**（采集命令未同期存 transcript）：单条 `cp -p <显式名单 + OrcaSlicer-2026-07-09-*.ips glob> <evidence>/ips/`（implement 01:20 PDT；cp -p 保留原 mtime）；硬证据=逐文件原 mtime(崩溃时刻)+SHA256,见 Appendix D |
| BambuStudio-2026-07-09-002600.ips | raw | 同上 | 同上 |
| Google Chrome-2026-07-09-211740.ips | raw | 同上 | 同上 |
| biome-2026-07-09-172924.ips | raw | 同上 | 同上 |
| chrome-headless-shell-2026-07-09-211828.ips + .000.ips | raw | 同上 | 同上 |
| node-2026-07-09-194358.ips | raw | 同上 | 同上 |
| node_2026-07-09-151442_MacBook-Pro.diag / node_2026-07-09-155715_MacBook-Pro.diag / Google Chrome Helper_2026-07-09-022154_MacBook-Pro.diag | raw | /Library/Logs/DiagnosticReports/（system 域，实测本用户可读，未提权） | 采集=for 循环 `cat 可读性测试 && cp -p`（implement 01:20 PDT，**未同期存 transcript → Appendix D 标 recon**）；硬证据=mtime+sha |

### B2. unified log 复导出（易失窗口，transcripts/logexport-*.txt 含 exact command + exit code + 行数）

| 文件 | raw/derived | 窗口 | exact command |
|---|---|---|---|
| catchall-1420-1440-raw-0710reexport.log.gz | raw | 7/9 14:20–14:40 | `log show --start '2026-07-09 14:20:00' --end '2026-07-09 14:40:00' --info`（transcripts/logexport-catchall-1420-1440-raw-0710reexport.txt） |
| catchall-2128-2136-raw.log.gz | raw | 7/9 21:28–21:36:30（第 5 杀 stall 窗） | 同型命令（transcripts/logexport-catchall-2128-2136-raw.txt） |
| catchall-2325-2335-lifecycle-slice.log.gz | **derived** ← 本地 raw | 7/9 23:25–23:35（第 6 杀窗） | raw 全量 18MB gz 过大不入库：本地 0700 目录 `~/FLY-1117-evidence-local/catchall-2325-2335-raw.log.gz`（sha256=4a633170f46601fb70401ff923eb719c4d3022d742ab6dca03fb1e01af4a2a47）；slice = `gunzip -c <raw> \| grep -Ei 'launchd\|memorystatus\|jetsam\|appDeath\|app death\|CHECKIN\|tmux\|kernel:\|exited\|exit code\|spawn\|corpse\|SIGKILL\|signal'`（111,512 行） |

> 注意：复导出发生在事发 ~11–34 小时后，受 unified log 滚动影响（design 阶段实测 launchd 类目保留窗 ~1 小时级）——复导出的负证据弱于 design 阶段近实时导出；两代导出并存互证。

### B3. bridge.log 段抽取（transcripts/bridge-log-segment-extraction.txt 含单趟 awk 命令 + 全部行号范围；行号对齐已抽查）

| 文件 | 行号范围（/tmp/flywheel-bridge.log 绝对行号） | 覆盖 |
|---|---|---|
| bridge-seg-130918-pre.log | 2034638–2034900 | 13:09:18 边界前 150 行 + 13:09 双起 |
| bridge-seg-142620-pre.log | 2063274–2063480 | 14:26:20（第 1 杀）边界前 |
| bridge-seg-144037-pre.log | 2069929–2070200 | 14:40:37/14:41:08 双起边界 |
| bridge-seg-181658-pre.log | 2169283–2169500 | 18:16:58（第 2 杀）边界前 |
| bridge-seg-182324-tail.log | 2170074–2170300 | 18:16:58 段尾 → 18:23:24（第 3 杀） |
| bridge-seg-210341-pre.log | 2252385–2252600 | 21:03:41 边界前 |
| bridge-seg-211245-213524-full.log.gz | 2256195–2264765 | 21:12:45 boot → 21:35:24（第 4 杀全段，含第 5 杀 stall 窗段尾） |
| bridge-seg-232959-pre.log | 2322841–2323060 | 23:29:59（第 6 杀）边界前 |

### B4. 脚本/配置证据快照（`scripts-snapshot/`；provenance 见 transcripts/deployed-vs-repo-scripts.txt、bridge-launchd-plist.txt）

| 文件 | source | 关键事实 |
|---|---|---|
| flywheel-bridge-wrapper.DEPLOYED.sh | ~/.flywheel/bin/flywheel-bridge-wrapper.sh | **launchd 实际执行体**；mtime 2026-07-09 06:06:56（事发前）；sha256 a6b6bd7f… |
| flywheel-bridge-wrapper.sh | ~/Dev/flywheel/scripts/（repo 版） | mtime 7/9 22:42:57（**事发后** FLY-1062 改动）；与部署版 diff 仅 +7 行 packaged-install 分支 |
| flywheel-cmux-autostart | ~/.flywheel/bin/flywheel-cmux-autostart → ~/Dev/flywheel/scripts/flywheel-cmux-autostart.sh | symlink；target mtime 2026-06-16、最后 git 改动 2026-06-01（FLY-177）——事发时版本 = 当前版本 |
| com.flywheel.bridge.plist | ~/Library/LaunchAgents/ | mtime 7/4；**ThrottleInterval=30**、KeepAlive=true、stdout/err=/tmp/flywheel-bridge.log |

### B5. transcripts/（rt.sh 生成的查询 transcript 含 `# command:`+`# exit_code:` 头;**分析产物型**（e3-ips 子 agent 报告、tmux WebFetch 引文、e1-lifecycle 方法说明）无 shell exact-command 头,Appendix D 逐文件如实标 derived/derived-report;Step3/Step7 型为 SCRIPT+OUTPUT、无独立 exit 行——见 Appendix D）

当前：tmux-binary-forensics、deployed-sha-and-prod-checkout、deployed-vs-repo-scripts、watchdog-log-current、bridge-launchd-plist、bridge-log-segment-extraction、logexport-×3。后续 Step 1–7 新增 transcript 直接入该目录并进 SHA256SUMS。

### B6. 分析阶段衍生件（Step 1–7）

| 文件 | raw/derived | derived-from | 说明 |
|---|---|---|---|
| e1-death-join-table.txt | derived | catchall-142640-142750-raw.log.gz + catchall-1420-1440-raw-0710reexport.log.gz | 268 条 appDeath 的 LSASN↔CHECKIN join 全表（时刻/asn/年龄分类/出生时刻/pid）；方法与统计见 transcripts/e1-lifecycle-rebuild.txt |
| transcripts/*（Step 1–7 全部新增） | derived/raw 混合 | 行内自述 | rt.sh 生成的含 `# command:`+`# exit_code:`；分析产物型（e3-ips 子 agent、tmux WebFetch、e1-lifecycle）无 shell exact-command，Step3/7 型无独立 exit 行——**逐文件按 Appendix D 标 verbatim/no-exit/derived/recon**；全部进 SHA256SUMS |

## C. 敏感数据处理记录（Step 0d）

- 目前入库文件未含私钥/token 原文。`.ips` 含二进制路径与线程栈——评估为可入库（无凭据）。
- 23:25–23:35 raw 全量（18MB，含全机进程日志）留本地 `~/FLY-1117-evidence-local/`（0700），库内只入 lifecycle slice + sha256（见 B2）。
- `last`（wtmp）原始输出留本地 `~/FLY-1117-evidence-local/last-raw.txt`（0600，sha256=ce63ae68d8b65e25a347a5e5ca97719a1ddb5f5ac1936bf2079d0b5f0c00a1be，2681 行）；库内（step7 transcript）只含脱敏聚合视图（用户/tty/来源类别计数 + 7/9 条目的 user+tty+date 摘要），无 IP/主机名（实测 60 天记录本就零远程来源）。
- SSH 材料：库内仅 authorized_keys 的 key 指纹（ssh-keygen -lf 输出）与文件 mtime 清单；私钥原文不采集。
- step7 transcript 内含一段无关内容生产进程的 argv 转储（pgrep "booster" 子串误匹配）——已在该 transcript 头部注明，无凭据，保留以维持输出完整性。

## D. 逐文件 chain-of-custody 全表（回应 Codex「每件证据一行」+ fail-closed provenance——全部 84 件受锁文件逐一列出）

provenance 列按**逐文件实际情况**诚实标注(不统一断言):
- `verbatim`=exact command 逐字留存(transcript 头 `# command:`+`# exit_code:` 均在);
- `verbatim(no-exit)`=有 `# command:` 头但无独立 exit 行(如 Step3/Step7 的 SCRIPT+OUTPUT 型);
- `derived`=分析产物,无 shell exact-command 头(WebFetch 引文 / 方法说明型);
- `derived-report`=子 agent 报告(如 e3-ips-classification.md);
- `recon`=implement 阶段采集但**采集命令未同期存 transcript**——命令为事后从 session 可复现的重构;**硬证据 = 逐文件 mtime(原时刻)+ SHA256**,不声称逐字 verbatim;
- `NCR`=design 阶段命令未逐字留存(fail-closed,不补造)。
逐文件 SHA256 见同目录 SHA256SUMS.txt。

| # | 文件 | raw/derived | provenance | source / 命令指针 |
|---|---|---|---|---|
| 1 | appdeath-per-second-142640-142750.txt | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 2 | bridge-boot-142620-segment.log.gz | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 3 | bridge-restart-history-linenos.txt | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 4 | bridge-seg-130918-pre.log | raw 切片 | verbatim | §B3 + transcripts/bridge-log-segment-extraction.txt(awk 命令 + 行号范围 + exit) |
| 5 | bridge-seg-142620-pre.log | raw 切片 | verbatim | §B3 + transcripts/bridge-log-segment-extraction.txt(awk 命令 + 行号范围 + exit) |
| 6 | bridge-seg-144037-pre.log | raw 切片 | verbatim | §B3 + transcripts/bridge-log-segment-extraction.txt(awk 命令 + 行号范围 + exit) |
| 7 | bridge-seg-181658-pre.log | raw 切片 | verbatim | §B3 + transcripts/bridge-log-segment-extraction.txt(awk 命令 + 行号范围 + exit) |
| 8 | bridge-seg-182324-tail.log | raw 切片 | verbatim | §B3 + transcripts/bridge-log-segment-extraction.txt(awk 命令 + 行号范围 + exit) |
| 9 | bridge-seg-210341-pre.log | raw 切片 | verbatim | §B3 + transcripts/bridge-log-segment-extraction.txt(awk 命令 + 行号范围 + exit) |
| 10 | bridge-seg-211245-213524-full.log.gz | raw 切片 | verbatim | §B3 + transcripts/bridge-log-segment-extraction.txt(awk 命令 + 行号范围 + exit) |
| 11 | bridge-seg-232959-pre.log | raw 切片 | verbatim | §B3 + transcripts/bridge-log-segment-extraction.txt(awk 命令 + 行号范围 + exit) |
| 12 | bridge-watchdog-log-snapshot.log | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 13 | catchall-1420-1440-raw-0710reexport.log.gz | raw/derived(见 §B2) | verbatim | §B2 + transcripts/logexport-*.txt(exact log show 命令 + exit code) |
| 14 | catchall-142640-142750-raw.log.gz | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 15 | catchall-2128-2136-raw.log.gz | raw/derived(见 §B2) | verbatim | §B2 + transcripts/logexport-*.txt(exact log show 命令 + exit code) |
| 16 | catchall-2325-2335-lifecycle-slice.log.gz | raw/derived(见 §B2) | verbatim | §B2 + transcripts/logexport-*.txt(exact log show 命令 + exit code) |
| 17 | cmux-watcher-incident-window-0709.log | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 18 | diagreports-system-listing.txt | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 19 | diagreports-user-listing.txt | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 20 | e1-death-join-table.txt | derived | derived | §B6;derived←catchall 两窗口 LSASN↔CHECKIN join;方法见 transcripts/e1-lifecycle-rebuild.txt |
| 21 | ips/BambuStudio-2026-07-09-002600.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 22 | ips/Google Chrome Helper_2026-07-09-022154_MacBook-Pro.diag | raw | recon | /Library/Logs/DiagnosticReports/(system 域,实测可读未提权);采集=for 循环 cat-可读性测试 + cp -p(implement 01:20,未存 transcript);硬证据=mtime+sha |
| 23 | ips/Google Chrome-2026-07-09-211740.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 24 | ips/OrcaSlicer-2026-07-09-113239.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 25 | ips/OrcaSlicer-2026-07-09-204217.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 26 | ips/OrcaSlicer-2026-07-09-204318.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 27 | ips/OrcaSlicer-2026-07-09-211114.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 28 | ips/OrcaSlicer-2026-07-09-211229.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 29 | ips/OrcaSlicer-2026-07-09-211305.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 30 | ips/OrcaSlicer-2026-07-09-211308.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 31 | ips/OrcaSlicer-2026-07-09-220802.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 32 | ips/OrcaSlicer-2026-07-09-221241.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 33 | ips/OrcaSlicer-2026-07-09-221549.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 34 | ips/OrcaSlicer-2026-07-09-222034.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 35 | ips/OrcaSlicer-2026-07-09-222150.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 36 | ips/OrcaSlicer-2026-07-09-222257.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 37 | ips/OrcaSlicer-2026-07-09-222543.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 38 | ips/OrcaSlicer-2026-07-09-222622.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 39 | ips/OrcaSlicer-2026-07-09-222819.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 40 | ips/OrcaSlicer-2026-07-09-222901.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 41 | ips/OrcaSlicer-2026-07-09-223010.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 42 | ips/biome-2026-07-09-172924.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 43 | ips/chrome-headless-shell-2026-07-09-211828.000.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 44 | ips/chrome-headless-shell-2026-07-09-211828.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 45 | ips/node-2026-07-09-194358.ips | raw | recon | ~/Library/Logs/DiagnosticReports/(user 域);采集=单条 cp -p(implement 01:20,未存 transcript;§B1 记可复现命令);硬证据=mtime(原崩溃时刻)+sha |
| 46 | ips/node_2026-07-09-151442_MacBook-Pro.diag | raw | recon | /Library/Logs/DiagnosticReports/(system 域,实测可读未提权);采集=for 循环 cat-可读性测试 + cp -p(implement 01:20,未存 transcript);硬证据=mtime+sha |
| 47 | ips/node_2026-07-09-155715_MacBook-Pro.diag | raw | recon | /Library/Logs/DiagnosticReports/(system 域,实测可读未提权);采集=for 循环 cat-可读性测试 + cp -p(implement 01:20,未存 transcript);硬证据=mtime+sha |
| 48 | launchd-flywheel-2320-2335-0709.log.gz | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 49 | memorystatus-fullday-0709.log.gz | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 50 | remote-access-fullday-0709.log | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 51 | scripts-snapshot/com.flywheel.bridge.plist | raw | recon | 见 §B4;采集=cp -p(未单独存 transcript);对照 stat/hash/diff 见 transcripts/deployed-vs-repo-scripts.txt;硬证据=mtime+sha |
| 52 | scripts-snapshot/flywheel-bridge-wrapper.DEPLOYED.sh | raw | recon | 见 §B4;采集=cp -p(未单独存 transcript);对照 stat/hash/diff 见 transcripts/deployed-vs-repo-scripts.txt;硬证据=mtime+sha |
| 53 | scripts-snapshot/flywheel-bridge-wrapper.sh | raw | recon | 见 §B4;采集=cp -p(未单独存 transcript);对照 stat/hash/diff 见 transcripts/deployed-vs-repo-scripts.txt;硬证据=mtime+sha |
| 54 | scripts-snapshot/flywheel-cmux-autostart | raw | recon | 见 §B4;采集=cp -p(未单独存 transcript);对照 stat/hash/diff 见 transcripts/deployed-vs-repo-scripts.txt;硬证据=mtime+sha |
| 55 | system-health-2026-07-09.log.gz | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 56 | system-health-2026-07-10-partial.log.gz | 见 §A | NCR | design 阶段保全(§A);谓词见 §A 描述列;命令未逐字留存 |
| 57 | transcripts/bridge-launchd-plist.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 58 | transcripts/bridge-log-segment-extraction.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 59 | transcripts/bridge-process-tree-and-watchdog-source.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 60 | transcripts/cmux-autostart-content.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 61 | transcripts/deployed-sha-and-prod-checkout.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 62 | transcripts/deployed-vs-repo-scripts.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 63 | transcripts/e1-lifecycle-rebuild.txt | derived/raw(见文件头) | derived(方法头+输入指针) | 该 transcript 头部(命令/输入/时间见文件头) |
| 64 | transcripts/e3-ips-classification.md | derived/raw(见文件头) | derived-report | 该 transcript 头部(命令/输入/时间见文件头) |
| 65 | transcripts/fly1082-four-state.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 66 | transcripts/incident-version-scripts-audit.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 67 | transcripts/kill5-attribution-branch-confirm.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 68 | transcripts/kill5-attribution-worktree-activity.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 69 | transcripts/kill5-vitest-trigger-hunt.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 70 | transcripts/logexport-catchall-1420-1440-raw-0710reexport.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 71 | transcripts/logexport-catchall-2128-2136-raw.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 72 | transcripts/logexport-catchall-2325-2335-raw.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 73 | transcripts/source-facts-wrapper-watchdog.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 74 | transcripts/step3-suspect-matrix-static-batch1.txt | derived/raw(见文件头) | verbatim(no-exit;SCRIPT+OUTPUT 型) | 该 transcript 头部(命令/输入/时间见文件头) |
| 75 | transcripts/step3-suspect-matrix-static-batch2.txt | derived/raw(见文件头) | verbatim(no-exit;SCRIPT+OUTPUT 型) | 该 transcript 头部(命令/输入/时间见文件头) |
| 76 | transcripts/step5-memorystatus-classification.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 77 | transcripts/step7-attack-surface-core.txt | derived/raw(见文件头) | verbatim(no-exit;SCRIPT+OUTPUT 型) | 该 transcript 头部(命令/输入/时间见文件头) |
| 78 | transcripts/step7-wrapup.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 79 | transcripts/swap-figure-provenance.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 80 | transcripts/tmux-35a-fatal-path-source.txt | derived/raw(见文件头) | derived(WebFetch 引文,头含 url+collected_at) | 该 transcript 头部(命令/输入/时间见文件头) |
| 81 | transcripts/tmux-binary-forensics.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 82 | transcripts/watchdog-log-current.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 83 | transcripts/watchdog-source-bc9c9bfb.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
| 84 | transcripts/watchdog-source-locate.txt | derived/raw(见文件头) | verbatim(# command + # exit_code) | 该 transcript 头部(命令/输入/时间见文件头) |
