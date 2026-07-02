# Follow-up plan: opt-in Cloudflare Access JWT verification

Status: **proposed, not started.** Created as a follow-up to the 2026-07 security
review (see the `security-hardening` branch). Defense-in-depth.

## Context

FeedFactory has **no app-layer authentication** in normal (non-demo) mode. Auth is
enforced at the Cloudflare edge: `ff.jme-ds.com` sits behind Cloudflare Access
(Azure AD + MFA), and the origin is only reachable via the CF Tunnel → `edge-nginx`
(see `/opt/stacks/CLAUDE.md`). The app trusts that any request it receives already passed
Access.

The review noted (item: "no app-layer auth outside CF Access") that this is **by design**
and acceptable given the topology — the origin isn't publicly reachable. The one
defensible defense-in-depth control is to **validate the `Cf-Access-Jwt-Assertion` header**
that Cloudflare Access injects, so a request that somehow reached the origin *without*
going through Access (e.g. a future misconfig that exposes the origin, or lateral movement
inside the Docker network) is rejected.

This must be **strictly opt-in / fail-open when unconfigured**, so default behavior is
unchanged and there is zero risk of locking the single user out on deploy.

## Approach

Add a middleware that, **only when configured via env**, verifies the Access JWT on
incoming requests.

Config (all optional; feature is inert unless both are set):
- `CF_ACCESS_TEAM_DOMAIN` — e.g. `https://<team>.cloudflareaccess.com`
- `CF_ACCESS_AUD` — the Application Audience (AUD) tag from the Access app
  (Cloudflare dashboard → Access → the `ff` application → Overview).

Verification steps (standard CF Access pattern):
1. Read the JWT from the `Cf-Access-Jwt-Assertion` header (fall back to the
   `CF_Authorization` cookie).
2. Fetch and cache the signing keys from
   `${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` (JWKS; cache with a TTL, refresh on
   unknown `kid`).
3. Verify RS256 signature, `iss == CF_ACCESS_TEAM_DOMAIN`, `aud` contains `CF_ACCESS_AUD`,
   and `exp`/`iat`.
4. On failure return 403 (JSON for `/api/*`). On success continue.

Behavior details:
- **Fail-open when unconfigured**: if either env var is missing, the middleware is a
  no-op. This keeps the current single-user deploy working untouched.
- **Exempt paths**: health/static and the machine-to-machine surfaces. At minimum exempt
  `/static/`, `/manifest.json`, `/sw.js`, and `/feeds/*` (the digest RSS is polled by
  downstream readers that don't carry an Access JWT — confirm whether those consumers go
  through Access or a bypass before enforcing on `/feeds/`). Mirror the existing
  `DemoAuthMiddleware.OPEN_PREFIXES` as a starting point.
- Register it in the middleware stack next to `DemoAuthMiddleware` in `main.py`.

## Dependencies

- Add `PyJWT[crypto]` (pulls in `cryptography`) to `requirements.txt`. `PyJWT` handles
  RS256 + JWKS cleanly; `python-jose` is an alternative.

## Files to touch

- `main.py` — new `CFAccessMiddleware` class + env parsing + JWKS fetch/cache helper +
  `app.add_middleware(...)`.
- `requirements.txt` — add `PyJWT[crypto]`.
- `.env.example` / `compose.yml.example` — document `CF_ACCESS_TEAM_DOMAIN` and
  `CF_ACCESS_AUD`.
- Cross-repo note: the AUD tag lives in the Cloudflare Access app for `ff.jme-ds.com`;
  see `/opt/stacks/cf_tunnel` + the `cf-onboard` skill for how Access apps are wired.

## Verification

- **Unconfigured (default):** with the env vars unset, every route behaves exactly as
  today (no 403s). This is the most important regression check.
- **Configured, valid:** with the vars set, a request carrying a genuine
  `Cf-Access-Jwt-Assertion` (i.e. through the real `ff.jme-ds.com` Access flow) succeeds.
  Test through the tunnel per the `/opt/stacks/CLAUDE.md` edit/test procedure.
- **Configured, invalid/missing:** a direct request to the origin
  (`docker run --rm --network cloudflare curlimages/curl -H 'Host: ff.jme-ds.com'
  http://edge-nginx/api/settings`) with no valid JWT returns 403.
- Confirm `/feeds/*` still serves to its intended consumers before enabling — don't break
  downstream RSS polling.

## Risk

Low if kept opt-in and fail-open. The real hazard is enforcing on a path that legitimately
lacks a JWT (esp. `/feeds/*` RSS consumers) and silently breaking it — hence the explicit
exempt-path step and the "unconfigured = no-op" default.
