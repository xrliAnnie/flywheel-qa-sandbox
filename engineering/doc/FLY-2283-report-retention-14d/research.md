# FLY-2283 报告链接保留 14 天 — 调研
Issue: FLY-2283 (https://linear.app/geoforge3d/issue/FLY-2283/报告托管-publish-report-链接-7-天过期写死default-retention-max-age-ms-改为-14)
日期: 2026-09-02
基于: exploration.md

## 1. 现行代码路径

| 环节 | 权威来源 | 现行行为 |
|---|---|---|
| Bridge 装配 | `packages/teamlead/src/bridge/plugin.ts` | 所有项目共用 `~/.flywheel/reports` 下的一个 `ReportRegistry`；显式传入默认 TTL 常量，不读 TTL env |
| 输入边界 | `packages/teamlead/src/bridge/reports-route.ts` | HTML 必须非空且不超过 512 KiB；publish 串行执行 stage → Vercel deploy → commit |
| TTL | `packages/teamlead/src/bridge/report-registry.ts` | 当前默认 7 天；每次新 publish 惰性删除 age `>= TTL` 的旧项 |
| 容量 | 同上 | TTL 后再按全局 count/bytes 最旧优先剪枝；默认 100 份、8.5 MiB |
| 上游请求 | `packages/teamlead/src/bridge/vercel-deploy.ts` | 每次将 `robots.txt` 与全部 retained HTML 作为 inline UTF-8 files 放入同一个 JSON POST body |
| canonical skill | `xrliAnnie/flywheel-skills` 的 `skills/generic/founder-html-delivery/SKILL.md` | `main` 仍有两处 7 days；文件不在本 Flywheel worktree/PR |

registry 的两段剪枝顺序是：

```text
先删 age >= retentionMaxAgeMs
→ 汇总剩余 bytes
→ while count > retentionMax OR bytes > retentionBytes，shift 最旧项
```

所以 count/bytes 是 TTL 的独立上限；把 TTL 改成 14 天不会阻止它们更早下线链接。

## 2. 现有测试覆盖与需要改变的断言

`packages/teamlead/src/__tests__/report-registry.test.ts` 已用真实临时目录覆盖：

- 默认 count/bytes 常量；
- 默认 TTL 常量；
- 已退役 `FLYWHEEL_REPORTS_TTL_DAYS` 即使设为 `0`/`30` 也不改变默认 TTL；
- TTL 内存活、超过 TTL 删除、精确边界用 `>=` 删除；
- TTL 与 count cap 共存；
- stage 后 abort 不把 TTL 剪枝落盘；
- bytes cap 的 21 份重报告回归，确保 8.5 MiB 上限下完整 JSON body低于 Vercel 10 MB。

TDD 应先只改这些既有合同：

1. 默认 count 从 100 变为 2000；
2. 默认 TTL 从 7 天变为 14 天；
3. 7 天时旧链接仍在 staged deploy 中；
4. 14 天精确边界删除，13 天仍保留，15 天已过期；
5. 退役 env 的两组测试仍证明「无开关」，只是固定值改为 14 天；
6. 8.5 MiB 事故回归保持原样，证明本单没有牺牲上游安全线。

## 3. 当前频率与两道上限

快照：`~/.flywheel/reports/registry.json`，mtime 2026-09-02 23:06:07 PT。
100 份报告从 2026-09-02T10:45:57.236Z 到 2026-09-03T06:06:00.344Z，
总 hardened HTML 为 5,528,309 bytes。

用 `count / span` 表示当前密度（Lead 裁定采用的口径）：

```text
100 / 19.3341967h = 5.172 reports/h
5.172 * 24 * 14 = 1,738 reports / 14d
5,528,309 / 100 = 55,283 bytes/report
1,738 * 55,283 ≈ 96.1 MB / 14d
```

若以到达间隔 `99 / span` 计算，结果为 5.120 份/小时、14 天 1,721 份；两种口径
都远超旧 count cap，且都低于新 count cap 2000。2000 相对保守的 1,738 份投影有
约 15% 数量余量。

当前两份 personal-assistant 报告：

| 报告 | createdAt | bytes | 快照时其后已有报告 | 距旧 count cap 淘汰只余 |
|---|---|---:|---:|---:|
| 周三购物车对照 | 2026-09-02T17:13:39.410Z | 11,848 | 71 | 29 份 |
| 9/6-9/12 周菜单（交互版） | 2026-09-02T18:54:06.983Z | 70,293 | 65 | 35 份 |

旧 count cap 会让它们约 19 小时后下线。把 count 提到 2000 可移除这个更早的限制。

但 8.5 MiB 按当前均值只容纳 `8,912,896 / 55,283 ≈ 161` 份；按 5.172 份/小时，
约 31 小时就先命中 byte cap。也就是说在当前「全集 inline JSON」模型下，14 天访问目标
仍然达不到；如果把 byte cap 放到约 96 MB，下一次 publish 会重新触发 FLY-1728 的
Vercel 10 MB body 故障。

## 4. Lead 裁定

问题 `8e51ed58-18f9-4c39-b776-7ad83c42e98f` 的回复锁定本实现节点范围：

1. `DEFAULT_RETENTION_MAX_AGE_MS`：7 天 → 14 天；
2. `DEFAULT_RETENTION_MAX`：100 → 2000，让 byte cap 成为唯一实际容量硬约束；
3. `DEFAULT_RETENTION_BYTES`：保持 8.5 MiB，不能破坏 Vercel 10 MB 单次部署合同；
4. 不在本单重做托管；把「约 30–31 小时先撞 byte cap、现模型达不到 14 天」写入
   implementation notes 与 PR body，后续架构单由 Lead 另立；
5. 外部 `flywheel-skills` 的 SKILL.md 不在本 PR 修改，由 Lead 跨仓协调；本仓 base rule
   若存在 7 天文案才同步。实际审计 `packages/teamlead/lead-rules-base/founder-html-delivery.md`
   没有任何保留天数，故本仓无 skill 文案可改。

该裁定避免把一个已知的链接寿命缺口变成全报告发布不可用，同时也意味着本节点交付的是
「TTL + count 前置条件」而非完整 14 天运行保证。implementation notes 和 PR 必须明确写出，
不能把常量绿测夸大成端到端验收已满足。

## 5. 最小实现面

代码只需要改三类字节：

- `report-registry.ts` 的 `DEFAULT_RETENTION_MAX`、`DEFAULT_RETENTION_MAX_AGE_MS`
  及紧邻 7 天注释；
- `plugin.ts` 紧邻装配注释的 7 天 → 14 天；
- `report-registry.test.ts` 的默认值、TTL 时钟推进、用例名与注释。

不新增 helper、schema、env、feature flag、定时器、项目特例或依赖。没有渲染表面变化，
因此不需要 ProofShot；保留现有真实 fs 单测与全仓门即可验证本节点代码范围。

## 6. 会过期的结论

| 结论 | as-of | 重核方法 |
|---|---|---|
| 当前密度约 5.17 份/小时、均值约 55 KB | 2026-09-02 23:06 PT | 从生产 `registry.json` 的 100 条 `createdAt`/`bytes` 重算 |
| 8.5 MiB 对齐 Vercel 10 MB inline JSON 安全线 | 2026-09-02 | 运行 21 份重报告回归并读 FLY-1728 调研 |
| canonical skill 在外部 `xrliAnnie/flywheel-skills` | 2026-09-02 | GitHub tree 查 `skills/generic/founder-html-delivery/SKILL.md` |
| 本仓 base rule 没有 7 天文案 | 2026-09-02 | `rg '7 days|7 天|seven days' packages/teamlead/lead-rules-base/founder-html-delivery.md` |
