/**
 * "saat leave table, ini kaya seat kaga singkron... kadang ada user yang kaga
 * bisa join seat" — reported 2026-08-26, worst in 2v2.
 *
 * A client's seat GRID is rebuilt only from an authoritative roster — the
 * `players[]` array carried by `seat_changed` / the lobby PLAYER_JOINED
 * (PTW-233). `PLAYER_LEFT` carries a single id and no roster, so a client can
 * decrement a counter with it but has nothing to redraw the chairs from.
 *
 * Every seat mutation broadcast that roster... except the two that free a seat
 * by LEAVING:
 *
 *   handleClaimSeat        -> _broadcastSeatChanged   ✓
 *   handleRespondSwap      -> _broadcastSeatChanged   ✓
 *   handleHostSwapSeats    -> _broadcastSeatChanged   ✓
 *   handleLeaveSeat        -> _broadcastSeatChanged   ✓
 *   handleHostKick         -> _broadcastSeatChanged   ✓
 *   handleRemoveBot        -> _broadcastLobbyPlayers  ✓  (fixed for BOTS, PTW-233)
 *   handleLeaveRoom        -> PLAYER_LEFT only        ✗
 *   disconnect grace expiry-> PLAYER_LEFT only        ✗
 *
 * So the leaver stayed drawn in their chair on every other screen, and the seat
 * they had vacated could not be claimed — the server would have allowed it, but
 * no client was offering it. It also explains the "kadang": leaving via the SEAT
 * button was fine, leaving the TABLE was not, and the grace path stranded a
 * chair for minutes with nobody pressing anything to correct the picture.
 *
 * 2v2 suffers most: four chairs, four chances to hold a ghost.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');

function fakeSocket(id, emitted, rooms) {
  return {
    id,
    join: (r) => rooms.add(r),
    leave: (r) => rooms.delete(r),
    emit: (event, payload) => emitted.push({ scope: 'socket', id, event, payload }),
    to: (roomId) => ({
      emit: (event, payload) =>
        emitted.push({ scope: 'socket-to', id, roomId, event, payload }),
    }),
  };
}

function fakeIo(emitted, registry) {
  return {
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ scope: 'room', roomId, event, payload }),
    }),
    sockets: { sockets: registry },
  };
}

const SEATS = [
  { id: '10', name: 'Host', socket: 's10' },
  { id: '20', name: 'Bee', socket: 's20' },
  { id: '30', name: 'Cee', socket: 's30' },
  { id: '40', name: 'Dee', socket: 's40' },
];

describe('lobby seat sync — freeing a seat must ship the authoritative roster', () => {
  const services = [];
  let emitted;
  let registry;
  let io;
  let handlers;
  let service;
  let origFetch;

  beforeEach(() => {
    origFetch = global.fetch;
    global.fetch = () => Promise.resolve({ ok: true });
    emitted = [];
    registry = new Map();
    for (const s of SEATS) registry.set(s.socket, fakeSocket(s.socket, emitted, new Set()));
    io = fakeIo(emitted, registry);
    service = new GameService();
    services.push(service);
    handlers = new SocketHandlers(io, service);
  });

  afterEach(() => {
    global.fetch = origFetch;
    while (services.length > 0) services.pop().shutdown();
  });

  /** A full 2v2 lobby, still WAITING. */
  function lobby2v2(roomId = 'seat1') {
    const room = service.createRoom(roomId, 4);
    for (const s of SEATS) service.joinRoom(roomId, s.id, s.name, s.socket);
    return room;
  }

  /** The roster from the last seat_changed, as {seat: playerId|null}. */
  function lastRoster(roomId) {
    const frames = emitted.filter(
      (e) => e.event === 'seat_changed' && (e.roomId === roomId || e.scope === 'room')
    );
    if (frames.length === 0) return null;
    const players = frames[frames.length - 1].payload.players;
    const byIndex = {};
    for (const p of players) byIndex[p.playerIndex] = String(p.playerId);
    return byIndex;
  }

  it('a player leaving the TABLE frees their chair for everyone', () => {
    const room = lobby2v2();
    expect(room.players.size).to.equal(4);

    emitted.length = 0;
    handlers.handleLeaveRoom(registry.get('s30'), {});

    // The single-id notice still goes out (older clients patch a counter).
    expect(emitted.some((e) => e.event === 'player_left')).to.equal(true);

    // ...and so does the roster the seat grid is actually rebuilt from.
    const roster = lastRoster('seat1');
    expect(roster, 'no seat_changed after a table leave').to.not.equal(null);
    expect(Object.values(roster)).to.not.include('30');
    expect(Object.values(roster).sort()).to.deep.equal(['10', '20', '40']);
    // The seat the leaver held is now claimable, and the others did NOT shuffle.
    expect(roster[2]).to.equal(undefined);
    expect(roster[0]).to.equal('10');
    expect(roster[1]).to.equal('20');
    expect(roster[3]).to.equal('40');
  });

  it('the freed seat can then actually be claimed', () => {
    const room = lobby2v2('seat2');
    handlers.handleLeaveRoom(registry.get('s40'), {});

    emitted.length = 0;
    // Bee walks across to the chair Dee vacated.
    handlers.handleClaimSeat(registry.get('s20'), { seat: 3 });

    expect(emitted.some((e) => e.event === 'swap_failed')).to.equal(false);
    const roster = lastRoster('seat2');
    expect(roster[3]).to.equal('20');
    expect(roster[1]).to.equal(undefined);
    expect(room.getPlayer('20').playerIndex).to.equal(3);
  });

  it('a seat freed by an expired disconnect grace is broadcast too', async () => {
    const room = lobby2v2('seat3');
    const bee = room.getPlayer('20');
    bee.isConnected = false;

    // Drive the grace timer instead of waiting 30s for it.
    const realSetTimeout = global.setTimeout;
    let graceFn = null;
    global.setTimeout = (fn) => {
      graceFn = fn;
      return { unref() {} };
    };
    try {
      handlers._scheduleWaitingLeave('seat3', '20');
    } finally {
      global.setTimeout = realSetTimeout;
    }
    expect(graceFn, 'grace timer was never armed').to.be.a('function');

    emitted.length = 0;
    await graceFn();

    expect(emitted.some((e) => e.event === 'player_left')).to.equal(true);
    const roster = lastRoster('seat3');
    expect(roster, 'no seat_changed after a grace-expired leave').to.not.equal(null);
    expect(Object.values(roster)).to.not.include('20');
    expect(roster[1]).to.equal(undefined);
  });

  it('the LAST player leaving does not broadcast into a deleted room', () => {
    const roomId = 'seat4';
    const room = service.createRoom(roomId, 4);
    service.joinRoom(roomId, '10', 'Host', 's10');
    service.joinRoom(roomId, '20', 'Bee', 's20');
    // Non-host leaves first, then the host — the host path deletes the room.
    handlers.handleLeaveRoom(registry.get('s20'), {});
    emitted.length = 0;
    handlers.handleLeaveRoom(registry.get('s10'), {});

    expect(service.getRoom(roomId)).to.not.exist;
    // A roster for a room that no longer exists would be a lie. What the people
    // still in it get is the room closing, which is a different message.
    expect(lastRoster(roomId)).to.equal(null);
    expect(emitted.some((e) => e.event === 'room_closed')).to.equal(true);
  });
});
