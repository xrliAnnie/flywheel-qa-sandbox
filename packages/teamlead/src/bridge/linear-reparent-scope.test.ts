import { expect, it, vi } from "vitest";
import { prepareLinearReparent } from "./linear-reparent.js";

const rawRequest = vi.fn();
vi.mock("@linear/sdk", () => ({
	LinearClient: vi.fn().mockImplementation(() => ({ client: { rawRequest } })),
}));
it("rejects different project UUIDs even when their names match", async () => {
	rawRequest.mockImplementation(
		async (_query: string, { id }: { id: string }) => ({
			data: {
				issue: {
					id,
					identifier: id === "source" ? "FLY-1" : "FLY-2",
					title: "issue",
					description: "",
					priority: 0,
					priorityLabel: "None",
					url: "",
					createdAt: "",
					updatedAt: "",
					state: { name: "Backlog", type: "backlog" },
					labels: { nodes: [] },
					assignee: null,
					project: { id: `${id}-project`, name: "Same Name" },
					parent: null,
				},
			},
		}),
	);
	await expect(
		prepareLinearReparent("fake", "source", "target", {
			team: "FLY",
			project: "Same Name",
		}),
	).rejects.toMatchObject({ status: 403 });
	expect(rawRequest.mock.calls[0]![0]).toMatch(/project\s*\{\s*id\s+name\s*\}/);
});
