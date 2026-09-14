# FLY-2467 全包门可靠性 — 探索
Issue: FLY-2467 (https://linear.app/geoforge3d/issue/FLY-2467)
日期: 2026-09-14
基于: 无

## 当前证据与边界
基线 HEAD 31979aa94。本分支无已有 FLY-2467 文档。TURN implement epoch=1 已取得；收件箱无指令。
package.json 直接 pnpm recursive test:run，包失败会阻断后续证据。CI teamlead 3 片，矩阵 fail-fast=false；CI OK 已通过 needs unit-tests 覆盖整个矩阵。
本单仅 CI、测试配置、聚合脚本、runner 模板及其测试；不改生产源码，不改测试 timeout/skip/only，不重启服务。
目标不是把未知错误变绿：仅完整零失败收据且全部异常精确为 worker onTaskUpdate RPC timeout 才可进入一次重试与伪影分类。
