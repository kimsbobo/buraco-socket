/**
 * Socket handshake authentication.
 *
 * Without this, the server trusts the client-supplied `playerId` (handshake
 * query / event payloads), so any client can present another user's id and act
 * as them. This middleware verifies a backend bearer token at connect and binds
 * the connection to the SERVER-resolved user id (`socket.data.userId`), which
 * the handlers then treat as authoritative.
 *
 * Verification reuses the backend `GET /api/me` endpoint (which already requires
 * a valid Sanctum token and rejects banned users), so no new backend surface is
 * needed and bans are enforced at the socket layer for free.
 *
 * Gated by `config.auth.required`:
 *   - required=false (default): a valid token is used if present, but a missing/
 *     invalid token still connects in LEGACY mode (`socket.data.authenticated`
 *     stays false) so existing clients keep working during rollout.
 *   - required=true: a missing/invalid token is rejected at the handshake.
 */

const logger = require('../utils/logger');

/**
 * Default token verifier — calls the backend /api/me with the bearer token and
 * returns the resolved user id (string) or null. Isolated + injectable so tests
 * don't need a live backend.
 * @param {string} token
 * @param {{backendUrl: string, verifyTimeoutMs: number}} opts
 * @returns {Promise<string|null>}
 */
async function defaultVerify(token, { backendUrl, verifyTimeoutMs }) {
  if (!backendUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), verifyTimeoutMs);
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, '')}/api/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    // The backend wraps every /api response in the ApiEnvelope middleware as
    // { status, message, result } — only api/admin, api/webhooks and api/internal
    // are excluded. Reading body.id first therefore always yielded null, which
    // silently disabled realtime DM fan-out and left playerId spoofing unblocked.
    // Keep the unwrapped shapes as fallbacks so a raw /api/me still verifies.
    const id = body && (body.result?.id ?? body.id ?? body.user?.id ?? body.result?.user?.id);
    return id != null ? String(id) : null;
  } catch (err) {
    logger.warn(`[socketAuth] token verification failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the Socket.IO auth middleware.
 * @param {{required: boolean, backendUrl: string, verifyTimeoutMs: number}} authConfig
 * @param {(token: string, opts: object) => Promise<string|null>} [verify] injectable verifier (tests)
 * @returns {(socket: object, next: Function) => Promise<void>}
 */
function createSocketAuth(authConfig, verify = defaultVerify) {
  const { required } = authConfig;
  return async (socket, next) => {
    const token =
      socket.handshake?.auth?.token ||
      socket.handshake?.query?.token ||
      null;

    socket.data = socket.data || {};
    socket.data.authenticated = false;
    socket.data.userId = null;

    if (!token) {
      if (required) return next(new Error('Authentication required'));
      return next(); // legacy mode
    }

    let userId = null;
    try {
      userId = await verify(token, authConfig);
    } catch (err) {
      userId = null;
    }

    if (userId) {
      socket.data.authenticated = true;
      socket.data.userId = userId;
      return next();
    }

    if (required) return next(new Error('Invalid authentication token'));
    return next(); // legacy mode: bad token, but auth not enforced
  };
}

module.exports = { createSocketAuth, defaultVerify };
