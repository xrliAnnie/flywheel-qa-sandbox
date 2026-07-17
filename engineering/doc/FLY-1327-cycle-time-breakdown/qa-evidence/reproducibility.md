# FLY-1327 周期时间分解 — 可复现性
Issue: FLY-1327
日期: 2026-07-17
基于: plan.md

## Procedure

使用 manifest 中固定的 `as-of=2026-07-17T08:55:31.345Z`，重新执行完整五源采集和渲染到独立临时目录。逐字节比较：

- `manifest.json`
- `data-FLY-1309.json`
- `data-FLY-1307.json`
- `data-FLY-1319.json`
- `data-FLY-1252.json`
- `cycle-time-report.html`

六个文件全部 `cmp` 通过。cross-family review R3 修复后的最终重跑目录为 `/private/tmp/fly1327-repro7.Dng9a5/output`；该 scratch 路径只用于 QA，不进入 canonical 产物。

## Snapshot retention

每次采集的 SQLite backup 暂时保留在系统生成的 `0700` 临时目录，目的是在评审期间复核同一份 WAL-safe 快照；完整 DB 不写入 HTML、canonical JSON 或 Git。该取舍只适合当前单用户开发机，后续若把采集器服务化，应增加显式 retention TTL / success cleanup。

## Published artifact hashes

- HTML: `1b55649bb9e212ca3ebf462108af34d71a3ea834f680439ab657bb1c089aebd2`
- manifest: `afb8b2c3e8c1877dad49eec4620c1c2f35d61901a1a9e5eb5f126bc443b8cd85`
- FLY-1309: `b80f8dec9b26b5ce05b91237a045784469979280c922d7b2fec8cff08d4e9934`
- FLY-1307: `0291e500270f58fe4c5fcd84cf03cf1e0c1d3e8ccdb2a6443e7e35b55c04a053`
- FLY-1319: `16aee3506f9bfa22f5a684e13a1203a4266788cd1cff622754789869731b6b60`
- FLY-1252: `73381917989931c1ce96d97f0e58a38b25e5e93f4124e3c22fb95c5e0bc12a74`
