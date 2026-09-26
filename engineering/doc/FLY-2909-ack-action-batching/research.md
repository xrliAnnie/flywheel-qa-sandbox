# FLY-2909 ACK 开关返工 — 调研
Issue: FLY-2909
日期: 2026-09-26
基于: exploration.md

沿用 lead_token_savings 的只读 SQLite launch reader、共享规则选择器与治理 registry/store codec。项目行优先于 * 行，再取默认值。启动时读取，生效需下一次 Lead 启动；本节点不重启服务。
