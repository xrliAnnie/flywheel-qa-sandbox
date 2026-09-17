import { PassThrough, Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { importClaudeXhsMedia } from "../claude-media.js";

const state = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../claude-bridge-client.js", () => ({
	createClaudeXhsBridgeClient: () => ({
		async importArtifact(data: Buffer, mime: string) {
			state.calls++;
			return { size: data.length, mimeType: mime };
		},
	}),
}));
it("collects only bounded binary stdin and passes its bytes to intake", async () => {
	state.calls = 0;
	expect(
		await importClaudeXhsMedia(
			Readable.from([Buffer.from("one"), Buffer.from("two")]),
			"video/mp4",
			{},
		),
	).toEqual({ size: 6, mimeType: "video/mp4" });
	expect(state.calls).toBe(1);
});
it("rejects excessive or nonbinary input without uploading", async () => {
	state.calls = 0;
	await expect(
		importClaudeXhsMedia(
			Readable.from([Buffer.alloc(10 * 1024 * 1024), Buffer.from("x")]),
			"video/mp4",
			{},
		),
	).rejects.toThrow("xhs_request_invalid");
	await expect(
		importClaudeXhsMedia(Readable.from(["not-binary"]), "image/png", {}),
	).rejects.toThrow("xhs_request_invalid");
	expect(state.calls).toBe(0);
});
it("cancels a stalled stream and never uploads partial bytes", async () => {
	state.calls = 0;
	const stream = new PassThrough();
	const controller = new AbortController();
	const pending = importClaudeXhsMedia(
		stream,
		"image/png",
		{},
		controller.signal,
	);
	stream.write(Buffer.from("partial"));
	controller.abort();
	await expect(pending).rejects.toThrow("xhs_request_invalid");
	expect(stream.destroyed).toBe(true);
	expect(state.calls).toBe(0);
});
