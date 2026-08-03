# FLY-1603 全量重启结果通知 founder — 调研

Issue: FLY-1603 (https://linear.app/geoforge3d/issue/FLY-1603/基建-全量重启成功后不通知-founder-她不知道什么时候能-expect-舰队上线)
日期: 2026-08-02
基于: exploration.md

## 1. 现行通知拓扑(已核代码 + 生产运行时 env)

### 1.1 restart-services.sh 的三路通知(FLY-1081 定型)

| 函数 | 行号 | 机制 | 落点(生产实值) |
|---|---|---|---|
| `notify_routine(msg)` | :223-247 | 直 curl,`CLAUDE_INFRA_BOT_TOKEN` + `FLYWHEEL_NOTIFY_CHANNEL`;env 缺 → stderr ERROR + meta-alert,不回落;POST 失败同样留痕;恒 return 0 | #flywheel-notify |
| `alert_warning(slug,title,body)` | :195-200 | `lead-alert.sh --lead deploy --kind deploy_degraded --severity warning`,`1>&2 \|\| true` | #flywheel-alerts(见 1.2) |
| `alert_severe(slug,title,body)` | :202-214 | 同上但 `deploy_failed --severity severe` + `FLYWHEEL_FOUNDER_USER_ID` 存在时 `--mention-user` | #flywheel-alerts |
| `fire_meta_alert(...)` | :176-180 | Discord 独立桌面留痕,per-reason 10min debounce | 桌面 + state 文件 |

**stdout 纪律**(:188-194 注释,历史 Codex R2 HIGH):这些 helper 会被 command-substitution 敏感路径调用(`bp_fail_loud` 在 `$(bp_confirm_port_released …)` 链内),**绝不写 stdout**;lead-alert.sh 调用重定向 `1>&2`;不许 `>/dev/null 2>&1` 吞 ERROR。新 helper 必须继承同一纪律。

### 1.2 lead-alert.sh 频道解析(为什么 deploy 告警全进 #flywheel-alerts)

生产 `~/.flywheel/.env` 设置了 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=1518793447165661254`;lead-alert.sh:316-317 里 unified channel **优先级最高**,直接短路 projects.json 解析。所以 `--lead deploy`(projects.json 无此 lead,系统身份)也能投递,且必然落告警频道。这就是昨夜三次 deploy_degraded 全进 1518793447165661254 的机制。⇒ 想借 lead-alert.sh 投主频道必须打洞绕 unified 优先级 = 改投递语义,坐实 exploration §3 方案 B 的否决。

### 1.3 频道版图(生产 projects.json + .env 实核)

| 频道 | id | 用途 |
|---|---|---|
| #flywheel-core | 1516209714097291335 | **founder 主频道** = flywheel-eng-lead(Tadashi)的 chatChannel/alertChannel;Annie 日常在此 |
| #flywheel-alerts | 1518793447165661254 | unified alert channel(`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`);也是 claude-infra-bot-lead 的 alertChannel |
| #flywheel-notify | `FLYWHEEL_NOTIFY_CHANNEL`(.env:114) | routine 例行通知(✅/🔄/⏳) |

**待实测项**:claw bot(`CLAUDE_INFRA_BOT_TOKEN`)对 #flywheel-core 的发言权限。它当前只被证实能发 #flywheel-notify / 自己的 chat 频道;对 #flywheel-core 的 SEND_MESSAGES 权限**不能假设**,实现阶段第一步就要真发一条验证(失败则在 Discord 服务端给 claw bot 补权限,属部署 checklist,非代码)。

## 2. 关键数据源核查

### 2.1 sha 与 reason

`DEPLOYED_SHA`(deployed-sha 文件)与 `CURRENT_HEAD` 在 main 序列早段就绪(:640 前);`RESTART_REASON` 由 `--reason` 解析(:480/:497),已被 `notify_routine` 的开始/完成消息引用。直接可用。

### 2.2 Lead 计数与名单 — `do_restart_all_leads`(:1298-1392)

- stdout contract:**仅** `skipped:N failed:M` 一行(:1391);stderr 承载全部日志。
- 解析点 3 处,同文件:`rollback_and_restart` :1471(只取 failed)、`deploy_and_verify` :1565-1566(sed `s/.*skipped:\([0-9]*\).*/`)。
- 循环内变量:`key`(形如 `flywheel-flywheel-eng-lead`,`${project}-${lead_id}`,lead-restart-lifecycle.sh:408;无空格/逗号/冒号 → CSV 安全)、`lid`、`classification`。
- `candidate_count` 已统计(:1356),但含 `skip-test`(QA slot,刻意不参与部署健康,:1358-1360)。**M(总数)应 = candidate_count − skip-test 数**,否则 QA slot 会让「5/7」这种数字撒谎。
- 失败路径有两类计入 failed:`restart` 类实际重启失败(:1362-1369)与 `probe-error|config-drift`(:1377-1382);`manifestless` 计入 skipped(:1371-1376)。三个早退分支(convergence 失败 :1318、mktemp 失败 :1336、inventory 不可判定 :1348)输出 `skipped:0 failed:1` 但**没有真实名单** —— 扩展 contract 时这些分支的 `failed_ids` 需给哨兵值(如 `restart-wave-refused`),消息措辞对应「Lead 重启批次整体被拒(细节见告警频道)」,不能编造名单。

### 2.3 Bridge 健康 — 现状只判真值不计时

:1539-1556:最多 450×2s 轮询 `curl -sf "$BRIDGE_URL/health" | jq -e '.ok'`,首个健康样本即通过。FLY-1600 教训(端口开了≠可用、boot 9 分钟)说明:**通过时刻的单次样本不足以代表「可用」**。测量方案:hc 通过后串行 5 次 `curl -sf -o /dev/null -w '%{time_total}' --max-time 5 "$BRIDGE_URL/health"`,间隔 1s;`%{time_total}` 是秒(小数),×1000 取整为 ms;报「N/5 通过,中位 X ms,最大 Y ms」。5 样本称「中位/最大」而非「P95」(样本量不支持 P95 的说法,诚实优先 —— issue 允许「至少一次实测延迟」)。若 5 次全失败,措辞降级为「健康检查通过但后续实测全部失败」且整条消息不得写「健康」。

### 2.4 总耗时 — 无现成锚点

脚本无 T0 记录。锚点放 main 序列早段(env 加载后、diff 分析前),`DEPLOY_T0=$(date +%s)`,覆盖 idle-wait(--wait-idle 时)+ build + Bridge/Lead 重启全程 —— 这是 founder 体感的「这次重启花了多久」。格式化 `X分Y秒`(<60s 时只报秒)。

### 2.5 leads-restart-status.json(:144-171)

`write_leads_restart_status` 原子写,schemaVersion 1,消费者 grep 全仓仅 restart-services.sh 自身 + scripts/test-restart-services.sh(无 TS 消费者)。**加性**扩展 `failedIds`/`skippedIds`/`total` 字段安全,schemaVersion 保持 1(纯加性,旧读者不破)。

## 3. 终局分支完整清单(通知调用点)

`deploy_and_verify`(:1492-1608)+ `rollback_and_restart`(:1425-1486)的全部出口:

| # | 终局 | 位置 | 现有告警 | founder 三态 |
|---|---|---|---|---|
| T1 | 端口卡死,部署中止 | :1503-1508 | alert_severe deploy-port-stuck | 🚨 |
| T2 | build 失败 → 回滚 | :1513-1518 → R1-R5 | (由回滚分支报) | 见 R* |
| T3 | Bridge 健康超时 → 回滚 | :1551-1554 → R1-R5 | 同上 | 见 R* |
| T4 | leads_failed>0(代码已部署) | :1590-1594 | alert_warning leads-partial-failed | ⚠️ |
| T5 | leads_skipped>0(代码已部署) | :1600-1604 | alert_warning leads-skipped-no-manifest | ⚠️ |
| T6 | 全成功 | :1607 | notify_routine ✅ | ✅ |
| R1 | 无 known-good sha,无法回滚 | :1429-1434 | alert_severe deploy-failed-no-rollback | 🚨 |
| R2 | 工作区脏,拒绝回滚 | :1439-1444 | alert_severe rollback-blocked-dirty | 🚨 |
| R3 | 回滚时端口卡死 | :1457-1461 | alert_severe rollback-port-stuck | 🚨 |
| R4a | 回滚成功但 Lead 未恢复 | :1475-1477 | alert_severe rollback-leads-failed | 🚨 |
| R4b | 回滚成功且 Lead 恢复 | :1478-1481 | alert_warning update-rolled-back | 🚨(更新失败了,对 founder 是失败;正文写明已回滚恢复旧版) |
| R5 | 回滚 build 也失败 | :1482-1485 | alert_severe update-and-rollback-failed | 🚨 |

T4 与 T5 可能**同时**成立(failed>0 且 skipped>0)—— 现行代码 T4 先 return,founder 消息应合并写(failed 名单 + skipped 名单一条消息),不因早退丢 skipped 信息。注意 T4/T5/T6 共用一个「重启结束」消息骨架(sha/Lead/Bridge/耗时),只是三态措辞不同 —— 实现上是一个 build-message + 一次 notify_founder,不是三份复制粘贴。

R4b 的三态判定:代码层面是 warning(旧版已恢复),但对 founder 而言「我批的那次更新失败了」是主事实 → 🚨 开头 + 正文如实写「已回滚到旧版并恢复运行」。这是「按行为面写」纪律的具体应用。

## 4. 测试基建现状

- `scripts/__tests__/restart-notify-routine.test.sh`:hermetic 模式范本 —— awk 按 `/^fn\(\)/,/^}/` 抽取**真函数**(非拷贝),`env -i` + fake `curl`(记录 url + auth 来源 argv/stdin)+ fake `meta-alert.sh`,断言频道/token/留痕/rc。
- `scripts/__tests__/restart-services-notify.test.sh`:fake `lead-alert.sh` 记录调用参数 + 源级 grep 锚点(如 `grep -q 'alert_severe "rollback-port-stuck" '`)双轨。
- CI:scripts/__tests__/*.test.sh 由既有 shell 测试通道执行(ci-matrix-coverage.test.sh 有接线断言,新测试文件需确认被矩阵覆盖)。
- **变异判据的强形式**:抽取 `deploy_and_verify`/`rollback_and_restart` + stub 协作函数,跑出每个终局,断言 fake notify_founder 恰好一次且首行三态正确。awk 抽取对函数体内嵌套 `}` 顶格闭合敏感 —— 这两个函数体内无顶格 `}`(已核:全部嵌套块缩进),可安全抽取。

## 5. 风险与开放问题

1. **claw bot 对 #flywheel-core 无发言权限**(概率中):部署 checklist 第一项真发验证;若无权限,在 Discord 给 claw bot 加该频道权限(服务端操作,不改代码)。失败面兜底:notify_founder POST 失败 → stderr ERROR + meta-alert(桌面可见),不静默。
2. **stdout contract 扩展破坏既有解析**(概率低):3 个解析点同文件同 PR 改;新增字段追加在行尾,`failed:` 与 `failed_ids:` 前缀有别,既有贪婪 sed `.*failed:\([0-9]*\)` 在 `failed_ids:` 无数字前缀跟随时不会误锚(`failed_ids:` 后是非数字);为稳妥,解析统一改为锚定字段名的 `grep -oE '(^| )failed:[0-9]+'` 形式并配测试。
3. **消息风暴**(概率低):一次重启恰好一条 outcome;上游 FLY-1501 storm gate 限重启频率;不在本单加去重。
4. **QA slot 计数污染**(已规避):M 排除 skip-test(§2.2)。
5. **真机验收路径**:本 feature 自身 ship 的那次生产重启就是第一次真实验收(成功面);degraded 面用 QA room(FLY-529 镜像,`FLYWHEEL_FOUNDER_DEPLOY_CHANNEL` 指向测试频道)或临时指环境变量到测试频道做一次受控 degraded 演练,不往她主频道发测试消息。
