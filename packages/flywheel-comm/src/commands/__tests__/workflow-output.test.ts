import { describe, expect, it } from "vitest";
import { buildWorkflowOutputRequest } from "../workflow-output.js";

describe("workflow-output", () => {
	it("keeps the credential out of the payload artifact while binding a request id", () => {
		expect(
			buildWorkflowOutputRequest({
				credential: "secret-ticket",
				clientRequestId: "request-1",
				payload: '{"result":"ok"}',
			}),
		).toEqual({
			credential: "secret-ticket",
			client_request_id: "request-1",
			payload: '{"result":"ok"}',
		});
	});
});
