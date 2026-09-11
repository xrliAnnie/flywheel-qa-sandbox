# FLY-2506 合并权限范围 — 探索
Issue: FLY-2506 (https://linear.app/geoforge3d/issue/FLY-2506/病根-runner-合同before-any-merge-必须-verify-approval把冲突返工的)
日期: 2026-09-10
基于: 无

任务报告两次 conflict_rework 在合 origin/main 进 feature 前调用 ship 审批校验，得到 review_question_unbound 后停下。当前合同第 130 行确有 before ANY merge，并称 ship workflow 为 only merge path，扩大了 ship 权限边界。目标是让已授权返工直接同步主干，同时保留进入 main 的审批与 ship 工作流约束。
