# FLY-2803 额度页页面改版 — 调研
Issue: FLY-2803 (https://linear.app/geoforge3d/issue/FLY-2803/额度页页面-页面一张单改完spec-e1-e19呈现改版分组排序在用号染绿进度条时间格式-订阅到期显示与手填记确认人时间-e19)
日期: 2026-09-23
基于: plan.md, research.md

## Review round 1

question=8d63ca84-a88e-471e-b4a2-aaf0d93eef1a；request=43cf79b8-04c3-4d50-9649-2d262739357c。
effective reviewVerdict=CHANGES_REQUESTED；1 HIGH，5 MEDIUM，2 LOW。没有把advisory当成阻断，也没有请求治理豁免。

| findingKey | 处置 |
|---|---|
| manual-pct-drives-grouping-without-provenance | 已修：页面只允许机器百分比进分组/条形；旧manual百分比显示无，第三组，新增对照验收；共享tick不变 |
| no-validator-entrypoint-for-manual-file | 已修：明确validate/install/identities CLI及失败回执、固定目标、原子安装 |
| fourth-claude-identity-digest-format | 已修：复用exported identityKey和既有identityDigest同源hash |
| claude-identity-optional-may-dead-end-manual | 已修：五号identity有无只读核实，录入前重新核实，缺失走既有identity-set受权操作路径 |
| vacuous-tier-negative-control | 已修：删除不具有tier输入的selector假变换；保留真实页面负测及type/import审计 |
| subscription-column-ships-empty-vs-E24 | 已修验收遗漏：指定Lead/QA真实录入与到期日往返验收门槛；新派工禁止预填高于旧spec，拒绝自动seed，日期缺失如实待验 |
| future-confirmedat-silently-dropped | 已修：future_confirmation safe error与安装拒绝 |
| account-name-regex-not-exported | 已修：计划明确export现有ACCOUNT_NAME，不复制正则 |

下一步提交修订并注册新review gate/request。以上是作者处置，不替代新reviewVerdict。

## Review round 2 — effective APPROVED

question=23080e8d-dc98-4bb4-825f-83dfac6eda86；request=3e7e6438-2215-4523-aeeb-cf9d1d22eb45；Bridge answered 2026-09-23T14:16:39.991Z。
effective reviewVerdict=APPROVED，reviewerVerdict=APPROVED，round=2。没有HIGH；下面2 MEDIUM/3 LOW按medium_low_findings_are_non_blocking_v1为Follow-ups，不重开设计、不冒称全部建议已解决。已批准plan.md不再改动。

| findingKey | 非阻断建议，交Lead安排 |
|---|---|
| type-negative-assertion-not-typechecked | .test.ts被tsc排除；若实施采用类型负断言，应放到实际被编译的文件并运行typecheck，不能用vitest通过声称类型证据；import/consumer审计仍有效 |
| manual-pct-suppression-missing-from-s7-authorized-list | QA逐格清单补记旧manual百分比80/79→无这一变化；对应§3/T1已批准的机器来源约束，不能漏写对照 |
| manual-install-lock-primitive-unnamed | 实施时优先复用已有mkdir-lock原语，明确独立路径与owner恢复；避免另造不明owner清理逻辑 |
| manual-file-append-only-cap-has-no-compaction | 安装合并后先校验128条/64KiB上限；越限明确拒绝且旧文件不变，后续历史归档由Lead决定 |
| new-cli-not-registered-like-sibling-clis | 裸node入口需main-guard及真实进程调用测试；thin launcher/bin登记与本地命令形态由实施依现有范式选择 |

这五项已通过ask --report回报Lead；不把意见文字视为新的审批或治理裁定。设计最终交付仍须托管HTML校验与phase completion receipt。
