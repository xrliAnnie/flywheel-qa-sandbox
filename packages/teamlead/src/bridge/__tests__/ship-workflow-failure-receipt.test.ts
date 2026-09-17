import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
	fileURLToPath(
		new URL(
			"../../../../../.github/workflows/ship-on-comment.yml",
			import.meta.url,
		),
	),
	"utf8",
);

describe("ship workflow failure receipt", () => {
	it("captures bounded merge API evidence before the action fails", () => {
		expect(workflow).toContain(
			"core.setOutput('merge_error', JSON.stringify({",
		);
		expect(workflow).toContain(
			"status: Number.isInteger(error?.status) ? error.status : null",
		);
		expect(workflow).toContain(
			"message: error instanceof Error ? error.message : String(error)",
		);
	});

	it("distinguishes pre-merge CI failure from merge-step failure in the durable receipt", () => {
		expect(workflow).toContain(
			"needs.prepare.result == 'cancelled' || needs.merge.result == 'cancelled'",
		);
		expect(workflow).toContain(
			"AWAIT_CI_RESULT: $" + "{{ needs.prepare.outputs.await_ci_result }}",
		);
		expect(workflow).toContain("MERGE_RESULT: $" + "{{ needs.merge.result }}");
		expect(workflow).toContain(
			"MERGE_ERROR: $" + "{{ needs.merge.outputs.merge_error }}",
		);
		expect(workflow).toContain(
			"if (process.env.AWAIT_CI_OUTCOME === 'failure')",
		);
		expect(workflow).toContain(
			"} else if (process.env.PREPARE_RESULT !== 'failure') {",
		);
		expect(workflow).toContain("failedStep = 'merge_405_required_check'");
		expect(workflow).toContain("failedStep = 'merge_409_head'");
		expect(workflow).toContain("failedStep = 'prepare_cancelled'");
		expect(workflow).toContain("failedStep = 'merge_cancelled'");
		expect(workflow).toContain("failedStep = 'merge_other'");
		expect(workflow).toContain("status=failure failed_step=$" + "{failedStep}");
	});

	it("keeps CI preparation parallel while serializing only the exact-head merge", () => {
		expect(workflow).toContain(
			"group: ship-prepare-$" +
				"{{ github.repository }}-$" +
				"{{ github.event.issue.number }}",
		);
		expect(workflow).toContain(
			"group: ship-merge-$" + "{{ github.repository }}",
		);
		expect(workflow).toContain("pr.head.sha !== process.env.HEAD_SHA");
	});

	it("accepts content-bound tickets only from the trusted Bridge identity with signature, exact-head, expiry, and replay guards", () => {
		expect(workflow).toContain(
			"LAND_TICKET_PUBLIC_KEY_B64: $" +
				"{{ secrets.FLYWHEEL_LAND_TICKET_PUBLIC_KEY_B64 }}",
		);
		expect(workflow).toContain(
			"BRIDGE_GITHUB_LOGIN: $" + "{{ vars.FLYWHEEL_BRIDGE_GITHUB_LOGIN }}",
		);
		expect(workflow).toContain(
			"context.payload.comment.user.login !== process.env.BRIDGE_GITHUB_LOGIN",
		);
		expect(workflow).toContain("verified = crypto.verify(");
		expect(workflow).toContain("ticket.headSha !== pr.head.sha");
		expect(workflow).toContain("now > Date.parse(ticket.expiresAt)");
		expect(workflow).toContain(
			"const replayMarker = `ticket_id=$" +
				"{ticket.ticketId} nonce=$" +
				"{ticket.nonce}`;",
		);
		expect(workflow).toContain(
			"core.setFailed('Structured land ticket was already started')",
		);
	});
});
