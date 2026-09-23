import { PINNED_NATIVE_ORIGIN } from "./native-resource-baseline.js";
import { PINNED_NATIVE_RESOURCE_FILES_0154_0156 } from "./native-resource-baseline-0154-0156.js";
import type { NativeSkillBaseline } from "./native-skills.js";

const BASELINE_ROOT =
	"/Users/xiaorongli/.codex-259-qa/packages/native-skill-baselines";

const OLD_SOURCES = Object.freeze(
	[
		{
			name: "imagegen",
			sha256:
				"681ddb4ad6d06a2acc78a3535b583f8d0c1ea800ecda3d56370d3310fd2cd4ba",
		},
		{
			name: "openai-docs",
			sha256:
				"7cb8fa1b2a0c635b5c61ffe1da7b8594a7ea0fce5b71e8d523e2025d88b2a05e",
		},
		{
			name: "plugin-creator",
			sha256:
				"71b95b8219644f95d633721e7f7cd3c469edfc8fe50f8415d400dfb2d74bc7b9",
		},
		{
			name: "review-agent",
			sha256:
				"07079efd0dc76f05fade424e5dfb048dce1de2df7626e1a4f56292a4f3f92228",
		},
		{
			name: "skill-creator",
			sha256:
				"6656e54755638e8efcf275a472b9672eaa8a9a1b9e59dc210e275b03b59e1e66",
		},
		{
			name: "skill-installer",
			sha256:
				"d68b77e5bbb34dedab89d134da52855f140fc4b4299b80104f534e3b9e98f8ee",
		},
	].map((source) => Object.freeze(source)),
);

const NEW_SOURCES = Object.freeze(
	[
		{
			name: "imagegen",
			sha256:
				"681ddb4ad6d06a2acc78a3535b583f8d0c1ea800ecda3d56370d3310fd2cd4ba",
		},
		{
			name: "openai-docs",
			sha256:
				"aa6829e21df2223167c85d2e49b6337a7345c84c1033f1ec10182c7882b36d45",
		},
		{
			name: "plugin-creator",
			sha256:
				"71b95b8219644f95d633721e7f7cd3c469edfc8fe50f8415d400dfb2d74bc7b9",
		},
		{
			name: "review-agent",
			sha256:
				"07079efd0dc76f05fade424e5dfb048dce1de2df7626e1a4f56292a4f3f92228",
		},
		{
			name: "skill-creator",
			sha256:
				"6656e54755638e8efcf275a472b9672eaa8a9a1b9e59dc210e275b03b59e1e66",
		},
		{
			name: "skill-installer",
			sha256:
				"d68b77e5bbb34dedab89d134da52855f140fc4b4299b80104f534e3b9e98f8ee",
		},
	].map((source) => Object.freeze(source)),
);

function baseline(
	codexVersion: "0.153.2" | "0.154.0" | "0.156.0",
	files: readonly { path: string; sha256: string }[],
	sources: NativeSkillBaseline["sources"],
): NativeSkillBaseline {
	return Object.freeze({
		codexVersion,
		origin: Object.freeze({
			root: `${BASELINE_ROOT}/${codexVersion}/skills/.system`,
			files,
		}),
		sources,
	});
}

/** Explicit host-observed admissions; never regenerated from an active home. */
export const PINNED_NATIVE_CODEX_SKILL_BASELINES = Object.freeze({
	"0.153.2": baseline("0.153.2", PINNED_NATIVE_ORIGIN.files, OLD_SOURCES),
	"0.154.0": baseline(
		"0.154.0",
		PINNED_NATIVE_RESOURCE_FILES_0154_0156,
		NEW_SOURCES,
	),
	"0.156.0": baseline(
		"0.156.0",
		PINNED_NATIVE_RESOURCE_FILES_0154_0156,
		NEW_SOURCES,
	),
} satisfies Readonly<Record<string, NativeSkillBaseline>>);

/** Target admission after the FLY-2766 cutover. */
export const PINNED_NATIVE_CODEX_SKILLS =
	PINNED_NATIVE_CODEX_SKILL_BASELINES["0.156.0"];

export function resolvePinnedNativeSkillBaseline(
	codexVersion: string,
): NativeSkillBaseline {
	if (!Object.hasOwn(PINNED_NATIVE_CODEX_SKILL_BASELINES, codexVersion))
		throw Object.assign(new Error("baseline_drift"), {
			receipt: { status: "baseline_drift", codexVersion },
		});
	const resolved =
		PINNED_NATIVE_CODEX_SKILL_BASELINES[
			codexVersion as keyof typeof PINNED_NATIVE_CODEX_SKILL_BASELINES
		];
	return resolved;
}
