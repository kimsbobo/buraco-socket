/**
 * Handshake authentication: the server must derive the user id from a verified
 * backend token instead of trusting the client-supplied playerId. Gated by
 * config.auth.required (legacy mode allows tokenless connects during rollout).
 * The join binding rejects an authenticated socket that claims another user's id.
 */

const { expect } = require('chai');
const { createSocketAuth } = require('../../src/middleware/socketAuth');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function fakeSocket(auth = {}, query = {}) {
  return { handshake: { auth, query }, data: {} };
}

// A verifier that maps a fixed "good" token to a user id, everything else null.
const verify = async (token) => (token === 'good-token' ? '42' : null);

describe('#socket handshake auth', () => {
  describe('middleware (gated)', () => {
    it('legacy mode: no token still connects, unauthenticated', async () => {
      const mw = createSocketAuth({ required: false }, verify);
      const socket = fakeSocket();
      let err;
      await mw(socket, (e) => (err = e));
      expect(err).to.equal(undefined);
      expect(socket.data.authenticated).to.equal(false);
      expect(socket.data.userId).to.equal(null);
    });

    it('required mode: no token is rejected', async () => {
      const mw = createSocketAuth({ required: true }, verify);
      const socket = fakeSocket();
      let err;
      await mw(socket, (e) => (err = e));
      expect(err).to.be.an('error');
    });

    it('valid token resolves and binds the server-side user id', async () => {
      const mw = createSocketAuth({ required: true }, verify);
      const socket = fakeSocket({ token: 'good-token' });
      let err;
      await mw(socket, (e) => (err = e));
      expect(err).to.equal(undefined);
      expect(socket.data.authenticated).to.equal(true);
      expect(socket.data.userId).to.equal('42');
    });

    it('required mode: invalid token is rejected', async () => {
      const mw = createSocketAuth({ required: true }, verify);
      const socket = fakeSocket({ token: 'bad-token' });
      let err;
      await mw(socket, (e) => (err = e));
      expect(err).to.be.an('error');
    });

    it('legacy mode: invalid token connects but unauthenticated', async () => {
      const mw = createSocketAuth({ required: false }, verify);
      const socket = fakeSocket({ token: 'bad-token' });
      let err;
      await mw(socket, (e) => (err = e));
      expect(err).to.equal(undefined);
      expect(socket.data.authenticated).to.equal(false);
    });

    it('accepts token from the handshake query as a fallback', async () => {
      const mw = createSocketAuth({ required: true }, verify);
      const socket = fakeSocket({}, { token: 'good-token' });
      let err;
      await mw(socket, (e) => (err = e));
      expect(err).to.equal(undefined);
      expect(socket.data.userId).to.equal('42');
    });
  });

  describe('identity guard (_assertSocketIdentity)', () => {
    const handlers = new SocketHandlers(
      { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } },
      new GameService()
    );

    it('allows any id for unauthenticated/legacy sockets', () => {
      expect(handlers._assertSocketIdentity({ data: {} }, 'anyone')).to.equal(true);
      expect(handlers._assertSocketIdentity({}, 'anyone')).to.equal(true);
    });

    it('allows the matching id for an authenticated socket', () => {
      const s = { data: { authenticated: true, userId: '42' } };
      expect(handlers._assertSocketIdentity(s, '42')).to.equal(true);
      expect(handlers._assertSocketIdentity(s, 42)).to.equal(true);
    });

    it('rejects a mismatched id for an authenticated socket (impersonation)', () => {
      const s = { data: { authenticated: true, userId: '42' } };
      expect(handlers._assertSocketIdentity(s, '99')).to.equal(false);
    });

    it('allows a null/absent claim (nothing to impersonate)', () => {
      const s = { data: { authenticated: true, userId: '42' } };
      expect(handlers._assertSocketIdentity(s, null)).to.equal(true);
      expect(handlers._assertSocketIdentity(s, undefined)).to.equal(true);
    });
  });
});
