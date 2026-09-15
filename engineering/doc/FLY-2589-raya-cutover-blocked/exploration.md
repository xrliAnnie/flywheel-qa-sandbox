# FLY-2589 生产 Raya 仍是旧壳 0f77e977 — 探索

Issue: FLY-2589 (https://linear.app/geoforge3d/issue/FLY-2589/raya热修-生产-raya-仍是旧壳-0f77e9770000-班车判-raya-rayaconfig)
日期: 2026-09-15
基于: 无

## 1. 现象（Lead 已核，本单复核通过）

2026-09-15 00:00 PT 班车两条错误连在一起：

```
00:13:19 [restart] ERROR: Lead candidate raya-raya cannot be assigned safe restart authority
                   (class=config-drift project=raya lead=raya sources=manifest)
00:14:20 [restart] WARNING: code deployed; Lead restart result is degraded — 失败: raya-raya
00:14:21 [flywheel-updater] raya shuttle: not_configured migration-ledger-absent
```

生产 Raya 仍是 9 月 8 日那个旧壳：`~/.flywheel/raya/code` HEAD `0f77e977`，
`deploy-receipt.json` 还是 `schemaVersion 1` / `carrier` 缺席；FLY-2445 的目标头
`9d63a2b2` 早已在 `origin/main`，但 P0–P7 割接一次都没跑过。

## 2. 两条错误不是同一件事，但同源

| 错误 | 判定位置 | 直接含义 |
|---|---|---|
| `config-drift sources=manifest` | Lead 重启波（`restart-services.sh`） | `manifests/raya-raya.json` 在，但 `projects.json` 里查不到 `raya/raya` 这一行 |
| `migration-ledger-absent` | Raya 班车（`updater-raya-deploy.sh`） | `~/.flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json` 不存在 |

两者的共同上游是：**FLY-2496 §4 的宿主激活包（H0–H3）在 2026-09-14 只跑到一半，
而且跑过的那一半后来被人手回滚了，回滚只回滚了注册表、没回滚 manifest 投影。**

## 3. 本单的三个问题

1. `config-drift sources=manifest` 具体读什么？manifest 的哪个字段漂了？
   —— 结论：**manifest 自身一个字段都没漂**，漂的是 manifest 与 `projects.json` 的**关系**。
2. `migration-ledger-absent` 指哪个文件、由哪一步写出？为什么 FLY-2496 在 Linear 是
   Done、账本却不存在？
   —— 结论：账本由 H3（人手，`raya-migration-manifest.js init`）写；FLY-2496 交付的是
   **代码**，H0–H3 是代码之外的 operator 步骤，从来没跑到 H3。
3. 最小修复是什么，哪些是 operator 步骤、哪些是代码改动？
   —— 结论：**唯一必须做的修复是补回注册表那一行**（重跑 H2 register）。
   manifest 不用改、updater 判定不用改（它两次都是正确地 fail-closed）。
   代码侧只留下一个**独立的加固 follow-up**：孤儿 manifest 没有任何人回收。

## 4. 约束

- 只读调查；不改宿主状态、不跑 install/launchctl、不动 `~/.flywheel/raya/code`。
- ship / 紧急重启是 founder 门；本单只产出 runbook，不执行。
- 详细证据见 [research.md](research.md)，修复与 runbook 见 [plan.md](plan.md)。
