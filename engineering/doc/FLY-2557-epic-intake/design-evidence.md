# FLY-2557 Epic 自动入口 — 调研
Issue: FLY-2557 (https://linear.app/geoforge3d/issue/FLY-2557/epic-流程intake-epic-进-in-progress-自动触发拆解bridge-监听-linear-epic无)
日期: 2026-09-14
基于: plan.md

## 设计执行身份
execution `6e76e8b9-4193-44c2-b3c0-4f385968403c`；TURN设计epoch1；workflow run `f7b658b8-74cb-4566-952f-65ffea1e6563`；activation `activation:6e76e8b9-4193-44c2-b3c0-4f385968403c:f7b658b8-74cb-4566-952f-65ffea1e6563:eng_design:1`。

## 正式评审
- 设计commit：`56f2630b9`（exploration/research/plan）。
- review question：`2bdefa31-e2fd-4e10-8acb-170d0fe5e1ac`。
- requestId：`26294295-d942-4bd2-ae0c-78c7e2c077f6`，request-review accepted=true, skipped=false。
- R1 effective reviewVerdict=CHANGES_REQUESTED；reviewerVerdict=CHANGES_REQUESTED；1 HIGH、6 MEDIUM、3 LOW。
- 唯一blocking findingKey=`no-epic-discriminator-runner-issues-become-intakes`；Lead已裁定，最终按`[lead-instruction da084518-89ac-4ddc-a8ba-231d67cad46e]`修订为有子单或无本项目dispatch记录，plan.md已同步，commit `4d6af3a71`。
- R2 question=`39d046bb-7439-4ead-adb1-6cf043a9f2bf`，requestId=`71633106-0ead-40f4-84b2-20360d276493`，accepted=true/skipped=false；2026-09-14T20:11:14 服务端done，reviewVerdict=APPROVED，reviewerVerdict=APPROVED。
- Lead完整instruction DONE receipt=`815961cf-21d1-4c03-b48b-fb443596163a`。
- R1九条及R2新增两条非阻塞项均列plan.md Follow-ups，R2正式Lead报告receipt=`b3d669be-ea6c-4a77-9895-eeee1caba6cb`。不扩修、不重开设计。

## HTML本地验证
`python3 engineering/doc/FLY-2557-epic-intake/build-founder-html.py`生成；`node engineering/doc/FLY-2557-epic-intake/verify-founder-html.mjs` PASS：

- 8个section各有评论框，DOM结构经parse5检查；id唯一、单个nonce占位脚本、没有CSP meta/inline handlers/外部资产。
- VM控制器检查：评论输入保存、重载恢复、pathname隔离、localStorage拒绝仍能工作、clipboard正常/缺失/拒绝路径、execCommand失败提示、空汇总、长Unicode分段<=1800字符、每段固定标记和标题、copy-all/逐段copy、恶意HTML作为textContent。
- 最终HTML 15,655 bytes，commit `08cfbe67f`；最终状态文案更新后结构/控制器重验PASS。
- 这只是结构/控制器验证，不是浏览器视觉QA或产品功能测试。

## 本地图形渲染限制
`flow.mmd`与`model.mmd`各执行两次本地mmdc（初次及规定标准参数重试），均失败：

```
mmdc -i <source> -o <output.svg> -w 1000 -b white --svgId fly2557-d1
mmdc -i <source> -o <output.svg> -w 1000 -b white --svgId fly2557-d2
MachPortRendezvousServer ... Permission denied (1100)
```

没有生成SVG；HTML各处明确 `DIAGRAM PENDING LOCAL RENDER` 并附原始Mermaid源码，未用远程渲染或CSS箭头假图。符合注入任务的两次失败降级路径。R2更新flow.mmd后再次执行初次及标准重试，仍是同一系统权限错误；源文件与HTML同步，结构/控制器重验PASS。浏览器视觉检查未执行。

## 最终发布与托管核验
- 最终HTML commit：`08cfbe67f`，已推送origin/flywheel-FLY-2557。
- URL：https://fw-reports-624a39.vercel.app/r/d3c0dd9a979b9e0cb6af8e8564156c3c/
- reportId：`d3c0dd9a979b9e0cb6af8e8564156c3c`；publishOnly=true，messageId=null，delivered=false（静默发布，无频道消息）。
- `verify-report --url <上述URL> --expect FLY-2557 --timeout-ms 20000`：ok=true，HTTP200，noncePlaceholder/scriptCsp/scriptNonce/expect全部pass，warnings=[]。
- 独立fetch复核：HTTP200，__CSP_NONCE__残留0，唯一inline script、nonce与CSP一致，脚本文本逐字等于已提交源，外部资产0，页面含R2 APPROVED及评论汇总标记。
- 本地HTML SHA256：`84ce25d19b568eb0bff3156cb920ee4a5b8ac2710bf0e71f7ee47bc9eb255c70`。
- 托管HTML SHA256：`7c50996829ae2ae21bebb4b0de1a9bd47f1457eeff5ace02201b69deb49528f3`（包含发布时注入的nonce/CSP，故与源不同）。
- 正式DESIGN-HTML ready receipt：`2a95c9e5-81d1-4e51-ba25-0e915cf27db8`，发给flywheel-eng-lead并引用正确execution、repo路径和issue。

## 设计完成审计
| 要求 | 当前证据 |
|---|---|
| TURN与设计边界 | epoch1设计TURN，所有版本改动仅engineering/doc/FLY-2557-epic-intake/ |
| full DOC-FLOW | exploration.md、research.md、plan.md，规定标题/Issue/日期/基于字段齐全 |
| 实施合同 | plan.md含身份、查询/路由、事务/ACK、Lead规则、空根页面、迁移回滚及完整测试矩阵 |
| 正式设计审查 | R2 effective/reviewer APPROVED；唯一HIGH按Lead最终裁定修复；11条累计advisory另列并已报告 |
| Founder HTML | 已提交推送、8节逐节评论、单nonced脚本、两个Mermaid源与显式本地失败占位 |
| 发布及验证 | 上述静默发布、HTTP/CSP/源码比对与DESIGN-HTML ready正式回执 |
| 进度游标 | progress.md由注入progress命令持久化，阶段交接前更新 |
| 完成与驻留 | 下一步执行phase_design_complete，再park；实际服务端完成回执由CLI/控制器持久化，不能用本行替代成功回执 |

没有剩余设计内容修改；只执行完成/park协议，不再改设计或重新评审。

## 功能证据边界
未实现产品代码；未启动/重启/部署服务；未创建或修改真实/测试Epic与频道；未派发后继或请求ship。plan.md列出的完整功能验收由后续节点完成，不以此HTML验证代替。
