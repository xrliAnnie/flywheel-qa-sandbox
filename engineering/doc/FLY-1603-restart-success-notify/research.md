# FLY-1603 全量重启结束通知 — 调研

Issue: FLY-1603 (https://linear.app/geoforge3d/issue/FLY-1603/基建-全量重启成功后不通知-founder-她不知道什么时候能-expect-舰队上线)
日期: 2026-08-02
基于: exploration.md

## 1. 现有播报通路盘点(`scripts/restart-services.sh`, 1622 行)

| 通路 | 位置 | 目标频道 | 触发条件 | 备注 |
|------|------|----------|----------|------|
| `notify_routine(msg)` | `:223-247` | `FLYWHEEL_NOTIFY_CHANNEL`(经 `CLAUDE_INFRA_BOT_TOKEN` 直 POST) | 调用方决定 | FLY-929/FLY-1081;env 不齐 → loud refusal + meta-alert;POST 失败 → ERROR + meta-alert;永远 return 0 不阻塞 deploy;token 走 curl `-K -` stdin 不进 argv |
| `alert_warning(sig,title,body)` | `:195-200` | alerts 频道(经 `lead-alert.sh`,kind=`deploy_degraded`) | 调用方决定 | FLY-1577 修好的投递体系:claims 去重 + queue/dead-letter |
| `alert_severe(sig,title,body)` | `:202-214` | alerts 频道(kind=`deploy_failed`) | 调用方决定 | 带 founder @-mention(gate-approved,不动) |
| `fire_meta_alert` | `:176-180` | 桌面 + 本地文件 | best-effort | Discord-independent 兜底 |

## 2. `deploy_and_verify()` 结束分支解剖(`:1492-1608`)

```
🔄 notify_routine "开始全量重启 … old → new"        ← :1495(已有,内容够,不动)
stop_bridge → build → start_bridge → health check   ← 失败走 rollback_and_restart,alerts 侧已覆盖
do_restart_all_leads → "skipped:N failed:M"         ← :1564,stdout 只有数量、无名单
deployed-sha 推进 + write_leads_restart_status       ← :1575-1588(FLY-1434:代码真相与 Lead 健康分账)
├─ failed>0  → alert_warning(只有数量) + return 0    ← :1590-1594  ★无结束通知
├─ skipped>0 → alert_warning(只有数量) + return 0    ← :1600-1604  ★无结束通知
└─ 全净      → notify_routine "✅ …完成"             ← :1607  ★内容不达标
```

✅ 现有消息内容:`✅ Flywheel 全量重启完成 (reason=…)。版本 <sha>,重启了: Bridge Leads` —— 缺 from→to、缺 N/M、缺 Bridge 实测延迟、缺总耗时。

## 3. 昨夜日志实录(`/tmp/flywheel-restart-2026080{1,2}-*.log`)

| Run | 结局 | 走到的分支 | notify 频道结束通知 |
|-----|------|-----------|---------------------|
| 08-01 15:38 / 16:06 | Bridge health 超时 → rollback | rollback_and_restart | 无(scope 内属「完全失败」,alerts 覆盖) |
| 08-02 01:31 / 02:04 | 同上(FLY-1600 根因) | rollback_and_restart | 无 |
| 08-02 03:02 | 代码部署成功,2 Lead failed | `:1590` degraded → return | **无** ← 本单要修的 |
| 08-02 03:51 | 代码部署成功,1 Lead failed | `:1590` degraded → return | **无** |
| 08-02 04:38 | 代码部署成功,1 Lead failed | `:1590` degraded → return | **无** |

失败的 Lead 反复是 `flywheel-eng-lead`(newborn/body/model verification 不过)与 `mufasa-lead`。复核全部调用点后更正:多数失败路径会先发点名的 per-candidate alert,随后 deploy-level tail alert 只报数量;unreadable-manifest 分支则只有日志、没有 per-candidate alert。验收 2 的缺口是 tail summary 不完整且少数可命名分支完全漏名,不是 alerts 频道从未出现名字。

## 4. 数据从哪来(完成消息的每个字段)

| 字段 | 来源 | 现状 |
|------|------|------|
| sha 从→到 | `$DEPLOYED_SHA`(旧值变量在完成时仍未被覆盖)→ `$CURRENT_HEAD` | 现成 |
| Lead 总数 M | `do_restart_all_leads` 内 candidate 分类(`restart`+`manifestless`+`config-drift`,排除 `skip-test`) | **需新增**:stdout 合同追加 `total:K`;消费侧改为严格单行字段 parser,防 non-match sed 在 `set -u` 下把整行当算术变量 |
| 失败/跳过名单 | 每个 candidate 的 `key`(`project-leadId`) | **需新增**:沿 `PROJECT_SHA_UPDATES_FILE` 先例,写入全局临时名单文件(`failed\tkey` / `skipped\tkey`);名单不进入 stdout 机器合同 |
| Bridge 健康+延迟 | 完成时刻对 `$BRIDGE_URL/health` 一次 `curl -w '%{time_total}'` 实测 | **需新增**(FLY-1602 教训:「端口开了≠可用」,完成时刻再实测一次) |
| 总耗时 | 文件头 `set -euo pipefail` 后立即记 `date +%s`,完成时刻求差(覆盖 env/plugin scan/idle wait/build/restart 全 wall-clock) | **需新增** |
| reason | `$RESTART_REASON` | 现成 |

## 5. 频道路由事实核查

- notify:`FLYWHEEL_NOTIFY_CHANNEL=1521630422918758472`(生产 `~/.flywheel/.env` 实测,与 founder 指定一致)。
- alerts:`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=1518793447165661254`(env)/ `projects.json` `alertChannel` 同值 —— lead-alert.sh 内部解析,本单不碰。
- core 主频道 `1516209714097291335`:`restart-services.sh` 全文无引用(grep 证实),现状本来就不发;验收 3 用测试断言「录到的 POST 目标只含 notify/alerts」锁死。

## 6. 测试基建现状(`scripts/test-restart-services.sh`, ~2000 行)

三代技术并存,新增测试用后两种:

1. **keep-in-sync 拷贝**(旧,classify_changes 等)——不再新增这种。
2. **BO 黑盒 rig**(`bo_run`):fake HOME + PATH shims(fake curl/launchctl/pnpm 录调用)+ 真 git repo + 真跑 `restart-services.sh` 全程。现在显式设 `CLAUDE_INFRA_BOT_TOKEN="" FLYWHEEL_NOTIFY_CHANNEL=""` 走 unconfigured 分支——新测试给它配上 fake 值,断言 curl shim 录到的 POST URL+payload。**变异判据在这层落**:删通知调用 → POST 断言红。
3. **source 生产 lib**(FLY-1507 模式,`scripts/lib/lead-restart-lifecycle.sh` 等)——渲染/计时函数放 `scripts/lib/restart-notify.sh` 后测试直接 source,无拷贝漂移。

`scripts/lib/*` 改动在 `classify_changes` 里已归 `_restart_bridge=true`,部署语义正确。

## 7. 风险点

- `do_restart_all_leads` stdout 是机器合同(rollback/deploy 两类消费)。名单**不进 stdout**(`failed_keys` 会踩字段名),走文件;计数消费改为严格 parser,使缺字段、多行或 stdout 泄漏 fail-closed 为 wave error,而不是依赖 non-match 仍 rc=0 的 sed。
- `deploy_and_verify` 在 `set -euo pipefail` 下运行:新增的探测/计时代码必须全部 best-effort(`|| true` / 默认值),完成播报绝不能反过来挂掉 deploy。
- rollback 路径复用 `do_restart_all_leads`:名单文件/`total:` 对行为无感;其 `failed:` 消费同步改用严格 parser,非法合同按失败处理,rollback 仍不发 notify。
