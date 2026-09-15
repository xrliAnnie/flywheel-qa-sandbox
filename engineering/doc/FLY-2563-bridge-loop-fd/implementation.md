# FLY-2563 Bridge 响应与连接寿命 — 实施记录
Issue: FLY-2563 (https://linear.app/geoforge3d/issue/FLY-2563/bridge-ship-judgment-modetick-每-3s-同步跑)
日期: 2026-09-14
基于: plan.md

## 当前状态

Implement TURN epoch=2，activation attempt=1。工作开始时分支只有已批准设计，工作树干净。
实时 check `8b68f7f7-65a6-44b4-b6aa-319babf09006` 确认 R2 effective APPROVED。
本记录不是完成回执。T1–T7 尚未全部实施，不宣称事件循环事故已修复。

## T3 第一批：fleet 同步连接所有权

- 提取 `insertLeadInstruction`、`readZombieCandidates`；每次打开的连接均在同步 finally 关闭，之后才进入 zombie 异步 liveness probe。
- 通知仍创建尚不存在的库，保留发送者、目标和 dedupe identity；缺失 zombie 库返回空，已存在损坏库继续报错。
- 真实临时 CommDB 测试覆盖100轮通知及两个项目读取、真实 numeric fd 回到基线、重复 receipt、写入冲突、list 抛错、挂起 probe 前释放。
- RED：首次缺模块失败；另将两处 close 临时移除，3/4 tests 因未释放失败，随后恢复修复。未使用 GC。
- GREEN：fleet tests 4/4；与 gate-poller-health、lifecycle-routes 合跑 29/29；teamlead typecheck exit=0。
- 环境：`pnpm install --frozen-lockfile` 成功；修改前 `pnpm -r build` exit=0。安装时缺 dist 的 bin 警告经基线构建解决，未当作行为失败。
- 剩余：104处 ownership 清单全审计、legacy与默认backend lifetime夹具、跨网络 lease 审计。已发现 founder-reply-deliverer 在读取线程后持有 lease 跨 processFounderMessage/reaction await，下一批需验证有界性与authority再验证。

## 验收矩阵

| 项目 | 当前证据 |
|---|---|
| A 真实备份取消 <50ms | pending |
| B 15分钟 health/lag | pending 独立部署后 QA |
| C 增量水位、终态只消费一次 | pending |
| D 大夹具与 exact-head CI | pending |
| E 2小时 numeric comm.db fd | pending 独立部署后 QA；局部临时库回归不替代 |
| F 实际 Bridge fd.limit≥8192 | pending |
| 告警、SQL计时、归档预算/重启 | pending |
| Code review、PR、needs_review completion | pending |
