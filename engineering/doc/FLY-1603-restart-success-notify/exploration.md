# FLY-1603 全量重启结束通知 — 探索

Issue: FLY-1603 (https://linear.app/geoforge3d/issue/FLY-1603/基建-全量重启成功后不通知-founder-她不知道什么时候能-expect-舰队上线)
日期: 2026-08-02
基于: 无

## 1. 问题

Founder 原话(2026-08-02):

> 「每次全量重启之后,它并不会说在重启结束之后告诉我重启结束了。所以我也不知道什么时候结束了,什么时候应该 expect 你们全部上线了,这也是一个问题。」

落点已被 founder 直接纠正(以此为准):

| 结果 | 落点 |
|------|------|
| 成功结束 | **#flywheel-notify**(`1521630422918758472`)— 她确认有在看这个频道 |
| 完全失败 | **#flywheel-alerts**(`1518793447165661254`)— 现状已对,保持不变 |
| 任何情况 | **绝不发 core 主频道**(`1516209714097291335`)— 零新增消息 |

## 2. 审计发现(部分推翻 issue 现状描述)

Issue 写「成功结束时只往日志写一行 Done.,零通知」。**实际代码不是零通知,而是通知只覆盖了一条几乎走不到的分支**:

1. `restart-services.sh` 里已经存在成功侧播报通路 `notify_routine()`(`scripts/restart-services.sh:223`,FLY-929 W3b ② / FLY-1081 加的):经 Claude Infra Bot 直发 `FLYWHEEL_NOTIFY_CHANNEL`。生产 env 三件套(`CLAUDE_INFRA_BOT_TOKEN` / `FLYWHEEL_NOTIFY_CHANNEL=1521630422918758472` / `FLYWHEEL_FOUNDER_USER_ID`)全部已配置——**通路是活的**。
2. 但 `deploy_and_verify()` 尾部的 ✅ 完成通知(`restart-services.sh:1607`)只在 **0 failed + 0 skipped 的全净分支**才执行。degraded 分支(`:1590-1594` leads_failed>0、`:1600-1604` leads_skipped>0)先 `return 0`,✅ 永远发不出。
3. **昨夜实录印证**:08-02 五次 restart 里,3 次「代码部署成功」的 run(03:02 / 03:51 / 04:38)全部以 1-2 个 Lead 重启失败收尾 → 全走 degraded 提前 return → notify 频道零结束通知,只有 alerts 频道的 `deploy_degraded`。另外 2 次(01:31 / 02:04)Bridge health 超时进 rollback(FLY-1600 已另修)。
4. 即使全净分支走到,现有 ✅ 消息内容也不达标:没有 from→to sha、没有 Lead N/M、没有 Bridge 实测延迟、没有总耗时。
5. degraded 的**deploy-level tail summary**(`:1592`)只报数量不报名单;多数 `restart_lead`/candidate 失败路径此前已各自发一条点名的 per-candidate alert,但 unreadable-manifest 分支没有,且 failed+skipped 组合在 tail summary 里会丢 skipped。验收 2 的真实缺口是「每个可命名失败都必须有名字 + deploy-level summary 必须完整」,不是 alerts 频道完全没有名字。

**结论:根因不是「缺一条通知调用」,而是「结束播报没有收口点」——三个结束分支各自为政,只有一个分支带播报,且内容不完整。**

## 3. 方案

### 方案 A(选定):纯 shell,在 `deploy_and_verify` 尾部收口一个「结束播报点」

- 三个「代码已部署」的结束分支(healthy / degraded-failed / degraded-skipped)收敛到同一个结束播报:组装一条完成消息 → `notify_routine` 发 #flywheel-notify → 同时原样写进 restart 日志(验收 1「数字与日志一致」)。
- 消息内容:✅/⚠️ 状态 + sha 从→到 + Lead N/M(degraded 如实写「M 个里 N 个成功、X 个失败: 名单」)+ Bridge 健康 + 一次实测 `/health` 延迟 + 总耗时。
- degraded 时既有 per-candidate `alert_warning` 原样保留;只升级现有单条 deploy-level tail summary 的 body,补上失败/跳过 Lead 名单(不增加 tail alert 数)。
- 完全失败(rollback / abort)路径**不发** notify 结束通知——alerts 的 `alert_severe` + founder @-mention 已覆盖(scope「不做」明确保持)。
- 渲染/计时/探测逻辑放进可 source 的 `scripts/lib/restart-notify.sh`(FLY-1507 的 sourceable-lib 模式),测试直接 source 生产函数,不做 keep-in-sync 拷贝。

理由:重启期间 Bridge 正在被杀/重启,结束时刻的播报者必须活在 Bridge 之外——shell 脚本是唯一贯穿全程的执行体,而且 `notify_routine` 已经是这个形态(fail-loud + meta-alert + token 不进 argv 全都现成)。改动半径最小,回归面最小。

### 方案 B(否决):给 lead-alert.sh 加新 kind(如 deploy_completed)

- lead-alert.sh 的路由目标是 alerts 频道(`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`),成功通知要去的是 notify 频道——得改路由;
- scope「不做」明确「不动 lead-alert.sh 的投递机制本身」(FLY-1577 刚修好并实证可用);
- 成功完成不是 alert,塞进 claims 去重/severity 语义是错位。

### 方案 C(否决):Bridge 侧(TypeScript)发完成通知

- Bridge 在重启窗口内恰恰是被操作对象,自己报自己的重启结束存在结构性盲区(它挂了就没人报);
- 需要新增 Bridge↔脚本状态同步,复杂度远超收益。

## 4. 边界(诚实声明)

- **只加「结束播报」**,不改 🔄 开始通知(已有、内容够)、不改 deploy_failed @-mention、不改 lead-alert.sh 投递机制、不动主频道。
- 完全失败路径 notify 频道保持沉默(她会被 alerts @-mention),这是 scope 决定,不是遗漏。
- Lead 成功数只证明 restart lifecycle 已完成进程级替换(新本体已起、model 一致),不证明 Discord 可达;通知必须按这个证据口径措辞,不写「全部上线」。
- 「实测响应」按 scope 的最低要求做**一次**真实 `/health` 延迟采样(P95 需要持续采样基建,超出本单;scope 原文「建议带 P95 或至少一次实测延迟」)。
- notify POST 失败沿用现有 fail-loud(stderr ERROR + meta-alert),不阻塞 deploy、不重试排队——投递可靠性归 FLY-1577/lead-alert 体系,notify 侧本单不加队列。
