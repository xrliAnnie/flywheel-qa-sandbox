# FLY-2998 干净房间执行流程 — 调研
Issue: FLY-2998 (https://linear.app/geoforge3d/issue/FLY-2998/qa-sbx-fly-2925-clean-room-synthetic-runner-lifecycle-task-2)
日期: 2026-09-28
基于: exploration.md

## 仓库证据与适用范围
初始分支 project-slot-2-FLY-2998，基线 7c5a01d74，工作树干净；qa-sandbox 目录及目标文件不存在。本库版本 doc/VERSION 为 v1.57.0。
已读取 CLAUDE.md、产品体验规范、onboarding 说明、相关 FLY-2925 计划与 runner 合同。当前注入的设计阶段边界及 Lead 本次澄清优先于旧文档里的完整实现/发版流程。

目标文件没有运行时消费者：git grep -lF 对 qa-sandbox/fly2925-clean.md 和 fly2925-clean.md 均无匹配。父目录 qa-sandbox 的现有匹配是仓库名或测试环境标签，不是本目标文件的读取。不存在 TypeScript/API/schema 变更，没有迁移或依赖包构建需求。

## 持久记录与恢复
正文及 Git 历史是完成步骤的证据；进度说明只是导航。推送失败时保留本地提交，重试同一提交的普通推送，成功前不进入下一步。重启后先取得 TURN，核对当前文件、历史及远端分支，再从第一个未完成步骤继续，不凭记忆重写或重复提交。不重设执行、激活或会话身份，不主动重启服务。

## 验证选择与排除记录
这是可逆的文档修改，不新增测试文件，不跑任何全仓或全包套件。实施者以正文结构、逐步提交 diff 和每步远端 SHA 核对为验收；SHA 是 Git 为一次提交生成的唯一编号。
下面为父目录文字命中的测试文件，全数排除，因为它们使用的是 sandbox 仓库名称/环境配置，未读取目标 Markdown；修改不会改变被测逻辑：
- `packages/qa-framework/suites/runner-test-discipline.md`：环境或仓库名匹配，不依赖本文。
- `packages/teamlead/src/bridge/__tests__/terminal-gate-retirement.test.ts`：环境或仓库名匹配，不依赖本文。
- `scripts/__tests__/fixtures/fly2301/claude-stdout.json`：环境或仓库名匹配，不依赖本文。
- `scripts/__tests__/fly1663-qa-launchd-mutants.test.sh`：环境或仓库名匹配，不依赖本文。
- `scripts/__tests__/qa-fly-2456-file-adopt.test.mjs`：环境或仓库名匹配，不依赖本文。
- `scripts/__tests__/qa-generalized-e2e-lib.test.mjs`：环境或仓库名匹配，不依赖本文。
- `scripts/__tests__/qa-lead-artifact-fixtures.test.sh`：环境或仓库名匹配，不依赖本文。
- `scripts/__tests__/test-deploy-multilead.test.sh`：环境或仓库名匹配，不依赖本文。
- `scripts/__tests__/test-deploy-preflight-github.test.sh`：环境或仓库名匹配，不依赖本文。
- `scripts/qa-runner-test-discipline.mjs`：环境或仓库名匹配，不依赖本文。
- `scripts/test-deploy.sh`：环境或仓库名匹配，不依赖本文。

HTML 单独核对本地结构、评论保存与复制退路、托管页状态与 nonce。nonce 是发布服务授予页面脚本的一次性许可标记。Mermaid 图仅本地渲染；失败按任务规则重试一次并明确显示占位。没有真实重启实验，所以不声称验证了 FLY-2925 的生产恢复能力。
