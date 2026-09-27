# FLY-2922 设计交付验证（沙箱 slot-2 重派轮） — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-27
基于: plan.md

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
