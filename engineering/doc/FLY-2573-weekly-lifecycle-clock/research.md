# FLY-2573 weekly lifecycle 时间夹具 — 调研
Issue: FLY-2573 (https://linear.app/geoforge3d/issue/FLY-2573/ci假红-db-maintenance-weekly-lifecycle-测试跨秒就假红假-stat-在读取时才取-date)
日期: 2026-09-14
基于: exploration.md

## 选择
1. 夹具建立时冻结 mtime：最小修复，模拟文件 mtime 不会因为被读取而变化，采用。
2. 全部时间永远固定：能变绿但单独使用会隐藏跨秒缺陷，不采用。
3. 放宽生产未来 mtime 判定：违反边界，不采用。

## 确定性对照
生产仅消费整数秒。用测试专属毫秒时钟文件从 2000000000999 开始，fake date +%s 取整返回 2000000000；在假 BSD stat 探测时将时钟推进 1ms，然后 GNU fallback 的旧 date 返回 2000000001。冻结的 mtime 保持 2000000000。无需真实等待。
fake date 只拦截 +%s，其余格式转发真实 date；PATH 仅在被测子进程生效。断言时钟确实跨秒，保证阳性对照可解释。
单独构建只有 teamlead DB 的 future fixture，mtime=now+1；完整生产入口应完成维护并产生一条 VACUUM 收据，不能 weekly-skip。
