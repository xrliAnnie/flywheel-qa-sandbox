# FLY-2753 本机定向验证 — 调研
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: plan.md

## 设计阶段实测记录

- TURN：design / epoch 1，执行 `5a74cc4f-af10-4a44-b04a-bbbc8fa7b57d`。
- 探索/调研/计划已提交：`428a4d797`；HTML、Mermaid 源与留言验证脚本：`5420ef639`。
- `pnpm lint` exit 0，1894 files，14 个现有警告；未修改无关文件。新增文档验证脚本另做格式检查。
- `node engineering/doc/FLY-2753-targeted-local-tests/verify-html.mjs`：14 项检查通过，覆盖静态结构、按页面隔离的存储、恢复、存储拒绝、长文本分段、复制全部以及 clipboard 缺失/拒绝时的回退。使用实际 inline JS + Node VM 的 DOM 替身，**没有宣称真实浏览器验证通过**。
- Mermaid 本地渲染两次均 exit 1：Chromium `bootstrap_check_in ... Permission denied (1100)`。按任务允许的降级规则保留 `flow.mmd`，HTML 使用 `DIAGRAM PENDING LOCAL RENDER`。没有远端渲染或伪造图。
- `git diff --check` 通过。
- 本阶段只写设计目录，没有改产品代码、守则或运行本机全量测试；build/typecheck 不适用，因为没有编译资产变更。

## HTML 发布

提交后的 `founder-design.html` 已通过注入 CLI 的 `publish-report --project test-slot-1 --publish-only` 发布：

http://127.0.0.1:61308/fw-reports-5e694e/r/3d736997c050fd95dd312acc2517206c/

返回 `reportId=3d736997c050fd95dd312acc2517206c`、`publishOnly=true`、`messageId=null`。`delivered=false` 与禁止发送频道消息的要求一致，不解释成频道投递成功。这是 slot 返回的 loopback 托管地址，不宣称手机/公网可访问。

读取托管页：HTTP 200；`__CSP_NONCE__` 无残留；单一 script nonce；CSP 包含匹配 nonce；页面 9836 字节。已运行 `ask --report "DESIGN-HTML ready: ..."`，报告 id `eb718ab5-a0e1-48b7-a1b9-f6512e9bf141`。本地渲染失败也已单独报告。

## R1 评审及修订

- 设计评审 gate：`f9d65e54-60a4-4c92-ab02-534d9ee34d1a`，request `a2979284-a1a9-46d2-9092-be619d7007c8`。R1 有效 verdict = CHANGES_REQUESTED，完整反馈保存在 design-review-r1.json。两项 HIGH 已按仓库证据修订：当前 config 路由的 executor 文件才是本仓实施对象；假绿守卫直接进入最终规则文字。所有 advisories 一并处理：CI 证据按目标实际任务、文件存在检查 fail-closed、限制消费者搜索范围、逐项盘点 helper/skill 残留。下一轮批准前仍不得完成设计阶段。
- Lead 目标澄清：`70231531-d5e3-4be0-ba98-0b1eb23397ad`。当前 sandbox 有实际生效的 executor 入口，应在该授权范围继续，不等不存在的生产节点。生产三份 nodes 与同步验收仍按单独目标记录，不算作本分支成果。
- 后续：处理评审、记录裁决，必要时更新并重发 HTML；提交/push 最终记录，运行精确阶段完成命令，再 park。目标澄清若未解决，必须明确交接给后继节点，不写成实施完成。

修订后的 HTML 将重新提交、发布并报告，旧 URL 仅保留为 R1 历史，不代表最新设计。

## R2 提交与最新交付

修订提交 `7a526e2fb` 已推送。四个计划命令块通过 `bash -n`；五个实际入口文件经 `git cat-file -e HEAD:<path>` 与工作树存在性核对通过。HTML 留言脚本 14 项检查再次通过。

第二轮 gate `220b6002-630e-4d22-ab37-ad91506160e5`，request `c338c95f-cfb8-45e8-b722-4bf540f0363f` accepted，当前待有效裁决。

最新托管页（替代 R1 页面）：
http://127.0.0.1:61308/fw-reports-5e694e/r/c765bc108893c4cc49d087da12a02d9e/

