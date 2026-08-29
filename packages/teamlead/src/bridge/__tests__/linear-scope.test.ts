/**
 * FLY-371: request-level projectName binding resolution + pure scope merge.
 */
import { describe, expect, it } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	resolveLinearScope,
	resolveProjectNameParam,
} from "../linear-scope.js";

const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [{ agentId: "eng", chatChannel: "c", match: { labels: ["Eng"] } }],
		linear: { team: "FLY", project: "Flywheel", label: "Flywheel" },
	},
	{
		projectName: "no-binding",
		projectRoot: "/tmp/nb",
		leads: [{ agentId: "x", chatChannel: "c", match: { labels: ["X"] } }],
	},
	{
		projectName: "null-binding",
		projectRoot: "/tmp/null",
		leads: [{ agentId: "y", chatChannel: "c", match: { labels: ["Y"] } }],
		linear: null,
	},
];

describe("FLY-371: resolveProjectNameParam", () => {
	it("undefined ⇒ ok with no binding (byte-compat: caller did not pass projectName)", () => {
		expect(resolveProjectNameParam(projects, undefined)).toEqual({
			ok: true,
			binding: undefined,
		});
	});

	// Codex R2 MEDIUM-2: helper accepts `unknown` so JSON body `projectName: 123` is caught.
	it("non-string (123) ⇒ 400", () => {
		const r = resolveProjectNameParam(projects, 123);
		expect(r.ok).toBe(false);
		expect(r).toMatchObject({ ok: false, status: 400 });
	});

	it("empty string ⇒ 400", () => {
		expect(resolveProjectNameParam(projects, "")).toMatchObject({
			ok: false,
			status: 400,
		});
	});

	it("whitespace-only ⇒ 400", () => {
		expect(resolveProjectNameParam(projects, "   ")).toMatchObject({
			ok: false,
			status: 400,
		});
	});

	it("array (repeated query param) ⇒ uses first value", () => {
		expect(resolveProjectNameParam(projects, ["flywheel", "ignored"])).toEqual({
			ok: true,
			binding: { team: "FLY", project: "Flywheel", label: "Flywheel" },
		});
	});

	it("unknown project ⇒ 404 'Unknown'", () => {
		const r = resolveProjectNameParam(projects, "nope");
		expect(r).toMatchObject({ ok: false, status: 404 });
		if (!r.ok) expect(r.error).toMatch(/Unknown Flywheel project/);
	});

	it("known project with no linear field ⇒ 404 'no linear binding'", () => {
		const r = resolveProjectNameParam(projects, "no-binding");
		expect(r).toMatchObject({ ok: false, status: 404 });
		if (!r.ok) expect(r.error).toMatch(/no linear binding/);
	});

	it("known project with linear: null ⇒ 404 'no linear binding'", () => {
		const r = resolveProjectNameParam(projects, "null-binding");
		expect(r).toMatchObject({ ok: false, status: 404 });
		if (!r.ok) expect(r.error).toMatch(/no linear binding/);
	});

	it("known project with a binding ⇒ ok + binding", () => {
		expect(resolveProjectNameParam(projects, "flywheel")).toEqual({
			ok: true,
			binding: { team: "FLY", project: "Flywheel", label: "Flywheel" },
		});
	});
});

describe("FLY-371: resolveLinearScope", () => {
	const binding = { team: "FLY", project: "Flywheel", label: "Flywheel" };

	it("binding undefined + no explicit ⇒ all undefined (byte-compat)", () => {
		expect(resolveLinearScope(undefined, {})).toEqual({
			project: undefined,
			labels: undefined,
		});
	});

	it("binding defaults project + label when no explicit", () => {
		expect(resolveLinearScope(binding, {})).toEqual({
			project: "Flywheel",
			labels: ["Flywheel"],
		});
	});

	it("explicit project overrides binding.project", () => {
		expect(resolveLinearScope(binding, { project: "Other" })).toMatchObject({
			project: "Other",
		});
	});

	it("explicit non-empty labels override binding.label", () => {
		expect(resolveLinearScope(binding, { labels: ["A", "B"] })).toMatchObject({
			labels: ["A", "B"],
		});
	});

	it("explicit empty labels array ⇒ fall back to binding.label", () => {
		expect(resolveLinearScope(binding, { labels: [] })).toMatchObject({
			labels: ["Flywheel"],
		});
	});

	it("label-only binding (no project) ⇒ labels=[label], project=undefined (Polaris)", () => {
		expect(resolveLinearScope({ team: "GEO", label: "Polaris" }, {})).toEqual({
			project: undefined,
			labels: ["Polaris"],
		});
	});
});
