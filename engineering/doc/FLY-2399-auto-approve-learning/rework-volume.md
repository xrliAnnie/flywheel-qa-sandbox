# FLY-2399 真实采集体积与失败隔离 — 实施记录
Issue: FLY-2399
日期: 2026-09-13
基于: plan.md

QA 在 da01f4d78 判 FAIL，Lead 指令 2642264b-6601-4e72-b8e4-6fa121df310f 限定修复真实 GitHub 体积和单 PR 采集失败隔离，补 ≥800KB fixture 并证明数字 Link 分页实际可达。17 条 advisory 不处理；本轮不改变批准权限、模型预算或计划。

GithubProjectApi 每页从 100 降至 20，单次流读取响应上限从 256KiB 改为 2MiB，仍在读取中超限即取消。页面只归一化所需字段，不持久化 PR body、用户元数据或 patch。分页只消费 next 页码，请求继续生成 allowlisted slug URL；数字 repository Link 的相同资源后缀、同源、页码+1与每页20校验保留。不是无限制放大载荷；极端超限仍报 github_body_budget。

SharedProjectRefresh 将单 PR 文件分页/身份核对失败记录为 filesComplete=false、空 files、受限 filesError；继续其它 PR 并持久化部分快照。失败项不能复用，后续一轮重新采集；完整且同 head 项仍可复用。PR 列表/main 失败、项目调用额度/lease 失败、全局超时/停止、API rate limit 仍关闭整轮，不把缺失项目列表伪装完整。

生产语义收集可以继续，失败的文件清单只影响机械冲突判断。目标自身或同仓竞争 PR 不完整时，conflict 仍 unknown；不能凭缺失文件证明无冲突。与目标不同仓库的不完整 PR 不影响文本冲突判定。现有已知重叠与 merge 冲突回归仍验证 fail。完整快照保持旧序列化形状；没有 SQL schema 变更，不新增表。

TDD：
- 20 项 PR/body 与 files/patch 响应均约1.2MB、分64KiB块传入；旧代码两例均 github_body_budget RED，新实现 GREEN，数字 Link 真正走到第二页，输出各小于8KiB。
- 集成真实 GithubProjectApi+内存StateStore：900KB PR列表、1MB文件页，第一 PR 500，后续三 PR 仍完成；旧代码 unavailable RED，新代码 ready 且失败项单独落账 GREEN；新store对象读回一致，下一轮仅取失败 PR 的 files。
- 生产组装：失败目标/同仓peer依旧产出语义 ready + conflict unknown；不同仓失败不再污染本卡。旧版本期望 pass 得到 undetermined RED，修复后 GREEN。移动head仍不作为完整文件清单；项目级预算/限流负例保留。

本轮60文件378项相关回归通过，pnpm lint 与 pnpm -r build exit0。按返工指令仅跑这些 gate，不重跑已留档的宿主全包失败。独立QA和精确头CI仍须新头验证，不把mock语义材料或只读API冒充真实模型验收。

真实只读验证（2026-09-14T03:28–03:30Z）：3次API样本的未压缩响应为371241/262563/184682B，归一化后3497/1538/1677B；数字Link顺利进入下一页。随后用真实SharedProjectRefresh+StateStore.create(":memory:")完整采集一次：48457ms、109次调用、39/39 PR完整、#1163共203文件、快照61639B，原120次/小时与60s整轮上限未改。回执volume-live.json/volume-sweep.json；无生产DB读写、无模型调用。此结果是当前仓库规模的采集证据，不代表更大规模永不撞预算，撞限仍诚实unknown。
