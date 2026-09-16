# FLY-2619 Raya 汇报合同 — 实现记录
Issue: FLY-2619 (https://linear.app/geoforge3d/issue/FLY-2619/raya汇报合同-文字模式不再每轮强制发言恢复-1846-63没内容可跳过-她可见面去统计头缺交名单roundid英文报错取消-6h)
日期: 2026-09-16
基于: plan.md

状态：实现与本地全仓验证已完成，代码复审、Flywheel PR exact-head CI 与隔离 QA 仍由后续关卡确认。Raya 配套源码 PR 为 [xrliAnnie/raya#154](https://github.com/xrliAnnie/raya/pull/154)。本文不表示新合同已上线。

## 1. 实现结果

- E-1：summary round 仍逐轮写 `lead_events` 与 presentation member；Raya 可将完成组判为 `silent`，此路径不调用 outbound。单轮有实质内容仍可冻结一份中文正文并发送一次。
- E-2：旧/新 queued summary 投影不再携带“每轮必须发言”命令；专用 formatter 拒绝 round/group ID、`N/M` 统计、缺交名单及原始错误。原 summary fleet alert 改为固定中文影响说明与 opaque diagnosticRef。自动六小时 pass 仍做 due/settlement 和后台记账，但空轮没有 founder-visible 汇总。
- E-4：rider 在一个事务内追加同 pass 的全部成熟轮次；presentation begin 一次领取当前全部 eligible 轮次并冻结同一 group。组内逐轮保留业务结果，finalize 最多产生一份 founder-visible 消息。
- 恢复：silent/sent 幂等；未知发送进入 `ambiguous` 且不换键重发，也不阻塞下一组；collecting/sending/ambiguous 与 building migration 超过两个 cadence 后只认领一次脱敏 stale 告警。受管支持入口只能给原成员补明确 failed 结果，不能改写发送键。
- 历史迁移：updater 在新版 Raya preflight/install 前运行受管 adapter。边界内每轮必须分类；只有真实 message/channel 证据可标为 `historical_presented`，明确静默证据可标为 `historical_silent`，明确未处理且无发送尝试的人工决定才可释放为 `eligible`，其余进入 `needs_reconciliation`。中断按 cursor 恢复，输入变更只重算未确认分类，完成后 source digest 漂移 fail closed。

## 2. 两仓身份与加载边界

| 面 | 当前证据 | 结论 |
|---|---|---|
| Flywheel 实现分支 | package-gate head `d8a3745350c162f606a735b4ae73aa0298d38228`，其后只有 Biome 格式化与 closeout 文档 | Bridge/controller/store/migration/updater 已提交；最终 PR head 以后续 milestone commit 为准 |
| Raya 受管源码 | `c320c66ab686ef5dd409af7c428258b06373167f`，PR #154 | `.lead/raya/identity.md` 与 `packages/cos` 改为 group presentation 合同 |
| Raya persona 源 hash | `.lead/raya/identity.md` = `707bdb8f3c35e9d7b8e16bd892f0469646af0f8a2579e622d02cc2d60900253b` | PR 源码证据，不是当前加载 hash |
| Raya COS 源 hash | `summary-round.ts` = `d0c137a554270bb2aeac530a6fda271756f48cd74b8f11476f25d24143d72f4d`；`summary-report.ts` = `24dbcc549b8d39421c84fbb371b6f1d6032c9a2d61d39c0faaff85abe22a5008` | PR 源码证据，不是当前加载 hash |
| 当前生产 deploy checkout（只读核对） | HEAD `0f77e9772176c973eb1e09548b00c05ae550ef32`；根 `IDENTITY.md` hash `b2c7e5220740122218c4f4fff6be0988b64a9c86627eb65c22a9d78bed4befa1`；没有上述 `.lead`/COS 源文件 | 仍是旧部署形态，未被本实现修改 |
| 当前受管业务 workspace（只读核对） | `/Users/xiaorongli/Dev/raya-lead-workspace/.lead/raya/identity.md` hash `4e982448296ac31215dde62ac2a6343f642753eeb39ba96e16767ed921e63b1f` | 与 PR persona hash 不同；新合同未加载 |

源码映射由标准 updater 完成：Raya PR 的受管业务 artifact 写入 canonical `raya/raya` workspace，Flywheel updater 先在 authoritative `teamlead.db` 完成 presentation migration，再执行现有 preflight/install/restart 生命周期。本实现没有编辑 `~/.flywheel/raya/`、没有重启进程、没有向真实 `#raya` 发消息。

## 3. 测试证据

行为测试先加入并观察失败，再实现最小状态机/投影/受管 persona 合同。当前结果：

- Biome 格式化后的 Flywheel presentation/renderer/rider/lead-actions/heartbeat 定向集：9 files，91 tests passed。
- `pnpm --filter flywheel-teamlead typecheck`：通过；格式化后 `pnpm -r build`：通过。
- `pnpm lint`：exit 0；0 errors，22 条均为本分支未触及文件的既存 warnings。
- 历史迁移：100 个旧轮次的中断/恢复、明确积压与未知隔离、3 个新 v2 轮次、source change、ACK 非呈现证据：通过。
- updater shell：40 passed，0 failed；确认迁移完成在新版 Raya preflight/install 之前。
- retention consumer gate：测试 9 passed，生产扫描 `ok:true`；`lead_events` 读取登记为 `candidate_guarded`，缺失证据只会拒绝/跳过操作，不把缺失变成权限。
- `pnpm test:packages:run` 在 `d8a3745350c162f606a735b4ae73aa0298d38228` 完整通过：17 packages、1822 files、23689 passed、32 skipped、0 failed；同一 receipt 的 build 也通过。receipt：`/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/flywheel-package-gate-Oxzoha/summary.json`。
- aggregate 前两次分别暴露一次不可复现的 founder-consent 404，以及可复现的同毫秒 heartbeat event-id 碰撞；前者独立 22/22 后在最终 aggregate 22/22，后者以冻结递增时钟稳定测试身份，独立 23/23 且最终 aggregate 23/23。只有上述第三次完整通过作为 package-gate 证据。
- Raya COS 全套：55 files，302 tests passed；另有 presentation receipt 身份/round 绑定负测 3 passed；`pnpm lint`、`pnpm build`、`pnpm typecheck` 通过。

代码复审、最终两个 PR 的 exact-head CI 与隔离真机 QA 尚未在本文写作时完成，不在这里提前写绿。最终 CI 需覆盖 milestone/doc-only 尾提交与上述 Biome 格式化后的精确 PR head。

## 4. 激活与 QA 边界

合入不等于生效。两个 PR 均合入、标准 updater 完成数据迁移与受管 artifact 安装、Raya 进程重启且读回源码/加载 hash 后，才可能报告新合同生效。任一步之前旧合同继续运行。

Implement 节点不做生产部署或重启，也不派发 QA。后续 QA 必须在非生产 DB/workspace/bot/channel 的隔离副本验证：3 空轮为 0 可见消息但 3 条后台账本；2 轮积压为 1 条；单轮实质内容仍为 1 条；六小时调度不发自动主频道汇总；chat 与 alert 两个可见面均无内部 ID、统计头、缺交名单或原始英文错误。
