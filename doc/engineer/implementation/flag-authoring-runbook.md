# Feature flag 创建与部署手册

日期: 2026-08-22
适用范围: Flywheel 产品行为 flag

## 创建 flag 的唯一路径

新 flag = registry 条目 + store codec + scope 声明，别无他路。

新的产品 flag 必须按照这条路径一次完成。不得先放进 `.env` 或
`config.yaml`，不得先登记为 legacy 直读，也不得另建第二套开关通道。

1. 在 `packages/config/src/feature-flags/registry.ts` 登记 spec，并明确 `default`、`polarity`、`valueKind`、`scope` 与真实 read site。
2. 每个 registry 条目都加入 `STORE_MANAGED_FLAGS`，并提供与 `default`、`polarity` 完全一致的 store codec。Bridge-global flag 使用 `scope: bridge_global`；逐项目 flag 还必须加入 `PROJECT_STORE_MANAGED_FLAGS` 并使用 `scope: project`。
3. 在 `flag-store-runtime.ts` 建立命名读取 wrapper。registry `readSites` 只以 `delegated` + `call_time` 指向精确 wrapper symbol；业务代码不读 `process.env.FLYWHEEL_*`，`config.yaml` 也不承载 flag key。
4. Project scope 的显式 `0/1` 由 codec 解析为 false/true，读取优先级是项目行 → `*` 行 → registry default。project row 写时创建、clear 时删除；Bridge-global flag 必须拒绝项目行。
5. 用 `flag-routes` 的 stage/apply 路径证明管理面覆盖：reason 必填，scope 必须是 `*` global row 或 `projects.json` 名册里的 project row。修改只写 SQLite，不写 `.env` / `config.yaml`。
6. 运行 registry/store/drift/route 守卫，只有 guard green 才可合并。新 spec 如果缺 managed membership、codec、scope、存储合同或管理 route，CI 必须直接变红。

## 豁免不是新通道

`LEGACY_FLAG_EXEMPTION_BASELINE.length === 0`，并有机械守卫禁止重新增长。`FLAG_EXEMPTIONS` 只记录真实的 QA 隔离 seam、dry-run 旁路或一次性迁移开关；每条都必须写清 reason、owner、issue 与可执行的退役条件，名单默认只许缩小。唯一可修订情形是 founder 在具体 issue 中明确把一个**已登记的产品 flag**重分类为有界非产品 seam；baseline、exemption、reason、owner、issue 和机械守卫必须在同一 PR 原子更新。FLY-2102 将 `FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE` 从 registry 迁为仅允许 loopback staged Bridge 的 transient QA seam，是当前唯一一次此类修订。补齐字段或伪造生产 read site 都不能自行获得授权。

未来新增单次调用、测试注入或运维调试 seam，仍必须建立与产品 flag 分开的非产品 ledger，先定义权威、生命周期和机械守卫；没有上述 founder 重分类裁定，不得把新名字追加到 `FLAG_EXEMPTIONS`。

## 生产 `.env` 移除与部署顺序

必须区分代码状态和运行状态：已合并 / 已 staged ≠ 已部署。删除旧 env 后，旧 Bridge 二进制仍可能读取它；因此必须严格执行以下七步：

1. 合并新代码并由 updater 将新 artifact 放入 staged 位置；merged/staged 状态不切换进程。
2. 对 staged artifact 运行静态 preflight，确认它已内建 workflow resume enabled 与 founder consent `audit_only`；验证失败则在修改 `.env` 前停止。
3. 建立 `no-old-binary-restart` 制动，并通过 updater 状态确认它已生效；从此刻到新 Bridge 启动前，不得重启、回拉或启动旧 artifact。
4. updater 以原子修改删除 `.env` 里的 `FLYWHEEL_WORKFLOW_RESUME=1` 和 `FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE=audit_only`，并重读文件验证两行都已消失。
5. 部署并启动新 Bridge artifact。
6. 检查 health/live，实测 workflow resume 仍为 enabled，founder consent 仍为 `audit_only` 并继续写入 audit 记录。
7. 如需 rollback，先恢复两条旧 env，确认持久化成功后再部署或启动旧 Bridge artifact。
