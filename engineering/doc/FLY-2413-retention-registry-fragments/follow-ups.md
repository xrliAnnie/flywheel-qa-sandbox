# FLY-2413 评审非阻塞建议 — 调研
Issue: FLY-2413 (https://linear.app/geoforge3d/issue/FLY-2413/fly-2006-retention-registry-是并发热点任何加表的单都要改同一个测试文件同批-pr-必然互撞)
日期: 2026-09-14
基于: plan.md

有效 reviewVerdict=APPROVED，reviewerVerdict=APPROVED，round=1。以下 4 MEDIUM / 4 LOW 均为 advisories，无阻塞 finding。完整原文见 design-review-receipt.json；本页是后续交接提示，不表示建议已实现，也不构成 Lead 的治理裁定。

按 runner 合同将全部建议 fire-and-forget 报给 Lead，由 Lead 选择后续处置。本轮不重新开启设计评审，不改写已评审方案的行为合同。

## MEDIUM — fly1674-filename-residue-scan

三阶段残留守卫的"文件名"扫描没有例外机制，two `three_stage_turn.json` 片段会把它打红

计划只替换了 scripts/__tests__/fly1674-residue.test.sh 的 allowed_hits（内容例外），但该脚本还有第二段独立扫描：`rg --files ... | grep -iE 'three[-_ ]?stage'`，断言"active file names contain no retired three-stage path"，且完全没有 allowlist。按 §2 的强制命名合同（文件名必须等于 table+'.json'），迁移会产生 scripts/lib/fly-2006-retention-tables/teamlead/three_stage_turn.json 与 comm/three_stage_turn.json 两个路径；实测 `printf 'scripts/lib/fly-2006-retention-tables/teamlead/three_stage_turn.json' | grep -iE 'three[-_ ]?stage'` 命中，于是 fly1674 会 FAIL（CI .github/workflows/ci.yml:1156）。计划同时写明"其他例外不动""不得为了绿改成目录通配许可"，等于把实施者逼进一个没有预设出路的角落：要么改命名合同（loader 会拒绝不符路径），要么给文件名扫描新增例外机制（属于守卫放宽，需要在设计里先裁定）。请在计划里显式给出选择（建议：为该扫描增加与 allowed_hits 同形的精确路径例外，并保留 liveness 检查），否则实施必然在 Task 4 停摆一轮。

状态：已记录；未实施；等待 Lead 选择后续。

## MEDIUM — fragment-dir-stray-file-import-blast-radius

严格目录扫描在 import 期抛错，会把 .DS_Store/.orig 这类未跟踪文件升级成 restart 窗口的 severe 告警

§2.1 规定子目录"只接受普通 .json 文件…拒绝未知扩展"，而 §2 规定 registry 顶层加载一次快照 ⇒ 任何非法条目在 **模块 import 阶段** 抛错。影响面不止 retention：scripts/db-maintenance.sh:13 的 RETENTION_CLI 就是 fly-1998-database-retention-sweep.mjs（import engine → import registry），而 restart-services.sh:3074 在重启窗口调用 db-maintenance.sh，失败会 alert_severe database-maintenance-failed；janitor 的 db_retention 模块同理。今天 registry 是单个 .mjs，只有被人编辑才可能坏；改成目录后，Finder 生成的 .DS_Store（.gitignore:2 已忽略，git status 仍然干净）、`git mergetool` 留下的 *.json.orig、编辑器临时文件都会让生产维护路径整条红。方向是 fail-closed（不会误删），但请在设计里明确 dotfile/备份文件策略（建议：显式跳过 `.` 开头条目，其余未知扩展仍硬拒），并在错误信息里给出具体相对路径。

状态：已记录；未实施；等待 Lead 选择后续。

## MEDIUM — missing-direction-cross-copy-guard-lost

删掉 production-tables fixture 后，"登记了一张永远不存在的表"不再有任何 CI 守卫，只会在生产 inventory 才 fail-closed

计划把 scripts/__tests__/fixtures/fly-2006-teamlead-production-tables.json（228 条，实核）定性为"同源镜像"因此可删。对 unclassified 方向这个判断成立，但它今天还承担另一个作用：sweep test:611 `expect(TEAMLEAD_PRODUCTION_TABLES).toEqual([...teamleadNames].sort())` 是两份手工副本的交叉核对，任何"只在一处写错表名"的登记会在 CI 变红。迁移后：新通用真实库测试只调 assertNoUnclassifiedSchema（单向），strict guard 只用微型 fixture 测，于是 `teamlead/sesions.json` 这类拼写错误可以一路绿灯合入；直到生产 inventory 调 assertClassifiedSchema 时抛 schema_missing:teamlead:sesions，janitor 每轮 inventory-failed 并写 failure 证据，retention 整条停摆，只能在生产被发现。请在 §3/§8 明确承认这条覆盖损失，或加一个便宜的替代（例如：登记集合减去真实初始化表集合后，剩余项必须出现在一份显式的"延迟/历史建表"小清单里——这正是 retiredOptional 的语义位置）。

状态：已记录；未实施；等待 Lead 选择后续。

## MEDIUM — digest-closure-underspecified

摘要闭包的边界与 registrySha256 的新语义没有定死，两种合理实现会产出不同摘要

§2 的接口是 loadRetentionSnapshot(root: URL)（root 指向片段目录），§4 又要求摘要输入包含"registry 源、loader 源、全部 JSON"，而同节明确 loader 不 import registry。计划没有说：这两个 .mjs 源路径由谁提供（registry 自报？loader 硬编码同级文件名？）、"模块根相对 POSIX 路径"的根到底是 scripts/lib 还是片段目录、以及测试用参数化 root 时这两个源如何参与。这是一个直接为删除授权背书的字段（fly2139ActivationRequirements().registrySha256 从"registry.mjs 文件 hash"变成"输入闭包 hash"），语义变更也应写进 §4 的兼容策略（字段名不变但含义变了，运维读凭证时会误解）。注：即便闭包漏掉 registry.mjs，engineSourceDigest 的五文件表仍覆盖它，所以不构成授权漏洞；但摘要合同必须唯一可实现，否则两轮实现/回滚会得到不同摘要。

状态：已记录；未实施；等待 Lead 选择后续。

## LOW — policy-equality-loosened-to-set

deleteTarget↔RETENTION_TARGET_POLICIES 由"排序数组相等"放宽成"去重集合相等"，会漏掉重复 policy

现有断言在 sweep test:1165 是 `policies.map(table).sort()` 对 `[...deleteTarget].sort()`，即多重集合相等。实核当前 RETENTION_TARGET_POLICIES 共 28 条、(database,table) 无重复，恰与 21+7 个 deleteTarget 一一对应。计划改成集合相等并声明"允许多个 policy target 共享同表"，等于主动放弃对"同一张表被两条 policy 重复扫描/重复计数"的检测，而这条放宽在本单里没有任何需求驱动。建议保留现有多重集合相等；若确有共享同表的未来需求，单独立项并给出 caps 叠加语义的证据。

状态：已记录；未实施；等待 Lead 选择后续。

## LOW — temp-module-tree-deps-unspecified

Task 3 的"临时模块副本"缺少可运行所需的依赖布局说明

registry.mjs:1 从 `../../packages/teamlead/dist/bridge/release-readiness/evaluate.js` re-export RETENTION_MS，engine.mjs:38 用 `createRequire(join(repoRoot,'packages/teamlead/package.json'))` 解析 better-sqlite3（repoRoot = scripts/lib/../..）。只把 scripts/lib 拷到 /tmp 的副本会在 import 阶段直接失败，Task 3 的三个 RED（activation_receipt_invalid / registry_inputs_changed / engine_digest_mismatch）全都跑不起来。请在计划里写死副本布局（<tmp>/scripts/lib 全量拷贝 + <tmp>/packages 软链或最小 dist+package.json+node_modules 软链），并说明子进程如何以新进程重新加载模块。

状态：已记录；未实施；等待 Lead 选择后续。

## LOW — json-format-and-companion-doc-tokens

片段示例用 2 空格缩进，与仓库 biome 格式化结果不一致；新 .md 说明文件会被 fly1645 扫描

biome.json 的 files.includes 是 `**`，`pnpm lint`（ci.yml:159）会检查 JSON；实测 `biome format --stdin-file-path=...json` 对该片段输出的是 **tab 缩进**（键值展开，不会折成一行——所以 fly1645 的 `"table": "x",` 行锚定是安全的）。计划的示例按 2 空格写，257 个文件一次生成后会整片 lint 红。另外 §5 新增的 `scripts/lib/fly-2006-retention-tables.md` 落在 fly1645 gate 的扫描范围内（config 的 extensions 含 .md、includeRoots 含 scripts），如果说明文档里引用 receipt_root_lineage / receipt_handle_requests 作为例子，expectedAllowedMatches(9/3) 会被顶破。建议在计划里把片段的规范字节形态（tab 缩进、键序、结尾换行）写成合同，并注明该 .md 不得出现 denied 表名。

状态：已记录；未实施；等待 Lead 选择后续。

## LOW — classification-rationale-comment-dropped

"恰有三个字段"会丢掉 registry 里现存的分类理由注释

scripts/lib/fly-2006-retention-registry.mjs:59-61 保留着一条审查结论注释（"Quota tables retain current pause, recovery, install, and delivery references. No quota deletion policy is authorized by the fleet rotation change."）。片段限定恰好三个字段、JSON 无注释语法，这条理由在迁移后无处安放。分类本身是"人工审查结论"，理由是它的证据。建议在计划里指定去处（迁移证据 implementation-evidence.md + scripts/lib/fly-2006-retention-tables.md 的 quota 小节），而不是在实施时静默丢弃。

状态：已记录；未实施；等待 Lead 选择后续。

