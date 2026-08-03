# FLY-1603 全量重启结果通知 founder — 探索

Issue: FLY-1603 (https://linear.app/geoforge3d/issue/FLY-1603/基建-全量重启成功后不通知-founder-她不知道什么时候能-expect-舰队上线)
日期: 2026-08-02
基于: 无

## 1. 问题本质

founder 原话(2026-08-02):「每次全量重启之后,它并不会在重启结束之后告诉我重启结束了。所以我也不知道什么时候结束了,什么时候应该 expect 你们全部上线了。」

审计 `scripts/restart-services.sh`(1621 行)后,现状比 issue 描述略复杂,但结论一致 —— **founder 主频道在整个重启生命周期里收不到任何一条消息**:

| 重启结局 | 现有播报 | 落点 | founder 看得到吗 |
|---|---|---|---|
| ✅ 全部成功 | `notify_routine "✅ 全量重启完成…"` (:1607) | #flywheel-notify(例行频道,`FLYWHEEL_NOTIFY_CHANNEL`) | ❌ 她不看这个频道 |
| ⚠️ degraded(Lead 部分失败/跳过) | `alert_warning`(deploy_degraded)(:1592/:1602),**提前 return,✅ 消息不发** | #flywheel-alerts(`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` = 1518793447165661254) | ❌ 告警频道,她不看 |
| 🚨 失败/回滚 | `alert_severe`(deploy_failed,@-mention founder)(:1431 等 8 处) | #flywheel-alerts | ⚠️ 有 @ 才可能注意到 |
| 主频道 #flywheel-core (1516209714097291335) | **无任何调用** | — | ❌ 全程零信号 |

补充事实(修正 issue 里「成功零通知」的表述):成功侧**有**一条 ✅ 通知,但它进的是 #flywheel-notify,不是她的主频道;degraded 时该 ✅ 消息被提前 return 跳过(措辞纪律是对的,没有把 degraded 说成完成 —— 缺的是「degraded 也得让她知道」)。

其次,即使 ✅ 消息进了主频道,它现在的内容也不够:没有 Lead 上线数 N/M、没有 Bridge 实测响应(昨夜刚证明「端口开了≠可用」,FLY-1600)、没有总耗时。

## 2. 目标(scope,来自 issue)

1. 重启**成功结束** → founder 主频道(#flywheel-core, 1516209714097291335)收到完成通知,至少含:
   - ✅ 完成 + 部署 sha(从 → 到)
   - Lead 上线数 N/M(degraded 时如实写「M 个里 N 个成功、X 个失败」+ **失败名单**,不许只报成功数)
   - Bridge 健康状态 + 实测响应(至少一次实测延迟)
   - 总耗时
2. **失败/degraded 也发她主频道**;告警频道保留原有播报**不动**。
3. 措辞铁律:**不许把 degraded 说成完成**(按行为面写)。

**不做**(issue 明确):不改 deploy_failed 的 @-mention 行为(gate-approved);不动 `lead-alert.sh` 投递机制本身(FLY-1577 刚修好并实证可用)。

## 3. 投递机制方案(核心决策)

### 方案 A:restart-services.sh 内新 `notify_founder()` 直 curl(✅ 推荐)

镜像既有 `notify_routine()`(:223-247)的全部惯例:直接 curl POST Discord API、token 走 `-K -` stdin config 不进 argv(FLY-510)、失败 stderr ERROR + `fire_meta_alert` 留痕、`return 0` 绝不 block 部署(FLY-739)、env 缺失 → loud refusal 不回落(FLY-1081 纪律)。

理由:
- **Bridge/Lead 独立**。重启通知恰好在 Bridge 和 Lead 被重启(甚至挂掉)的窗口发出,任何依赖 Bridge API 或 Lead relay 的路径在失败面上结构性不可用。shell 直 curl 是 FLY-1081 定下的 deploy 通知形态。
- **最小改动**。FLY-1081 已把该脚本的通知整理成三路(routine → #flywheel-notify;degraded/failed → lead-alert.sh → #flywheel-alerts;meta-alert → 桌面)。加第四路「founder outcome → 主频道」是同构扩展,不碰前三路。
- update-flywheel.sh wrap 了 restart-services.sh(update-flywheel.sh:88),launchd 自更新路径自动受益,零额外改动。

### 方案 B:lead-alert.sh 加 `--channel` override(❌ 拒绝)

违反 issue 明确 scope(不动 lead-alert.sh 投递机制);且生产设置了 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`,它在频道解析里优先级最高(lead-alert.sh:316-317),要打洞绕过等于改投递语义。

### 方案 C:经 Bridge API / flywheel-comm 发(❌ 拒绝)

Bridge 在重启窗口内不可用;失败路径(build 失败、健康检查超时、回滚)恰是 Bridge 最不可依赖的时刻。

### 方案 D:Lead(Tadashi)relay(❌ 拒绝)

Lead 同样在重启窗口内被 kickstart,且引入「通知依赖被通知对象健康」的循环。

## 4. 发送身份与 env

- **身份**:`CLAUDE_INFRA_BOT_TOKEN`(claw 基建身份)。它已是 deploy routine 通知(#flywheel-notify)的发送者,deploy 结果通知用同一身份最一致。**前提校验(QA 硬点)**:claw bot 需有 #flywheel-core 的发言权限 —— 实现阶段必须真发一条验证,不许假设。
- **频道 env**:新增 `FLYWHEEL_FOUNDER_DEPLOY_CHANNEL`(生产值 = 1516209714097291335)。不 hardcode 频道 id 进脚本(与 `FLYWHEEL_NOTIFY_CHANNEL` 同构)。
- **缺失行为**:channel 或 token env 任一缺失 → stderr ERROR + meta-alert 留痕 + return 0,**不回落**到任何其他频道/身份(FLY-1081 flipped-fallback 纪律:静默回落正是当年的 bug)。

## 5. 消息内容与三态措辞

一次重启恰好一条 outcome 消息,三态开头,绝不混用:

**✅ 成功**(所有 Lead 重启成功、Bridge 健康):
```
✅ Flywheel 全量重启完成 (reason=deploy)
版本: `abc1234` → `def5678`
Lead: 5/5 全部上线
Bridge: 健康,/health 实测 5 次全通 (中位 12ms / 最大 45ms)
总耗时: 4分32秒
```

**⚠️ degraded**(代码已部署但有 Lead 失败/跳过):
```
⚠️ Flywheel 全量重启结束,但有问题 (degraded, reason=deploy)
版本: `abc1234` → `def5678` (代码已部署)
Lead: 5 个里 3 个成功、2 个失败: flywheel-growth-mufasa-lead, flywheel-product-honey-lemon-lead
Bridge: 健康,/health 实测 5 次全通 (中位 12ms / 最大 45ms)
总耗时: 6分10秒
详情与后续处理见 #flywheel-alerts
```

**🚨 失败**(部署中止/回滚,每个终局分支一条对应消息):
```
🚨 Flywheel 全量重启失败 (reason=deploy)
build 失败,已回滚到 `abc1234` 并恢复旧版本运行 (Lead 已恢复)
总耗时: 8分02秒
详情见 #flywheel-alerts
```

措辞规则:
- degraded 的开头动词是「结束,但有问题」,**永不出现「完成」二字单独成句**;失败名单必须点名(不是只给数字)。
- Bridge 状态基于**实测**(健康检查通过后再做 N 次带耗时的 `/health` 探测);若实测探测失败,消息里如实写「健康检查过但后续实测异常」,不写「健康」。
- 数字全部来自本次运行的真实变量(sha、Lead 计数、耗时),与部署日志一致 —— 这是验收判据之一。

## 6. 需要的数据管道(现状缺口)

| 要素 | 现状 | 缺口 |
|---|---|---|
| sha 从→到 | `DEPLOYED_SHA` / `CURRENT_HEAD` 已有 | 无 |
| Lead N/M + 失败名单 | `do_restart_all_leads` stdout 只有 `skipped:N failed:M`(:1391),无 total、无名单 | 扩展 stdout contract 加 `total:T failed_ids:<csv> skipped_ids:<csv>`(candidate key 形如 `flywheel-flywheel-eng-lead`,无空格/逗号,CSV 安全;skip-test 的 QA slot 不计入 M) |
| Bridge 实测延迟 | 健康检查只判 `.ok`(:1542),不计时 | 新 `measure_bridge_health()`:hc 通过后 5 次 `curl -w '%{time_total}'` 探测,报中位/最大 ms |
| 总耗时 | 无计时锚点 | 脚本 main 入口记 `DEPLOY_T0=$(date +%s)`,通知时计算(覆盖 idle-wait + build + 重启全程) |

`leads-restart-status.json`(`write_leads_restart_status`)消费者只有本脚本与 test-restart-services.sh,可安全**加性**扩展 failed/skipped 名单字段,给后续排障留档。

## 7. 终局调用点(一次重启恰好一条)

不采用「在 alert_warning/alert_severe 里镜像」的做法 —— 那会把过程性告警(plugin-update-failed、per-lead lead-restart-failed 等,一次重启可能多条)也灌进主频道,变成告警风暴搬家。改为在**终局分支**逐一显式调用:

| 终局 | 位置(现行号) | 三态 |
|---|---|---|
| 全成功 | deploy_and_verify 末尾 :1607 旁 | ✅ |
| leads_failed>0 | :1590 分支 | ⚠️ |
| leads_skipped>0 | :1600 分支 | ⚠️ |
| 端口卡死中止 | :1505 分支 | 🚨 |
| build 失败→回滚(4 个子终局) | rollback_and_restart 各分支 | 🚨/⚠️ |
| Bridge 健康超时→回滚 | 同上(复用 rollback_and_restart 内的镜像) | 🚨 |

## 8. 测试与变异判据

沿用 `restart-notify-routine.test.sh` 的 hermetic 模式(awk 抽取真函数 + fake curl/meta-alert):
- `notify_founder()` 单元合同:env 齐 → POST 到 `FLYWHEEL_FOUNDER_DEPLOY_CHANNEL`、token 走 stdin 不进 argv;env 缺 → 零 curl + meta-alert + rc=0。
- **变异判据**(issue 硬要求):终局调用点行为级测试 —— 抽取 `deploy_and_verify` / `rollback_and_restart`,stub 全部协作函数,断言每个终局恰好一次 `notify_founder` 且三态措辞正确;删掉任一调用 → 对应断言必红。
- `do_restart_all_leads` stdout contract 扩展的解析测试(3 个 sed 解析点同文件同步改)。

## 9. 边界(本设计不做)

- 不发「开始重启」到主频道(scope 是完成侧;开始事件她通常自己知道 —— ship 由她批准触发。若后续想要,同一 helper 一行可加)。
- 不动 update-flywheel.sh 自己的 deploy_failed 告警面(它 wrap restart-services.sh,outcome 通知自动覆盖)。
- 不做跨次重启的 storm 聚合/去重(FLY-1501 storm gate 已在上游限频;每次真实重启的结局对 founder 都是有效信息)。
- 不动 #flywheel-alerts / #flywheel-notify 两路现有播报的任何字节。
