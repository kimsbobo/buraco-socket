/**
 * "Player X not in room" while the table is visibly alive (prod 2026-08-18,
 * rooms BRC-9VTJK and BRC-08EB6).
 *
 * What happened, in order:
 *   1. Two finished matches (BRC-PHYKY, BRC-UFWPL) were still in Redis — the
 *      snapshot is rewritten on every action and only expires with its 2h TTL,
 *      and deleting a room never deleted its key.
 *   2. The server restarted. loadPersistedGames() rehydrated both dead matches
 *      as ZOMBIE rooms, rosters and all, and bound their playerIds in
 *      playerToRoom.
 *   3. The same two humans started a NEW room and played there, so playerToRoom
 *      now pointed at the live room while the zombie rooms still listed them.
 *   4. 15 minutes later the inactivity sweep reaped a zombie. _deleteRoom looped
 *      its roster and deleted those players' mappings unconditionally — cutting
 *      them loose from the game they were actually playing.
 *   5. Every draw/discard/meld answered "Player X not in room", while the turn
 *      timer and state broadcasts (which read the ROSTER, not the mapping) kept
 *      running. The table looked alive and rejected every tap until the client
 *      happened to re-emit join-room.
 *
 * Each step below is pinned so the chain cannot re-form.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const InMemoryRedis = require('../../src/utils/InMemoryRedis');
const PlayerSession = require('../../src/models/PlayerSession');
const { GameRoomStatus } = require('../../src/constants');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeIo() {
  return {
    to: () => ({ emit: () => {} }),
    sockets: { sockets: new Map() },
  };
}

function seat(room, playerId, socketId, index) {
  room.addPlayer(
    new PlayerSession({ playerId, playerName: `P${playerId}`, playerIndex: index, socketId })
  );
}

describe('#zombie-room a dead room must not unbind players from their live room', () => {
  it('deleting a stale room leaves the mapping of players who moved on intact', () => {
    const service = new GameService();

    // The zombie: a finished match whose roster still lists both humans.
    const zombie = service.createRoom('BRC-PHYKY', 2);
    zombie.status = GameRoomStatus.FINISHED;
    seat(zombie, '37453', 'sock-old-a', 0);
    seat(zombie, '7', 'sock-old-b', 1);
    service.playerToRoom.set('37453', 'BRC-PHYKY');
    service.playerToRoom.set('7', 'BRC-PHYKY');

    // Both humans move to a new room. claim-seat and the FailureManager
    // reconnect path rebind playerToRoom directly, without leaveRoom — so the
    // zombie keeps its roster entries.
    const live = service.createRoom('BRC-9VTJK', 2);
    seat(live, '37453', 'sock-new-a', 0);
    seat(live, '7', 'sock-new-b', 1);
    service.playerToRoom.set('37453', 'BRC-9VTJK');
    service.playerToRoom.set('7', 'BRC-9VTJK');
    service.socketToPlayer.set('sock-new-a', '37453');
    service.socketToPlayer.set('sock-new-b', '7');

    // The inactivity sweep reaps the zombie.
    service.deleteRoom('BRC-PHYKY');

    expect(service.getRoom('BRC-PHYKY')).to.equal(undefined);
    expect(service.playerToRoom.get('37453')).to.equal('BRC-9VTJK');
    expect(service.playerToRoom.get('7')).to.equal('BRC-9VTJK');
    expect(service.getPlayerRoom('7')?.roomId).to.equal('BRC-9VTJK');
    // The live sockets keep resolving to their players (the old sockets don't).
    expect(service.getPlayerIdBySocket('sock-new-b')).to.equal('7');
  });

  it('still clears the mappings the deleted room does own', () => {
    const service = new GameService();
    const room = service.createRoom('BRC-SOLO', 2);
    seat(room, 'p1', 's1', 0);
    service.playerToRoom.set('p1', 'BRC-SOLO');
    service.socketToPlayer.set('s1', 'p1');

    service.deleteRoom('BRC-SOLO');

    expect(service.playerToRoom.has('p1')).to.equal(false);
    expect(service.socketToPlayer.has('s1')).to.equal(false);
  });

  it('getPlayerRoom self-heals a lost binding from the roster', () => {
    const service = new GameService();
    const room = service.createRoom('BRC-LIVE', 2);
    room.status = GameRoomStatus.IN_PROGRESS;
    seat(room, '7', 's7', 0);

    // Mapping lost by some other teardown; the player is still seated.
    expect(service.playerToRoom.has('7')).to.equal(false);

    expect(service.getPlayerRoom('7')?.roomId).to.equal('BRC-LIVE');
    expect(service.playerToRoom.get('7')).to.equal('BRC-LIVE');
  });

  it('getPlayerRoom does not resurrect a binding to a room that has ended', () => {
    const service = new GameService();
    const ended = service.createRoom('BRC-DONE', 2);
    ended.status = GameRoomStatus.FINISHED;
    seat(ended, '7', 's7', 0);

    expect(service.getPlayerRoom('7')).to.equal(undefined);
    expect(service.playerToRoom.has('7')).to.equal(false);
  });

  it('loadPersistedGames skips ended matches and purges their snapshots', async () => {
    const redis = new InMemoryRedis();
    const service = new GameService();
    const failureManager = new FailureManager(fakeIo(), redis, service, silentLogger);

    const ended = service.createRoom('BRC-PHYKY', 2);
    ended.status = GameRoomStatus.FINISHED;
    ended.gameEndedAt = new Date();
    seat(ended, '7', 'sock-old', 0);
    await failureManager.persistGameState(ended);

    const playing = service.createRoom('BRC-LIVE', 2);
    playing.status = GameRoomStatus.IN_PROGRESS;
    seat(playing, '7', 'sock-new', 0);
    await failureManager.persistGameState(playing);

    // Fresh boot: nothing in memory yet.
    service.rooms.clear();
    service.playerToRoom.clear();

    const restored = await failureManager.loadPersistedGames();

    expect(restored).to.equal(1);
    expect(service.rooms.has('BRC-PHYKY')).to.equal(false);
    expect(service.rooms.has('BRC-LIVE')).to.equal(true);
    expect(service.playerToRoom.get('7')).to.equal('BRC-LIVE');
    expect(await redis.get('game:BRC-PHYKY:state')).to.equal(null);
    await redis.quit();
  });

  it('loadPersistedGames still restores a room parked in the round-over intermission', async () => {
    const redis = new InMemoryRedis();
    const service = new GameService();
    const failureManager = new FailureManager(fakeIo(), redis, service, silentLogger);

    const intermission = service.createRoom('BRC-BETWEEN', 2);
    intermission.status = GameRoomStatus.FINISHED; // finished round, live match
    intermission.awaitingNextRound = true;
    intermission.nextRoundAt = Date.now() + 10000;
    seat(intermission, '7', 'sock', 0);
    await failureManager.persistGameState(intermission);

    service.rooms.clear();
    service.playerToRoom.clear();

    const restored = await failureManager.loadPersistedGames();

    expect(restored).to.equal(1);
    expect(service.rooms.has('BRC-BETWEEN')).to.equal(true);
    await redis.quit();
  });

  it('a restored snapshot never steals a player already bound to a live room', () => {
    const service = new GameService();
    const failureManager = new FailureManager(fakeIo(), new InMemoryRedis(), service, silentLogger);

    const live = service.createRoom('BRC-LIVE', 2);
    live.status = GameRoomStatus.IN_PROGRESS;
    seat(live, '7', 'sock-new', 0);
    service.playerToRoom.set('7', 'BRC-LIVE');

    const rehydrated = service.createRoom('BRC-OLD', 2);
    seat(rehydrated, '7', 'sock-old', 0);
    failureManager._restoreGameManagerMappings(rehydrated);

    expect(service.playerToRoom.get('7')).to.equal('BRC-LIVE');
  });

  it('deleting a room purges its Redis snapshot so a restart cannot revive it', async () => {
    const redis = new InMemoryRedis();
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    handlers.failureManager = new FailureManager(fakeIo(), redis, service, silentLogger);

    const room = service.createRoom('BRC-GONE', 2);
    seat(room, 'p1', 's1', 0);
    await handlers.failureManager.persistGameState(room);
    expect(await redis.get('game:BRC-GONE:state')).to.not.equal(null);

    service.deleteRoom('BRC-GONE');
    await new Promise((resolve) => setImmediate(resolve));

    expect(await redis.get('game:BRC-GONE:state')).to.equal(null);
    await redis.quit();
  });
});
