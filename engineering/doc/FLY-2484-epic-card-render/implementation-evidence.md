# FLY-2484 Epic 卡渲染 — 实施证据
Issue: FLY-2484 (https://linear.app/geoforge3d/issue/FLY-2484/进度页e3-渲染层epic-徽标照抄-linear-子单计数分组稳定排序依赖徽标等-fly-xxxx整块在等跨-epic)
日期: 2026-09-10
基于: plan.md

## 当前边界

E1 基线实现与 Lead 授权的审计侧车、网关保护已完成；最终 lint/build 通过。完整包失败与单次隔离通过分别披露；Lead 指定精确头 Bridge review + CI 为代码交接门。E2/E4 真实接线与最终视觉/生产发布验收交后续节点。以下为阶段时点记录，最终边界见 ship-report.md。

Lead 响应 601a8194-35b2-4539-8486-8d6e6f925b57 授权先在 E1 main 基线上实现并保留 A/B1/B2；普通 push 前复核 #1147/#1148，未全部合入则问 Lead。响应 ca28d5e1-86a1-41ca-a46e-86c03d1484fe 要求恢复已推设计历史，随后只用 merge 同步 main。已恢复 origin/flywheel-FLY-2484、merge origin/main、重放 S1；remote 设计 HEAD 是当前 HEAD 祖先。计划 v4 未改。

## S1

- 首次新增分类/归属测试：12 条失败，缺少 classifyItem/rootOf；原有及错误优先级断言通过。
- 最小抽取后 rules / scope-v2 / generate 共 97 条通过，原 scope-v2 37 条未修改。
- 新文案首次 38 条失败（Unknown label）；加入批准词表后通过。
- 固定 JSON 对照锁定 V2 每根 value、missing 缺席和有序 from。
- S1 最终四文件 140 条通过；依赖 build 后 teamlead typecheck exit 0。

## S2 基线

- identifier 字典序占位实现产生预期顺序断言失败；改为类别、前缀、数字长度、数字串、原串全序键后 5,040 种排列通过，并覆盖超出安全整数范围的单号。
- buildFounderView 缺失时新增视图用例失败；实现后开放 Epic、终态计数、未知状态、三种 blocker 归属、整块在等、机器进度及五格出处通过。
- 六类 view provenance 的输入指针逐条可解析，时间按 Date.parse 排序。时间测试初版误用早于生成时刻的 .999Z，改为生成同秒 .999Z 后通过。
- permuteSnapshot 缺失时稳定性测试失败；按 UUID 同步重排 snapshot/facts/signals 后通过。包含 A→B→null 的三张 unattached、状态分组、free/live_no_run、逐桶计数对照和空范围。
- 当前 pnpm --filter flywheel-teamlead exec vitest run src/epic-page：14 文件、233 条通过。
- 当前 pnpm --filter flywheel-teamlead typecheck：exit 0。
- 聚焦套件不是全仓通过，也不是 CI、视觉或生产验收证据。


## S3 E1 基线 HTML

- 新 founder-render 测试先红：没有 Epic details、等待徽标缺失、roots Cell 重复。接入 FounderView 后通过。
- Epic 卡默认收起，状态名照抄 Linear，计数并列；终态子单不出行、只留计数。根投影与 roots 全格分开，Lead 面板位于卡片之后。
- 每个可见子单包含 parent 在内的 15 格出处；六种展示规则输出具体路径与观测时间。危险标题、blocker 文本转义，非 Linear URL 无链接。
- A/B1/B2 目前是明确代码插槽注释，尚无 E2/E4 功能；待合入 main 后原样接线及复测。Markdown 未修改。
- 按批准计划改写旧卡片的布局断言。新卡片使 blockerList/dependentList/whySummary 三个旧私有函数不可达，类型检查报 unused 后删除。
- 最终聚焦：15 文件、240 条通过；teamlead typecheck exit 0。未运行全仓最终门禁。

## 本地视觉证据与限制

- ProofShot 对 E1 V3 fixture 运行 start（含 --run）→ 浏览器交互 → stop。
- DOM 实测：roots = EPX-100/EPX-200/EPX-400，open details = 0；1280px 与 390px 的 scrollWidth 均等于 viewport，无横向溢出。
- 已逐张检查并提交 visuals/desktop-expanded.png、mobile-collapsed.png、mobile-expanded.png。手机展开 EPX-400 时可见整块在等、跨 Epic 与范围外标记。
- 该 fixture HTML = 110619 bytes；这不是最终 C5 最大容量结果。
- 桌面收起截图两次命令 exit 1 未产图。ProofShot stop 产出两条空 console error，视频裁剪到 476 bytes，录像证据无效；不能声称完整 ProofShot PASS。
- 补跑不能新建 agent-browser 默认 socket（Operation not permitted）；DevTools new_page 被工具审批策略拒绝。已向 Lead 报告，后续仍需最终集成版本视觉复验。
- 本轮 ProofShot 临时服务器为 127.0.0.1:18484 PID 84520；18485 / PID 85873 后经 Lead 更正属于其他执行体，不是本轮创建。清理交 Lead 台账，未再操作。原 start shell 已 Ctrl-C。


## S4 进行中：守卫、重放与容量裁定

- G4 新测试先红（缺失 blocker 被判 other_epic），补 byId 存在性后绿；两张 no_parent 子单先红（null==null 被误判 same_epic），增加真实 root 条件后绿。
- 新增 raw snapshot 重排后的 HTML data-root/data-item 顺序对拍，通过。
- 本单 replay-linear.ts 读取 E1 冻结文件并验证 SHA256，独立按原始 Linear 数据核对 root 与全部子单归属、counts 和可见子单集合。结果 linear-replay-result.json：7 roots、36 items、18 visible children，HTML 230031 B，同输入逐字节相同、0 open details。运行事实显式 missing，不是生产固定页验收。
- 全仓 pnpm lint exit 0，14 warnings；pnpm -r build exit 0。pnpm test:packages:run 初轮最终 exit 1，claude-runner onTaskUpdate 超时；日志 /tmp/fly2484-full-packages.log。该次为中间工作树验证，后续回执见末节。
- 真实规模的容量基线测试失败：8 roots/60 kids、120 字标题、4096 B acceptance、三条 blocker、facts+signal = 769194 B。L1 773778 B 更大，已撤回；不修改输入夹具降低压力。
- Lead 的显式扩展记录在 capacity-ruling.md（问题 af69050a-1f8c-4bd7-afa4-13f79b8d7d98）。保持 60 张与 480KiB，按出处字典、短文本/完整标题字典、终态不列顺序，每步实测。
- AuditDictionary 基础模块 2 条测试通过；尚未接入 renderer，第一步压缩字节未测，容量测试仍红。
- Lead 接受部分 PNG、终局视觉交 QA、不再重试录像；PID85873 属于其他体的更正已记入 capacity-ruling.md。

### 容量侧车阶段（未完成发布接线）

- 第一轮字典 768600 B，短标题/摘录后 640926 B，终态排除无额外变化；Lead 二次裁定见 capacity-ruling.md。
- 侧车打包：HTML 281855 B；JSON 217898 B；1042 条。相同 8-root/60-child 夹具未降规模。
- 新增 audit-sidecar 两测试红绿；audit-bundle 因接口缺失红，再逐格 Cell、view from、hash/path/bytes 与重复渲染绿。founder-render 11 测试同时绿。
- lint/build 曾通过；完整 package suite 此轮 exit1：claude-runner 50 文件/1256 tests 通过，但 Vitest onTaskUpdate unhandled timeout 导致总命令失败。最终变更后仍需重跑全部门限。
- 发布、网关、清理、上游集成与最终代码审查尚未完成。

### 发布链路与 Lead 最终范围

- 发布/Blob/网关定向 40 测试绿；加入网关发布前探针后定向 32 测试绿。audit 先上传，公共网关 GET 200 + JSON MIME + SHA-256 一致后才覆盖 HTML；失败返回 `transient: publish_failed:audit_gateway`。
- 远端读取用于恢复真正的上一审计 hash；重复发布保留前一版本，失败不删旧审计，成功后清除其他 hash；报告 TTL 删除含 hash 子目录。当前 HTML 无正文、hash 不符、审计上传失败、HTML 上传失败均测试覆盖。
- 第一张页面允许先验证已上传 audit；过期固定页也必须能用新 audit 恢复。审计自身 uploadedAt 使用相同 14 天 TTL，旧 HTML 的访问有效期不延长。
- 合成插槽测试：68 条、每条 280 中文字备注 + 最小 attention 警告，HTML 338195 B；A 首节点、B1 首节点、B2 紧跟 machine-line；空插槽与默认收起测试绿。未接 sibling 真 renderer/预算器，不能声称上游集成完成。
- E1 冻结回放：HTML 92717 B，audit 89305 B / 292 条；7 roots、36 items 来源集合与计数无变化；0 初始 open。审计 hash 写 linear-replay-result.json。
- Lead 12b30083 裁定当前 E1 基线可交 PR，E4→E2→E3 顺序由 Lead 控。合入 sibling 后还需一次普通 merge main 技术返工、真实接线与重验。
- 网关当前 production 项目只读核实为 fw-reports-a53de2；新增 gateway-deploy.md。现有 migrate 命令会 no-op，文档的已有 helper 组合部署命令未执行。无分支 preview，网关路由真机未验，由 Lead 部署后补验。
- 全仓 build 已再绿；lint 一次 import 顺序失败已修。当前整包 suite 在运行期间收到新增探针裁定，树有变更，作为中间回执；最终冻结前还需所有 gate 的最后回执。

### 本地整包与审查基础设施回执

- `pnpm test:packages:run`（/tmp/fly2484-final-packages.log）exit 1。teamlead 955 文件通过、1 文件失败；12836 tests 通过、1 失败、7 skipped；另有 `onTaskUpdate` unhandled timeout。
- 唯一断言失败：`fly-2341-db-hygiene-script.test.ts:241` 预期 archived.teamlead=100，实得64。E3 未修改该脚本；同文件单次隔离复跑 4/4 通过（/tmp/fly2484-hygiene-isolated.log）。这是独立回执，不把 full suite 改为绿。
- `codex:rescue` 通过 companion `task --fresh --prompt-file` 调用，未用 raw exec；启动失败：fs sandbox helper exit71 / sandbox-exec sandbox_apply Operation not permitted。没有审查结果。Lead c3982de8 明确无需重试，以 Bridge 精确头 request-review 为代码门。
- 新增审计失败 outcome 的 StateStore 回执测试先因 allowlist 拒绝而红，补入 `transient: publish_failed:audit_gateway` 后绿。无新表或 schema migration。
- 最后容量负向测试证明 raw HTML 刚好512KiB仍可能因 CSP hardening 超限；发布器现按 hardened HTML 加上一 hash 属性的最大字节开销再次拒绝，未写 Blob。发布器10测试通过。
- 本轮未新增 scripts/__tests__/*.test.sh。

最终 closeout lint exit0（14 既有 warnings）、pnpm -r build exit0，日志 /tmp/fly2484-closeout-lint.log 与 /tmp/fly2484-closeout-build.log。未取得本地 full-green；按 Lead c3982de8 不再重跑完整包，保留失败回执。

### 精确头代码审查 R1 修正

- R1 请求 a3212141-6778-4b4b-864d-a6bee74feae1，问题6a3d5714-6f06-47b2-bcec-db8bd70ff653，审查头035c06f06811f70645ba79bfa9508568b2513cd5，effective verdict CHANGES_REQUESTED。
- 唯一HIGH `empty-epic-counted-as-done`：仓库原fixture的无子单日常root被计入「全做完」。新增用例先红（hidden=1），最小修复只在counts.total>0时增加hiddenDone；无子单root继续按F1不列，真正终态Epic保持原计数。
- R1其余8条非阻断建议已向Lead报告（3409a84d-5da9-47ab-959e-d607672a1cdc）：delete-reports全扫描、网关手动部署、unavailable分支待接线、null标题、stream.cancel失败、SDK404死分支、audit数量常量、free blockerScope。未扩入本次修复。
- 旧头CI不能作为修复头回执；修复提交后将重新milestone-last、普通push、开新review gate并等待新头CI。
# QA 返工 epoch 4（2026-09-10，进行中）

QA claim 1017 在 cef15b9ce 判 FAIL：托管 audit footer 的 SHA-256 长串在 390px 撑破页面；旧 PNG 在 footer 引入前采集，不能证明托管版布局。Lead [lead-instruction 7e7b0b1f-9bca-4833-8148-574bcdbb4e6d] 限定为 footer 换行、counts 排序变异体断言和托管版 390/1440 PNG，其余 advisories 不动。

- `audit-bundle.test.ts` 对托管页 footer 的 computed overflow-wrap 新增回归，预期 anywhere、实际空串失败；补 `footer{overflow-wrap:anywhere}` 后通过。完整 SHA 与审计内容不删减。
- `founder-view.test.ts` 新增同状态根 EPX-10/20/30、live counts 1/3/0 的断言。插入降序 counts.live 排序键后仅该新测试失败（EPX-20 错到首位）；撤回变异代码后通过，生产排序器无改动。
- Epic suite 21 files / 257 tests 通过；`pnpm lint`、`pnpm -r build` exit 0。本轮未重跑已由 Lead c3982de8 豁免追绿的完整 package suite，历史 full 失败仍保留。
- 日志：`/tmp/fly2484-footer-red.log`、`/tmp/fly2484-footer-green.log`、`/tmp/fly2484-counts-mutant-red.log`、`/tmp/fly2484-rework-epic.log`、`/tmp/fly2484-rework-lint.log`、`/tmp/fly2484-rework-build.log`。
- `verify-hosted-layout.mjs` 使用独立 Chromium CDP 对托管输出断言 footer SHA 存在、scrollWidth <= clientWidth、首屏零展开，保存两档 PNG；`--without-footer-wrap` 用于复现缺陷。真实运行与图片检查尚待浏览器连接，不能以 DOM 样式测试替代视觉硬门。

## QA attempt 2 交接（恢复后）

最新任务明确视觉门由 QA 的真 Chromium 执行，实现沙箱不再重试浏览器。旧 Chromium 阻塞游标已被此指令取代；未产生新的 PNG，既有侧车前 PNG 不作托管版证据。

当前定向重验：21 文件 / 257 测试通过（/tmp/fly2484-resume-epic.log）。counts 变异红回执仍为 /tmp/fly2484-counts-mutant-red.log：1 failed / 11 passed；正式排序器仍只读 state.type 与 identifier。完整包保留先前失败与隔离通过回执，按已复核的 Lead c3982de8 不追本地全绿；rescue 初始化失败也不重试。

QA 在仓库根生成托管 bundle，再连接自己的隔离 Chromium：
```bash
pnpm exec tsx engineering/doc/FLY-2484-epic-card-render/replay-linear.ts /tmp/fly2484-qa/index.html
node engineering/doc/FLY-2484-epic-card-render/verify-hosted-layout.mjs --cdp "$QA_CDP_WS" /tmp/fly2484-qa/index.html /tmp/fly2484-qa/hosted
node engineering/doc/FLY-2484-epic-card-render/verify-hosted-layout.mjs --cdp "$QA_CDP_WS" /tmp/fly2484-qa/index.html /tmp/fly2484-qa/mutant --without-footer-wrap
```
正常路径须在390/1440均通过并保存PNG；移除footer换行的对照须在390报横向溢出。QA另按任务要求对旧头cef15b9ce做实物对照；脚本变异不能冒充旧头运行。脚本保留原位置参数兼容，新增任务规定的 --cdp 入口。

普通push前已fetch：origin/main=d6cda1fc1，是当前HEAD祖先；#1147/#1148仍OPEN。按Lead c3982de8 / 12b30083继续交PR，真实sibling接线仍等合入后的独立返工。

本轮 pnpm lint 与 pnpm -r build 均 exit0（/tmp/fly2484-resume-lint.log、/tmp/fly2484-resume-build.log）；QA脚本 node --check exit0。
