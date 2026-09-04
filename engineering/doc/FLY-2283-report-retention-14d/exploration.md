# FLY-2283 报告链接保留 14 天 — 探索
Issue: FLY-2283 (https://linear.app/geoforge3d/issue/FLY-2283/报告托管-publish-report-链接-7-天过期写死default-retention-max-age-ms-改为-14)
日期: 2026-09-02
基于: 无

## 1. 问题与用户场景

`publish-report` 的所有项目共用一个 Vercel 部署集。当前
`ReportRegistry` 把默认 TTL 写死为 7 天；personal-assistant 的「每周菜单」与
「购物车对照」需要让同一链接跨过下一周，默认保留期必须达到 14 天。

单改 TTL 不足以证明这个体验成立。相同 registry 还受两道全局上限约束：

- 最多 100 份报告；
- hardened HTML 总量最多 8.5 MiB。

任一道上限都按最旧优先剪枝，可以早于 TTL 让链接下线。因此本单必须用当前生产发布频率
核算这两道上限，而不能把「TTL 常量变成 14」等同于「链接能活 14 天」。

## 2. 锁定范围

必须完成：

1. 默认 TTL 从 7 天改为 14 天，不增加 env、feature flag 或项目级开关；
2. 先改既有 retention 测试得到 RED，再用最小常量改动恢复 GREEN；
3. 以当前生产 registry 快照核算 100 份与 8.5 MiB 是否先于 14 天淘汰
   personal-assistant 报告；
4. 同步 founder-html-delivery skill 的 7 天文案为 14 天；
5. 保持现有 stage → deploy → commit 事务、HTML hardening、512 KiB 单报告边界、
   Discord 投递与惰性剪枝语义不变。

非目标：

- 不增加配置开关；
- 不改报告 HTML 渲染、ProofShot 或 Discord 消息形状；
- 不借机重构 registry；
- 不部署、不合并，也不由实现节点派发 QA。

## 3. 当前生产快照

2026-09-02 23:06 PT 读取 `~/.flywheel/reports/registry.json`：

| 指标 | 实测 |
|---|---:|
| 在保报告 | 100（已触及 count cap） |
| 最老 → 最新时间跨度 | 19.334 小时（0.806 天） |
| 发布率 | 5.120 份/小时，122.891 份/天 |
| hardened HTML 总量 | 5,528,309 bytes |
| 平均每份 | 55,283 bytes |
| 按该速率外推 14 天 | 约 1,721 份、95,168,452 bytes |
| 8.5 MiB 按当前均值可容纳 | 约 161 份，即约 31.3 小时 |

计算采用 100 个有序样本之间的 99 个到达间隔：

```text
rate = 99 / 19.3341967h = 5.120461 reports/h
14d count = 1 + rate * 24h * 14 = 1721.47 reports
14d bytes = 1721.47 * 55,283.09 = 95,168,452 bytes
```

两份当前 personal-assistant 报告分别只有 29、35 个 count 槽位余量。若速率不变，
它们会在快照后约 5.7、6.8 小时被 count cap 淘汰，总寿命约 19 小时，远小于 14 天。
因此答案明确是「会先被挤掉」，且先命中的是 count cap。

## 4. 冲突与待裁定项

按当前速率把两道上限扩到足以覆盖 14 天，会让单次 Vercel 全集 JSON 部署达到约
95 MB；若按 count 的 17.21 倍同比例放大 8.5 MiB cap，则 byte cap 约为 146.4 MiB。
两者都超过 FLY-1728 为 Vercel 10 MB body cap 设置的安全边界。机械放大上限会把
「旧链接提前失效」换成「新旧报告全部发布 502」，不满足产品目标。

另一个仓库边界是：canonical `founder-html-delivery/SKILL.md` 属于
`xrliAnnie/flywheel-skills`，当前 Flywheel worktree 不包含该文件；本仓只有引用该 skill
的 slim base rule，且没有 7 天文案。已通过非阻塞 Lead 问题
`8e51ed58-18f9-4c39-b776-7ad83c42e98f` 请求决定安全容量方案与 skill 落点。

## 5. 方案梯子

| 方案 | 结果 | 结论 |
|---|---|---|
| 只改 TTL | 测试表面通过，但生产约 19 小时仍被 count 淘汰 | 不满足场景 |
| 机械同比放大 count/bytes | 14 天 registry 可容纳，但单次全集部署远超 Vercel body cap | 不安全 |
| 保持 8.5 MiB，仅加 count | 大报告仍会约 31 小时淘汰，且不符合「两道一并上调」 | 不满足要求 |
| 按项目隔离部署集 | flywheel 高频报告不再挤掉 personal-assistant；每项目仍可守住上游 cap | 能解决根因，但显著扩大本单架构范围，需 Lead 裁定 |
| 更换为非全集托管 | 可让总保留量超过单次 body cap | 架构迁移，超出本小改默认范围 |

## 6. 实现前假设

1. 「14 天内可访问」包括不被 count/bytes 提前淘汰，而不只是 TTL 分支不淘汰。
2. 生产 registry 快照是本单要求的「当前发布频率」权威样本；报告发布有突发性，
   因此外推会在 research 中明确标记为 snapshot projection，不伪装成长期稳定均值。
3. FLY-1728 的 8.5 MiB 上限仍服务真实 Vercel 10 MB body cap，不能无证据放大。
4. 在 Lead 给出边界裁定前，可以完成测试与最小 TTL 改动的设计，但不能把冲突静默写成
   一个会破坏发布链的实施计划。
