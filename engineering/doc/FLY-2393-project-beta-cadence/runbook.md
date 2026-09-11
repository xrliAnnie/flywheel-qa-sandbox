# FLY-2393 项目 beta 分频 — 接管与回滚
Issue: FLY-2393 (https://linear.app/geoforge3d/issue/FLY-2393)
日期: 2026-09-11
基于: plan.md

## 当前交付与两态

代码提供每项目调度能力，本分支没有修改生产配置、owner 变量或发布任何 beta。未接管仍为产品基线全 6h；flywheel 原 workflow 保留 6h cron。Bridge 只在 owner=bridge、项目配置/凭据/数字绑定有效且首次接管前旧运行排空后建立游标。显式 beta_release 块省略 interval_hours 默认24h；整个块缺失不激活。GeoForge3D 没有真实兼容 workflow 时保持 unconfigured，不能把 fixture 当成双项目上线。

客户每周 release、判据与 auto-ship 不读取 beta lane 状态作门槛。三个客户 workflow 只增加 queue:max，原触发、environment、inputs、凭据和发布动作均保留。共享锁仍可能造成等待；本实现不承诺零排队延迟。

## 授权运维接管流程

1. 先由独立更新/部署流程部署兼容 receiver 和 Bridge；本实现节点不部署。owner 保持 legacy，确认原6h路径可执行。
2. 为每个项目配置独立仓库范围的 Actions write、Variables read、metadata/contents read 凭据。只写变量名到 canonical `.flywheel/config.yaml` 的 beta_release.token_env。Bridge 进程须由运维显式设置 `FLYWHEEL_BETA_ACTIONS_TOKEN_ENVS`（逗号分隔的变量名允许集，例如 `FLYWHEEL_BETA_ACTIONS_TOKEN,GEOFORGE3D_BETA_ACTIONS_TOKEN`）；它不放在项目 YAML 中，不含 token 值。允许集缺失、为空、格式非法或未列入所选变量时，显示 credential_missing，读取/发送凭据前拒绝；已有数据库绑定也不能绕过。不得复用两个项目的变量名或 token 值，不使用客户发布、ship、npm或Cloudflare凭据。实际验证 A 的凭据对 B 的 dispatch 被平台拒绝；本地 stub 不能替代该验收。
3. 配置 workflow_file basename，确认目标默认分支 workflow 声明 project-key、schedule-key、source-commit、run-name和receipt合同；flywheel明确6h，第二项目可24h。频率范围1–168安全整数，无env频率override。
4. 用既有仓库设置权限把 FW_BETA_SCHEDULER_OWNER 设 paused，确认读取成功。列出旧 schedule/人工/Bridge queued、in_progress及未确认提交；取消或等全部终态。未知HTTP提交不能因超时当成已排空。
5. 全排空后改 bridge。Bridge首次检查会再次拒绝仍在排队/运行的目标workflow；接管后第一个有效tick保存activatedAt，首次到期为该锚+interval，不回补接管前历史周期。
6. 验证旧schedule不进入publish队列；记录第一次合法 dispatch 的项目、due、run URL、receipt、真实版本及下次时间。无变化应记录no_change；已有后代应记录covered_by_newer。run success但无合法receipt不算成功。
7. 对第二个真实项目重复；收集48h左右每项目自己的发版/无变化证据。没有真实入口不激活该项目，flywheel-only客户release继续独立运行。

## 暂停与回滚

先设 paused 并验证；不再提交新任务，在途仍可能完成。按真实 run ID 观察、取消或排空；取消不等于已撤回副作用，坏版处置沿用既有 quarantine/withdraw 权限。确认无live/unknown提交后改 legacy，旧6h执行资格恢复。保留beta两表与历史occurrence，不删除manifest或回滚数据库。仅回滚Bridge二进制而owner仍bridge会停止供给beta，不能作为完整回滚。

绑定改变会fail closed，不能直接改旧lane的repo/workflow或复用游标。当前无管理台重绑定写入口；重新接入必须在paused且全部在途排空的维护窗口按原始绑定与新绑定分别核验，保留历史occurrence。常规频率变化无需重绑，active周期保持原SHA/due，结算后按新频率计算。

## 观测与恢复

每项目最多一个active occurrence；故障停机合并最新到期项，结算后推进到未来网格。已知live run继续查询，不按年龄重启。HTTP未知提交保留完整key与SHA，查询完整分页后才按2/5/15分钟重试；最多5次POST或min(interval,6h)预算。live/unknown预算耗尽后attention并低频观察，不伪清active。429/认证/观测错误冷却不会阻塞另一项目；已绑定lane的冷却持久化，未绑定项仅进程内退避。

页面只读缓存/DB，观测超过两个tick或时钟倒退显示unknown；运行链接固定github.com。缺失workflow/凭据、not_activated、非法receipt均不显示发布成功。独立Bridge失联告警仍是已归档的Lead follow-up，未在本单实现。

## QA专属验收

打开 `fixtures/beta-console.html`：测试数据中的flywheel ready与geoforge3d unconfigured；点击两项目检查布局和响应式。页面fixture不会调用生产API。根据Lead对问题6a05af77-6274-43fa-9b55-68f7b60eaf69的裁定：visual acceptance deferred to QA (sandbox Chromium unavailable)。实现侧DOM/XSS与管理台全族93测试是结构证据，不代替真实浏览器视觉验收。

授权隔离仓还需证明跨workflow/job同名共享锁互斥、排队客户不被后来的beta取消、停用cron不入锁，以及A/B真实凭据隔离。生产A11单独保留；未取得这些证据不得宣称双项目已上线或外部授权验证已完成。
