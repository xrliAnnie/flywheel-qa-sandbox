# FLY-2543 CI 清理竞态 — 探索
Issue: FLY-2543 (https://linear.app/geoforge3d/issue/FLY-2543/flake-ci-classifytestsh-收尾-rm-竞态git-directory-not-empty让-shell3-在-1440)
日期: 2026-09-14
基于: 无

范围仅 scripts/__tests__/ci-classify.test.sh 的临时仓配置和退出清理，以及必要回归测试。生产 src、分类器断言与 CI 策略保持锁定。

已知红回执：run 34802401554 / job 103847586472，144/0 后 .git Directory not empty。当前脚本 EXIT trap 的 rm 非零可覆盖成功退出；单一临时仓有大量 commit，未关闭自动维护。
