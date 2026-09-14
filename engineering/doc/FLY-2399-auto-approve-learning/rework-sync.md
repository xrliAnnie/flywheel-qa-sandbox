# FLY-2399 main 同步 — 实施记录
Issue: FLY-2399
日期: 2026-09-13
基于: plan.md

Lead 开局指令 e7f5f8c5-07f4-4058-b128-1ad401083aa9 要求接管既有 PR #1163，仅同步 main、解冲突并重新 review/CI 后交 QA。原 head 89ba5dfb9 的 14 项 CI 当前查证通过；上一轮 QA attempt 3 PASS 与 review APPROVED 由本轮 Lead 指令确认，不冒充新头验收。

合并提交 37c472e6b，第二父为 origin/main 0c923c697c4de13d26c7eb309dcd0c3de3b9a384。四处冲突：StateStore imports 保留双方；retention registry 保留双方表；consumer config 保留双方消费者；表数断言按 main 208 + ship_judgment 8 = 216，protected current 147 + 8 = 155，去 retired 为 213，comm 29 沿用 main。git show --remerge-diff 核对只有这些手工解决，无功能扩面。无 FLY-2399 stash。

验证回执（本机 /tmp/fly2399-sync-*.log）：
- lint exit 0，原有 16 warnings，不改无关格式。
- 判断/保留策略 53 文件 231 项通过；旧批准路径 6 文件 129 项通过；五个判断/retention 脚本 17 项通过。本分支相对 main 无新增 test.sh。
- 首轮 build 因未安装 main 新增 yauzl 依赖失败；pnpm install --frozen-lockfile exit 0，锁文件无变化；随后全仓 build 结果在 milestone 记录。
- pnpm test:packages:run exit 1：voice-core src/__tests__/process.test.ts:66，expected empty stdout to contain chunk，测试固定等待 800ms。仅一次隔离复验 pnpm --filter flywheel-voice-core exec vitest run src/__tests__/process.test.ts --maxWorkers=1，6/6 pass。符合宿主启动时序争用症状；保留原全包红，不称全包绿，不改测试/超时。新头精确 CI 必须另证。

最终 milestone 为最后提交，推送后冻结新 head，注册新 review 请求与等待精确 CI。QA 由 needs_review 路由交接，不 dispatch、不 merge main、不 deploy。
