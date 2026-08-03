# FLY-1603 全量重启结果通知 — 设计更正(founder 直接纠正)

Issue: FLY-1603 (https://linear.app/geoforge3d/issue/FLY-1603/基建-全量重启成功后不通知-founder-她不知道什么时候能-expect-舰队上线)
日期: 2026-08-02
基于: plan.md(Codex 4 轮 APPROVED 版)+ Tadashi lead-instruction 6b7e9942(转述 founder 原话)

## founder 原话(2026-08-02,经 Tadashi 转述)

> 「flywheel-notify 你为什么说我不看这个频道?我有看这个频道啊!」
> 「你这里做错了,不要发到 flywheel Core 主频道…千万不要发到 Flywheel Core 主频道」
> 「1. 成功会发到 Flywheel Notification 频道 2. 完全失败会发到 Flywheel alerts 频道 — 基本上是对的。那就这样吧」

上游事实更正:原 issue 的「落点应该是她的主频道」是 Lead 从抱怨推断的,founder 从未要求;她**看** #flywheel-notify。

## 废除的概念

| 废除项 | 原 plan 位置 | 说明 |
|---|---|---|
| 「成功/失败通知都发 founder 主频道 1516209714097291335」 | §0/§2.1(b)(c)(f)/§3 | 主频道**零新增消息**,且升级为显式验收项 |
| `notify_founder()` 直发 helper | §2.1(b) | 无主频道路 → 无此 helper |
| 新 env `FLYWHEEL_FOUNDER_DEPLOY_CHANNEL` | §2.2 | 不需要 |
| claw bot 对 #flywheel-core 的发言权限预检 | §3 checklist 1 | 不需要 |
| notify_founder 专属 defense-in-depth/替换 literal 合同 | §2.1(b) R3#1 部分 | 随 helper 一起废除;SAFE_RESTART_REASON 与预算纪律**保留**并改护现有两路的新增文案 |

## 保留的器官(founder 无异议,全部保留)

- **通知内容设计**:sha 从→到、Lead 上线数 N/M、degraded 如实点名失败的那几个、Bridge 实测延迟(5 次 `/health` 验 `.ok` 真值,不只看端口)、总耗时。
- **措辞纪律**:不许把 degraded 说成「完成」;rollback 未验证不许说「已恢复」;malformed 探测不编造 N/5。
- **数据管道**:`DEPLOY_T0` 计时、`measure_bridge_health()`、`do_restart_all_leads` stdout contract 扩展 + 严格 fail-closed parser、运行记录留档(runId/attempted/active sha/完整名单)。
- **exactly-one 终局纪律 + EXIT finalizer**(异常中止不许无声消失)—— 落点改为现有告警路。
- **2000 字符确定性预算**(护新增的富化文案)。

## 更正后的落点

| 结局 | 落点 | 机制 |
|---|---|---|
| ✅ 成功 | #flywheel-notify `1521630422918758472` | 既有 `notify_routine`(:1607)**消息内容升级**(补 sha 从→到、Lead T/T、Bridge 实测、总耗时);机制不动。生产 `FLYWHEEL_NOTIFY_CHANNEL` 实值已核 = `1521630422918758472`,路由现状已对 |
| ⚠️ degraded / 🚨 失败 | #flywheel-alerts `1518793447165661254` | 既有 `alert_warning`/`alert_severe` → lead-alert.sh 路径**机制不动**;degraded 告警 body 升级为点名失败/跳过名单(来自扩展后的 stdout contract) |
| 异常中止(finalizer) | #flywheel-alerts(同上) | EXIT finalizer 改调既有 `alert_severe`(deploy_failed,天然带 @-mention,与既有失败告警行为一致) |
| founder 主频道 `1516209714097291335` | **零新增消息** | 显式验收项:全终局场景断言无任何 POST 指向该频道 |

## 对已过评审的影响

Codex 4 轮 APPROVED 的工程核(exactly-one/严格 parser/实测真值/措辞诚实/预算闭合/CI 显式接线)不受更正影响,全部保留;被废除的仅是「主频道投递层」及其专属前提(权限预检、新 env、helper 合同)。plan.md 已同步改写落点;两文档冲突时以本更正为准。