`publishOnly=true`；HTTP 200、单一 script nonce、占位符无残留、匹配 CSP、修订内容均已核对。DESIGN-HTML ready 已报告 Lead，receipt `b05b072d-af4b-43a5-9a0c-725dd14cd4fb`。本地 Mermaid 渲染限制仍存在，按规定保留明确占位与源码。

## 最终设计裁决

第二轮 `reviewVerdict=APPROVED`、`reviewerVerdict=APPROVED`，gate `220b6002-630e-4d22-ab37-ad91506160e5`，request `c338c95f-cfb8-45e8-b722-4bf540f0363f`，完整响应见 `design-review-r2.json`。原有“待裁决”文字是各轮当时记录；现以本节及 JSON 为准。

三个非阻塞 advisories 已以 `ask --report` 报告 Lead：
- `injected-skill-testcommand-still-full-suite`（MEDIUM）：评估项目级 `skills.test_command`，避免注入技能与角色规则冲突。
- `contract-test-underasserts-4th-file-and-fail`（LOW）：加强 QA 红灯职责/helper 断言、让临时副本负例能使用同一检查函数。
- `dependents-filter-overbroad`（LOW）：前置 `...<pkg>` 包含自身及传递依赖方，不是仅直接依赖方；实施证据须列真实选中包。

按有效评审合同继续交接，不把 advisories 自行升级成门，也不在批准后悄悄更改计划范围。HTML 仅更新裁决状态及建议摘要。Lead 目标问题仍未答；实施按批准计划的当前真实路由范围推进，生产节点/同步检查未在本分支覆盖，交接必须保留该边界。

## 最终 HTML 发布及完成前审计

最终 HTML 内容提交 `82b529b76` 已推送后发布。最新（最终）页面：
http://127.0.0.1:61308/fw-reports-5e694e/r/74408bf4ec4a6a14354754d87c4aa3ec/

报告 receipt `2bedc10a-ef2d-4dd5-b6af-c0857f754735`，命令严格使用 `publish-only`。HTTP 200、nonce 替换、单脚本、CSP 匹配、已批准状态和建议摘要都已在托管页复核。

设计交付要求审计：exploration/research/plan 及规定页首齐全；有效 R2 APPROVED 已保存；进度 5/5；HTML 已提交、推送、发布并结构化报告；本地 Mermaid 两次失败按明文 fallback 保存源码与占位；14 项留言检查通过，浏览器真实渲染未验证的限制已披露。分支变更限于本 issue 设计文档目录，未实施、派发后继、申请 ship 或合并。下一步执行 `complete --route phase_design_complete` 后 park；阶段完成不等于 issue 终结。

## 2026-09-20 重新派发设计验证（本节为本轮当前状态）

执行 `dfd18c56-9466-4361-be52-0b3cee49a4a8`、run `7ceaee87-c0cd-4340-8a7d-00d5e5f76701`，取得 design TURN / epoch 1 后，从保留头 `6b987d1b1` / PR #206 继续。前文审批、发布、完成审计均属于前轮历史，不替代本轮 gate。

- 当前设计修订 `673b5de41` 已提交并推送，只改本 issue 设计目录。原生产三份节点及投影验收明确仍是 issue 必需范围；当前 sandbox 未覆盖，已提问 Lead `7889b4bc-48fa-48ae-99eb-e10bae2e7981`。
- 重新运行 `pnpm lint`：exit 0，1897 files，14 个现有警告。未执行本机完整包套件；文档没有编译产物变化，build/typecheck N/A。
- 既有定向 shell 合同：四个 prompt 文件检查通过，七种负例全部拒绝。它证明文字规则与回归守卫，不证明真实 runner 行为或远端 CI。
- HTML 验证：14 项静态/Node VM 检查通过；三份文档页首符合要求，计划四个 shell 命令块通过 `bash -n`；`git diff --check` 通过。
- Mermaid 使用 mmdc 本地渲染，再按 `-w 1000 -b white --svgId FLY-2753-d1` 重试，两次均因 Chromium `bootstrap_check_in ... Permission denied (1100)` 失败。保留 flow.mmd 与明确的 DIAGRAM PENDING LOCAL RENDER 占位。没有远端渲染。真实浏览器外观/CSP 执行仍未验证。
- 新 gate `11bface8-3042-49ea-8f2e-6fbfd2eb561a`，request `37382311-d376-4a1c-a602-d3b90f05c686` accepted；待有效 reviewVerdict。
- 当前 HTML 已以 publish-only 发布： http://127.0.0.1:53682/fw-reports-de07d0/r/7c79ca7feab74e6628b8f220058cc709/ 。这是隔离 slot 的 loopback URL，不宣称公网可访问。verify-report 证明 HTTP 200、占位符替换、单脚本 nonce 与 CSP 匹配；没有发送频道消息。
- DESIGN-HTML ready 结构化报告 receipt `80c4a6c8-4ecd-4665-80c4-4abd584e6f59`，包含渲染限制和当前评审 pending。批准后再更新最终状态并发布报告。

