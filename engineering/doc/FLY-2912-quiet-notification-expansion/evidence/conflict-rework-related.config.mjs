import base from "../../../../packages/teamlead/vitest.config.ts";
import { serialFiles } from "../../../../packages/teamlead/vitest.shards.mjs";
const retained = [
  "src/__tests__/fly2139-query-plans.test.ts",
  "src/__tests__/fly2912-evening-replay.test.ts",
  "src/bridge/__tests__/alert-wake-dedup.test.ts",
  "src/bridge/__tests__/commdb-lifetime.test.ts",
  "src/bridge/__tests__/flag-store-runtime.test.ts",
  "src/bridge/__tests__/infra-alert-wiring.test.ts",
  "src/bridge/__tests__/lead-audit-summary.fly2912.test.ts",
  "src/bridge/__tests__/lead-delivery-adapter.test.ts",
  "src/bridge/__tests__/lead-inbox-batch-ack.test.ts",
  "src/bridge/__tests__/lead-inbox-loop.test.ts",
  "src/bridge/__tests__/lead-inbox-runtime-summary.fly2912.test.ts",
  "src/bridge/__tests__/lead-inbox-runtime.test.ts",
  "src/bridge/__tests__/lead-inbox-summary.fly2912.test.ts",
  "src/bridge/__tests__/lead-interrupt-delivery.test.ts",
  "src/bridge/__tests__/lead-summary-retry.fly2912.test.ts",
  "src/bridge/__tests__/question-admission.test.ts"
];
const serial = new Set(serialFiles);
const groups = [
  { name: "serial", files: retained.filter((p) => serial.has(p)) },
  { name: "parallel", files: retained.filter((p) => !serial.has(p)) },
].filter((group) => group.files.length);
export default {
  ...base,
  root: new URL("../../../../packages/teamlead", import.meta.url).pathname,
  test: {
    ...base.test,
    projects: groups.map((group) => ({
      extends: true,
      test: { name: group.name, include: group.files },
    })),
  },
};
