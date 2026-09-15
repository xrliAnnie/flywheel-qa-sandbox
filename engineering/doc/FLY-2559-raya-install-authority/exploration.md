# FLY-2559 Raya 首装修复 — 探索
Issue: FLY-2559 (https://linear.app/geoforge3d/issue/FLY-2559/2496热修-raya-标准-lead-装不上resident-codex-lead-recoversh-的-wrapper-白名单只认)
日期: 2026-09-14
基于: 无

目标：使 Raya registered → credential preparation → preflight → install 路径可用。隔离 fixture 验证，不操作生产 home、频道、wrapper 或 updater。

发现：recover 和公共 restart authority 各有 wrapper 白名单；标准 install 实际写 flywheel-lead.sh carrier。现有测试 preflight 使用 link-truth stub，无法覆盖首装凭据链。
