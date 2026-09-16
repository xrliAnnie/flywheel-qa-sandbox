/** Reviewed installed sources, Lead ruling 4b1bfb67 (2026-09-14).
 * Paths are relative to the trusted host home. Do not regenerate pins at runtime.
 * Missing or changed persona sources are visible gaps; native admission is separate.
 */
export const PINNED_PERSONA_SKILL_SOURCES = Object.freeze(
	[
		{
			name: "company-values",
			homePath:
				".claude/plugins/marketplaces/minimalist-entrepreneur/skills/company-values/SKILL.md",
			sha256:
				"d8c017eb5ad222630fbf503320ead27c9ef39909db5752c8a38b0e96428d19ad",
		},
		{
			name: "find-community",
			homePath:
				".claude/plugins/marketplaces/minimalist-entrepreneur/skills/find-community/SKILL.md",
			sha256:
				"74725186bcad409520a59edffa14689bcbbfc213c4dc5dae4dffce97fd5183dc",
		},
		{
			name: "first-customers",
			homePath:
				".claude/plugins/marketplaces/minimalist-entrepreneur/skills/first-customers/SKILL.md",
			sha256:
				"da4bfe33a52b6911388561e752691bb51f544c7965715c78ce16e33c47d84b64",
		},
		{
			name: "grow-sustainably",
			homePath:
				".claude/plugins/marketplaces/minimalist-entrepreneur/skills/grow-sustainably/SKILL.md",
			sha256:
				"55e382834d6e2416c26a2a869af52e23f4c6e30ead40703864114321ee92f6b5",
		},
		{
			name: "marketing-plan",
			homePath:
				".claude/plugins/marketplaces/minimalist-entrepreneur/skills/marketing-plan/SKILL.md",
			sha256:
				"f0776f808cba0afde645919d3f33682f89d5104513627dfcc2b0b1055f2ed5f6",
		},
		{
			name: "minimalist-review",
			homePath:
				".claude/plugins/marketplaces/minimalist-entrepreneur/skills/minimalist-review/SKILL.md",
			sha256:
				"2c4a8735bb4978f1b7e213c782044cb5ad7279492db1b725caa71a4b380dccd8",
		},
		{
			name: "mvp",
			homePath:
				".claude/plugins/marketplaces/minimalist-entrepreneur/skills/mvp/SKILL.md",
			sha256:
				"0546a592044bf2ada0f61507991cc41ab10507f7131b666a25caca10e6c2339a",
		},
		{
			name: "pricing",
			homePath:
				".claude/plugins/marketplaces/minimalist-entrepreneur/skills/pricing/SKILL.md",
			sha256:
				"120d0c341219051bf9b769d288ad47c0cf104602213e05dc612303c0468a2d1d",
		},
		{
			name: "processize",
			homePath:
				".claude/plugins/marketplaces/minimalist-entrepreneur/skills/processize/SKILL.md",
			sha256:
				"a5a6888ce36d56a63b0abeff06256e64642b79f4f35309993ea80f243f078560",
		},
		{
			name: "validate-idea",
			homePath:
				".claude/plugins/marketplaces/minimalist-entrepreneur/skills/validate-idea/SKILL.md",
			sha256:
				"46d931aaef8e74c358253161d3950ea0c18525778b3b0286a925bf42917d6b03",
		},
		{
			name: "deep-research",
			homePath: ".claude/skills/deep-research/SKILL.md",
			sha256:
				"26ea666f1eb59d062ce546823e8be296292a15bca67368ecee5ba821db45d7dc",
		},
		{
			name: "synthesize-research",
			homePath: ".claude/skills/synthesize-research/SKILL.md",
			sha256:
				"822ed6c48e856846e52c8496055642351c4757863807652e220f416707c06dd8",
		},
	].map((source) => Object.freeze(source)),
);
