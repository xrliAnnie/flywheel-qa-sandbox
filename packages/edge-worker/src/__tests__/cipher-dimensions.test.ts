import { describe, expect, it } from "vitest";
import { extractDimensions } from "../cipher/dimensions.js";
import type { SnapshotInputDto } from "../cipher/types.js";

function makeInput(
	overrides: Partial<SnapshotInputDto> = {},
): SnapshotInputDto {
	return {
		labels: ["bug"],
		exitReason: "completed",
		changedFilePaths: ["src/foo.ts"],
		commitCount: 2,
		filesChangedCount: 1,
		linesAdded: 30,
		linesRemoved: 10,
		consecutiveFailures: 0,
		...overrides,
	};
}

describe("extractDimensions", () => {
	it("extracts primary label from first label", () => {
		const d = extractDimensions(makeInput({ labels: ["feature", "ui"] }));
		expect(d.primaryLabel).toBe("feature");
	});

	it("uses 'unlabeled' when no labels", () => {
		const d = extractDimensions(makeInput({ labels: [] }));
		expect(d.primaryLabel).toBe("unlabeled");
	});

	it("classifies size bucket correctly", () => {
		expect(
			extractDimensions(makeInput({ linesAdded: 5, linesRemoved: 5 }))
				.sizeBucket,
		).toBe("tiny");
		expect(
			extractDimensions(makeInput({ linesAdded: 50, linesRemoved: 10 }))
				.sizeBucket,
		).toBe("small");
		expect(
			extractDimensions(makeInput({ linesAdded: 200, linesRemoved: 100 }))
				.sizeBucket,
		).toBe("medium");
		expect(
			extractDimensions(makeInput({ linesAdded: 400, linesRemoved: 200 }))
				.sizeBucket,
		).toBe("large");
	});

	it("classifies area as backend by default", () => {
		const d = extractDimensions(
			makeInput({ changedFilePaths: ["src/server.ts", "src/api.ts"] }),
		);
		expect(d.areaTouched).toBe("backend");
	});

	it("classifies area as frontend for component paths", () => {
		const d = extractDimensions(
			makeInput({ changedFilePaths: ["src/components/Button.tsx"] }),
		);
		expect(d.areaTouched).toBe("frontend");
	});

	it("classifies area as auth when >50% auth paths", () => {
		const d = extractDimensions(
			makeInput({
				changedFilePaths: [
					"src/auth/login.ts",
					"src/auth/session.ts",
					"src/utils.ts",
				],
			}),
		);
		expect(d.areaTouched).toBe("auth");
	});

	it("classifies area as mixed when both frontend and backend", () => {
		const d = extractDimensions(
			makeInput({
				changedFilePaths: ["src/components/App.tsx", "src/server.ts"],
			}),
		);
		expect(d.areaTouched).toBe("mixed");
	});

	it("detects exit status correctly", () => {
		expect(
			extractDimensions(makeInput({ exitReason: "completed" })).exitStatus,
		).toBe("completed");
		expect(
			extractDimensions(makeInput({ exitReason: "timeout" })).exitStatus,
		).toBe("timeout");
		expect(
			extractDimensions(makeInput({ exitReason: "error" })).exitStatus,
		).toBe("error");
	});

	it("detects prior failures", () => {
		expect(
			extractDimensions(makeInput({ consecutiveFailures: 0 })).hasPriorFailures,
		).toBe(false);
		expect(
			extractDimensions(makeInput({ consecutiveFailures: 2 })).hasPriorFailures,
		).toBe(true);
	});

	it("classifies commit volume", () => {
		expect(extractDimensions(makeInput({ commitCount: 1 })).commitVolume).toBe(
			"single",
		);
		expect(extractDimensions(makeInput({ commitCount: 3 })).commitVolume).toBe(
			"few",
		);
		expect(extractDimensions(makeInput({ commitCount: 10 })).commitVolume).toBe(
			"many",
		);
	});

	it("classifies diff scale", () => {
		expect(
			extractDimensions(makeInput({ filesChangedCount: 1 })).diffScale,
		).toBe("trivial");
		expect(
			extractDimensions(makeInput({ filesChangedCount: 4 })).diffScale,
		).toBe("small");
		expect(
			extractDimensions(makeInput({ filesChangedCount: 10 })).diffScale,
		).toBe("medium");
		expect(
			extractDimensions(makeInput({ filesChangedCount: 20 })).diffScale,
		).toBe("large");
	});

	it("detects test files", () => {
		expect(
			extractDimensions(makeInput({ changedFilePaths: ["src/foo.ts"] }))
				.hasTests,
		).toBe(false);
		expect(
			extractDimensions(makeInput({ changedFilePaths: ["src/foo.test.ts"] }))
				.hasTests,
		).toBe(true);
		expect(
			extractDimensions(
				makeInput({ changedFilePaths: ["src/__tests__/foo.ts"] }),
			).hasTests,
		).toBe(true);
	});

	it("detects auth-touching files", () => {
		expect(
			extractDimensions(makeInput({ changedFilePaths: ["src/foo.ts"] }))
				.touchesAuth,
		).toBe(false);
		expect(
			extractDimensions(makeInput({ changedFilePaths: ["src/auth/login.ts"] }))
				.touchesAuth,
		).toBe(true);
		expect(
			extractDimensions(
				makeInput({ changedFilePaths: ["src/middleware/guard.ts"] }),
			).touchesAuth,
		).toBe(true);
	});
});
