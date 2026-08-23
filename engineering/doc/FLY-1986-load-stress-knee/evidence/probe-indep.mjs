// FLY-1986: independent-client cross-check of the curl-based sampler.
// Deliberately a DIFFERENT HTTP client (node fetch, not curl) so that a shared
// client-side artefact cannot explain the observation.
// Read-only: GET /health only.
const url = process.env.BRIDGE_URL ?? "http://localhost:9876";
const n = Number(process.env.N ?? 12);
console.log(`# probe-indep node=${process.version} target=${url}/health n=${n}`);
console.log("iso_ts,load1,secs_or_error");
for (let i = 0; i < n; i++) {
  const load1 = (await import("node:os")).loadavg()[0].toFixed(2);
  const s = process.hrtime.bigint();
  let out;
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(90000) });
    await r.text();
    out = (Number(process.hrtime.bigint() - s) / 1e9).toFixed(3);
  } catch (e) { out = `ERR:${e.name}`; }
  console.log(`${new Date().toISOString()},${load1},${out}`);
  await new Promise((r) => setTimeout(r, 400));
}
