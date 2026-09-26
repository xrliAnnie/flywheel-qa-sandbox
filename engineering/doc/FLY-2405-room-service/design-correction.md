# FLY-2405 起房服务 — 实施说明
Issue: FLY-2405 (https://linear.app/geoforge3d/issue/FLY-2405)
日期: 2026-09-26
基于: plan.md

- Lead 裁定 `e77dd177-2b14-42f4-842b-c6fa4358568b`：§15 env-only 回退改为 bridge-global `qa_room_service` flag store；生产默认 on，隔离默认 off、有界 TEST_ opt-in，stage/apply 即时回退，无新增豁免。详见 plan.md 末节。
