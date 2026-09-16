// @vitest-environment happy-dom

import { resolveAllFlags } from "flywheel-config";
import { beforeEach, describe, expect, it } from "vitest";
import { renderFlagReport } from "../bridge/feature-flag-report-html.js";
import { buildConsoleSnapshot } from "../bridge/fleet-console-model.js";

const flags = resolveAllFlags({ env: {} });
const docFlow = flags.find((flag) => flag.name === "doc_flow");
if (!docFlow) throw new Error("missing doc_flow");

function mount(): void {
	const html = renderFlagReport(
		[
			{
				...docFlow,
				storeManaged: false,
				projectStoreManaged: true,
				clockReadiness: "ready",
				scopedStore: {
					rows: [{ scope: "flywheel", raw: "0", value: false }],
				},
				effectiveByProject: [
					{
						projectName: "flywheel",
						value: false,
						isDefault: true,
						via: "project_row",
					},
					{
						projectName: "geoforge3d",
						value: false,
						isDefault: true,
						via: "default",
					},
				],
			},
		],
		{ interactive: true },
	);
	document.open();
	document.write(html);
	document.close();
	const script = document.querySelector("script");
	if (!script?.textContent) throw new Error("missing interactive script");
	new Function(script.textContent)();
}

describe("phone scoped flag control state machine", () => {
	beforeEach(() => mount());

	it("turns absent OFF into set, present OFF into clear, and resets on scope changes", () => {
		const scope =
			document.querySelector<HTMLSelectElement>("[data-ffp-scope]")!;
		const value =
			document.querySelector<HTMLSelectElement>("[data-ffp-value]")!;
		const output = document.querySelector<HTMLTextAreaElement>("#ffCopyText")!;

		expect(scope.value).toBe("*");
		expect(value.value).toBe("inherit");
		value.value = "off";
		value.dispatchEvent(new Event("change"));
		expect(output.value).toBe(
			"flywheel-comm feature-flags set --name 'doc_flow' --to 'off' --project '*' --reason 'phone-report'",
		);

		scope.value = "flywheel";
		scope.dispatchEvent(new Event("change"));
		expect(value.value).toBe("off");
		expect(output.value).toBe("");
		value.value = "clear";
		value.dispatchEvent(new Event("change"));
		expect(output.value).toBe(
			"flywheel-comm feature-flags clear --name 'doc_flow' --project 'flywheel' --reason 'phone-report'",
		);

		scope.value = "*";
		scope.dispatchEvent(new Event("change"));
		expect(value.value).toBe("inherit");
		expect(output.value).toBe("");
		scope.value = "flywheel";
		scope.dispatchEvent(new Event("change"));
		expect(value.value).toBe("off");
		expect(output.value).toBe("");
	});
});

it("copies a Codex effort change using explicit identities from the report row", () => {
	const snapshot = buildConsoleSnapshot(
		[
			{
				projectName: "project-with-dashes",
				projectRoot: "/tmp/project",
				leads: [
					{
						agentId: "lead-with-dashes",
						backend: "codex-app-server",
						model: "gpt-6-astra",
						effort: "low",
					},
				],
			},
		],
		undefined,
		{ fleetScriptPath: "/repo/fleet.sh", commCliPath: "/repo/comm.js" },
	);
	document.open();
	document.write(renderFlagReport(snapshot, { interactive: true }));
	document.close();
	// happy-dom misreads selected options after document.write (minimal three-option
	// repro selects a when b carries selected). Restore the rendered attribute.
	for (const select of document.querySelectorAll<HTMLSelectElement>(
		"[data-cfg-kind]",
	)) {
		const selected =
			select.querySelector<HTMLOptionElement>("option[selected]");
		expect(selected?.value).toBe(select.getAttribute("data-current"));
		select.value = selected!.value;
	}
	new Function(document.querySelector("script")!.textContent!)();
	const effort = document.querySelector<HTMLSelectElement>(
		'[data-cfg-kind="effort"]',
	)!;
	effort.value = "high";
	effort.dispatchEvent(new Event("change"));
	expect(
		document.querySelector<HTMLTextAreaElement>("#ffCopyText")!.value,
	).toBe(
		"node '/repo/comm.js' lead-config set --project 'project-with-dashes' --lead 'lead-with-dashes' --effort 'high' --reason 'phone-report'",
	);
	effort.value = "__default__";
	effort.dispatchEvent(new Event("change"));
	expect(
		document.querySelector<HTMLTextAreaElement>("#ffCopyText")!.value,
	).not.toContain("bash");
});
