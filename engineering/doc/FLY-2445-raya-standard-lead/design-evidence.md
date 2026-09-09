# FLY-2445 Raya 标准 Lead — 调研
Issue: FLY-2445 (https://linear.app/geoforge3d/issue/FLY-2445/raya-raya-迁为标准-codex-lead注册进-flywheel走-mailboxraya-仓删掉-ingest-名册)
日期: 2026-09-08
基于: plan.md

## 本节点验证

只修改本 issue 设计目录；没有实施代码、生产 registry、Raya 源仓、服务或模型配置变更。

- inventory.md 附录 A 与 Raya main `0f77e9772176c973eb1e09548b00c05ae550ef32` 的 `git ls-files` 路径集合、顺序完全一致：274 文件；177 个 .ts/.mjs。另列2379/2380/2381分别29/20/58个分支差异路径。
- HTML由 `python3 build-report.py` 构建，单个 inline nonce script、零外部资源、每个section都有comment textarea；所有导入的Mermaid文本与表格字段通过html.escape。
- 使用本机已装 `happy-dom@20.10.6` 在独立脚本中执行真实HTML脚本：10 sections/10 comments；same pathname重载恢复；different pathname不串草稿；localStorage抛异常仍可写/汇总；注入HTML作为文字显示；长意见分3块，最大1764 codepoints，每块以精确标记和换行开始；clipboard API缺失与promise rejection均调用execCommand fallback。测试PASS。
- JS经过 `vm.Script` 语法检查；静态检查单script、nonce placeholder、无inline handler、无innerHTML、无自建CSP meta、无外链脚本/图片/字体。PASS。

## 本地渲染失败（不能冒称已目视验收）

`mmdc --version` = 11.12.0。三张图各首次尝试+一次标准参数重试均退出1，错误相同：Chromium `mach_port_rendezvous.cc` 的 `bootstrap_check_in ... Permission denied (1100)`；不是Mermaid解析结果。每次使用不同稳定svgId：

```bash
mmdc -i diagrams/d1-core.mmd -o diagrams/d1-core.svg -w 1000 -b white --svgId FLY-2445-d1
mmdc -i diagrams/d2-model.mmd -o diagrams/d2-model.svg -w 1000 -b white --svgId FLY-2445-d2
mmdc -i diagrams/d3-migration.mmd -o diagrams/d3-migration.svg -w 1000 -b white --svgId FLY-2445-d3
```

按节点明示例外，HTML有三处 `DIAGRAM PENDING LOCAL RENDER`，保留三份.mmd源码，并可在页面展开读取；没有CSS假图，没有远程渲染。该宿主限制也意味着本节点尚未完成真实浏览器视觉/CSP交互验证；happy-dom是DOM行为证据，不是视觉截图或CSP执行证明。

## 设计评审与Lead裁定

- v1计划commit `a7bf80218`；review gate `a886a3df-71c0-4f26-900f-d8c9572efb05`，request `27560a93-a5f7-4832-a63b-b3e641d1a7cf`，已受理。
- 随后Lead两个问题回复到达：`9c72c361-ffb0-4da1-85bf-8607ee4bb06e`、`b2ea8602-feee-41d5-8743-380fa13e47e2`。v2移除新的Lead问答API和额外实现hold，收敛到文字+summary迁移，保留业务状态机与unavailable守卫，⑤明确FLY-2446。v2必须新评审，不以v1未决请求充当批准。
- 托管页HTTP/CSP/nonce检查、最终评审与完成命令的实际结果在拿到后追加；此处不预填PASS。

## v2 发布与当前评审游标

- v2 commit：`280d0704e`，已push。当前review gate：`23769cd0-eb77-456c-9be3-a65963257530`；requestId：`088867e4-1935-49db-b660-e2a61d4293ca`，Bridge已持久受理。旧gate仍运行，当前v2请求排队；仅当前有效verdict能完成设计。
- publish-only成功：<https://fw-reports-a53de2.vercel.app/r/09fba6ee3daca23c090744aab497fd15/>；reportId `09fba6ee3daca23c090744aab497fd15`；messageId=null，符合不发送频道消息要求。DESIGN-HTML报告回执id `80f0a1bd-80f8-48cc-b090-58bb0dbf36ae`。不要无故重复发布。
- 托管页curl结果：HTTP200，22122 bytes，nonce占位符0处，script恰1个，CSP中nonce与script值匹配，3个明确的渲染失败占位。该检查证明文档与CSP结构，不等于真浏览器脚本执行。
- 当前请求服务端核查：`codex_review_job`首轮running、v2 pending，共用reviewer_session_uuid `909762f9-1a50-4868-a3ea-f2bcc402062f`，failure_reason=null；以check命令继续轮询，不因等待重启reviewer。
- Lead两个范围裁定均已应用并报告，DONE report id `0fd64b0a-7da2-4307-b02c-799f3ba4bc02`。

## v3：处理R2评审

R2 gate `23769cd0-eb77-456c-9be3-a65963257530` effective `CHANGES_REQUESTED`；1 HIGH、6 MEDIUM、2 LOW。旧R1被服务端标为superseded_by_revision，不构成另一项待处理评审。v3按全部finding修订，尚不预填批准。

| findingKey | v3处置 |
|---|---|
| cutover-cursor-not-in-checkpoints | §6.2新增P4b、明确updater/helper路径、严格seed/readback与install停止线；P6/G验证停机窗口已知source messageId真实入mailbox；旧副作用不明写manifest并停止，明确无运行时holdback队列 |
| cos-context-roster-writer-missing | §3.1/A新增受cfglock的import-cos-context更新已有行；CAS与两文件pending/recover；复用③candidateRegistry扩展，非现有main applyManifest或add |
| v2-receipt-drops-v1-rollback-fields | §6.4完整保留22个v1键+8个v2键；旧carrier键仅历史；明确pinned key-set测试、两SHA rollback_target以及失败null证据 |
| bridge-env-raya-bot-token-precondition | P5在Bridge与Lead实际进程环境中验证token解析与botUserId；缺失禁止install；P6身份证据 |
| no-alert-channel-for-standard-raya | §3/§6.3/A扩已有alert字段注册参数、显式落点与FLY-927优先级；P6告警可达证据 |
| roundtable-opens-inbound-polling | §3.2说明双向入站/出站、mention gate、缺字段不收不发与既有频道cursor范围 |
| section9-svg-and-browser-gate-stale | §9列design-evidence.md与任务明示渲染失败例外，移除“已真浏览器验证”的暗示 |
| job-label-collides-with-fly2216-plist | P5/F检查同label异构plist存在即停止，不覆盖；不以本次审计未装推断未来未装 |
| founder-diagram-implies-standalone-ingester | §1与HTML/图源明确收信器在标准Lead进程内，停机靠cursor补齐；迁移图增加seed步骤 |

v3验证：

- TypeScript真实parser检查计划里的两个类型代码块语法通过；StandardRayaReceipt顶层30键，原测试pin的22键全部包含，omitted=[]。
- Mermaid 11.12.0在happy-dom中对三份当前源码执行真实 `mermaid.parse()`，全部PARSE_OK。该证据只证明图源语法。
- 改动的d1/d3各执行首次mmdc+一次标准参数重试，仍因Chromium bootstrap_check_in Permission denied(1100)失败；没有SVG，没有远程渲染。d2未变，保留原两次失败证据。
- HTML更新后执行实际inline脚本的DOM回归：10意见框、pathname隔离、禁用storage、HTML按文本处理、长文三块、两种clipboard fallback全部通过；单nonce script、零外部依赖与git diff --check通过。
- v3发布与复审结果待实际取得后追加；本节不把设计验证写成生产迁移验证。

## v3提交、发布与待决游标

- v3设计commit `0997a85f0` 已push。新gate `aa6390a0-34f1-485d-ac14-543e148a39c2`，request `745a451d-7e30-410b-bf26-93b39a9789e9` 已受理；只认本轮effective reviewVerdict。
- 最新页面：<https://fw-reports-a53de2.vercel.app/r/8e0448e57c0cb04c3175dfc69ce68c41/>，reportId `8e0448e57c0cb04c3175dfc69ce68c41`；publishOnly=true，delivered=false，messageId=null。
- 托管验证：HTTP/2 200，23135 bytes，单script，nonce占位符为0且脚本nonce匹配注入CSP，三处明确渲染占位；v3窗口收件文案存在。
- DESIGN-HTML报告回执 `c11fce8c-ec1a-47b2-b17b-caa1db3e4076`；R2全部处置DONE报告回执 `c3f2337c-791e-4f08-80d0-cb6f5faeafd0`。
- 设计节点尚未完成；继续轮询上述新gate，无实施/部署/ship动作。

## 最终设计评审与交接审计

2026-09-08 20:12Z，R3 gate `aa6390a0-34f1-485d-ac14-543e148a39c2` 返回 effective `reviewVerdict=APPROVED`、`reviewerVerdict=APPROVED`，request `745a451d-7e30-410b-bf26-93b39a9789e9`、round=3；服务端job为done且failure_reason=null。R2的HIGH已关闭。

两条non-blocking advisories已报告Lead（回执 `8560b6ab-46c0-4aaf-9f0e-f6053a73d049`），并就地作符合批准设计的说明修正：

- `p4b-helper-artifact-path`：改为teamlead的src/bin→dist/bin构建产物，node调用前普通非symlink检查；明确package-onboard.sh的PO_SCRIPT_FILES、package-onboard-files.allow和converge-flywheel-bin.sh全部适用FILES，隔离安装测试验证可运行。没有新增业务或平台运行方式。
- `d3-hold-to-active-skips-seeded`：恢复边改为Hold→Seeded，状态标签为“初始化或复核标准收信位置”，符合正文原有启动前检查与禁止游标倒退规则。更新图源真实Mermaid parse通过；再次本地渲染首次+标准重试仍同宿主权限失败，按任务明示例外保留占位。

设计节点交付范围核对：

| 必需项 | 实际证据与边界 |
|---|---|
| full DOC-FLOW | exploration/research/plan和同目录progress；标题、Issue、日期、基于字段齐全；progress为CLI托管格式 |
| 逐文件删留、注册、迁移、回滚 | inventory main 274路径及2379/2380/2381覆盖层；plan §3、§5、§6；未用历史文档词命中冒充活动驱动存在 |
| 业务与依赖、唯一身份 | 两条Lead范围裁定已落实；raya/raya、中央名册、两仓部署、summary连续性和⑤/⑥边界均明确 |
| 负向守卫与测试证据设计 | plan批次A–H、P0–P7含P4b、需求验收矩阵；未宣称已完成生产测试 |
| 独立工程评审 | 上述R3 effective APPROVED；两条advisories已报并澄清 |
| founder HTML五类内容与交互 | 最终页面具备一句话、核心流程/结构Mermaid源码与合法渲染例外、取舍和边界；10个意见框、路径隔离存储、实时汇总/标记/分块、双clipboard fallback；真实DOM复测通过 |
| CSP与零外链 | 单inline nonce script、零inline事件属性/外部依赖；托管页再验证后记录最终URL，不以DOM测试冒充浏览器视觉验收 |
| 权限与角色边界 | 只修改本issue设计目录；未写实施代码、生产registry或Raya源仓，未读取禁止凭据，未派实施/QA节点、未merge/deploy/restart |
| 阶段完成 | 最终commit/push、publish-only、Lead报告与phase_design_complete/park按实际结果记录；设计完成不等于迁移上线 |

最终页面/完成回执在取得后追加，不预填成功。

最终页面已于2026-09-08发布：<https://fw-reports-a53de2.vercel.app/r/74334829121ecf2b4baf456d5830c749/>。HTML内容commit `aa1dbee39`已push；reportId `74334829121ecf2b4baf456d5830c749`；publishOnly=true、delivered=false、messageId=null。托管检查HTTP/2 200，23162 bytes，单script且nonce与注入CSP匹配、无inline handler、3个明示渲染占位、批准标签和Hold→Seeded修订均存在。DESIGN-HTML最终报告回执 `0dfeea71-453a-496d-bfd2-2a51cc9c97a7`。

设计交付与审计已齐备；即将执行phase_design_complete并park。完成命令的权威结果由CommDB completion event及CLI的last-complete.json记录，不在执行前预写为成功。本阶段未实施迁移，FLY-2445的生产文字、summaries及deploy-receipt验收仍由后续节点/部署责任人执行。
