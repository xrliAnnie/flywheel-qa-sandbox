# ponytail 接入 + 灰度运维 — FLY-615

**Issue**: FLY-615
**Date**: 2026-06-28

ponytail = 一个 code-minimalism 插件(决策梯:能不写就不写)。Flywheel 用一个三层灰度条件控制每个 Runner 开不开它,配合 FLY-614(token 归账)+ FLY-616(质量 eval)做 A/B。

## 1. 一次性接入(操作员跑一次)

```bash
scripts/setup-ponytail.sh
```
脚本(幂等):preflight `claude` + `node` 在 PATH → 若未装则 `claude plugin marketplace add DietrichGebert/ponytail` + `claude plugin install ponytail@ponytail` → **显式 `claude plugin disable ponytail@ponytail`(强制全局关)** → 验证「installed 且 globally disabled」。

> 为什么强制全局关:Flywheel **per-run** 开 ponytail —— 解析出 "on" 的那次跑才给 `claude` 加 `--settings enabledPlugins`。若全局开,**每个** Claude Runner 都会继承,灰度/A/B 失效且非 byte-compat。
> Codex Runner **不用**插件(headless、无法交互信任 hook)—— Flywheel 改为把 ponytail ruleset 注入 Codex 的 prompt,**无需** setup。

## 2. 三层灰度(优先级高→低)

`per-run flag > per-issue Linear 标签 > per-project config > 默认 off`

| 层 | 怎么开 | 备注 |
|----|--------|------|
| per-run | `/api/runs/start` body `ponytail: "on"\|"off"` | **v1 ✅** 临时 override、最高优先 |
| per-issue | Linear 标签 `ponytail`(强制开)/ `ponytail-off`(强制关) | **v1 ✅、A/B 主入口**:同项目两 issue 一开一关 |
| per-project | `<project>/.flywheel/config.yaml` → `ponytail: { enabled: true }` | **v2(v1 未激活)**:resolver 三层架构已就位,但 `run-infra` v1 **故意不 load** `flywheelConfig.ponytail` → 设了也**无效**;v2 由 run-infra 加载即激活(改后需重启一次 Bridge) |
| 默认 | 全 off | byte-compatible(不配置/不标/不传 = 行为逐字不变) |

## 3. 条件标签(对接 614/616)

每个 run 把解析出的条件持久化到 `session.ponytail_condition`(StateStore 列),编码 `requested` + `effective`:
- `on:label` / `on:project` / `off:default` / `off:run` …
- `unavailable:readiness:on:<source>` —— 要开但插件/node 没装好(readiness 失败)。
- `unavailable:selector:label_unreadable` —— project on 但 Linear 标签读不到(无法判断是否被 `ponytail-off` 豁免)。

FLY-614 按此列归 token 账;FLY-616 按此列分 A/B 桶,**排除 `unavailable:*`**。

> 诚实边界(给 616):Codex 拿的是注入的**等效 ruleset**,不是真插件的每轮 hook,效果可能弱于 Claude —— A/B 须保持 Claude/Codex 桶可区分。

## 4. v1 已实现 vs remaining(Codex-approved plan §7)

**v1 已实现**:config 层 `PonytailConfig` + 纯解析阶梯(全单测)、Claude `--settings` 启用、Codex ruleset 注入、Blueprint 在 envelope 前解析 + readiness(per-backend、只缓存 ready)+ enablePonytail、**per-run flag + per-issue 标签 两层**(`run-infra` v1 不 load per-project config → project 层 dormant)、标签冲突 → `unavailable:conflict`(loud、不静默 off)、条件持久化 `session.ponytail_condition`(两条 session_started 写路径)、本 setup 脚本。

**Remaining(tracked)**:
- **v2 per-project rollout**:`run-infra` 加载 `flywheelConfig.ponytail` → Blueprint 构造器(resolver 三层 + 参数已就位,只差这一步)。
- retry rehydrate(`actions.ts` 读 predecessor `ponytail_condition` → `decodePonytailConditionForRetry` → frozen / 重解析)。
- unavailable 的 fail-before-spawn + `emitStartedReliable()` 有序 started(当前:unavailable 记条件 + 不发 flag,但仍 spawn;未做 fail-before-spawn 的 audit-row-first 时序)。
- Codex 的 managed `AGENTS.md` 持续注入(比一次性 prompt 更接近真 hook;当前 Codex 走 prompt 注入)。