## 本轮 R1 返回与修订证据

Gate `11bface8-3042-49ea-8f2e-6fbfd2eb561a` 返回有效 CHANGES_REQUESTED；完整响应保存在 design-review-resumed-r1.json。唯一 HIGH 为 `node-test-name-pattern-false-green`：命名测试缺失时 Node 可 exit 0。本轮通过临时 fixture 复现，并把 §5 改为测试名预检 + TAP 精确非跳过成功行断言。

逐字提取计划中的命令，在临时仓库 fixture 上验证六种情形：pass exit 0；renamed、comment-only、failure、skip、todo 均 exit 1。四个 shell 块通过 bash -n。初次 fixture 因宿主默认 TMPDIR 在沙箱外而失败，改成显式 /tmp 的唯一 mktemp 文件后六项通过；不修改宿主环境。

同时修复两个 LOW 的文案与 grep 集合一致性。三个 MEDIUM 的未实施建议/边界在计划 §8 单独列明，不声称已完成 CI wiring、技能注入配置或自动脚本存在性守卫。本阶段仍只改设计文档。

## 本轮 R2 最终设计裁决

Gate `ef0bcbf7-4147-4dd8-af81-72bacb824a27`，request `711bfb1b-b7f6-4b2a-a199-eda7d0fec169`，有效 reviewVerdict 与 reviewerVerdict 均为 APPROVED。评审确认 `00bcc4f6f` 的唯一 HIGH 已修复。完整响应见 design-review-resumed-r2.json；不再修改获批 plan。

五项非阻塞 advisories 已向本轮 Lead 结构化报告：CI 未接新合同、注入技能默认命令仍冲突、缺脚本指引未进入长期守则、TAP 嵌套子测试会误红、真实测试失败时 TAP 诊断可能被清理。它们保留为已知建议，不宣称已实施，不自行升级成评审阻塞项。HTML 更新为本轮已批准，并准确披露限制。生产目标澄清仍待回答，原题生产验收不能被当前 sandbox 成果替代。

## 本轮最终 HTML 发布与完成审计

最终 HTML 内容提交 `3a80774c5` 已推送，再以 publish-only 发布：
http://127.0.0.1:53682/fw-reports-de07d0/r/64e80e0a2cfaf68a3859b5ca4b6a12b5/

verify-report 返回 ok=true、HTTP 200、noncePlaceholder/scriptCsp/scriptNonce/批准状态文本均 pass。DESIGN-HTML ready 报告 receipt `631f751a-72e8-4479-a997-f48cb908e935`；advisories 报告 receipt `7d5177d6-cc05-47db-a6d2-353eefceebbf`。没有发送频道消息；loopback 可访问性和本地 Mermaid 降级限制已披露。

完成审计：三份上游设计文件与规定页首已保存；本轮 R2 有效 APPROVED；计划保持审批版本不变；HTML 最终状态、七节留言层及 14 项定向检查通过；既有本机 lint 和规则合同证据保留，未跑全量；HTML 已提交、推送、发布、验托管并报告；进度更新 5/5。所有本轮工作树变更限于本 issue 设计目录。下一步提交推送本记录，执行精确 phase_design_complete 路由，然后 park。此审计只证明设计交付，原题生产投影与最终 CI 仍须相应授权节点验收；不申请 ship、不实现、不调度后继、不终结 issue goal。
