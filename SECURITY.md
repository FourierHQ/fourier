# Security policy

Please report vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/FourierHQ/fourier/security/advisories/new) rather than in a public issue. Include steps to reproduce and the version or commit you tested. You will get an acknowledgement within a few days and a fix or a plan before any public disclosure.

Note that v1 has no authentication on the dashboard or the read API by design. Do not expose a Fourier deployment to the public internet without putting the dashboard and `/api/*` behind your own access control; only `/v1/*` (ingest) is meant to be public. Authentication is on the roadmap.
