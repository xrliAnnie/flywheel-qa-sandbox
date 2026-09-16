/** Check the credential against the persisted identity before any voice IO. */
export async function verifyLeadVoiceTokenIdentity(
	token: string,
	expectedBotUserId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	if (!/^\d{17,20}$/u.test(expectedBotUserId))
		throw new Error("lead_bot_identity_mismatch");
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let payload: unknown;
	try {
		payload = await Promise.race([
			(async () => {
				const response = await fetchImpl(
					"https://discord.com/api/v10/users/@me",
					{
						method: "GET",
						headers: { Authorization: `Bot ${token}` },
						redirect: "error",
						signal: controller.signal,
					},
				);
				if (!response.ok) throw new Error("http");
				return (await response.json()) as unknown;
			})(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("timeout"));
				}, 2_000);
			}),
		]);
	} catch {
		throw new Error("voice_bot_identity_unavailable");
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
	if (
		!payload ||
		typeof payload !== "object" ||
		!("id" in payload) ||
		payload.id !== expectedBotUserId ||
		!("bot" in payload) ||
		payload.bot !== true
	)
		throw new Error("lead_bot_identity_mismatch");
}
