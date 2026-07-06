import { describe, expect, it } from "vitest";
import {
	assertConfinement,
	type ConfinementExpectation,
	extractThreadDescriptor,
	type ThreadDescriptor,
} from "../confinement.js";

const WS = "/scratch/lead-245";
const exp: ConfinementExpectation = {
	workspace: WS,
	cliVersionAllowlist: ["0.139.0", "0.137.0"],
};

/** A real-shaped, fully-compliant thread/start result. */
function goodResult(over: Record<string, unknown> = {}): unknown {
	return {
		thread: { id: "thr-1", cliVersion: "0.139.0" },
		model: "gpt-5.5",
		cwd: WS,
		runtimeWorkspaceRoots: [WS],
		approvalPolicy: "never",
		sandbox: {
			type: "workspaceWrite",
			networkAccess: false,
			writableRoots: [WS],
		},
		...over,
	};
}

function goodDescriptor(
	over: Partial<ThreadDescriptor> = {},
): ThreadDescriptor {
	return { ...extractThreadDescriptor(goodResult()), ...over };
}

describe("extractThreadDescriptor", () => {
	it("parses the real result shape (top-level policy + thread.id/cliVersion)", () => {
		const d = extractThreadDescriptor(goodResult());
		expect(d.id).toBe("thr-1");
		expect(d.cliVersion).toBe("0.139.0");
		expect(d.approvalPolicy).toBe("never");
		expect(d.cwd).toBe(WS);
		expect(d.runtimeWorkspaceRoots).toEqual([WS]);
		expect(d.sandbox).toEqual({
			type: "workspaceWrite",
			networkAccess: false,
			writableRoots: [WS],
		});
	});

	it("is defensive on garbage/missing shapes (fields left undefined)", () => {
		expect(extractThreadDescriptor(undefined).id).toBe("");
		expect(extractThreadDescriptor(null).sandbox).toBeUndefined();
		const d = extractThreadDescriptor({ threadId: "x" });
		expect(d.id).toBe("x");
		expect(d.approvalPolicy).toBeUndefined();
	});
});

describe("assertConfinement", () => {
	it("passes a fully-compliant descriptor", () => {
		expect(() => assertConfinement(goodDescriptor(), exp)).not.toThrow();
	});

	it("dedups runtimeWorkspaceRoots [workspace, workspace] → {workspace}", () => {
		expect(() =>
			assertConfinement(
				goodDescriptor({ runtimeWorkspaceRoots: [WS, WS] }),
				exp,
			),
		).not.toThrow();
	});

	it("rejects approvalPolicy !== never", () => {
		expect(() =>
			assertConfinement(goodDescriptor({ approvalPolicy: "on-request" }), exp),
		).toThrow(/approvalPolicy/);
	});

	it("rejects a missing sandbox", () => {
		expect(() =>
			assertConfinement(goodDescriptor({ sandbox: undefined }), exp),
		).toThrow(/sandbox policy missing/);
	});

	it("rejects sandbox.type !== workspaceWrite", () => {
		expect(() =>
			assertConfinement(
				goodDescriptor({
					sandbox: {
						type: "dangerFullAccess",
						networkAccess: false,
						writableRoots: [WS],
					},
				}),
				exp,
			),
		).toThrow(/workspaceWrite/);
	});

	it("rejects networkAccess !== false (drift to true)", () => {
		expect(() =>
			assertConfinement(
				goodDescriptor({
					sandbox: {
						type: "workspaceWrite",
						networkAccess: true,
						writableRoots: [WS],
					},
				}),
				exp,
			),
		).toThrow(/networkAccess/);
	});

	it("rejects an extra writable root", () => {
		expect(() =>
			assertConfinement(
				goodDescriptor({
					sandbox: {
						type: "workspaceWrite",
						networkAccess: false,
						writableRoots: [WS, "/etc"],
					},
				}),
				exp,
			),
		).toThrow(/writableRoots/);
	});

	it("rejects cwd !== workspace", () => {
		expect(() =>
			assertConfinement(goodDescriptor({ cwd: "/somewhere/else" }), exp),
		).toThrow(/cwd/);
	});

	it("rejects an extra runtimeWorkspaceRoot", () => {
		expect(() =>
			assertConfinement(
				goodDescriptor({ runtimeWorkspaceRoots: [WS, "/extra"] }),
				exp,
			),
		).toThrow(/runtimeWorkspaceRoots/);
	});

	it("rejects a cliVersion not in the allowlist (version drift)", () => {
		expect(() =>
			assertConfinement(goodDescriptor({ cliVersion: "0.140.0" }), exp),
		).toThrow(/allowlist/);
	});

	it("rejects a non-string cliVersion", () => {
		expect(() =>
			assertConfinement(goodDescriptor({ cliVersion: undefined }), exp),
		).toThrow(/allowlist/);
	});
});
