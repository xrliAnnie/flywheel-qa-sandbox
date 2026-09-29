# FLY-2922 设计交付验证（沙箱 slot-2 多轮） — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-29
基于: plan.md

> **阅读顺序：** 2026-09-27 的 verify-then-submit 与本文件前半历史收据已 superseded；当前有效设计证据从“QA@4 重开设计轮（exec 11c7ab0f）”开始。已删除的 `handin.zsh` 不得执行。

## 合同自检

- `zsh -n handin.zsh` exit 0；plan §3.4 与 `handin.zsh` 的 `diff` 为空（§3.1 的 awk 提取）。
- `DRY_RUN=1 zsh handin.zsh`（提交 d87806136 后，本机）：`DRY_RUN OK: A1-A8 PASS on 2dd29e0276617cf21e31ce4bfe2a4df792d8cf0a | PR body checked; missing markers: 92e28887`。exit 0；零写入（A0 只更新沙箱 remote-tracking ref）。
- R1 时用 `|| echo FAIL` 形式跑 A1–A7 曾出现 A7 FAIL 而整块 exit 0（Codex 复现），这正是改成脚本逐步检查退出码的原因。

### 最终 DRY_RUN

`DRY_RUN OK: A1-A7 PASS; A8=PASS (PR xrliAnnie/flywheel#1374 head == 2dd29e0276617cf21e31ce4bfe2a4df792d8cf0a; body missing markers: 92e28887; sandbox never edits the prod PR — missing items are host-side Lead work) | head 2dd29e0276617cf21e31ce4bfe2a4df792d8cf0a` (exit 0，提交 c48f6c156 的脚本)

## 本地交付页验证

- 文件 `founder-design.html`，  134346 字节；SHA-256 `549b01f4a904a70ca23d5b1212a5d1d1ecb1b7b3e120d501d942bee1533ea369`。
- 静态检查：`__CSP_NONCE__` 占位 1 处、`<script` 1 处、内联事件属性 0、`innerHTML` 0、自定义 CSP meta 0、外部 `src/href="http` 0、汇总首行标记 `【页面意见汇总】FLY-2922` 存在、评论框 8 个（每个 section 一个）、`location.pathname` 入 localStorage key 前缀。
- 脚本逻辑在 Node VM 用假 DOM 跑三组：正常剪贴板（写入 1 次）、剪贴板 promise 拒绝（回落 execCommand 1 次）、无剪贴板 + localStorage 抛错（回落 1 次、不崩）。长中文/emoji/含 `<script>` 字样的意见拆成 2 段，每段以标记开头、长度 ≤ 1800 字符。
- 三张图用本机 `mmdc` 11.12.0 渲染为独立 SVG 并内联：`--svgId FLY-2922-d1`（交卷流程）、`FLY-2922-d2`（核验对象关系）、`FLY-2922-d3`（上游已批准的恢复流程）；SVG 内无 http 引用、无 @import、无外部 image。这不是浏览器视觉 QA。

## 设计评审

- 首轮 request `023e256d-3188-44b1-9a59-a5848b7b547b`，thread `01a0e2e9-4f98-7502-b116-d377dd2fd8d6`，round 1 CHANGES_REQUESTED（high=1, medium=5），处置见 plan §9。
- 第二轮 request `d2c3ca1b-d42d-4405-8d3c-6103af5152e2`（plan blob `d427730d1`）CHANGES_REQUESTED（medium=1 low=1），处置见 plan §10。
- 第三轮 request `16de6265-85ff-4760-a120-5d785dadb51d`（plan blob `ad33389ff`）APPROVED，findings 全零；`design-review.json` 已按 manifest :4 写入，`await-codex-gate design` 结果见下方「门与发布」。

## 边界

未运行实现测试、未验证九类修复行为、未在沙箱开 PR、未改任何代码；生产 PR #1374 只读核对。托管发布与报告在评审通过后追加。

## 门与发布

