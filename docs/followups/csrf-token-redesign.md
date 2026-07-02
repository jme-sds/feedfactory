# Follow-up plan: CSRF redesign (remove reliance on a JS-readable token)

Status: **proposed, not started.** Created as a follow-up to the 2026-07 security
review (see the `security-hardening` branch). Low priority / defense-in-depth.

## Context

FeedFactory currently protects mutating requests with a **double-submit CSRF token**:
- Backend `CSRFMiddleware` (`main.py`) sets a random `csrf_token` cookie with
  `httponly=False`, and on every non-safe method compares the cookie value against the
  `X-CSRF-Token` request header (`hmac.compare_digest`).
- Frontend `apiFetch()` (`frontend/src/lib/api.ts:22-45`) reads the cookie via
  `document.cookie` and echoes it in the `X-CSRF-Token` header.

The review flagged that the cookie is `httponly=False` (item **L2**). This is **inherent
to double-submit** — the client must be able to read the token to echo it — so it cannot
simply be flipped to `httponly=True` without breaking every mutating request. It is also
not a vulnerability on its own: a cross-site attacker cannot read a same-origin cookie,
and any XSS defeats CSRF regardless of this flag. The XSS sinks that made L2 exploitable
were already fixed in the `security-hardening` branch (server-side `nh3` sanitization).

This plan is therefore **optional hardening**, not a required fix. Goal: reduce reliance
on a client-readable secret and harden against cookie-injection, by adding
**request-origin verification** as the primary CSRF defense.

## Key investigation FIRST (blocking unknown)

Requests reach FastAPI **through the Next.js rewrite proxy** (`frontend/next.config.ts`
rewrites `/api/*` → `BACKEND_URL`). The browser talks to the Next origin; Next proxies
server-side to the backend. **Before choosing an approach, confirm what the backend
actually sees** for a browser-initiated mutating request:
- Does the backend receive the browser's `Origin` header, or Next's? (`Origin`,
  `Referer`, `Sec-Fetch-Site`, `Host`.)
- Repro: add a temporary route that logs `dict(request.headers)` and POST to it from the
  running UI, then read the container logs.
- If Next strips/rewrites `Origin`, the Origin-check approach needs Next to forward it (or
  a custom trusted header), which changes the recommendation. Do not skip this step.

## Recommended approach (pending the check above)

**Origin/Sec-Fetch-Site allow-list check in `CSRFMiddleware`, replacing the token.**

1. On non-safe methods, require that the request came from a trusted origin:
   - Prefer `Sec-Fetch-Site: same-origin` (sent by modern browsers, not forgeable by
     cross-site pages).
   - Fall back to an `Origin`/`Referer` allow-list (the deployment's own hostnames, e.g.
     `ff.jme-ds.com`, plus `localhost:3000`/`frontend:3000` for dev). Make the allow-list
     configurable via env (`ALLOWED_ORIGINS`).
   - Reject with 403 when neither matches. Keep the existing HX-Request/JSON 403 shaping.
2. This is stateless (no session store — good, the app is single-user and otherwise
   stateless) and needs **no client-readable token**, so the `csrf_token` cookie can be
   dropped entirely.
3. Frontend: remove `getCsrfToken()` and the `X-CSRF-Token` header logic from
   `apiFetch()` (`frontend/src/lib/api.ts`). No token to manage.

**Fallback approach if the proxy hides `Origin`/`Sec-Fetch-Site`:** keep double-submit but
make the token an **HMAC-signed** value (`token = rand || hex(HMAC(server_secret, rand))`,
verified server-side). The cookie stays readable, but a planted/injected cookie can't be
forged into a valid pair. This does **not** remove the readable-cookie property, so only
use it if the Origin approach is infeasible.

## Files to touch

- `main.py` — `CSRFMiddleware` class and its cookie-set block; add `ALLOWED_ORIGINS`
  parsing near the other env reads (`DEMO_MODE`, `DEV_MODE`).
- `frontend/src/lib/api.ts` — drop `getCsrfToken()` + `X-CSRF-Token` (Origin approach) or
  leave as-is (HMAC fallback).
- `frontend/CLAUDE.md` / this repo's `CLAUDE.md` — note the mechanism change.

## Verification

- Manual: with the UI running, confirm normal mutations (add feed, mark read, save
  settings) still succeed, and that a `curl` POST with no/foreign `Origin` gets 403.
- Cross-site repro: a POST from a different origin (or with `Sec-Fetch-Site: cross-site`)
  must be rejected.
- Regression: run the CLAUDE.md container flow (`docker compose up -d --build`, then the
  edge-nginx Host-header curl) and click through the reader + settings.

## Risk

Medium blast radius — a mistake here breaks **all** mutating requests. Do the header
investigation first, ship behind a quick rollback, and test the full mutation surface.
