# FLY-3029 Claude 体探针 — 调研
Issue: FLY-3029 (https://linear.app/geoforge3d/issue/FLY-3029/529-合成单勿派-fly-2919-真房-n-to-n-claude-体)
日期: 2026-09-28
基于: exploration.md

## 当前事实
- 已核对 CLAUDE.md、doc/architecture/product-experience-spec.md、doc/architecture/v0.2-architecture.md、packages/README.md 及项目声明的两份模式参考。旧文档中的流程/目录规则由本次注入的 design 阶段和 DOC-FLOW 覆盖。
- 历史记忆索引为空，没有导入快照。
- README.md 共三行，字节为 `\n\nFLY-1375 land E2E marker 20260722T023540Z\n`。
- `git grep -lF -- 'FLY-2919 N-to-N claude-body probe'` 未命中；旧标记仅命中 README.md。
- README 的消费者是仓库阅读者与外层测试驱动；未发现运行时代码依赖该标记。
- 无数据库、API、配置、依赖或公开类型变化；无需迁移。回退仅撤销追加标记的独立提交，不回滚设计材料或其他阶段成果。

## 本地验证选择
已搜索完整绝对路径、文件名 README.md、工作区父目录名 project-slot-2-FLY-3029；绝对路径与目录名均无匹配。根目录路径不作为全库测试理由。
README.md 文件名命中的测试逐项排除如下（全部针对别的 README 或临时夹具，均不读取本仓根 README 的探针正文）：
- packages/edge-worker/src/__tests__/SkillInjector.test.ts：生成临时仓库 README。
- packages/flywheel-cli/src/__tests__/migrate-agents-path.test.ts：迁移 .claude/README。
- packages/onboard-shell/__tests__/onboard-shell-publish-gate.test.sh：打包清单。
- packages/teamlead/scripts/test-fly26-rules-split.sh：规则目录说明文件。
- packages/teamlead/src/__tests__/fly152-reply-discipline.test.ts：lead-rules-base/README。
- packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts：lead-rules-base/README。
- packages/teamlead/src/__tests__/workflow-decision-routes.test.ts：临时仓库提交夹具。
- packages/teamlead/src/bridge/publish-broker/__tests__/shell-publish.e2e.test.ts：临时打包仓库。
- scripts/__tests__/package-onboard-version-injection.test.sh：打包清单。
- scripts/__tests__/package-onboard.test.sh：打包清单。
- scripts/__tests__/test-setup-doc-flow.sh：临时文档目录 README。
- scripts/__tests__/test-setup-new-project.sh：临时项目生成结果。
- scripts/test-deploy.sh：其他包 README 的帮助链接。
- scripts/test-restart-services.sh：临时项目/构建夹具。
- scripts/test-slots.example.json：配置示例中的说明链接（非测试）。
无保留的相关自动化测试；用原字节前缀、精确行数、末行和单文件 diff 验证。不得运行全库或全包测试；未变更 TypeScript，不运行 vitest related。保留 pnpm lint；无受影响的代码包需要构建或类型检查。

## 证据边界
设计阶段不操作驱动、不注入故障、不读秘密凭证、不改变执行或 activation 身份。不将窗口缺失解释为进程死亡。完整 N-to-N 验收仍需外部 QA 提供实时进程与回执证据。

## HTML 验证限制
未找到可用 html-report-style 文件，使用派单指定 Apple-light 风格。Mermaid CLI 按标准参数渲染两次均因 Chromium MachPortRendezvous bootstrap_check_in Permission denied 失败；依合同保留 flow.mmd，在 HTML 标注 DIAGRAM PENDING LOCAL RENDER，不调用远程服务。当前环境无法据此声称浏览器视觉检查通过。

## 设计产物检查
2026-09-28：文档抬头、7 个 section 对应 7 个意见输入、单一 nonce 脚本、无外部资源引用、无内联事件或 innerHTML、README 字节未变的静态检查通过；脚本 node --check 通过；git diff --check 通过。pnpm lint 退出 0（14 个已有警告，不修改无关代码）。这不是浏览器视觉或完整测试套件证据。
