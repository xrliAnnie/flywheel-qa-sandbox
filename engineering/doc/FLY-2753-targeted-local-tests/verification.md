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
