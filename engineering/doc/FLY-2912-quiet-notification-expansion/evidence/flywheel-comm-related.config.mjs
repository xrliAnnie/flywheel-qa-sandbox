import base from "../../../../packages/flywheel-comm/vitest.config.ts";
const retained = [
  "src/__tests__/lead-audit-summary-receipt.fly2912.test.ts",
  "src/__tests__/mailbox-adopt-inflight.test.ts",
  "src/__tests__/mailbox-query-plans.fly2139.test.ts",
  "src/__tests__/mailbox-queue-capabilities.test.ts",
  "src/__tests__/mailbox-queue-schema.test.ts",
  "src/__tests__/mailbox-queue.test.ts",
  "src/__tests__/mailbox-schema.test.ts",
  "src/__tests__/mailbox-terminal-archive.fly2341.test.ts"
];
export default {...base,root:new URL("../../../../packages/flywheel-comm", import.meta.url).pathname,test:{...base.test,include:retained}};
