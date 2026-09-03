# FLY-2276 托管交互报告自动 CSP nonce — 探索
Issue: FLY-2276 (https://linear.app/geoforge3d/issue/FLY-2276/publish-report-托管页注入的-csp-默认-default-src-none-无-script-src作者不写-csp)
日期: 2026-09-03
基于: 无

## 现象与用户影响

`publish-report` 接受完整 HTML 后，Bridge 的 `ReportRegistry` 会在 `<head>` 中补安全策略。当前默认策略是：

```text
default-src 'none'; style-src 'unsafe-inline'; img-src data:;
```

如果作者写了 inline `<script>`、但不知道 `__CSP_NONCE__` 约定，发布仍会成功，浏览器却从 `default-src 'none'` 继承脚本限制并静默拦截所有 inline JavaScript。HTML 和 CSS 正常显示，因此按钮、标签页、留言框、`localStorage` 草稿等交互会呈现“看起来完整但全部失效”的危险状态。

## 期望体验

作者交给 `publish-report` 一份无 CSP meta 的完整 HTML 时：

- 纯静态报告维持现在的严格 CSP，不新增 `script-src`。
- 含 inline `<script>` 的报告无需知道私有占位符约定；发布端为所有 inline script 注入同一个本次发布随机 nonce，并注入 `script-src 'nonce-<真值>'`。
- `<script src=...>` 不获得自动 nonce，仍被 `default-src 'none'` / nonce-only `script-src` 拒绝。
- 已自带 CSP meta 的页面仍由作者的 CSP 决定；发布端不改写它。
- 已使用 `__CSP_NONCE__` 的现有页面继续走原有替换路径。
- `verify-report` 必须同时证明 script tag 有 nonce、CSP 也允许 nonce 脚本；不能再把“标签有 nonce、策略却无 `script-src`”判成通过。

自动路径只授权 **publish 当刻已经存在** 的可执行 inline script。托管页是冻结的静态文档、URL 不可猜，发布后没有注入入口，因此这些块等价于作者逐块 opt-in；发布端不会给以后动态创建的 script 自动加 nonce。与此同时，`publish-report` 的 HTML 是**受信任生成物边界**：所有进入 HTML 的 issue、PR、网页、用户输入等动态数据必须先 HTML-escape。漏转义的 `<script>` 会被视为作者在 publish 前放入的脚本；这段威胁分析必须写入代码合同。

## 范围与假设

1. 只改 `publish-report` 托管链路的 HTML hardening 与对应 `verify-report` 检查，不增加 CLI 参数、配置项或 feature flag。
2. 不改报告 deploy/commit 事务、Vercel 路径、Discord 投递、截图、权限和 512 KiB 限制。
3. 不改 FLY-2283 正在处理的 7→14 天保留逻辑。
4. “可执行 inline script”定义为真实 `<script ...>...</script>` 元素、opening tag 没有 `src` 属性，且 `type` 缺失/为空、为 `module`，或为 JavaScript MIME。`application/ld+json`、`text/template` 等 data block 不触发 `script-src` 放宽。
5. 自带 CSP meta 的页面保持现有行为，包括作者自行承担 CSP/script 对齐；本单只在 CSP 缺失时自动补齐。
6. 源 HTML 没有 CSP 时，已有的普通 nonce 没有策略意义；自动路径可把所有可执行 inline script 的 nonce 归一为本次发布真值，确保每一个都能执行。
7. nonce 不授权 `onclick=` 等 inline event-handler 属性。发布端在准备注入默认 CSP 时检测到这类属性必须直接拒绝，并提示改用 nonced script 内的 `addEventListener`；不自动改写 handler。

## 成功判据

- 单元测试先复现：无 CSP、无 nonce 的 inline script 当前被配上 no-script CSP。
- 修复后，同一输入的每个 inline script 都带同一随机 nonce，CSP 保留 `default-src 'none'` 并增加匹配的 `script-src`。
- 外链 script 的 opening tag 不被加 nonce。
- 动态文本中的 `&lt;script&gt;` 保持惰性，代码注释同步声明“所有 publish-report 消费者必须 escape 不可信动态内容”的硬前置。
- 无自带 CSP 的页面出现 `onclick=` 等 inline handler 时，发布在 deploy 前非零/HTTP 400，并给出 `addEventListener` 修法。
- 占位符约定与纯静态报告输出行为不回归。
- `verify-report` 对“有可执行 inline script、CSP 无 `script-src` 或 nonce 不匹配”返回非零并给出可执行修法。
- 用 `publish-report --publish-only` 真发一个无 CSP、无 nonce、带按钮的 HTML，在托管 URL 上验证点击会改变页面状态。
