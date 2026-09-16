import { PINNED_NATIVE_ORIGIN } from "./native-resource-baseline.js";
import type { NativeSkillBaseline } from "./native-skills.js";

/** Explicit host-observed admission, FLY-2519 ruling 8ca4ab13 (2026-09-14).
 * Never regenerate from the runtime home: changed versions/content must fail closed.
 */
export const PINNED_NATIVE_CODEX_SKILLS: NativeSkillBaseline = Object.freeze({
	codexVersion: "0.153.2",
	origin: PINNED_NATIVE_ORIGIN,
	sources: Object.freeze(
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
	),
});
