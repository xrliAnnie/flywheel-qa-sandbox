# FLY-1463 Ship-gate 交付 interactive ship-report HTML — QA 报告

Issue: FLY-1463 (https://linear.app/geoforge3d/issue/FLY-1463/机制founder-可见-ship-gate-交付-interactive-ship-report-html-qa-pass-时随-gate)
日期: 2026-07-24
基于: plan.md · 验证 head 8f524845 (origin/flywheel-FLY-1463)

## 结论：PASS

机制成立且可用。契约（qa-executor.md + 模板）被 CI 守卫钉死；投递管道（`--issue` → 解析 parent thread、多 Lead 歧义 fail-closed、绝不 fallback 大频道、byte-compat）单测/集成全绿；**这一页本身在真实 Vercel hosting 的严格 CSP 下真渲染并可交互**——Annie 亲定的四条验收 + localStorage 隔离全部在真机上过。

## 验证 head
- `8f5248456d3c7711dbd2ec5af0f4981dc0ad6821` — local == origin/flywheel-FLY-1463（PASS 前已复核，未漂移）。
- QA 全程只读源码；工作树 clean（改动仅落 scratchpad + /tmp fixture）。

## Tier 1 — 静态 + 单测/集成（自跑，非信实现者）
| 套件 | 结果 |
|---|---|
| `scripts/__tests__/test-qa-executor-ship-report-contract.sh` | 24/24 PASS（md 11 锚 + 模板 8 断言 + 40k 字节预算） |
| `packages/flywheel-comm` publish-report.test.ts | 28/28 PASS（含真子进程 CLI：`--channel`/`--issue` 互斥、非法 issue 号发布前拒、byte-compat 无 `issueIdentifier` 键） |
| `packages/teamlead` reports-route.test.ts | 36/36 PASS（真 express+真 HTTP：issue thread 解析成功 / 无命中 404 且**绝不发 generalChannel** / channelId+issue 互斥 / 非法 issue 号 400 / 现行 generalChannel fallback byte-compat） |
| `packages/teamlead` report-issue-thread-resolver.test.ts | 3/3 PASS（唯一命中 / 多 Lead 歧义→undefined / 无项目·无 thread→undefined；用 session canonical issue key） |
| `pnpm build`（flywheel-comm + teamlead） | 干净通过（`resolveIssueThread` 现为 required field，tsc 全 call-site 通过 = 无 caller 遗漏） |
| `biome lint`（5 改动文件） | 0 issue |

## Tier 2 — 真机 hosted CSP 交互 E2E（Claude-in-Chrome，founder 面）
把本报告本身用 `.flywheel/templates/ship-report-template.html` 走真实 QA 作者流程填成 FLY-1463 的 ship-report（3 张真 mmdc 11.12.0 渲染的 Mermaid inline SVG + 填全 slot），发前四连自查全过（nonce=1 / prefers-color-scheme=0 / textarea[data-k]=7 / 64358<491520B / onclick=0），再经**byte-compat 的 publish 路径**发布到真 Vercel hosting，用 Claude-in-Chrome 打开真链接验证：

| 验收（Annie 亲定） | 真机证据 | 结果 |
|---|---|---|
| CSP 下脚本能跑 | hosted 页 `__CSP_NONCE__` 已换真 nonce `dd38659e…`，meta CSP `script-src 'nonce-…'` 与 `<script nonce="…">` **逐字匹配**；init `#feedback-output` 已被页面自身脚本 `render()` 填成 `SHIP-VERDICT: undecided…`（只有页面脚本会产生）；console 零 CSP violation | ✓ |
| ① 区域留言 → Lead 能定位区域 | 在诚实边界框真键盘输入 → 点复制 → 载荷含 `## qa-boundary · 诚实边界` + 原文；localStorage 真持久化（input/change listener 触发 save），reload 后原文回填 | ✓ |
| ② 勾"不 Ship" → Lead 收到打回 | 真点"不 Ship" radio → 复制载荷首行 `SHIP-VERDICT: no`；localStorage `verdict:"no"`，reload 后仍选中 | ✓ |
| ③ Mermaid 真渲染 | 3 张 inline SVG 全部 layout 可见（1020×180），病根/新路径/数据流三图；SVG id 已 namespace 防同页冲突 | ✓ |
| ④ 529 GIF/link 真可见 | 529 thread link (`linear.app/geoforge3d/issue/FLY-1463`) 可点；529 证据 img（data: URI，合 `img-src data:`）可见 | ✓ |
| localStorage 跨报告隔离 | 发第二份不同 path 报告 → 打开后诚实边界框空、verdict none、无 A 的 marker；A 数据仍在 A 的 key 下（`location.pathname` 键隔离生效） | ✓ |

复制载荷实测原文：
```
SHIP-VERDICT: no
ISSUE: FLY-1463
REPORT: https://fw-reports-a53de2.vercel.app/r/f25a7ad596169499be293924a69c1bec/

## qa-boundary · 诚实边界
BOUNDARY-COMMENT-MARKER-A1 这个边界我不放心：ship 前必须补真机 Discord 投递 E2E。
```

## 代码审读要点（无缺陷）
- deliver 边界：`channelId+issueIdentifier` 互斥、非法 issue 号，两处都在 **resolve/post 之前**拦（400），单测覆盖。
- 解析器：`getSessionByIdentifier(id)?.issue_id ?? id` 取 canonical key；per-distinct-Lead-channel 查 thread，收集 distinct thread_id，**恰好一个**才返回，0 或 >1 一律 fail-closed（不猜 primary Lead，不误投别部门 thread）。
- byte-compat：不带 `--issue`/`--channel` 时 deliver body 无 `issueIdentifier` 键、走原 generalChannel fallback，逐字不变（单测 sentinel）。
- 引擎**不加 gate/flag**：Bridge 不校验"PASS 带没带 HTML"、不阻塞任何 verdict（Annie 铁律，同 FLY-1461 自持有招）。

## 诚实边界（没测什么 / 为什么 / 何时补）
1. **未跑"真 publish-report --issue 把消息投进真 Discord thread"的全链 E2E。** 原因：生产 Bridge 跑的是 main（尚无本分支的 `issueIdentifier` 逻辑），拿它测等于测旧码；起隔离 Bridge 属 529 房级重活。该投递逻辑已被真 express+真 HTTP 的 39 条集成测试逐路径覆盖（解析成功/404-fail-closed/互斥/byte-compat）。为不触碰生产，真机段用 `--publish-only`（发布到真 hosting 但**不发 Discord**）——聚焦在 founder 真正会看到的这一页 HTML 的渲染与交互。
2. **未跑多 Lead 房 529 N-to-N。** 原因：此改动的 Discord 面很窄，只是往"已解析出的单一 issue thread"发一条报告消息，不触发多 Lead relay/roundtable/render 拓扑——529 N-to-N 验的是那套拓扑，对此单线程投递不是对口证据。**故此改动无 N-to-N 面，已用真 HTTP 集成 + 真机 hosted CSP 交互替代，非静默跳过。**
3. **补测建议（上线后）**：真 ship 部署本分支后，在真 ship 上按验收①② 走一遍（Annie 留一条评论→Lead 收到并定位区域；勾不 Ship→Lead 收到打回），作为上线确认。这也正是 issue 验收原文"做完在真 ship 上跑一遍"的落点。

## QA 产出的真机 fixture（无 Discord 副作用，isolated hosting，noindex + retention 自动过期）
- 报告 A：https://fw-reports-a53de2.vercel.app/r/f25a7ad596169499be293924a69c1bec/
- 报告 B（隔离对照）：https://fw-reports-a53de2.vercel.app/r/7ce1e6145aa4a8a5d8217bd6db55ceba/
