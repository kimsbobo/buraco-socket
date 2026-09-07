/* eslint-env mocha */
//
// PTW-233 — Lobby player-list must be authoritative for a JOINER (non-owner).
//
// Bug: during the WAITING phase a non-owner only ever received a partial
// PLAYER_JOINED snapshot, so its seat list rendered empty. The fix makes every
// seat/bot mutation broadcast the FULL roster (all seats + bots) to ALL clients,
// regardless of isInProgress, and adds `players` to all state builders.
//
// These tests assert the full `players` array rides on the broadcasts a joiner
// (and the other already-seated clients) actually receive, in 1v1, 2v2, and on
// bot-invite.

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { SocketEvents } = require('../../src/constants');
const GameService = require('../../src/services/GameService');

describe('SocketHandlers — lobby player list (PTW-233)', () => {
  const createSocketMock = (id) => {
    const emitted = [];
    const broadcasts = []; // captures socket.to(roomId).emit(...) to OTHERS
    const joinedRooms = [];
    return {
      id,
      handshake: { headers: {}, auth: {} },
      join: (roomId) => joinedRooms.push(roomId),
      to: (roomId) => ({
        emit: (event, payload) => broadcasts.push({ roomId, event, payload }),
      }),
      emit: (event, payload) => emitted.push({ event, payload }),
      get emitted() {
        return emitted;
      },
      get broadcasts() {
        return broadcasts;
      },
      get joinedRooms() {
        return joinedRooms;
      },
    };
  };

  const createIoMock = (sockets = []) => {
    const map = new Map(sockets.map((s) => [s.id, s]));
    const io = {
      roomEmits: [], // captures io.to(roomId).emit(...) to the whole room
      sockets: { sockets: map },
      to: (roomId) => ({
        emit: (event, payload) => io.roomEmits.push({ roomId, event, payload }),
      }),
    };
    return io;
  };

  const idsOf = (players) => players.map((p) => p.playerId).sort();

  it('1v1: joiner ack AND the broadcast to others both carry the full roster', async () => {
    const service = new GameService();
    const owner = createSocketMock('s-owner');
    const joiner = createSocketMock('s-join');
    const io = createIoMock([owner, joiner]);
    const handler = new SocketHandlers(io, service);
    service.createRoom('room-1v1', 2);

    await handler.handleJoinRoom(owner, {
      playerId: 'p1',
      playerName: 'Owner',
      roomId: 'room-1v1',
    });
    await handler.handleJoinRoom(joiner, {
      playerId: 'p2',
      playerName: 'Joiner',
      roomId: 'room-1v1',
    });

    // The joiner's own ack must include the complete seat list.
    const ack = joiner.emitted.find(
      (e) => e.event === SocketEvents.PLAYER_JOINED && e.payload?.players
    );
    expect(ack, 'joiner ack carries players').to.not.equal(undefined);
    expect(idsOf(ack.payload.players)).to.deep.equal(['p1', 'p2']);

    // The broadcast the EXISTING owner receives must now also carry the full
    // roster (previously it was a single-entry snapshot → empty list bug).
    const bcast = joiner.broadcasts.find(
      (b) => b.event === SocketEvents.PLAYER_JOINED && b.payload?.players
    );
    expect(bcast, 'broadcast to others carries players').to.not.equal(undefined);
    expect(idsOf(bcast.payload.players)).to.deep.equal(['p1', 'p2']);

    handler._stopTurnTimer(service.getRoom('room-1v1'));
    service.shutdown();
  });

  it('2v2: a late joiner (room not yet full) gets every occupied seat', async () => {
    const service = new GameService();
    const s1 = createSocketMock('s1');
    const s2 = createSocketMock('s2');
    const s3 = createSocketMock('s3');
    const io = createIoMock([s1, s2, s3]);
    const handler = new SocketHandlers(io, service);
    service.createRoom('room-2v2', 4);

    await handler.handleJoinRoom(s1, { playerId: 'p1', playerName: 'P1', roomId: 'room-2v2' });
    await handler.handleJoinRoom(s2, { playerId: 'p2', playerName: 'P2', roomId: 'room-2v2' });
    await handler.handleJoinRoom(s3, { playerId: 'p3', playerName: 'P3', roomId: 'room-2v2' });

    // Room is still WAITING (3/4) — no game start yet.
    expect(service.getRoom('room-2v2').isInProgress()).to.equal(false);

    // p3's ack lists all three occupied seats.
    const ack = s3.emitted.find(
      (e) => e.event === SocketEvents.PLAYER_JOINED && e.payload?.players
    );
    expect(ack, 'p3 ack carries players').to.not.equal(undefined);
    expect(idsOf(ack.payload.players)).to.deep.equal(['p1', 'p2', 'p3']);

    // The broadcast that p1 / p2 receive when p3 joins carries the full roster.
    const bcast = s3.broadcasts.find(
      (b) => b.event === SocketEvents.PLAYER_JOINED && b.payload?.players
    );
    expect(bcast, 'broadcast to others carries players').to.not.equal(undefined);
    expect(idsOf(bcast.payload.players)).to.deep.equal(['p1', 'p2', 'p3']);

    service.shutdown();
  });

  it('bot-invite: the room-wide PLAYER_JOINED carries seats + the new bot', async () => {
    const service = new GameService();
    const owner = createSocketMock('s-owner');
    const io = createIoMock([owner]);
    const handler = new SocketHandlers(io, service);
    service.createRoom('room-bot', 4);

    await handler.handleJoinRoom(owner, {
      playerId: 'p1',
      playerName: 'Owner',
      roomId: 'room-bot',
    });

    io.roomEmits.length = 0; // ignore join traffic; focus on the invite broadcast

    const result = handler.inviteBotToRoom({
      roomId: 'room-bot',
      botName: 'Bot 1',
      playerIndex: 1,
    });
    expect(result.success).to.not.equal(false);

    const playerJoined = io.roomEmits.find(
      (e) => e.event === SocketEvents.PLAYER_JOINED && e.payload?.players
    );
    expect(playerJoined, 'bot invite broadcasts full roster').to.not.equal(undefined);
    const ids = playerJoined.payload.players.map((p) => p.playerId);
    expect(ids).to.include('p1');
    expect(playerJoined.payload.players.some((p) => p.isBot === true)).to.equal(true);
    expect(playerJoined.payload.players.length).to.equal(2);

    service.shutdown();
  });
});
