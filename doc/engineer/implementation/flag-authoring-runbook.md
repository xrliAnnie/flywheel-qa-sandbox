# Feature flag 创建与部署手册

日期: 2026-08-22
适用范围: Flywheel 产品行为 flag

## 创建 flag 的唯一路径

`registry → STORE_MANAGED_FLAGS + codec → seed row → named store wrapper → management route test → guard green`

新的产品 flag 必须按照这条路径一次完成，不得先登记为 legacy 直读，再留给后续迁移。

1. 在 `packages/config/src/feature-flags/registry.ts` 登记 spec。当前只接受 `scope: bridge_global`、`source: env`、完整 `envVar` 且 `toggleable: direct` 的新 flag；必须明确 `default`、`polarity`、`valueKind` 和 live-read proof。在建立 project-scoped store 权威之前，禁止新增 `project_config` flag。
2. 将名称加入 `STORE_MANAGED_FLAGS`，并在 `getFlagStoreCodec` 提供 codec。codec 的无 override 结果必须等于 registry default，布尔解析必须与 polarity 一致；enum 必须完整限定可用值。
3. 确认 `StateStore.ensureFlagValueRows` 的通用循环为新名称建立 row，并且产生唯一 `seed` changelog。测试必须遍历全部 managed names，不得只枚举当前四个名称。
4. 在 `packages/teamlead/src/bridge/flag-store-runtime.ts` 添加命名明确的 store wrapper。registry `readSites` 必须以 `delegated` + `call_time` 指向该模块和精确 symbol；AST guard 必须看到真实 import 和 call，只在文本里写 symbol 无效。
5. 用 `flag-routes` 的 stage/apply 路径证明管理面覆盖：reason 必填，actor 固定为 `bridge-local-operator`，revision/effective 前后值正确，修改写入 SQLite 而不写 `.env`。`management-existing-writers` 必须继续拒绝 managed flag，防止第二个 writer。
6. 运行 registry/store/drift/route 守卫，只有 guard green 才可合并。新 spec 如果缺 codec、seed、真实 wrapper 或 management route，CI 必须直接变红。

## 豁免不是新通道

`FLAG_EXEMPTIONS` 的豁免名单只许缩小；`LEGACY_FLAG_EXEMPTION_BASELINE` 是硬上限，不接受任何新 `kind:name`。补齐 reason、owner、issue 或伪造生产 read site 都不能绕过检查。

未来如果需要单次调用、测试注入或运维调试 seam，必须建立与产品 flag 分开的非产品 ledger，先定义权威、生命周期和机械守卫；不得把它追加到 `FLAG_EXEMPTIONS`。

## 生产 `.env` 移除与部署顺序

必须区分代码状态和运行状态：已合并 / 已 staged ≠ 已部署。删除旧 env 后，旧 Bridge 二进制仍可能读取它；因此必须严格执行以下七步：

1. 合并新代码并由 updater 将新 artifact 放入 staged 位置；merged/staged 状态不切换进程。
2. 对 staged artifact 运行静态 preflight，确认它已内建 workflow resume enabled 与 founder consent `audit_only`；验证失败则在修改 `.env` 前停止。
3. 建立 `no-old-binary-restart` 制动，并通过 updater 状态确认它已生效；从此刻到新 Bridge 启动前，不得重启、回拉或启动旧 artifact。
4. updater 以原子修改删除 `.env` 里的 `FLYWHEEL_WORKFLOW_RESUME=1` 和 `FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE=audit_only`，并重读文件验证两行都已消失。
5. 部署并启动新 Bridge artifact。
6. 检查 health/live，实测 workflow resume 仍为 enabled，founder consent 仍为 `audit_only` 并继续写入 audit 记录。
7. 如需 rollback，先恢复两条旧 env，确认持久化成功后再部署或启动旧 Bridge artifact。
