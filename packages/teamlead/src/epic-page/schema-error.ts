export class EpicPageSchemaError extends Error {
	constructor(
		message: string,
		public readonly code: "invalid" | "size" = "invalid",
	) {
		super(message);
		this.name = "EpicPageSchemaError";
	}
}