- `await-codex-gate design`：`design review APPROVED for exec=8a9027c6-… (reviewer gpt-6-astra/xhigh, turn 01a0e3b1-7f6d-72a1-a69b-f344aaad5a96)`。
- 设计产物提交 `99b6e0c93` 已推送 `origin/project-slot-2-FLY-2922`。
- `publish-report --publish-only`：`{"url":"http://127.0.0.1:60111/fw-reports-9edb89/r/c78cd5676188c1a21784e8bcc8d62c4f/","reportId":"c78cd5676188c1a21784e8bcc8d62c4f","messageId":null,"delivered":false,"publishOnly":true}`（无频道消息为本任务预期）。
- 托管页核验：HTTP 200；`__CSP_NONCE__` 残留 0；单一 `<script nonce="262ad223…">`；CSP 中同 nonce 出现 1 次；标记首行 1、内联 SVG 3、外部 src/href 0。本地 SHA-256 `7df46ef3fad31ef9b947e2511b898c4c9c0fc2de2f17830ec60f8d11a2b7b2c7`；托管 SHA-256 `7034279871bd60b9ecd820b81e084f7ac1334a8bd82095668f2181e4c5698d0b`；把 minted nonce 换回占位后 `diff` 只剩 publish-report 注入的两行（`<meta name="robots" content="noindex">` 与 CSP meta），其余逐字一致。
- Lead 报告 `DESIGN-HTML ready: <url> | repo: engineering/doc/FLY-2922-unified-node-recovery/founder-design.html | issue: FLY-2922`，durable report `efa1eee3-9630-4cdf-8818-e6da1e75cf3f`。
- 下一步仅 `complete --route phase_design_complete`；本段不冒充该收据。

## 重派轮收据（exec 0edcc786，2026-09-27）

- 交付物核验：`founder-design.html` 本地 SHA-256 `7df46ef3fad31ef9b947e2511b898c4c9c0fc2de2f17830ec60f8d11a2b7b2c7`（与上轮相同）；静态检查占位 1 / script 1 / 内联事件 0 / innerHTML 0 / 自定 CSP 0 / 外链 0 / 标记 1 / SVG 3。
- 评审门：request `1a2e90ca-b426-403f-8bbe-c9efd513280c` 重绑 Round 3 turn，`await-codex-gate design` APPROVED（见 review-result.md「重派重绑」）。
- `publish-report --publish-only`：`{"url":"http://127.0.0.1:60111/fw-reports-9edb89/r/c836fe823b5ac62bff1c578522086f8d/","reportId":"c836fe823b5ac62bff1c578522086f8d","delivered":false,"publishOnly":true}`；托管页 HTTP 200，占位残留 0、nonce script 1、标记 1、内联 SVG 3。
- Lead 报告 `DESIGN-HTML ready: <url> | repo: engineering/doc/FLY-2922-unified-node-recovery/founder-design.html | issue: FLY-2922`，durable report `e1ed0464-9934-4394-9f97-63cdcade5ca6`。
- 上轮 `efa1eee3` 报告与 `c78cd567` 发布仍有效；本轮重发只为把收据绑到当前 exec。下一步 `complete --route phase_design_complete`。

## QA@4 重开设计轮（exec 11c7ab0f，2026-09-29）

### 当前事实与文档

- 权威只读审计：生产 PR #1374 / remote head = `6e21a123d34bb53ee29b8536503133d714f46435`，base `main@b165d649013d6b52899f395865e68d948c2f4831`，GitHub 为 `MERGEABLE/CLEAN`；精确头 CI run `36544821509` 的 `CI OK` 与展开 job 全绿。当前头同头 code-review gate 与 QA@4 真房证据仍未证明，计划未把前两项外推成 QA PASS。
- 刷新后的 exploration/research/plan 提交 `2f50b2fa1`；durable cursor 提交 `0f685feae`（design 4/5）；HTML/图提交 `a415b33f4`。全部已推 `origin/project-slot-2-FLY-2922`。
- plan 的中心合同：先重读远端并按 ancestor 决定是否 merge；review/CI/room/evidence 全绑最终 40 位 SHA；QA 自己选两个显式空槽，真实 Claude 设计评审，九步 driver 后保存 old→new dispatch 两层证据再 teardown。

