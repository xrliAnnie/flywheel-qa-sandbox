# FLY-1354 Cycle-Time mocks — 设计原型(design prototype)

Issue: [FLY-1354](https://linear.app/geoforge3d/issue/FLY-1354) · 日期: 2026-07-17 · 基于: 上游 FLY-1343 prd.md §4.1 + mockup.html

## 这是什么

两个**低保真样子稿**(mockup-first),给 Annie co-eval 方向 → 交 Tadashi 建。**不是生产实现。**

- `cycle-time-dashboard.html` — 面 1:折进管理台(:9876)的「周期时间」页签(P50/P90 + 趋势/前后对比 + 瓶颈排行 + 并发×load 占位 + 在跑单 live 条)。
- `daily-report.html` — 面 2:三合一每日报告(token + 完成 digest + 每单耗时,②③ 合并一张表)。
- `index.html` — 索引;`serve.mjs` — 本地静态服务(每请求重读文件)。

跑起来:

    node serve.mjs   # → http://127.0.0.1:9354

## 数据纪律(Annie 红线)

- **真值** = 每单周期时间(开单→ship 墙钟)· 各分段 mini-bar · 等待/干活比 · 瓶颈排行 —— 来自 FLY-1327 已测采集工具跑出的 8 张真实 issue(as-of 2026-07-17)。
- **MOCK 示意** = 全部 token/成本 · 报告日期分组 · P50/P90 环比 · 趋势箭头 · 在跑单当前态 · 改进单上线锚点 · route/PR/summary/计数 —— 页面内**就地标注 MOCK**。
- 不发明 §4.1 度量最小集之外的新指标。

## 交互契约(Annie 硬规矩)

- 每 section 留言框(建/不建/待定 + textarea,localStorage 自动保存)+ 底部一键复制回传 + 签名。
- **FLY-930 nonce**:`<script nonce="__CSP_NONCE__">` + 全 `addEventListener`,**零 inline handler**(Lead 经 publish-report 投递时 CSP 生效,inline handler 会被拦)。
- Apple 浅色零暗色;单文件自含;纯 HTML/CSS/内联 SVG,不引第三方库。

## 建造参照

- 面 1 = FLY-1343 §4.2 B2 「Dashboard 时间线页签」长相定稿(去 View A 历史逐单、加 P50/P90、折进 console 外壳)。
- 面 2 = FLY-1343 §4.3 B3 「每日报告集成」长相定稿(开 dark 的 digest + join per-issue 耗时 + token-usage issue 桶)。
- 字段来源 / 窗口 / 可建性见同目录上级 `../plan.md §3`。
