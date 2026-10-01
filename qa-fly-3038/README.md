# QA-SBX FLY-3038 real-runner handin drill

This branch exists only for one 529-room drill (token `202610010731-f45ed7`).
Never merge it into main.

Run directory for this drill: `qa-fly-3038/runs/202610010731-f45ed7/`

Repository rule (enforced by the pre-handin guard `probe-registry`): every
`probe.txt` under `qa-fly-3038/runs/` must be listed in `qa-fly-3038/probes.txt`,
one repository-relative path per line.

`.flywheel/config.yaml` declares `pre_handin.script: qa-fly-3038/pre-handin-check.mjs`. That
script is flywheel `scripts/pre-handin-check.mjs` at 79f56fdf6b6268e3b934a89df4634a4aa5b2f069 with only its
frozen GUARDS list replaced by the one guard above.

- sourceSha256: 5d9026603fa1dbcac0f73f0a30ac71d8085e68299f61de2e01611a32dd8048a5
- derivedSha256: 1b3674a69c554333f2dfe79304f8136153c22ffed72dc0674442bec0c2f3b393
- flywheelHead: 79f56fdf6b6268e3b934a89df4634a4aa5b2f069