### Founder HTML 本地验证

- `founder-design.html` 146225 bytes，SHA-256 `2cdf81efd0c61ab4677bcbda819062ff5df20855a8302bee8bddf7f575bbf7c9`。
- 静态检查：`__CSP_NONCE__` 1、`<script` 1、inline event 0、`innerHTML` 0、自定义 CSP meta 0、外部 HTTP src/href 0、card 9、textarea 9、汇总标记 1、内联 SVG 2。
- 两张图由 Mermaid source 本地 `mmdc` 11.12.0 渲染：`FLY-2922-d4` flow SVG SHA-256 `3620045dc6032388b015ebbf525a3d0095dd30d7fc27952fc5bafaaab66b3253`；`FLY-2922-d5` ER SVG SHA-256 `482ac5c6b4cda725835c97b91fdc6831071a6d162655f6c54d41a8816c768c9f`。页面零 runtime Mermaid/外链依赖。
- Playwright Chromium 在本地完整页面上验证：路径 scoped localStorage key、输入自动保存、reload 恢复、长意见拆 2 段、每段以 `【页面意见汇总】FLY-2922` 开头且 ≤1800 字、clipboard promise reject 时调用 `execCommand` fallback，page errors 为空。
- 1440px full-page screenshot 为 1440×6595；人工查看确认 Apple-light 布局、两张图已渲染、九张卡与评论输入均可见。该截图只用于本地视觉 QA，不冒充 hosted CSP 验证。

### Round 1 gate 状态（已被后续 CHANGES verdict 取代）

- `stage set design_review --plan .../plan.md` 后显式打开 gate question `0c9bc1c3-8c9a-4fb0-a5d8-f7acca2b8b88`，request-review `0cfeca03-fa17-4e78-b649-6bd17c5dce97` 已 accepted。
- 早期 `check` 曾返回 `not yet`；最终结果见下方“Round 1 设计评审与三域修订”，不能把本段误读为仍 pending。

### Round 1 设计评审与三域修订

- gate question `0c9bc1c3-8c9a-4fb0-a5d8-f7acca2b8b88` / request `0cfeca03-fa17-4e78-b649-6bd17c5dce97` 最终 `reviewVerdict=CHANGES_REQUESTED`。
- 两条 HIGH 已验证：当前 `test-slot-2` 是 `runnerMode=real, qaRunnerMode=stub` 的 QA sandbox，不能给生产 PR #1374 取得有效 review/completion；房内 QA 不执行 host tasks，再传 `--issue FLY-2922` 会让内层 design 递归收到当前生产任务。
- 修订后的计划分为 Production Implement、Host QA Controller、Inner Sandbox DAG 三个授权域。inner actor 只写 `flywheel-qa-sandbox`；host driver 使用 Lead 授权的 fixture issue，明确拒绝 FLY-2922；source 使用 owner 专属 isolated clone，`origin` 为 QA sandbox、`production` remote 只读 fetch exact head。
- 清理旧交接物：删除 `handin.zsh`、`handin-body.md` 与旧的 handoff/recovery Mermaid 文件；`review-result.md` 将 2026-09-27 的 plan approval 标成 superseded；`progress.md` 不再指向旧脚本。
- 测试清单改成生产头实际存在的六个 teamlead 文件，Vitest 参数使用 package-relative `src/...`；raw `test-deploy.sh --qa-stub-runner` 的 teardown 只走 `scripts/test-teardown.sh PRIMARY_SLOT`。

### 修订后的 Founder HTML 本地验证

