// Test-process only: controlled latency on this fixture's isolated HTTP path.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
 if (/^http:\/\/127\.0\.0\.1:\d+\/api\/lead-capabilities\/discord$/.test(String(input)))
  await new Promise(resolve => setTimeout(resolve, 300));
 return originalFetch(input, init);
};
