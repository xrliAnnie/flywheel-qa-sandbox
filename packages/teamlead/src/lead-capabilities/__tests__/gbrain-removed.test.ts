import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEAD_CAPABILITY_CATALOG } from "../catalog.js";
import { LEAD_DEPLOYMENT_ENTRIES } from "../deployment.js";
import { UPSTREAM_READ_BASELINES } from "../handlers/upstream-read.js";
import { unavailableIntegrationSchema } from "../manifest.js";
import { integrationUnavailableReason } from "../runtime-factory.js";
import { assertUpstreamToolsPinned } from "../upstream-baseline.js";
import { UPSTREAM_TOOL_ROWS } from "../upstream-inputs.js";

/**
 * FLY-2886, founder 2026-09-26 08:16 PDT: gbrain is removed from the machine, so
 * neither the resident Lead nor a voice parent assembles it any more.
 */
describe("gbrain is not a Lead integration", () => {
	it("has no catalog operation or upstream tool row", () => {
		expect(
			LEAD_CAPABILITY_CATALOG.filter(
				(row) =>
					row.operationId.startsWith("knowledge.") ||
					(row.credentialConsumer as string) === "gbrain",
			).map((row) => row.operationId),
		).toEqual([]);
		expect(
			UPSTREAM_TOOL_ROWS.filter(
				(row) => (row.serverId as string) === "gbrain",
			).map((row) => row.operationId),
		).toEqual([]);
		expect(Object.keys(UPSTREAM_READ_BASELINES)).toEqual(["xiaohongshu-mcp"]);
	});

	it("is not an optional integration a manifest can name", () => {
		expect(
			unavailableIntegrationSchema.safeParse({
				id: "gbrain",
				reason: "host_config_unverified",
			}).success,
		).toBe(false);
		// Its startup error code no longer has a dedicated public reason.
		expect(
			integrationUnavailableReason(new Error("gbrain_host_unverified")),
		).toBe("provider_start_failed");
	});

	it("is not an upstream baseline server", () => {
		const tools = [{ name: "search", inputSchema: { type: "object" } }];
		const toolSchemaDigest = createHash("sha256")
			.update(JSON.stringify(tools))
			.digest("hex");
		// Control: the same pin shape is accepted for a server that remains.
		expect(
			assertUpstreamToolsPinned(
				{ serverId: "context7", version: "1", toolSchemaDigest },
				{ serverId: "context7", version: "1", tools },
			).toolNames,
		).toEqual(["search"]);
		expect(() =>
			assertUpstreamToolsPinned(
				{ serverId: "gbrain" as never, version: "1", toolSchemaDigest },
				{ serverId: "gbrain", version: "1", tools },
			),
		).toThrow("baseline_drift");
	});

	it("ships no gbrain module", () => {
		expect(
			LEAD_DEPLOYMENT_ENTRIES.filter((entry) => /gbrain/i.test(entry)),
		).toEqual([]);
		const here = dirname(fileURLToPath(import.meta.url));
		for (const name of [
			"gbrain-host.ts",
			"gbrain-provider.ts",
			"gbrain-transport.ts",
		])
			expect(existsSync(join(here, "..", name))).toBe(false);
	});
});
