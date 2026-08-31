# FLY-2137 founder 日历治理 — 设计修正
Issue: FLY-2137 (https://linear.app/geoforge3d/issue/FLY-2137/治理-founder-的-google-calendar-写入权必须定规矩qa-期间实测第二条未授权写入路agent-自建假会议邮件提醒)
日期: 2026-08-31
基于: plan.md

## CLAUDE.md 治理指针移交

批准计划 §3 #13 原拟由实现节点在 `CLAUDE.md` Non-Negotiables 增加一行 founder 日历治理指针；
本次 implement node 的注入合同同时明确规定 `do not touch CLAUDE.md`。实现节点按更高优先级边界
没有修改该共享文件，并通过问题 `14580e9f-7c5a-4c5c-ab48-538d1eaade2f` 请求 Lead 裁定。

Lead 裁定如下：

- 本 PR 的 durable 治理指针落在本文件夹、FLY-2137 Linear 关系/评论和 PR；
- `CLAUDE.md` 条目属于 founder 批准规矩后“规矩生效”的动作；
- founder 批准后由 Lead 在 main checkout 单独提交该条目，避免 implement node 越界；
- 这是明确移交，不是静默删 scope。本文件不修改已批准的 `plan.md` blob。

实现与 QA 仍以 `plan.md` 的 P6、每日 sweep、测试日历和 FLY-2204 凭据隔离 blocker 为准。
