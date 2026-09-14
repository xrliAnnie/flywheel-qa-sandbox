# FLY-2467 全包门可靠性 — 实施记录
Issue: FLY-2467 (https://linear.app/geoforge3d/issue/FLY-2467)
日期: 2026-09-14
基于: plan.md

## 已实现
- teamlead CI 从三片扩为四片，CI OK 的 unit-tests 矩阵依赖覆盖全部四片；两个 matrix.name 条件步骤同步，守卫检查悬空条件和 mutation gate 不吞失败。
- teamlead、claude-runner 默认单 fork，teardownTimeout=60000；VITEST_MAX_FORKS 是 Vitest 原生覆盖项。没有修改 testTimeout、hookTimeout 或单测超时，没有跳过测试。
- pnpm test:packages:run 调用 scripts/package-gate.mjs，await 全仓 build 后串行执行每个 packages/* 的原始 test:run。非 Vitest 脚本原样执行，永不进入 RPC 豁免；缺损 manifest 不会静默漏包。
- 自定义 reporter 记录预期文件与实际文件、所有任务终态、通过/失败/声明跳过数量及完整 unhandled error 清单；不使用默认 JSON reporter 的不完整 fallback。仅完整零失败且所有错误精确为 onTaskUpdate worker RPC timeout 的 exit 1 才重试一次。真实失败仍继续后续包并最终失败。
- summary schemaVersion=1：root/head/时间、build、packages[].attempts[] 含命令、时间、原始退出码、信号、日志路径和 reporter receipt。每次运行位于操作系统临时目录独立 flywheel-package-gate-* 子目录，最后打印 PACKAGE_GATE_RECEIPT=<summary.json>。exit 0=绿色，exit 2=仅重试后仍存在的已分类伪影，exit 1=真实或未知失败；不把伪影称为普通绿色。
- implement/engineer/qa 活跃模板同步等价门口径和逐包命令；FLY-2533 fixture 仅追加迁移项，保留原 baseline。实现模板保持现有10%增长守卫。

## 已验证与待验证边界
TDD红→绿：CI四片守卫、RPC完整性/丢失结果/真实失败/混合错误/构建屏障/一次重试/下游继续/非Vitest/manifest/模板；14项Node测试通过。真实Vitest通过、RPC注入、断言失败三对照验证了reporter API；RPC-only的run-end reason可能是passed，不能据此推断进程绿色。
Blueprint.generalized-workflow 30/30；CI结构、shell与Node枚举、矩阵覆盖23/23包、FLY-2121节点合同12/12通过。pnpm lint、pnpm -r build通过。
完整 pnpm test:packages:run 正在运行，结果与后续精确头CI/review收据写入PR正文及Lead结构化报告，不在review后追加文档提交。本记录不构成全门绿、三轮CI绿、每片<400s或QA通过的声明。

## 消费者与风险
scripts/pre-ship-check.sh 仍fail closed，不获得ship豁免；由于它先build，再调用内置build聚合，会重复build。接受该非阻断开销，防止旧dist竞态。当前运行中的home及历史任务快照不改写，未来模板物化消费新源文件。
默认单fork限制本地主机负载，不能声称它直接改变RPC timeout或证明CI更快。四片能否满足每片<400s，必须测三轮精确头CI；不足时按已批准计划继续均衡。

## CI反馈后的收敛（新头审查前最终更新）
- 4106dd817 的 CI34808122300 四片均绿但步骤耗时374/295/499/400s，不达严格<400s；light的新增环境变量登记失败由原生Vitest --outputFile替代自定义环境变量修复，flag drift14/14通过。
- c8c890cc1 的 CI34809111107 使用按逐文件实测成本的LPT均衡，四片均绿但309/407/384/420s仍不达标。保留 --shard=k/4，并显式给独立CI的teamlead分片最多2个fork，其他CI包和本地聚合仍为1；CI记录CPU数及实际配置上限。两worker的最终耗时仍待新头CI证实，不宣称已满足目标。
- 成本数据 ci-test-costs.json 来自首轮单fork逐文件完成时间，涵盖collect/prepare；新文件用中位成本且始终分配。Vitest list --filesOnly在3.2.4忽略shard参数，因此仅用它作完整发现真值，再验证四片并集/互斥；另用真实Vitest --shard运行一重三轻fixture，证明实际执行采用成本分配。
- 当前聚焦20项通过，节点组合30项、flag drift14项和CI守卫通过。隔离checkout第一次build因复用原checkout依赖链接触发TS2742，换独立依赖安装后完整build通过；未修改相关生产源码。
- 旧头完整聚合仍活跃：claude-runner两次均1334通过、0失败、单RPC错误；随后comm/core/edge-worker等正常继续。旧config因已修复环境变量登记失败，原始非绿收据保留。新CI的未改动db-maintenance脚本出现weekly lifecycle重复收据失败，仍属真实CI失败，不能走RPC例外。
- 旧review a805e062在评审侧no_verdict，非代码判决；按Lead裁定不重放。新头review、连续三轮全CI绿且四片<400s仍待完成。依Lead最新指令，本次台账/里程碑与最后代码提交同推，之后以PR正文和Comm维护运行结果，不再单推文档。

## Lead 批准的稳定性修复（本次最终代码提交）
- 93205dec7/run34809960905的四片步骤344/298/321/319s，但1片仍RPC红、3片inventory真实5s超时，不能计入验收。批准及旧头HIGH finding见review.md。
- CI改为scripts/teamlead-ci-shard.mjs：同一--shard=k/4先运行serial项目（maxForks=1），再运行parallel项目（maxForks=2），前组失败仍执行后组并最终exit1。Vitest3的pool容量是全局的，故用独立CLI调用保证预算；没有singleFork复用、关闭isolation或更改测试超时。普通本地聚合仍强制所有项目1fork。
- serial项目使用实测文件成本>=2500ms的包含集合；parallel使用默认排除项加该集合，其余及未知文件完整保留。两组各自LPT四分，发现集合并集/互斥由真实Vitest list验证。inventory本地两个断言通过（557/458ms），并非CI稳定性证明。
- patches/vitest@3.2.4.patch只在worker createRuntimeRpc选项增加timeout:120000；未改变共享birpc默认值、错误回调、单测/断言超时。依赖版本未升级，lockfile只增加补丁hash引用。补丁适用于仓库使用该Vitest版本的测试worker。vitest-worker-rpc.test.mjs锁定版本、注册路径及已安装补丁，并用真实RPC模块/受控时钟证明120s到期仍抛原onTaskUpdate错误。旧安装负对照60000!=120000，补丁安装后通过。
- 当前24项聚焦全部通过，pnpm lint、pnpm -r build、CI结构与shell枚举通过。新完整聚合将在最终提交后启动，原聚合已以exit1完成全部17包；claude-runner两次1334pass/RPC、config旧环境登记真实失败、teamlead一个lease断言失败+RPC均保留原始收据。lease新头focused6/6通过不改写旧结果。
- 本次之后不追加文档提交；新头完整本地门、review、三轮全绿且四片<400s/零RPC的结果更新PR正文与Comm收据。当前不宣称交付验收通过。
