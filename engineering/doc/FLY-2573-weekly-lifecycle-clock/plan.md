# FLY-2573 weekly lifecycle 时间夹具 — 实施计划
Issue: FLY-2573 (https://linear.app/geoforge3d/issue/FLY-2573/ci假红-db-maintenance-weekly-lifecycle-测试跨秒就假红假-stat-在读取时才取-date)
日期: 2026-09-14
基于: research.md

## 范围
仅修改 scripts/__tests__/db-maintenance.test.sh；文档在本目录，最终里程碑 engineering/doc/milestones/FLY-2573.md。不改生产源或 CI 注册（现有脚本已在 Script Tests 内）。使用 Bash、SQLite、jq 和 PATH 注入。

## 审查
设计 gate cfe6644a-e1fd-4ea3-a9b2-aa0190e0163d：effective APPROVED。macOS 必须用规范 TMPDIR=/private/tmp；fake date 的真实路径在 PATH 注入前通过 command -v date 捕获，经环境传入，不能 exec date 递归。一次跨秒使第一个 DB RED（4 receipts），后两个正常 skip，足以作为同一脚本的确定性阳性对照。20 次是用户验收重复稳定性证据，确定性 RED/GREEN 才是因果证据；不声称概率保证。

## 执行步骤
- [ ] 安装锁定依赖 `pnpm install --frozen-lockfile`，准备必要构建。
- [ ] RED：在现有 GNU_STAT_BIN 中加入 fake date，毫秒时钟文件初值 2000000000999。`+%s` 返回文件值除以 1000；其他参数 exec 真实 date。在现有假 BSD stat 探测中将文件置为 2000000001000。保留旧 GNU 分支 `date +%s`。执行 `TMPDIR=/private/tmp bash scripts/__tests__/db-maintenance.test.sh`，必须观察 weekly lifecycle 收据超出 3 条，记录完整日志和 rc；非目标失败不能冒充 RED。
- [ ] GREEN：在夹具创建时记录 `fixture_mtime=2000000000`，经子进程环境传入 GNU stat；把 `date +%s` 替换为 `printf` 输出冻结值。跨秒时钟保持启用，断言跨秒文件终值与 3 条 skip、3 条收据、rc=0。
- [ ] 增加 future fixture：单独临时 HOME，创建真实 teamlead DB 和 schemaVersion=1/issue=FLY-2139/64位 receiptSha256 的 marker；令 now=2000000000、mtime=2000000001，走完整脚本。断言 rc=0、无 weekly skip、有 complete 和一条 VACUUM 收据。复用假 date/stat，但 future 模式不推进时钟。生产文件不变。
- [ ] `bash -n scripts/__tests__/db-maintenance.test.sh`；完整脚本连续执行 20 次，任一次失败即整体失败，保留每次日志。次数是验收证据，不进入测试重试逻辑。
- [ ] 运行 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`；严格区分 aggregate green 和完整 PACKAGE_GATE_RECEIPT 可接受 RPC-only 情况。对 unreached 包按注入命令运行。
- [ ] 更新 progress 和验证文档，提交代码。请求注入 review_code gate 并 request-review，取得有效 APPROVED；阻塞 finding 修复后新审。
- [ ] 按里程碑约定以 FLY-2573.md 为 literal last commit，push feature branch，开 PR。检查 exact-head CI，保留验证产物与 gate 收据，必要时对最终 head 新审。
- [ ] inbox 检查、ask --report 汇报，执行 `complete --route needs_review --pr <NUMBER>`，随后 park；不派 QA，不 merge。

## 验收映射
跨秒修前红/修后绿：同一个虚拟时钟和同一完整脚本，仅 GNU mtime 来源改变。N>=20：完整脚本 20/20。未来守卫：独立 future fixture 完整生产入口，生产脚本 git diff 为空。所有数据库均为 mktemp 下测试生成数据库。

## Lead 补充范围（question f8f0c599-6925-4b9a-97c0-996a9b85f7af）
- 本轮增加同一生产入口的 marker age=604799 和604800 秒边界，分别断言skip/不skip。独立临时HOME避免影响已有收据计数。
- 只读普查同形mtime夹具，结果见census.md；仅当前一处命中，无其它代码改动。
- 本机7/4失败调查与错误分类见census.md；不能将未分类rc1认作竞争。
- 20次只是重复稳定性证据，不推导失效率上界。新增边界后再跑完整脚本20次。

## Lead补充范围（response300be1d4-b000-4156-8241-92b383532433）
- 里程碑PR字段改为#1205。
- 缺失FIXTURE变量必须让整套测试失败；仅让stat/date退出会被生产回退吞掉，因此用独立错误记录加末尾断言。
- helper封装和BSD原生覆盖记follow-ups，本轮不做。
