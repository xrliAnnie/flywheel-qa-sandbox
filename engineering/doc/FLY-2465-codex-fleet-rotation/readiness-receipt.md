# FLY-2465 Codex 凭据迁移 — readiness receipt
Issue: FLY-2465 (https://linear.app/geoforge3d/issue/FLY-2465)
日期: 2026-09-09
基于: plan.md

部署 owner 在已批准的逐-home 迁移完成后运行检查器。它不迁移 home、不修改凭据、不自动扩大受管清单；只将通过检查的清单写为 `stateRoot/codex-quota/readiness-receipt.json`。不得把台架 receipt 当作生产迁移证明。

```
node scripts/codex-quota-readiness-receipt.mjs \
  --approved-homes /absolute/approved-homes.json \
  --canonical-home /absolute/canonical-home \
  --state-root /absolute/state-root \
  --build-sha <40-character-build-sha>
```

输入是显式数组，每行 `{ "home": "/absolute/home", "ownership": "managed" }` 或 `ownership: "independent"`。独立登录只作清点，不能通过这个命令纳入共享迁移。受管 home 必须已经链接到指定 canonical auth，且无 copy-pending 标记。

receipt schemaVersion=1，包含 buildSha、inventoryDigest、createdAt、homes。homes 每行包含 home、ownership、credentialShared、checkedAt。inventoryDigest 为按 home 排序的 `{home,ownership}` 数组的紧凑 JSON SHA256。时间为 ISO UTC；不写 account email、token 或凭据内容。

Bridge 每次 readiness 重新读取 receipt，核对摘要、process CODEX_HOME/FLYWHEEL_EXEC_ID、所有项目 CommDB 活跃行、keyed leases 和 Lead manifest authority，再检查实际链接。receipt 自身不证明当前活跃状态。缺失、损坏、不可读、未映射活跃家或无法交叉验证的 lease 都关闭自动能力。

独立活跃 home 的身份和刷新链由注入的身份读器核对：同 canonical 刷新链的非共享副本阻止切号；已确认不同链的独立账号加入候选号排除集合，读额度与探针前都须重查。身份不明不得继续。
