# FLY-2283 报告链接保留 14 天 — 实施计划
Issue: FLY-2283 (https://linear.app/geoforge3d/issue/FLY-2283/报告托管-publish-report-链接-7-天过期写死default-retention-max-age-ms-改为-14)
日期: 2026-09-02
基于: research.md

## 1. 实施结论

遵照 Lead 对问题 `8e51ed58-18f9-4c39-b776-7ad83c42e98f` 的裁定，本节点只做：

```typescript
export const DEFAULT_RETENTION_MAX = 2000;
export const DEFAULT_RETENTION_BYTES = 8.5 * 1024 * 1024;
export const DEFAULT_RETENTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
```

同步相邻注释与既有 retention 测试，不增加任何开关或抽象。

2000 来自当前 5.17 份/小时 × 14 天 ≈ 1,738 份，并留约 15% 数量余量；8.5 MiB
必须保持，以守住 Vercel 10 MB 全集 inline JSON 部署合同。后者按当前平均 55 KB/份仍会
约 30–31 小时先命中，所以本节点不能声称端到端 14 天保证已经成立；这个剩余架构缺口写入
implementation notes 与 PR body，由 Lead 另立后续单。

canonical founder-html-delivery skill 位于外部 `xrliAnnie/flywheel-skills`，不在本 PR；
Lead 已明确由其跨仓协调。本仓 slim base rule 没有 7 天文案，因此不制造重复的保留期说明。

## 2. TDD 顺序

### RED — 先改变现有合同

编辑 `packages/teamlead/src/__tests__/report-registry.test.ts`：

1. 默认 caps 用例改为 `2000 entries / 8.5 MiB`；
2. 默认 TTL 用例改为 14 天；
3. 已退役 env 用例名称改为 fourteen days，并断言：
   - env 分别为 `0`、`30` 时仍不被读取；
   - 旧报告在 7 天时仍进入 deploy set；
   - 到精确 14 天时被 `>=` 边界删除；
4. 一般 TTL 用例分别用 15 天（expired）、13 天（younger）、14 天（exact boundary）；
5. TTL/count 共存与 abort 用例的过期推进改为 15 天；
6. 所有测试名称、分节标题和注释从 7 天同步为 14 天。

运行：

```bash
pnpm --filter flywheel-teamlead test:run src/__tests__/report-registry.test.ts
```

预期至少默认 count 与 TTL 合同因生产常量仍是 100/7 天而失败；确认失败值准确指向本单，
不是 fixture、依赖或环境故障。

### GREEN — 最小生产改动

编辑 `packages/teamlead/src/bridge/report-registry.ts`：

- `DEFAULT_RETENTION_MAX` 从 100 改为 2000；
- `DEFAULT_RETENTION_MAX_AGE_MS` 从 7 天改为 14 天；
- options 文档与 TTL pass 注释同步 14 天；
- 不改 `DEFAULT_RETENTION_BYTES` 和剪枝算法。

编辑 `packages/teamlead/src/bridge/plugin.ts`，只把装配旁的 7 天注释改成 14 天；仍显式传
`DEFAULT_RETENTION_MAX_AGE_MS`，仍禁止 `FLYWHEEL_REPORTS_TTL_DAYS` 复活。

再次运行同一定向测试，要求全绿。

### REFACTOR/一致性检查

运行限定搜索，必须满足：

```bash
rg -n '7 days|seven days|7 天|DEFAULT_RETENTION_MAX = 100' \
  packages/teamlead/src/bridge/report-registry.ts \
  packages/teamlead/src/bridge/plugin.ts \
  packages/teamlead/src/__tests__/report-registry.test.ts \
  packages/teamlead/lead-rules-base/founder-html-delivery.md
```

结果应为空；并确认 8.5 MiB 的 FLY-1728 回归仍通过。没有新增 helper 或死代码可清理。

## 3. 文档与证据

新增 `implementation-notes.md`，记录：

- RED/GREEN 的命令、失败原因和通过数量；
- 生产快照的 5.17 份/小时、55 KB/份、2000 count cap 推导；
- 8.5 MiB 约 30–31 小时先命中的剩余缺口；
- Lead 决定本单不重做托管、外部 skill 文案不在本 PR 的边界；
- 全仓门与 code review 结果。

代码与实现文档提交后再创建 `engineering/doc/milestones/FLY-2283.md`，它必须是 PR 的
literal last commit；不修改 `CLAUDE.md`。

## 4. 验证门

从窄到宽执行：

1. `pnpm --filter flywheel-teamlead test:run src/__tests__/report-registry.test.ts`
2. `pnpm lint`
3. `pnpm -r build`
4. `pnpm test:packages:run`
5. 本实现没有新增 `scripts/__tests__/*.test.sh`，因此无新增 shell test；仍核对 git diff
   确认这一事实。

本改动没有渲染 surface，不需要 ProofShot。实现节点不做生产部署；「线上新报告 14 天」
在当前 byte cap 下无法由本节点真跑 14 天验证，也不得用常量单测替代该运行结论。

## 5. Code review 与 PR

1. 在 milestone 之前冻结 code/docs head；
2. 通过 `codex:rescue` 运行 code review，禁止 raw `codex exec`；
3. `stage set code_review`；
4. 按 codex author 协议注册 `review_code` gate + `request-review --type code`；
5. 若 `CHANGES_REQUESTED`，修 blocking finding、推新 head、重新跑相关门并开新 review gate；
6. review 通过后新建 milestone，作为 literal last commit；
7. push feature branch，创建 PR；PR body 必须写明 8.5 MiB 的剩余缺口与外部 skill follow-up；
8. 完成路线只用 `complete --route needs_review --pr <NUMBER>`，不 dispatch QA、不请求 ship、
   不 merge。

## 6. 验收映射

| 要求 | 本节点证据 | 明确边界 |
|---|---|---|
| 默认 TTL 14 天 | 常量 + 7/13/14/15 天 retention 测试 | 惰性 TTL 行为，不是 wall-clock 定时删除 |
| 不加开关 | retired env 两组测试 + plugin source sentinel | 固定默认值 |
| count 不先于 14 天命中 | 2000 常量；当前 14 天投影约 1,738 | 仅当前 snapshot projection |
| byte cap 评估 | 生产 100 份总量/均值实测；约 30–31 小时 | 仍早于 14 天；Lead 明确后续处理 |
| founder skill 文案一致 | 本仓 base rule 搜索无 7 天字样 | canonical skill 跨仓，不在本 PR，由 Lead 协调 |
| retention tests green | 定向 Vitest + 全仓 package tests | exact command output 记入 notes |

## 7. 失败边界

- deploy 失败仍 abort，registry 与旧报告不落盘变更；
- commit 顺序仍是新文件 → registry 原子 rename → best-effort 删旧文件；
- 8.5 MiB 事故回归若失败，不能以 14 天需求为由放宽断言；
- full gates 出现与本分支无关的已知失败时，必须给出 exact command/用例/对照，不能静默
  改用更窄命令冒充全仓绿；
- 外部 skill 不可通过改安装缓存冒充 PR 交付。

