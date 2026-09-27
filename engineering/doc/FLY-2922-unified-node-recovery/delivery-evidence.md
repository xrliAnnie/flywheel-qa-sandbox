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
- 第三轮结果在收到后追加于 review-result.md。

## 边界

未运行实现测试、未验证九类修复行为、未在沙箱开 PR、未改任何代码；生产 PR #1374 只读核对。托管发布与报告在评审通过后追加。
