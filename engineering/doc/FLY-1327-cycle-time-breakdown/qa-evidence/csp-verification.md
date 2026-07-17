# FLY-1327 周期时间分解 — CSP 验证
Issue: FLY-1327
日期: 2026-07-17
基于: plan.md

## Production hardening path

使用生产代码 `packages/teamlead/src/bridge/report-registry.ts::injectHeadMeta` 对报告注入固定 QA nonce：

- `__CSP_NONCE__` placeholder 全部消失；
- 仅有一个 `script nonce="FLY1327QA"`；
- CSP 包含 `script-src 'nonce-FLY1327QA'`，并保持 `default-src 'none'`；
- hardened HTML 小于 publish-report 的 512 KiB 上限。

静态 contract、escape、无 inline handler、namespaced localStorage、clipboard fallback 由 `render.test.mjs` 覆盖。

## Browser limitation

本 implement sandbox 内的 Chromium / Chrome 启动被 macOS bootstrap 拒绝：`MachPortRendezvousServer ... Permission denied (1100)`；因此这里**不声称**已完成真浏览器的正向交互 + 去 nonce 突变验证。该项留给独立 QA phase 在可启动浏览器的 runner 上执行；发布后仍需以 hosted URL 的真实 CSP 为准。
