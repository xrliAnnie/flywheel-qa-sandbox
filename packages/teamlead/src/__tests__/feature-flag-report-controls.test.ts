// @vitest-environment happy-dom

import { resolveAllFlags } from "flywheel-config";
import { beforeEach, describe, expect, it } from "vitest";
import { renderFlagReport } from "../bridge/feature-flag-report-html.js";

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
