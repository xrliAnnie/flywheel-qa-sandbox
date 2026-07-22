# FLY-1392 收据地基 — 验收证据
Issue: FLY-1392 (URL 不可得,只写 issue 号)
日期: 2026-07-21
基于: plan.md

> **最终口径:** 对外只验“Lead 办了没有”。`delivered_at` / `processed_at`
> 只是内部到达/办结时间戳;本文件旧轮次的分层说法与协议归因证据已由
> `design-correction.md` 废除。

> **2026-07-21 失效标记:** founder 在此证据形成后改型为纯 Lead 枢纽;
> 下方关于「协议层归因 / Lead 模型巷」的结论只证明旧 head,不能用于 ship。
> 必须以 plan.md 顶部 override 和其后的 fresh QA report 为准。

> **回退开关补充:** `FLYWHEEL_RECEIPT_FOUNDATION=0` 仅是事故紧急临时
> 逃生阀;Bridge 必须在启动时与每小时发出
> `receipt_foundation_off` severe 告警,不得静默运行旧直转拓扑。

## Founder 改型实现轮(待独立 QA 复测)

- F-2/F-3/F-5 默认路径均变为 founder 原文→Lead:Bridge 不读 card binding、
  不跑 ship classifier、不生成 `bridge-protocol` response/evidence、不写 runner wake。
- Lead 运行 root-only `route-founder-reply` 后,同一 CommDB 事务写 response、
  `lead_routed` handled evidence(`actor_kind=lead`)、family 收口与 wake intent;
  Lead 也可用 no-route UOW 显式标记已处理。
- founder 原文超过 1200 字仍在 receipt root 与 Lead event 中完整保留;
  fresh message 不再等待旧归因 grace。
- 紧急回退告警专项:startup、periodic、flag-on 零噪音、kind contract、
  infra route 与 feature-flag 文案共 68/68 PASS。
- 收据/路由专项:flywheel-comm 68/68 PASS;TeamLead 119/119 PASS。
- 包级验证:flywheel-comm 全量 87 files / 1138 tests PASS;config 全量
  30 files / 529 tests PASS;三包 typecheck PASS;`pnpm -r build` 22/22 参与包 PASS;
  本次 17 个变更 TS 文件 Biome PASS。
- TeamLead 全量运行为 628 files / 8902 tests PASS,26 条失败均在本单
  未修改文件(已知 merge-eligibility 基线、bash/launchctl 环境、npm cache
  EPERM 与并发 timeout);FLY-1392 受影响集合独立复跑全绿。根目录
  `pnpm lint` 另因 ignored `.pnpm-store` / `.flywheel/runs` 中的运行产物被
  Biome 扫描而失败,本单源文件无 lint 诊断。

## Implement 阶段结论

- 对抗 fixture 已固化:零 pending thread 的「帮我把这个也改了」「等下先别 ship」「🛑」「🚢」「❌」全部进入 Lead 模型巷,不产生 `no_route_needed`。
- receipt 专项:flywheel-comm 27/27、TeamLead 相关 187/187。
- flywheel-comm 全量串行曾通过 86 files / 1122 tests;提交前复跑因机器负载出现 2 个既有 CLI 子进程 5s timeout,其余 1120 通过,随后两条失败用例单独复跑 2/2 通过(487ms/596ms)。
- 529 隔离真机的非 founder 腿 13/13 PASS:真实生产组件完成内部到达/办结写入、
  真实 Claude mailbox 写入+runner CLI started、r1/r2、durable Lead-first
  escalation、真实 Discord POST 后 GET read-back。最新 read-back message
  id=`1529023516035518576`。该轮的 founder 自动归因结论已失效,须由 QA 按
  单层办结口径复测。

运行命令:

```bash
FLY1392_ALLOW_SYNTHETIC_FOUNDER=1 \
  node --import tsx scripts/qa-fly-1392-receipt-foundation-e2e.mjs
```

## 明确边界(交独立 QA)

严格模式在 529 room 最近 1000 条内找不到 Annie 的非 bot 消息,因此 fail-closed(exit 2),没有冒充 founder。上述 13/13 使用 synthetic founder ingress fixture,但 mailbox 与升级 Discord 腿均为真实生产组件/真实外部 I/O。

独立 QA 需让 Annie 在 529 room 发一条真实回复后,不带 `FLY1392_ALLOW_SYNTHETIC_FOUNDER` 重跑同一脚本;严格模式会自动选取真实 `DISCORD_OWNER_USER_ID` 且 `author.bot !== true` 的消息。若要同时验证真实 founder mention,显式加 `FLY1392_ALLOW_FOUNDER_MENTION=1`。该轮通过才满足 plan §1 的「Annie-authored 529 ingress」最终关单条件。
