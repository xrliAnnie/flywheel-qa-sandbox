# FLY-2389 私有下载与保留期 — 调研
Issue: FLY-2389 (https://linear.app/geoforge3d/issue/FLY-2389/1143b2-r2-payload-托管-端点私有-bucket-验-key-薄端点entitlement-分级-presigned-get)
日期: 2026-09-09
基于: plan.md

## 有效评审收据

- 首轮 question：`24197080-096a-4965-a57f-645a6fdd84f1`。
- request：`378ae9e4-5e7e-4160-8e11-2332862d8e84`，round=1。
- `reviewVerdict=APPROVED`，`reviewerVerdict=APPROVED`。
- 7 MEDIUM + 3 LOW，全部为 advisories；settled=[]；无阻塞 finding。
- 被审 plan blob：`94accef02c6b80f663285c8b0a620b09f78766f4`，提交 `d541139d0`。plan 首行状态保留送审快照；最终有效结果是本收据，不是首行的旧状态。
- 已通过 `ask --report` 将全部 findingKey 报给 Lead，报告问题 id `6b2549a7-9d03-44ed-9e4c-9f2bdb2e6aa1`。本附录是完整的非阻塞建议交接，不冒充 Lead ruling，也不把这些建议标为已实现或已治理解决。

## 建议列表（由 Lead 决定后续处置）

| findingKey | 级别 | 评审指出的问题 / 后续建议 |
|---|---|---|
| missing-serve-mjs-consumer | MEDIUM | C2/C4 直接调用方清单漏 `packages/payload-endpoint/__tests__/serve.mjs` 与 `scripts/__tests__/payload-promote-controls.test.mjs`；显式 delivery 依赖也必须传入它们，见下方实核清单 |
| cleanup-cron-red-before-activation | MEDIUM | 新 schedule 在未配置凭据时会每小时失败；建议借用 beta preflight 的显式未激活 skip，或激活 PR 才加 schedule；不得把 skip 当清理成功证据 |
| shared-concurrency-cancels-founder-dispatch | MEDIUM | cleanup 与 release 共用 concurrency group 可能挤掉 pending founder dispatch；建议 cleanup 使用独立 group，CAS 保留并发正确性 |
| full-validator-on-customer-hot-path | MEDIUM | 全量 validator 对只增账本中的 tombstone/versions/ops 嵌套扫描；建议明确读取预算或收窄读路径验证，避免随历史增长耗尽 Worker CPU |
| contract-503-vocabulary-not-amended | MEDIUM | CONTRACT.md §8 的精确 503 返回词汇也需随新增异常状态修订，并以字节断言锁定；只改权限/视图表不够 |
| cache-control-override-unasserted | MEDIUM | 真 R2 联合验收还应断言既有无 cache metadata 对象经签名 GET 返回的 Cache-Control，不能用本地假对象响应证明平台支持 override |
| r2-403-mapped-to-key-invalid | MEDIUM | 当前壳会把跨域跳转后的 R2 403 当授权码失效并要求重贴 key；建议区分对象端 403 与验权端 401，避免有效授权码被误导轮换 |
| repin-after-deadline-unenforced | LOW | 图中“到期前回指”未被现有 transition 强制；已到期但尚未被 cleanup stamp expired 的 active entry 仍可回指。需明确允许并重置还是拒绝，再补该边界夹具 |
| aws4fetch-expires-default-86400 | LOW | C2 红测试应显式对抗库默认 86400 秒，先解析 query 断言 X-Amz-Expires<=60，再完成短效签名实现 |
| lifecycle-set-replaces-existing-rules | LOW | lifecycle set 全量替换配置；部署前需要 diff 活规则与受审 JSON，未知规则即使无害也不能被静默覆盖 |

## 补充消费者实核（同轮实际查询）

在评审返回后执行 `rg -n 'handleRequest\(' packages/payload-endpoint scripts/__tests__/payload-promote-controls.test.mjs`，排除定义/注释后共有五个直接调用点：

| 调用点 | 计划要求的显式模式 |
|---|---|
| `packages/payload-endpoint/src/worker.mjs:17` | presigned |
| `packages/payload-endpoint/src/serve-node.mjs:54` | stream |
| `packages/payload-endpoint/__tests__/harness.mjs:89` | 原 harness stream；专用 presign 测试显式注入 signer |
| `packages/payload-endpoint/__tests__/serve.mjs:226` | stream；承载 contract-consistency / key-cleanup / B1 pipeline 脚本夹具 |
| `scripts/__tests__/payload-promote-controls.test.mjs:126` | stream；保留 B1 promote 控制测试 |

后两项补足原计划 C2 文件枚举，执行时不得用隐式 stream fallback 掩盖遗漏。本补充不改变已审显式 delivery 合同。
