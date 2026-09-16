# FLY-2519 Codex Lead 权限对等 — 实施审查记录
Issue: FLY-2519 (https://linear.app/geoforge3d/issue/FLY-2519/2441-codex-部门-lead-权限对等claude-lead-有的能力面-codex-lead-都要有founder-2026-09)
日期: 2026-09-13
基于: plan.md

- Lead 澄清（question `96a9b996-4994-44c9-b831-4c73cbd54dbb`）：plan6.2保护宿主/founder/action凭据与持久profile，不要求在任意evaluate前提下不可能实现的QA cookie全不外泄；隔离一次性profile、不暴露cookie DB，网络工具脱敏已知Cookie/Set-Cookie头，JS输出按不可信QA数据，QA身份仅限产品QA且run结束撤销；不改pinned plan blob。该记录不是code review通过或宿主验收证据。

- Lead Git deadline裁定（question `ee007edb-0fbf-47f8-99bf-757819413648`）：仅 `git.feature.push` 使用parent持有、可取消的120秒deadline，socket/façade同操作等待同步放宽；其他操作保持15秒。私有对象预算4GiB并做磁盘预算，不采用派前预备快照。只读对象共享须先证明子进程不能写回源对象；当前无此证明，保留私有复制，不退回原始对象alternate、不向子进程传凭据、不做生产push。实际仓库私有复制约117秒，余量很小；后续运行时接线必须保留此限制。

- Lead补充裁定（report response `e709ace2-7e79-4854-b4ad-209a380a4c79`）：上述120秒上限被180秒替代，仅适用于git.feature.push，socket/client margin同步。4GiB整库复制/磁盘预算不变。Follow-up标题：**Git alternates只读隔离证明**；本单不实施alternates共享。该延长不替代目录祖先隔离或生产push验收。
