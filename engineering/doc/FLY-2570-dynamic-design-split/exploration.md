# FLY-2570 动态设计分流 — 探索
Issue: FLY-2570 (https://linear.app/geoforge3d/issue/FLY-2570)
日期: 2026-09-14
基于: 无

## 目标与当前证据

2026-09-15 重读 Linear 当前正文（updatedAt 03:53:13.688Z）。目标是人设比例热生效，包括 Codex 断供时的 0% Codex / 100% Fable；75/25 只是当前期望值。仅 code.eng_design；不变更 implement/qa、跨 vendor 约束或 ship 权限。

Lead mailbox 93203c2f-08f8-41f9-a9ff-d8daa1b58e23 说明原 simple_code 没有设计交接，授权本节点先完整 DOC-FLOW + design review。

HEAD 6af2b8990：registry 配置 v1 奇偶；model-config.ts 已按文件 stat 身份热读取 models.json。问题是策略表达能力与安全写入/查询入口不足，不是完全没有热配置基础。
workflow-menu.ts 的 runtimeModelSplitStatus=invalid 路径当前取消分臂；必须为 code.eng_design 抛错。
workflow-dispatch-resolution.ts 还只接受 v1 rule，扩展时必须保持旧收据可回放。
FLY-2403 SQL 四口径已分别报告 N，但没有规则版本筛选。

## 三种方案

1. **复用 models.json（推荐）**：增加确定性 percentage rule 与 operator set/show 命令。复用派单决策现有 snapshot，不新增 DB 或重启路径；配置域仍是这台 host 的模型策略，仅应用于 code.eng_design。
2. 新增 project flag：现成写审计，但要把项目、store、runtime resolver 依赖引入目前独立的 menu 解析器，并与现有 models.json 形成两套优先级。当前目标无需此扩展。
3. 热改 registry：绑定大量菜单配置，缓存/校验影响更广，不适合单一止血阀。

## 固定语义

“下一次派单”是下一次新 workflow 的 admission/selection。已经生成 assignment 的 workflow 保留其策略与模型，重试/重启不得套用今天的比例改写历史。0% 必须让任意合法新 issue 进入 Fable；100% 必须进入 Codex。不会自动搬迁已派出去或 quota-held 的 workflow；需要 Lead 按现有恢复流程重新派单。

百分比支持任意有限 JS 数值 0..100（包括小数），无整数/25% 档位限制。稳定散列实现预期比例，不承诺小样本恰好 3:1。没有 RNG、自动调参或新 UI。
