import { describe, expect, it } from "vitest";
import { codexBodyRecoveryPending } from "../codex-body-recovery.js";

function fixture() {
	const session = {
		execution_id: "exec",
		adapter_type: "codex-tmux",
		status: "running",
		retry_successor: null,
	};
	let exhausted = false;
	let body = "active";
	let latest = "exec";
	let run = "active";
	const store = {
		getSession: () => session,
		getWorkflowExecutionProcessBody: () => ({ state: body }),
		getWorkflowRunNodeForExecution: () => ({
			run_id: "run",
			node_id: "implement",
			attempt: 1,
		}),
		getWorkflowRun: () => ({ status: run }),
		listWorkflowRunNodes: () => [{ execution_id: latest, attempt: 1 }],
		hasCurrentCodexRecoveryExhaustion: () => exhausted,
	};
	return {
		session,
		store,
		setExhausted: () => {
			exhausted = true;
		},
		setBody: (v: string) => {
			body = v;
		},
		setLatest: (v: string) => {
			latest = v;
		},
		setRun: (v: string) => {
			run = v;
		},
	};
}
describe("FLY-2919 reown precedence before body death", () => {
	it.each([
		"running",
		"ship_parked",
		"awaiting_review",
		"design_done",
		"approved_to_ship",
	])(
		"protects %s before the first claim and releases only current exhausted episodes",
		(status) => {
			const f = fixture();
			f.session.status = status;
			expect(codexBodyRecoveryPending(f.store as never, "exec", 100)).toBe(
				true,
			);
			f.setExhausted();
			expect(codexBodyRecoveryPending(f.store as never, "exec", 100)).toBe(
				false,
			);
		},
	);
	it.each(["completed", "failed", "terminated"])(
		"does not revive terminal %s",
		(status) => {
			const f = fixture();
			f.session.status = status;
			expect(codexBodyRecoveryPending(f.store as never, "exec", 100)).toBe(
				false,
			);
		},
	);
	it("does not revive a superseded binding or an ended run", () => {
		const f = fixture();
		f.setLatest("new-exec");
		expect(codexBodyRecoveryPending(f.store as never, "exec", 100)).toBe(false);
		f.setLatest("exec");
		f.setRun("completed");
		expect(codexBodyRecoveryPending(f.store as never, "exec", 100)).toBe(false);
	});
	it.each(["retiring", "standby", "resuming"])(
		"respects intentional %s",
		(state) => {
			const f = fixture();
			f.setBody(state);
			expect(codexBodyRecoveryPending(f.store as never, "exec", 100)).toBe(
				false,
			);
		},
	);
	it("read uncertainty cannot remove recovery priority", () => {
		const f = fixture();
		f.store.hasCurrentCodexRecoveryExhaustion = () => {
			throw new Error("DB busy");
		};
		expect(codexBodyRecoveryPending(f.store as never, "exec", 100)).toBe(true);
	});
});