- `founder-design.html` 192461 bytes，SHA-256 `3acd551a320f036d84950d65d9f36fcabca729f20237f98504e45f25e4d706a5`。
- 静态检查：`__CSP_NONCE__` 1、`<script` 1、inline event 0、`innerHTML` 0、自定义 CSP meta 0、外部 HTTP src/href 0、section card 9、comment textarea 9、汇总标记 1、内联 SVG 2。
- Mermaid 本地渲染：`FLY-2922-d6` flow SVG SHA-256 `30f70ce4d3b07c49ad2ff86f5736174be95378da243d5b43812598e314fe076f`；`FLY-2922-d7` ER SVG SHA-256 `b5a77cb116cf5a80aa9def9730dc3d5b3c5d1969c7f23369a0dc411f2e77592d`。均已内联，页面无 runtime Mermaid 或外部依赖。
- Headless Chrome 实页验证：9 cards / 9 inputs、2 SVG、路径 scoped localStorage、输入保存与 reload 恢复、长意见拆 3 段、每段固定 marker 且 ≤1800 字、clipboard promise reject 时调用 `execCommand` fallback、page errors 为空。
- 1440px full-page screenshot 为 1440×8463；人工查看确认 Apple-light 布局、三域流程、数据模型、九张评论卡均正常。尚未 publish/report/complete；必须先取得修订 plan blob 的新 APPROVED。
- 修订提交 `01f1fb46a` 已推 `origin/project-slot-2-FLY-2922`。gate question `f32da210-64ba-405f-8554-a15e3f52c909`、request `3240a3cb-8fd7-48f4-8c89-24215054a784` 后续返回 `APPROVED with advisories`；该裁决只覆盖当时 plan blob，不复用到本节后续修订。

## cwd-bypass 复审修订（exec e717d910，2026-09-29）

### 评审与运行事实

- 当前 activation gate question `06789ae1-dda9-4f84-85b8-147f3de10f16` / request `dfac902c-7e8a-4e7e-ac04-c2d0087792d6` 返回 `CHANGES_REQUESTED`；blocking HIGH 是旧 A1 只看 TURN 与 cwd，可被房内 actor `cd` 生产 checkout 绕过。
- 直接参数化读取 `$FLYWHEEL_STATE_DB_PATH` 的当前行得到 `test-slot-2|FLY-2922|design|/tmp/flywheel-test-slot-2/project-slot-2-FLY-2922`。用该可信行分别对 sandbox root 和 `/Users/xiaorongli/Dev/flywheel-FLY-2922` production root 执行 production-implement 判定，两者均拒绝；说明换 cwd 不改变 actor authority。
- 宿主只读进程检查确认 `qa-529-generalized-e2e.mjs 2 --issue FLY-2922 --real --timeout-ms 3600000` 仍活，campaign owner slot 2 借 slot 3。修订计划把它归为 recursive-fixture，要求房外 owner 先受控快照、精确 TERM、owner teardown；当前 inner 后继只走 `no_code`。

### Round 2 APPROVED 与 advisory 硬化

- gate question `00d3169f-6da3-42dc-9739-c2e3144b11a0` / request `fed7084b-43d7-4988-9d98-1252b6882cae` 返回 effective `reviewVerdict=APPROVED`，blocking findings 为 0。
- reviewer 的两个 MEDIUM advisory 可执行且已验证：`packages/teamlead/src/config.ts` 与 `packages/flywheel-comm/src/commands/verify-approval.ts` 都把 `$HOME/.flywheel/teamlead.db` 作为无 override 时的生产默认；旧 shell 示例没有 errexit，末尾 `git log` 可掩盖此前裸 `test` 失败。
- 修订后的 A1/QA preflight 使用 `set -euo pipefail`、带诊断的非零出口、Bridge 同序 DB fallback、slot realpath 拒绝、UUID 形态检查与 `sqlite3 -readonly` 参数化查询。
- LOW advisory 同步收口：production no-write 的权威证据是 remote branch SHA 与 PR `headRefOid` 前后相等；push-guard audit 只作辅助异常信号。
- advisory 改写产生新 plan blob，因此不复用 Round 2 approval，将新开 Round 3 取得对最终 blob 的明确 verdict。

