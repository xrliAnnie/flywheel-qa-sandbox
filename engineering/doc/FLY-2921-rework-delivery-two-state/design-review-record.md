# FLY-2921 返工投递收成两态 — 设计评审记录
Issue: FLY-2921 (https://linear.app/geoforge3d/issue/FLY-2921/病根修复-6-返工投递收成两态送达-失败交还-lead投给死体改投替身不再把整条-run-打-held6-张-46)
日期: 2026-09-26
基于: plan.md

有效评审：Codex `gpt-6-astra` xhigh（manifest 指定），线程 `01a0deb1-522a-7c72-bf1f-0dd7c177c4df`。

| 轮次 | 结论 | 原文 |
|---|---|---|
| R1 | CHANGES REQUESTED（1 BLOCKER、6 MAJOR、3 MINOR） | codex-review-r1.md |
| R2 | CHANGES REQUESTED（1 BLOCKER、3 MAJOR） | codex-review-r2.md |
| R3 | CHANGES REQUESTED（0 BLOCKER、1 MAJOR） | codex-review-r3.md |
| R4（Lead 裁定只验 R3#1，问题 `d4c8e2ff`） | **APPROVED** | codex-review-r4.md |

- Codex 批准的 plan blob 是 `63bf95a6b1903be9b32653e9a518315b0eccca20`（提交 `ef48a529c`）。批准之后 plan.md **没有再改过**。为了不让已批准的 blob 失效，R4 结论记在本文件，而不回写 plan §10。
- **非有效评审（照实记录）**：
  - 第一次 Codex 评审在本机账号撞周额度时中断；
  - Bridge `request-review` 因本 run 的评审路由钉的是 codex，返回 409；
  - 独立 Claude（fable）子代理跑过一轮参考评审，原文见 review-reference-r1.md，Lead 裁定不算有效评审。
- 这三次的实质发现都已吸收进 plan，详见 plan §10。
