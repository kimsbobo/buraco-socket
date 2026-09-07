/**
 * #11 multi-round match settlement — AUDITED blocker regression.
 *
 * Covers:
 *  1. A reused room broadcasts GAME_ENDED for round 2 and is NOT deleted by the
 *     stale round-1 60s finalize timer (startGame clears the per-round one-shots).
 *  2. An intermediate round_ended payload is explicitly NON-terminal:
 *     matchEnded:false + targetScore + cumulativeTeamScores so the client can
 *     tell round-over from match-over.
 *  3. The game.ended event sent on the wlive path (PartnerWebhookRelay →
 *     /api/brazilia/webhook) carries the enriched multi-round `data` + result_id.
 *  4. A forfeit mid-match is TERMINAL: matchEnded:true (+ reason) so the escrow
 *     settles instead of being stranded by a re-deal.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoom } = require('../../src/models');
const PlayerSession = require('../../src/models/PlayerSession');
const { GameRoomStatus } = require('../../src/constants');
const config = require('../../src/config');

function fakeIo(emits) {
  return {
    to: () => ({ emit: (ev, p) => emits.push({ ev, p }) }),
    sockets: { sockets: new Map() },
  };
}

function roomWith(service, ids) {
  const room = service.createRoom('mr1', ids.length);
  ids.forEach((id, i) =>
    room.addPlayer(
      new PlayerSession({ playerId: id, playerName: id, playerIndex: i, socketId: 's' + i })
    )
  );
  return room;
}

// Free-standing room (no GameService) for the pure _finalizeRound path.
function bareRoom({ players = 2 } = {}) {
  const room = new GameRoom({ roomId: 'mr-bare', maxPlayers: players });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = 'professional';
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  for (let i = 0; i < players; i += 1) {
    const id = `p${i + 1}`;
    room.addPlayer(new PlayerSession({ playerId: id, playerName: id, playerIndex: i, socketId: `s${i + 1}` }));
    room.playerHands.set(id, []);
    room.playerMelds.set(id, []);
    room.playerHasTakenPozzetto.set(id, false);
    room.playerDeadPileCount.set(id, 0);
    room.meldDirtyFlags.set(id, new Set());
    const teamId = i % 2 === 0 ? 'teamA' : 'teamB';
    if (!room.cumulativeTeamScores.has(teamId)) room.cumulativeTeamScores.set(teamId, 0);
  }
  return room;
}

describe('#11 multi-round settlement blockers', () => {
  let origFetch;
  let origUrl;
  let emits;

  beforeEach(() => {
    origFetch = global.fetch;
    origUrl = config.backend.url;
    config.backend.url = 'http://backend.test';
    global.fetch = () => Promise.resolve({ ok: true });
    emits = [];
  });

  afterEach(() => {
    global.fetch = origFetch;
    config.backend.url = origUrl;
  });

  // ---- BLOCKER 1 -----------------------------------------------------------
  it('round 2 in a reused room re-broadcasts GAME_ENDED and the stale 60s timer is cleared', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(emits), service);
    const room = roomWith(service, ['10', '20']);

    // Round 1 ends -> broadcast + a 60s finalize-cleanup timer is scheduled.
    handlers._broadcastRoundEndAndCleanup(room, { type: 'round_ended', winnerId: '10', winnerIndex: 0 });
    const gameEnded1 = emits.filter((e) => e.ev === 'game_ended');
    expect(gameEnded1).to.have.length(1);
    expect(room._roundEndBroadcast).to.equal(true);
    expect(room.finalizeCleanupHandle).to.not.equal(null); // stale teardown armed

    // The socket re-deals the SAME room for round 2.
    expect(room.startGame(true)).to.equal(true);
    // The per-round one-shots are reset AND the stale round-1 teardown timer is
    // cleared, so round 2 can broadcast and the room is NOT deleted mid-round-2.
    expect(room._roundEndBroadcast).to.equal(false);
    expect(room.finalizeCleanupHandle).to.equal(null);
    expect(room.lastRoundEndPayload).to.equal(null);

    // Round 2 ends -> it actually broadcasts again (guard was reset).
    handlers._broadcastRoundEndAndCleanup(room, { type: 'round_ended', winnerId: '20', winnerIndex: 1 });
    expect(emits.filter((e) => e.ev === 'game_ended')).to.have.length(2);
    // Room still present right after round 2 broadcast (deletion is the 60s grace,
    // and the round-1 timer that could have killed it was cleared).
    expect(service.getRoom(room.roomId)).to.equal(room);

    if (room.finalizeCleanupHandle) clearTimeout(room.finalizeCleanupHandle);
    service.shutdown();
  });

  // ---- BLOCKER 3 -----------------------------------------------------------
  it('intermediate round_ended payload is non-terminal: matchEnded:false + targetScore + cumulativeTeamScores', () => {
    const room = bareRoom();
    room.targetScore = 1000;
    room.cumulativeTeamScores.set('teamA', 100);
    room.cumulativeTeamScores.set('teamB', 50);

    const result = ActionHandlers._finalizeRound(room, 'p1');

    expect(result.matchEnded).to.equal(false);
    expect(result.targetScore).to.equal(1000);
    expect(result.cumulativeTeamScores).to.be.an('object');
    expect(result.cumulativeTeamScores).to.have.property('teamA');
    expect(result.cumulativeTeamScores).to.have.property('teamB');
    expect(result.roundWinnerId).to.equal('p1');
    // No matchWinner* on an intermediate round.
    expect(result).to.not.have.property('matchWinnerTeam');
    // Persisted for reconnect refetch.
    expect(room.lastRoundEndPayload).to.equal(result);
    expect(room.lastRoundEndPayload.matchEnded).to.equal(false);
  });

  it('single-round (targetScore 0) stays unchanged: no matchEnded signal', () => {
    const room = bareRoom();
    room.targetScore = 0;
    room.cumulativeTeamScores.set('teamA', 5000);
    const result = ActionHandlers._finalizeRound(room, 'p1');
    expect(result.matchEnded).to.equal(undefined);
    expect(result).to.not.have.property('targetScore');
  });

  // ---- BLOCKER 4 -----------------------------------------------------------
  it('the game.ended event on the wlive path carries the enriched data + result_id', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(emits), service);
    const partnerCalls = [];
    handlers.partnerWebhookRelay = {
      dispatch: (event, payload) => partnerCalls.push({ event, payload }),
    };
    const room = roomWith(service, ['10', '20']);
    room.targetScore = 1000;
    room.cumulativeTeamScores = new Map([['teamA', 1050], ['teamB', 400]]);
    room.lastTeamScores = { teamA: { total: 150 }, teamB: { total: 80 } };

    const roundEnded = {
      type: 'round_ended',
      matchEnded: true,
      targetScore: 1000,
      cumulativeTeamScores: { teamA: 1050, teamB: 400 },
      teamScores: { teamA: { total: 150 }, teamB: { total: 80 } },
      matchWinnerTeam: 'teamA',
      matchWinnerId: '10',
      matchWinnerIndex: 0,
      roundWinnerId: '20',
      roundWinnerIndex: 1,
      winnerId: '10',
      winnerIndex: 0,
    };

    handlers._broadcastRoundEndAndCleanup(room, roundEnded);

    expect(partnerCalls).to.have.length(1);
    expect(partnerCalls[0].event).to.equal('game.completed');
    const data = partnerCalls[0].payload.data;
    expect(data).to.be.an('object');
    expect(data).to.have.property('result_id').that.is.a('string');
    expect(data).to.have.property('match_id').that.is.a('string');
    expect(data.matchEnded).to.equal(true);
    expect(data.targetScore).to.equal(1000);
    expect(data.cumulativeTeamScores).to.deep.equal({ teamA: 1050, teamB: 400 });
    expect(data.teamScores).to.deep.equal({ teamA: { total: 150 }, teamB: { total: 80 } });
    expect(data.roundWinnerId).to.equal('20');
    expect(data.matchWinnerId).to.equal('10');
    expect(data.matchWinnerTeam).to.equal('teamA');

    if (room.finalizeCleanupHandle) clearTimeout(room.finalizeCleanupHandle);
    service.shutdown();
  });

  it('an intermediate round on the wlive path carries matchEnded:false (not terminal)', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(emits), service);
    const partnerCalls = [];
    handlers.partnerWebhookRelay = {
      dispatch: (event, payload) => partnerCalls.push({ event, payload }),
    };
    const room = roomWith(service, ['10', '20']);
    room.targetScore = 1000;
    room.cumulativeTeamScores = new Map([['teamA', 450], ['teamB', 300]]);

    handlers._broadcastRoundEndAndCleanup(room, {
      type: 'round_ended',
      matchEnded: false,
      targetScore: 1000,
      cumulativeTeamScores: { teamA: 450, teamB: 300 },
      winnerId: '10',
      winnerIndex: 0,
      roundWinnerId: '10',
      roundWinnerIndex: 0,
    });

    const data = partnerCalls[0].payload.data;
    expect(data.matchEnded).to.equal(false);
    expect(data.targetScore).to.equal(1000);
    expect(data.cumulativeTeamScores).to.deep.equal({ teamA: 450, teamB: 300 });
    expect(data).to.not.have.property('matchWinnerTeam');

    if (room.finalizeCleanupHandle) clearTimeout(room.finalizeCleanupHandle);
    service.shutdown();
  });

  // ---- BLOCKER (forfeit) ---------------------------------------------------
  it('a forfeit mid-match is TERMINAL: matchEnded:true + reason on the game.ended data', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(emits), service);
    const partnerCalls = [];
    handlers.partnerWebhookRelay = {
      dispatch: (event, payload) => partnerCalls.push({ event, payload }),
    };
    const room = roomWith(service, ['10', '20']);
    room.targetScore = 1000;
    room.status = GameRoomStatus.IN_PROGRESS;
    const leaver = room.getPlayer('20');

    handlers._handlePlayerForfeit(null, room, '20', leaver, { reason: 'opponent_left' });

    // The persisted terminal payload settles the match (no re-deal).
    expect(room.lastRoundEndPayload).to.be.an('object');
    expect(room.lastRoundEndPayload.matchEnded).to.equal(true);
    expect(room.lastRoundEndPayload.reason).to.equal('opponent_left');

    // ...and the wlive path receives matchEnded:true + the forfeit reason.
    expect(partnerCalls).to.have.length(1);
    expect(partnerCalls[0].event).to.equal('game.completed');
    const data = partnerCalls[0].payload.data;
    expect(data.matchEnded).to.equal(true);
    expect(data.reason).to.equal('opponent_left');

    service.shutdown();
  });
});
