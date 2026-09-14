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

## FLY-2508：取源策略与回滚

项目的 canonical `.flywheel/config.yaml` 中，`beta_release.source_commit`
可选 `default_branch_head`（缺省）或 `local_deployed_sha`。
前者保持从默认分支最新 commit 取源；后者仅适用于运行在该宿主机上的自托管项目，
读取 `FLYWHEEL_DEPLOYED_SHA_FILE` 或 `~/.flywheel/deployed-sha`。
这个文件是宿主机全局状态，不是每项目文件；误配其他项目将受默认分支 compare 守卫约束。

沿用上文的凭据配置、暂停、排空与 owner 接管步骤；本改动不会自动接管 legacy。
经运维授权接管 flywheel 时，先通过下述 FLY-2541 reader 激活守卫，再在既有 beta_release 段内添加：

```yaml
source_commit: local_deployed_sha
```

源缺失、非法或不在默认分支上时，泳道进入 attention，15 分钟后重试；
不会回退到默认分支 HEAD。管理台“当前配置：内部测试版取自 …”表示当前配置，
在途 occurrence 保留原先冻结的 source_commit 与 source_origin。

验收须使用真实 occurrence 和真实 beta 回执：
`published | no_change` 的 `publishedSourceCommit` 必须等于 occurrence 的 source_commit，
并用该 SHA 请求 B3 verdict，核对 `subject.sourceCommit === evidence.localDeployedSha`。
FLY-2541 第二轮按本单 QA 判据要求 `green | hold`；旧 FLY-2508 曾允许的
`soak_insufficient` 在本轮只能记为尚未验收，不能修改 soak policy 凑通过，
但不能含 `no_deployment_evidence` 或 `not_currently_deployed`。
`covered_by_newer` 表示已有后代版本，安全结算但不能充当同 SHA 对齐验收；
等待后续 `published | no_change`。真实运行还依赖 FLY-2534 workflow 修复落地。

回滚二进制时，必须同时从配置删除 `source_commit` 键：
旧解析器不认识此键，会将配置判为 config_invalid 并停止新派发。
数据库的 nullable source_origin 列可保留，历史行保持 NULL，无需删除列或回填数据。
本策略不改变 updater 节奏、B3 soak policy 或发布工作流。


## FLY-2541：真实 reader 激活守卫

接管前必须已由独立部署流程部署包含 FLY-2541 runtime 接线和首次激活守卫的 Bridge。
仅部署 #1156 的 B3 endpoint，或仅配置 source_commit，都不能证明 beta runtime 已接线。
以部署回执中的构建 SHA 对照已合入的实现版本；不依靠配置标签判断运行字节。

在 owner 仍为 legacy 时，由授权运维请求**同一实际 Bridge 进程**的鉴权接口：
`GET /api/release-readiness/verdict?baseVersion=<真实基础版本>&commit=<真实beta sourceCommit>`。
使用既有 Bridge 凭据通道，不把 token 写进记录。此 GET 会追加 verdict 历史，是有记录的验收动作。
保存返回的 subject、evaluatedAt、evidence.localDeployedSha。后者必须是有效 40 位小写 SHA，
并与计划取源的宿主部署 commit 相符；B3 和 beta runtime 共用该 Bridge 的
FLYWHEEL_DEPLOYED_SHA_FILE（未设时 ~/.flywheel/deployed-sha）。shell 中单独 cat 不算进程读取证明。
HTTP 错误、缺少 evidence 或 localDeployedSha=null 时拒绝接管。
这个探针证明 reader 当时可读，不代表 beta 已发布或 B3 已通过。

通过探针后才执行上文 paused、排空、bridge 的授权步骤。
local_deployed_sha 策略在尚未绑定 lane 时，scheduler 会在 owner=bridge 后、
assertDrained 之前再次校验实际 reader；缺席、null 或非法 SHA 均报
attention / beta_source_unavailable，不创建 activatedAt、不 reserve、不 dispatch、不回退 HEAD。
文件在探针后消失也会被这道守卫拦住。
恢复 reader 后遵循既有 15 分钟冷却，成功激活时才开始完整 interval 计时：
6h lane 首次到期为恢复激活后 6h，24h lane 为 24h，不补发失败期间的周期。
到期再读文件并执行默认分支 compare；已冻结的在途 occurrence 沿用原 SHA 恢复。

失败时不得强行改 owner=bridge。若仍在 legacy，保持原供给；
若已 paused，按回滚段排空 live/unknown 提交后恢复 legacy 才能恢复原 6h 供给。
paused 本身会停止供给，不能把它当作正常运行状态。

第二轮验收另存真实 beta version、Actions run URL、published/no_change receipt、
occurrence 的 source_commit/source_origin、publishedSourceCommit 和 B3 verdict。
要求 subject.sourceCommit、publishedSourceCommit、occurrence.source_commit、
evidence.localDeployedSha 同 SHA，并记录默认分支 compare 的 identical/ahead 关系及 SHA。
B3 返回的 state 必须为 green 或 hold，且有实际归因；不得含 no_deployment_evidence 或 not_currently_deployed，
lane 不再报 beta_source_unavailable。covered_by_newer 不算同源验收。
实现侧临时文件和网络 fixture 测试不能替代这份真实记录。
