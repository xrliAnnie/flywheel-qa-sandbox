# FLY-2696 人设投影 — 探索
Issue: FLY-2696 (https://linear.app/geoforge3d/issue/FLY-2696/raya-并仓s4-persona-投影p1人设留-raya-仓显式-opt-in-contract-启动屏障fail-open)
日期: 2026-09-17
基于: 无

## 范围与权威

本节点只交付设计。施工依据是已合入的 `../FLY-2680-raya-merge-plan/plan.md` §7、§7.3、§10.2、§12、§14.1①；P1′ 已裁定，人设留 Raya 仓，不重评 P2′。S4 后继实施交付投影代码并保持 dormant，不编辑生产 registry、不换 pin、不迁移 DB、不启动/重启服务。

## 要解决的问题

旧班车负责把 Raya identity 送到工作区，后续拆班车需要标准启动入口承担这一步。现有 selector 不输出 projectRepo，现有启动只检查 persona 可读/非空，不能证明实际加载经授权的字节。用 projectRepo + identity 目录推断开启会命中全舰队，覆盖工作分支。

## 固定决策

1. 显式 per-project contract 且绑定精确 lead；缺省完全跳过投影，不创建任何投影产物。
2. repo + exact commit + 固定 `.lead/<lead>/identity.md` + sha256 + 可验证授权引用构成唯一来源。禁止 main/tag/短 SHA。
3. pre-M0 可使用经过验证的 A0；进入 B3 后只有 B2 前冻结的 migration-compatible fallback 可用。阶段缺失、DB/receipt 不一致不等于 pre-M0。
4. runtime 在打开 transport 前校验实际加载内容，每一代重启都重复。registry identityDigest 不能充当 persona digest。
5. 先部署不启用；activation-window 与换 pin 是后续逐实例授权，ship S4 不授予它们。

## 当前证据与未知

只读清点见 fleet-inventory.json：16 个非 Raya Lead 全有 projectRepo 与 identity；13 个 tracked。不是零写测试的通过证明；后继需在隔离 fixture 中执行完整负例。
母方案 §13 的未验证项保持未验证。旧 brain 已停用来自本次任务权威说明，后续运维只复核仍停用；本节点不声称 live 验证。FLY-2657 独立推进，本单不等待、不阻挡。

向 Lead 的非阻塞接口对齐问题：605a759d-15cd-482c-b2de-6f965d2560c1（M0/activation receipt owner）。其未答不授权任何生产动作；计划必须在证明缺失时封闭。
