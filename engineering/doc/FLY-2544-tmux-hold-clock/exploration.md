# FLY-2544 确定性 hold 测试 — 探索
Issue: FLY-2544 (https://linear.app/geoforge3d/issue/FLY-2544/flake-tmuxadaptertestts-ensurerunnersessionfly-758-deadlinems1-计时竞态让)
日期: 2026-09-14
基于: 无

Scope: only the saturated typed-hold test and its clock cleanup; no production source changes, weakened assertions, or skips. Current base: 14866f7e5. TURN: implement epoch 1. No existing issue doc folder or approved plan found.

The real 1ms budget can expire between startedAt and the initial while check, returning unknown/deadline_exhausted before the mocked helper runs.
