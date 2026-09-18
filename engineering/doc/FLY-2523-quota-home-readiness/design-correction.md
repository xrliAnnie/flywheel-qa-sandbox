# FLY-2523 最新验收与阶段边界 — 实施计划补充
Issue: FLY-2523 (https://linear.app/geoforge3d/issue/FLY-2523/部署-codex-额度自动切号子系统在宿主上收尾生成-readiness-receiptjsonapproved-homes-清单)
日期: 2026-09-18
基于: plan.md

## 恢复基线与效力

本轮 design activation `activation:3771e914-7dac-459e-a3bb-836776845903:cf4ec485-c982-4b9b-96e8-1a2a47e4e8d0:eng_design:1`，TURN epoch=8；继承 PR #1260 的 `f0ad7e677e4101460d3f240080ddddee648d7a96`。实现游标原为 5/6，历史保留，不将本轮文档校准宣称为实现或 QA 完成。

原始 R2 gate `26854a59-7c17-4fc8-918f-c1f527e2dc98` 与 529 返工 R2 gate `02993337-40e8-46ee-82ab-b8aea54cb0db` 的有效 APPROVED 均已重新读取。保留已批准设计及 §14 实现，不重新设计。以下按本轮注入的 Lead 18:4xZ–19:1xZ 判据补充验收，冲突时新判据优先；历史批准不是本轮精确头 QA 或 ship 授权。

## 激活仍须独立授权

标题中的正式开启目标仍保留；当前 design/implement/QA 不执行开启动作，也不以合入或部署代替授权。后续独立激活必须同时具备：

1. 最新注册 home 证据与当场完整拓扑一致。
2. FLY-2729 真部署且 daemon 换代 QA 证据有效。
3. 桌面凭据正向权威证明，完整 global checker `ready=true`。
4. 独立开关授权以及 scope/revision 审计。
5. 隔离 usage-limit 真实链选到 `target_profile`、daemon 换代、后续请求成功，Lead/thread/window 全程保留。

任一缺失就保持 off。Lead 注入信息称截至 2026-09-18 第2/3/5项未成立；这是上游状态说明，不是本轮生产复测。本轮不会把 registered.ready、fixture checker ready 或旧 ship 卡提升为开启权。旧头 `2bd9a1ed7` 的 claimId 1314 PASS 与 12:55:02Z ship 卡均已 superseded。

## 529 真实告警验收（下游 QA 执行）

使用 `scripts/test-deploy.sh <slot> --from-branch <tested-branch> --alerts --codex-home-reconcile` 真起房，再跑 `scripts/qa-fly-2523-529-alerts.sh <slot>`。保留 stdout JSON 的 slot/project/lead/channelId、两个 messageId 与 runRoot；第一轮 cycle 故意 exit 75，第二轮坏 policy 产生 warning，不以 driver exit 0 独立判绿。

- A1–A2：缺少 `--alerts` 的 opt-in 必须 exit 1；仅 `--alerts` 不代表开启 rider。
- A3–A5：分别 REST GET 两条消息得 HTTP 200；content 以 🚨 / ⚠️ 开头，均无 `<@`，allowed_mentions 无 users 元素。severe 包含 home id、逾期天数、精确修复命令；warning 包含 layer/reason，并说明管道故障。
- A6：消息频道等于 slot 自身 Lead alertChannel；与当轮生产 projects 所有 general/alert/chat 频道集合不相交。REST GET 频道名，不能相信日志里的 channel 字段。
- A7–A8：提供两条真实消息截图或 GIF 及可点消息链接；先复制 bridge.log、runRoot 回执、alert-pipeline-receipts 和驱动 JSON 到耐久证据目录，再 teardown。
- D3 加严：使用有读取权限的身份 REST 读取生产工程频道整个 QA 时间窗，断言无本次 QA 消息，且当轮 REST 核实频道名。§14 所述 slot bot 403 只证明不可访问，不能替代此条；没有可用读取身份时标未覆盖并报告，不宣称零生产发送。

## 阴性对照必须逐项可变红

| 判据 | 独立执行与证据 |
|---|---|
| B1 | 完整 slot 坐标中冒充生产 project/lead：config_error，零 POST、频道消息数不增。 |
| B2 | 分别碰撞生产 general、alert、chat 三类频道：每格 config_error、零 POST。 |
| B3 | isolation root 形状错误，以及 state/projects/queue/deadletter/claims 每一项单独越界：每格 config_error、零 POST。 |
| B4 | 只有 SLOT=1 泄漏、生产身份且其余 slot 坐标缺失：sender 仍走历史生产 pin，不静音、不改道。验证放隔离捕获台，不制造生产告警。 |
| B5 | cycle 中 project 错或 lead 错：分别 slot_identity_invalid、exit 2、无告警/无 state 写入。这是与 B4 有意不同的入口合同。 |
| B6 | policy/approved-homes/projects/canonical-home 分别越界：slot_path_outside_isolation、exit 2；路径祖先为 symlink 或非目录：slot_path_unsafe、exit 2。 |
| B7 | slot Lead 绑定0条、2条分别 slot_lead_binding_invalid、exit 2。 |
| B8 | 默认起房后从真实进程或 wrapper env 证明 enabled=0 且最后一次赋值有效，不用源码推断运行值。 |
| B9 | 真 node 执行打包产物中的 cycle 和同族入口到参数/坐标校验，记录预期退出码，证明 import 可解析；正则/grep 不算。 |

## 原安全合同回归

C1 busy fixture 必须先实际得到 skipped/active_process，再比较目标整树 mode/mtime_ns/ctime_ns/size/sha256/link target，且无备份、pending 保留。ps 桩同时回答进程枚举与逐PID环境查询；退出0不能证明 busy 识别。

C2–C4 idle 为 done/linked，指向 canonical realpath，清 pending，恰好一份0600备份、内容等于原文件且 backupRef 在同条回执；立即重跑及 already-satisfied+busy 均无整树变化、无新备份，后者 mutation=false。canonical auth 的 sha256 每轮不变。

C5–C6 所有 approved fixture 满足后 receipt 只写 `<state-root>/codex-quota/readiness-receipt.json`，真实 checker ready=true；将一家改回 copy+pending，立即重跑必须 ready=false、credential_not_shared。不得以 registered 子集证明代替完整生产 global checker。

C7 真机 roster 推导只读，列全五家及 managed 归属、auth 形态、pending；不得写文件。使用归档夹具前把所有旧绝对路径改到被测 worktree，打印实际加载 dist 的绝对路径及该树 HEAD；旧 dist 的 PASS 不算当前证据。

G1/G2 精确头 CI 全绿并记录 run id、merge-tree 冲突数与当轮 main base SHA。D1/D2 前后比较 canonical auth sha256/mtime、五家 auth/pending、codex-quota 目录清单及生产 projects sha256/mtime，差异即红，不用旧 §14 的归因许可免除此新要求。D4 diff 证明无新增 launchd/plist/crontab 及相关加载/写入；D5 所有 fixture 在 QA 自己的 /tmp，改共享树必须有 TURN。全程不跑本地全量 test:packages:run。

E1 报告逐项列实际退出码与 POST 计数、房号/消息/频道/驱动 JSON。E2 诚实边界写“没测什么 / 为什么 / 风险与补测时间”，无证据不算覆盖。E3 旧 PASS 不得盖新头。

## 读数同源与告警等级

本轮只读复核 `packages/teamlead/src/bridge/capacity.ts` 仍产出 Codex `source: null`；`hook-payload.ts` 的 `capacity.quota.codex.source !== null` 仍拒绝非空值。就绪回执是凭据拓扑证明，不是额度用量数值源。本补充不提出新 Codex 数值源；QA 应回归 /api/capacity、巡检和 FLY-2688 accounts builder 一致性，若实现引入非空 source 则明确报依赖未覆盖，不以 ready 字段替换用量。

逾期且需要人处理才允许 severe；名册读取失败或观察管道故障只能 warning、不 @founder。两条 slot 测试消息均无 mention。按(单元,原因,UTC日)去重，不能压掉同日新原因；无回执逾期真实发送及破坏条件后变红的测试保留。

## 本轮交付边界

仅补文档与 founder HTML，并请求当前 activation 的有效设计审查。未执行任何 QA 真发、production home 迁移、登录、flag 写入、重启、部署或 ship。图沿用此前两次本地渲染失败后保留的 Mermaid 源及明确占位，不将其称为截图或浏览器视觉验证。
