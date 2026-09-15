# FLY-2447 Raya 统管业务 — 调研
Issue: FLY-2447 (https://linear.app/geoforge3d/issue/FLY-2447/rayacos-统管-leads-summaries88-日报-在新地基重排按-prd-fly-1846-的定义作为-raya)
日期: 2026-09-14
基于: plan.md

## 设计阶段证据

- 设计正文提交 `31eb537df`，已推送 `origin/flywheel-FLY-2447`。
- R1 gate `91192887-0b17-4c74-a79c-3d4b4a186f54`；request `dd9e93c2-0044-4e2d-b8ce-42096bb180c6` accepted，等待effective verdict。bare stage没有被当作请求。
- Lead答复 `7864eabe-93b8-4d7c-848f-8f773f98dfa1`：双仓边界确认；Raya拥有业务/持久化/判断，Flywheel仅补通用工具或载入点；无Lead问答API、不恢复2379；主动追问必须本单可用；⑤没有可继承的未合并已批准paired head，使用Flywheel已合入通用voice。
- Lead答复 `b9d33be4-3881-4491-9b45-dda0eb062c36`：允许最小、配置化通用唤醒，复用GatePoller tick+lead_event；无新scheduler/旧runBrain/第二模型；Raya拥有日报内容、日期业务语义与恢复，默认founder时区20:00。
- 已回报Lead，report ID `652e4f73-3f3f-410c-8add-016c5e4a85e6`。

## 图与HTML

`flow.mmd` 和 `model.mmd` 各执行一次mmdc，再各用标准参数重试一次：

```sh
mmdc -i <source.mmd> -o <output.svg> -w 1000 -b white --svgId FLY-2447-d1
mmdc -i <source.mmd> -o <output.svg> -w 1000 -b white --svgId FLY-2447-d2
```

四次均exit1，Chromium启动失败：`MachPortRendezvousServer ... Permission denied (1100)`。没有SVG产物；HTML明确放两处 `DIAGRAM PENDING LOCAL RENDER`，保留转义后的源码，无远程渲染、无伪图。

`python3 build-report.py` 生成完整HTML；`node verify-founder-html.mjs` PASS：10节逐节评论、单nonce script、无外部资产/inline handler、pathname隔离、保存禁用、长Unicode意见完整分段（每段≤1800 UTF-16、重复首行标记）、全量/单段复制、clipboard缺失/拒绝降级、失败提示、清空/重载。

仓库diagram-design `self_check.py` 未通过，原因是它要求SVG与animation-controller属性并拒绝外链，而本任务明确允许pending图、指定评论controller和issue链接。未为使检查器变绿而偏离任务合同。以上是artifact/controller检查，不是浏览器视觉或真实CSP执行验证。Chrome DevTools list-pages在观察窗口无响应，已结束该观察，未重启浏览器。

托管HTTP/CSP检查、最终commit/push、DESIGN-HTML报告及phase completion回执将在收尾时追加。当前没有生产业务验证。

## 评审等待核验（20:38 UTC）

只读查询权威 `codex_review_job` 的本request行：status=running，reviewer session=`e7edc20c-ebda-4659-a730-d0af55856e0b`，无verdict/failure_reason。未重发request或重启reviewer。托管snapshot命令返回retryable snapshot_owner_unavailable，未产生副本；随后仅以SQLite mode=ro查询该行并关闭句柄，不读取delivery_nonce。ps调用被系统权限拒绝，所以不把数据库running行声称为已验证活进程。继续沿原gate轮询，pending不是blocked。


## R2有效裁决与v2修订

2026-09-14 20:51 UTC，原gate收到R2 request `6bad0ad5-e820-4459-98a9-79c7811c1686` 的effective CHANGES_REQUESTED，两项HIGH见review-response.md。R1的no_verdict是基础设施失败，不能算已收件的有效设计裁决。Lead恢复指令 `[lead-instruction a69e0c48-efa1-49d0-af9c-9da3cd322067]` 已用原requestId显式重注册accepted=true，并以report `9b76ad14-ad50-4d0e-b407-965ac9d10e30`回执；首次重试遗漏request-id产生额外request的事实已报告。有效R2之后，按review协议修复计划并改走新gate，不继续重试已关闭的原gate。

v2补齐主动圆桌engage与replyTo传播，记录九项非阻塞意见的处理。全部为文档修订，没有实施代码或生产操作。源文件复核发现并纳入额外关键点：动态订阅无cursor会baseline最新；budget原为进程内Map；客户端/Bridge已有sent短路必须对engagement单独续做。对应恢复、去重及消费者测试写入plan §2.3/2.4。

## 本地流程图产物补充

R2 reviewer在另一执行环境用同机mmdc产出 `/tmp/fly2447-flow-test.svg`。作者核验XML、图根ID `FLY-2447-d1`、图中文字与flow.mmd一致、无script/外部引用/事件属性，并复制为本目录flow.svg；SHA-256 `db8adbdc8e4dbaf4965139a2520812bdd29d5c94f265299587ab2dc104848b6e`。原四次失败应精确归因为**作者本次执行环境**的Chromium权限限制；不等于整台机器无法渲染。没有切换权限或调用远程服务。

最终草稿现在为一张本地Mermaid SVG流程图 + 一处model待渲染占位，保留两个Mermaid源文件。作者未取得model.svg，也未取得浏览器视觉QA证据。


## v2重新送审

v2提交 `29b45dd7a` 已推送。新gate `d83e628f-0669-431c-a9b0-d683cdf50383`，request `1e966c8d-75d2-4e74-9010-bd314e16da21`（显式传request-id）在2026-09-14 21:00 UTC accepted=true / skipped=false / duplicate=false。等待此gate的effective verdict，未复用旧裁决。HTML草稿37509 bytes，10节评论、一张本地SVG及一处待渲染；VM controller检查与git diff --check通过。


## R3通过与最终HTML

2026-09-14 21:07 UTC，本gate的effective reviewVerdict=APPROVED / reviewerVerdict=APPROVED，R3 request `1e966c8d-75d2-4e74-9010-bd314e16da21`。review-result.json保留结构化裁决（不存deliveryNonce）。3项非阻塞advisories已以report `76b617a0-485b-409c-8fbd-428f3f1e3052`告知Lead，处理状态在plan Follow-ups。

R3 reviewer本地产出 `/tmp/fly2447-model-test.svg`，作者核对XML、全部5个结构对象、无script/事件/外部引用、root ID `FLY-2447-d2`且两图所有ID无交集后采用为model.svg，27151 bytes，SHA-256 `096116b342df53dbdec5ac472b0060e8f0ce483b2c216c6f8551e63775064d27`。两图最终均为本地Mermaid生成的内联SVG，原作者执行环境失败记录保留为历史证据，最终无PENDING图。

closeout学习已按本会话允许的更新路径写入native memory update inbox，一份包含3条可复用判断的note；未直接改共享role MEMORY.md。当前仍无产品实现或生产验证。


## 发布与交接就绪

最终HTML在提交 `d901e7286` 中，已推送。`publish-report --publish-only` 成功，reportId `64fa525729997c3aebc9647a1e9b3fea`，URL：
https://fw-reports-624a39.vercel.app/r/64fa525729997c3aebc9647a1e9b3fea/

没有频道消息（publishOnly=true, delivered=false）。必需DESIGN-HTML报告已送flywheel-eng-lead，receipt `c9e1a956-07fe-497f-8078-3074f5564217`。

`verify-report --expect FLY-2447` PASS，HTTP200、placeholder替换、CSP/script nonce匹配。独立HTTP检查确认2张inline SVG、ID无重复、1个inline script、无外部资产、批准状态/意见标记存在、托管controller与仓内脚本一致，详hosted-verification.json。VM评论controller最终版本检查PASS。此证据不声称浏览器视觉QA或产品生产验证。

交接范围：探索/调研/批准计划、两图HTML、评审修订与裁决、托管检查均已完成；代码实现、两天真实日报/反馈和上线证据由后续节点执行。R3的两个MEDIUM项保留Follow-ups并已报告。下一步只执行 exact `complete --route phase_design_complete` 和 `park`，结构化回执为阶段完成权威；该命令之前本段不宣称阶段已完成。
