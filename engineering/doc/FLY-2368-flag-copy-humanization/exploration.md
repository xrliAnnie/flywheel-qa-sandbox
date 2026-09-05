# FLY-2368 Flag 文案人话化 — 探索
Issue: FLY-2368 (https://linear.app/geoforge3d/issue/FLY-2368/2356s5-flag-文案人话化-删-governance-gate-类别registry-每条-flag)
日期: 2026-09-05
基于: 无

## 目标

让 founder 在管理台看到每条 flag 时，直接读到「打开（或这个取值）代表什么」，不再靠名字、`polarity`、`default` 拼出含糊的通用句子。同时维持 flag 的实际值、`polarity`、`default` 与解析路径完全不变。

## 当前事实

1. `packages/config/src/feature-flags/registry.ts` 当前有 **23** 条 flag。issue 写 21 条，是创建时快照；之后主干新增了 `database_archive` 等条目。「每条 flag」是范围判据，所以本单覆盖当前 23 条，不留下新增条目的英文工程文案。
2. FLY-2257 已经把 `FlagCategory` 收窄为 `feature | kill_switch`，生产代码中的 `governance_gate` 已清零；`doc/engineer/implementation/flag-authoring-runbook.md` 也已有逐字规则：**治理性策略不做成 flag,写死在代码里,要改走 PR。**
3. FLY-2257 增加了结构字段 `onMeans: enables | disables`。管理台 `flagReading()` 仍结合 `onMeans + polarity + default` 生成七类通用文案，无法回答每个 flag 具体在做什么。
4. `validateOnMeansContract()` 仍用 `name.endsWith("_disabled")` 检查语义；它虽在后端而非页面，仍是本单要求消除的名字启发式。
5. 旧的 `description` 还承担退休扫描、报告等工程上下文，不宜把全部技术 provenance 硬塞成 founder 文案。新增独立展示字段能让工程说明和 founder 说明各司其职。

## 范围与假设

- 新增必填展示字段 `whenOn: string`；bool 行解释「打开代表什么」，数值/枚举行解释「这个值代表什么」。
- 保留 `onMeans` 作为兼容的结构化元数据，但管理台与共享 flag 卡片的人话说明改读 `whenOn`。删除 `onMeans` 的 `_disabled` 后缀校验，不改变 bool/非 bool 的字段形状守卫。
- 新字段只展示，不参与 resolve、store codec、写入值或生效判断。
- `governance_gate` 已满足的删除与约定文档不重复改写；增加验收搜索，证明生产代码仍为零引用。
- 不改任一 flag 的 `default`、`polarity`、source、scope、valueKind、enumValues、读点或当前 store/env 值。

## 验收证据

- registry 守卫：当前 23 条 `whenOn` 都是非空人话；五条代表性 flag 的文案逐字锁定并与开关方向一致。
- 投影守卫：`resolveFlag()` 与 management snapshot 都携带 `whenOn`。
- 页面守卫：管理台行与共享 flag 卡片显示 `whenOn`，页面源码不再含 `_disabled` 判断。
- 不变量：改前 registry `[name, polarity, default, valueKind, scope, source]` 指纹为 `6d671432f1244e529fc8dbba38f2dfe8a89da113b533ac430113e794946e5506`（23 条）；改后必须相同。
- 全仓门：定向测试、`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run` 与全部新增 `scripts/__tests__/*.test.sh`。