### Advisory 修订验证

- A1 与 QA preflight 两段都通过 `bash -n`。在当前 slot-2 actor 上执行时分别以 40（`implement TURN not held`）与 60（`QA TURN not held`）立即拒绝，没有被后续命令掩盖。
- 清空 `FLYWHEEL_STATE_DB_PATH` 与 `TEAMLEAD_DB_PATH` 后，解析结果为 `/Users/xiaorongli/.flywheel/teamlead.db` 且文件存在；当前显式 slot DB 用 `sqlite3 -readonly` 参数化查询仍只返回 `test-slot-2|FLY-2922|design|/tmp/flywheel-test-slot-2/project-slot-2-FLY-2922`。
- `founder-design.html` 更新后 SHA-256 为 `66d7a2b7fde1b8e28228e013158b2a7637c7a099ef19722e9fbcb8d99a3c6b49`。静态检查保持 nonce placeholder 1、script 1、inline handler 0、`innerHTML` 0、自定义 CSP 0、外链 0、9 sections / 9 textareas、marker 1、内联 SVG 2。
- Headless Chrome 复验：路径 scoped localStorage、保存与 reload 恢复、3 个 ≤1800 字且均带 marker 的汇总 chunk、clipboard reject fallback、page errors 为空；截图 1440×10558，经人工查看布局与两张图正常。
- Round 2 advisory durable report：`3564163d-027e-40df-b54e-52df113f2e9b`。
- advisory 修订提交 `37ba93cdc` 与 cursor 头 `145cf6ca0` 已推送；Round 3 gate question `ec861d78-cd5b-47de-bb82-e709c6a61e85` / request `c540b3b5-4970-4e27-b7f8-b7eb3bf6de5d` 返回 effective `APPROVED`，reviewer verdict 同为 `APPROVED`，findings/advisories/settled 均为 0。delivery nonce：`b827c78a-a68f-4cfe-b6d8-99feccce31fb`。

### 文档与 Founder HTML 本地验证

- plan/research/exploration 已补：StateStore 参数化 identity gate、production QA 对称 gate、旧递归房处置、clone install + dependency build、HTTPS + sandbox default + production push disabled、明确 question ids、approve gate binding、一小时 driver timeout、生产未触达前后对照。
- 两张 Mermaid 图由本机 `mmdc` 重新渲染：flow 使用 `--svgId FLY-2922-d8`，SHA-256 `806534b43e8d71890227472a9e384738f515d3a6834d1cfb92a5cf2a9a82767d`；ER model 使用 `--svgId FLY-2922-d9`，SHA-256 `cfec37a49cdcad275d9403c092559cdb90399a79ff21a95e4c2af5287afe99ae`。
- `founder-design.html` 228047 bytes，SHA-256 `b27ff5f7af7e862058ef1d156f388200e2ff6808be6ef09f2e86656143bbbbbd`。静态检查：nonce placeholder 1、script 1、inline handler 0、`innerHTML` 0、自定义 CSP meta 0、外链 0、9 cards / 9 textarea、汇总 marker 1、两个新 SVG id 各 1。
- Headless Chrome 实页验证：路径 scoped localStorage、输入保存与 reload 恢复、长意见拆 3 段、每段 marker 正确且 ≤1800 字、clipboard promise reject 时 fallback 生效、page errors 为空；full-page screenshot 1440×10532。人工查看确认三域流程、identity/递归清场、证据模型、全部评论输入均正常。
- `git diff --check` exit 0；plan placeholder scan 为 0。尚未 publish/report/complete，必须先提交并取得当前 plan blob 的新 APPROVED。
- 修订提交 `862377f34` 已推 `origin/project-slot-2-FLY-2922`；新 gate question `00d3169f-6da3-42dc-9739-c2e3144b11a0` / request `fed7084b-43d7-4988-9d98-1252b6882cae` 已注册，首次 poll 为 `not yet`。
