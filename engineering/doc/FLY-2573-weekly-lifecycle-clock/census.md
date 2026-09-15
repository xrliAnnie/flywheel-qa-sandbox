# FLY-2573 时间夹具普查 — 调研
Issue: FLY-2573 (https://linear.app/geoforge3d/issue/FLY-2573/ci假红-db-maintenance-weekly-lifecycle-测试跨秒就假红假-stat-在读取时才取-date)
日期: 2026-09-14
基于: research.md

## 只读普查（2026-09-15 UTC）
范围：scripts/__tests__ 与 packages 内测试文件；rg 搜索假 stat 文件生成、stat 函数、mtime 格式、date +%s，然后读取命中实现。

| 文件与行 | 形状 | 同形缺陷 |
| --- | --- | --- |
| scripts/__tests__/db-maintenance.test.sh:119（基线104） | GNU mtime 原来在读取时运行 date；三个 DB 共用此夹具 | 是，仅此一处，已冻结 |
| scripts/__tests__/test-runner-workspace-trust.sh:103 | GNU mtime 常量1，陈旧锁 | 否 |
| scripts/__tests__/fly2264-verify-native-cutover.test.sh:84 | GNU mtime 常量1，heartbeat age | 否 |
| scripts/__tests__/artifact-freshness-check.test.sh:23,269,328 | NOW 与 STAT_MTIME 都是预设值 | 否 |
| scripts/__tests__/test-lead-memory-sync.test.sh:91,355 | mode常量600，不生成mtime | 否 |
| scripts/__tests__/host-terminal-cutover.test.sh:18 | owner/mode格式转换，其余转发真实stat | 否 |
| scripts/__tests__/restart-services-admission-pause.test.sh:35 | owner/mode格式转换，其余转发真实stat | 否 |
| scripts/__tests__/fly1577-cmux-bin-closure.test.sh:775 | device/inode故障注入，其余真实stat | 否 |
| scripts/__tests__/fly1663-launchd-foundation.test.sh:38 | uid/mode常量 | 否 |
| scripts/__tests__/fly2264-install-window-artifacts.test.sh:151 | mode故障注入，其余真实stat | 否 |
| scripts/__tests__/tmux-server-rescue.test.sh:806 | uid/mode解析，其余真实stat | 否 |
| scripts/__tests__/flywheel-log-rotate.test.sh:102 | 真实mtime与inode身份，非读取时造时间 | 否 |
| scripts/__tests__/meeting-notes-tick.test.sh:111 | 静态断言GNU优先，无时间生成 | 否 |

其它 date +%s 命中是记录发送/开始/结束时刻或建立夹具时写入，不是 stat 读取时生成mtime。未发现需一起修复的第二处同形夹具。三个 canonical DB lane 已共用修复，确定性跨秒阳性对照精确触发第一个 lane；三个 lane 均断言 skip。

## 本机第二处红
FLY-2519 原始 /tmp/fly2519-db-maintenance-local.log：7 passed / 4 failed，VACUUM rc1、receipts0、markers0。该日志没有内部 failure.detail，单凭摘要不能断言 contention。
本工作树以默认 TMPDIR 重现相同 7/4 签名；独立临时 WAL DB 运行的 failure.json 明确为 maintenance_database_path_not_canonical。源码 scripts/lib/fly-2006-retention-engine.mjs:1992 比较 HOME 派生路径与真实 databasePath；macOS /var 或 /tmp 的别名与 /private 路径不等。规范 TMPDIR=/private/tmp 后相同基线11/11通过，未改变生产检查。
判据：必须检查 failure.json 的 reason/detail。maintenance_database_path_not_canonical 是路径前提失败；SQLITE_BUSY/locked 或 checkpoint-busy 才支持竞争判断；rc1本身不区分二者。本次没有证据支持 contention。历史运行未保存detail时，无法追认其唯一原因，只能给出当前可复现的同签名环境原因。

## 重复验证的解释
20次零失败证明该固定夹具在20次完整执行中一致，不能推出失效率低于5%等统计保证。因果证据是同一虚拟跨秒条件下修前receipts4、修后receipts3，不依赖自然抖动概率。
