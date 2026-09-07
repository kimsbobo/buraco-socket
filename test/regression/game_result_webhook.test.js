/**
 * Game-result reporting: when a match ends the realtime server must POST the
 * result to the backend so win/loss/streak + leaderboard populate. Verifies the
 * payload, that bots are excluded, that a non-seated winner becomes null, and
 * that it is idempotent per room (normal-end + forfeit cannot double-count).
 */

const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const PlayerSession = require('../../src/models/PlayerSession');
const { GameRoomStatus } = require('../../src/constants');
const config = require('../../src/config');

function fakeIo() {
  return { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } };
}

function roomWith(service, players) {
  const room = service.createRoom('r1', players.length);
  players.forEach((p, i) =>
    room.addPlayer(new PlayerSession({ playerId: p.id, playerName: p.id, playerIndex: i, socketId: 's' + i, isBot: !!p.bot }))
  );
  return room;
}

describe('#game-result backend webhook', () => {
  let origFetch;
  let origUrl;
  let origSecret;
  let calls;

  beforeEach(() => {
    origFetch = global.fetch;
    origUrl = config.backend.url;
    origSecret = config.backend.webhookSecret;
    config.backend.url = 'http://backend.test';
    config.backend.webhookSecret = null;
    calls = [];
    global.fetch = (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return Promise.resolve({ ok: true });
    };
  });

  afterEach(() => {
    global.fetch = origFetch;
    config.backend.url = origUrl;
    config.backend.webhookSecret = origSecret;
  });

  it('posts winner + all real player ids (bots excluded) as integers', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }, { id: 'bot:9', bot: true }]);

    handlers._notifyBackendGameResult(room, '10');

    expect(calls).to.have.length(1);
    expect(calls[0].url).to.match(/\/api\/webhooks\/game-result$/);
    // match_id (room id + game-start stamp) is sent for backend idempotency (PTW-35).
    expect(calls[0].body).to.have.property('match_id').that.is.a('string');
    expect(calls[0].body.winner_user_id).to.equal(10);
    expect(calls[0].body.player_user_ids).to.deep.equal([10, 20]);
  });

  it('is idempotent per room (second call is a no-op)', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }]);

    handlers._notifyBackendGameResult(room, '10');
    handlers._notifyBackendGameResult(room, '20'); // already reported

    expect(calls).to.have.length(1);
  });

  it('null winner when the winner is not a seated real player (e.g. a draw)', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }]);

    handlers._notifyBackendGameResult(room, null);

    expect(calls[0].body.winner_user_id).to.equal(null);
    expect(calls[0].body.player_user_ids).to.deep.equal([10, 20]);
  });

  it('no-op when BACKEND_URL is not configured', () => {
    config.backend.url = null;
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }]);

    handlers._notifyBackendGameResult(room, '10');
    expect(calls).to.have.length(0);
  });

  // §6.2 room-stuck-after-finish: a transient failure must NOT silently drop the
  // settlement (the old bare .catch(log) did). It retries with backoff; the room
  // stays latched throughout, and the chain stops as soon as a send succeeds.
  it('retries a transient failure until it succeeds (settlement not dropped)', async function () {
    this.timeout(4000);
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }]);

    let n = 0;
    global.fetch = () => {
      n += 1;
      return Promise.resolve(n === 1 ? { ok: false, status: 503 } : { ok: true });
    };

    handlers._notifyBackendGameResult(room, '10');
    // First attempt fires synchronously; the settlement is NOT dropped.
    expect(n).to.equal(1);
    expect(room.resultReported).to.equal(true);

    // First retry backoff is ~1s — wait past it; the retry succeeds and the chain
    // terminates (no further sends, so nothing leaks into later tests).
    await new Promise((r) => setTimeout(r, 1300));
    expect(n).to.equal(2);
    expect(room.resultReported).to.equal(true);
  });

  // ---- #11 multi-round enrichment ----------------------------------------

  it('enriches the payload with matchEnded/targetScore/cumulativeTeamScores/teamScores (+ matchWinner* at match end)', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }]);

    room.targetScore = 1000;
    room.cumulativeTeamScores = new Map([['teamA', 1050], ['teamB', 400]]);
    room.lastTeamScores = { teamA: { total: 150 }, teamB: { total: 80 } };
    // Terminal round: _finalizeWith overwrites winnerId with the cumulative
    // leader and stashes the round-out player under roundWinner*.
    room.lastRoundEndPayload = {
      type: 'round_ended',
      matchEnded: true,
      matchWinnerTeam: 'teamA',
      matchWinnerId: '10',
      matchWinnerIndex: 0,
      targetScore: 1000,
      cumulativeTeamScores: { teamA: 1050, teamB: 400 },
      roundWinnerId: '20',
      roundWinnerIndex: 1,
      teamScores: { teamA: { total: 150 }, teamB: { total: 80 } },
      winnerId: '10',
      winnerIndex: 0,
    };

    handlers._notifyBackendGameResult(room, '10');

    expect(calls).to.have.length(1);
    const body = calls[0].body;
    expect(body).to.have.property('result_id').that.is.a('string');
    expect(body.matchEnded).to.equal(true);
    expect(body.targetScore).to.equal(1000);
    expect(body.cumulativeTeamScores).to.deep.equal({ teamA: 1050, teamB: 400 });
    expect(body.teamScores).to.deep.equal({ teamA: { total: 150 }, teamB: { total: 80 } });
    expect(body.roundWinnerId).to.equal(20);
    expect(body.roundWinnerIndex).to.equal(1);
    expect(body.matchWinnerId).to.equal(10);
    expect(body.matchWinnerIndex).to.equal(0);
    expect(body.matchWinnerTeam).to.equal('teamA');
  });

  it('intermediate round: matchEnded=false, no matchWinner* fields, but cumulative + targetScore present', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }]);

    room.targetScore = 1000;
    room.cumulativeTeamScores = new Map([['teamA', 450], ['teamB', 300]]);
    room.lastRoundEndPayload = {
      type: 'round_ended',
      winnerId: '10',
      winnerIndex: 0,
      teamScores: { teamA: { total: 200 }, teamB: { total: 90 } },
    };

    handlers._notifyBackendGameResult(room, '10');

    const body = calls[0].body;
    expect(body.matchEnded).to.equal(false);
    expect(body.targetScore).to.equal(1000);
    expect(body.cumulativeTeamScores).to.deep.equal({ teamA: 450, teamB: 300 });
    expect(body.roundWinnerId).to.equal(10);
    expect(body).to.not.have.property('matchWinnerId');
    expect(body).to.not.have.property('matchWinnerTeam');
  });

  it('fires once PER ROUND in a reused room (startGame clears the per-round guard)', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }]);

    // Round 1 end -> webhook fires, resultReported latched.
    room.cumulativeTeamScores = new Map([['teamA', 400], ['teamB', 300]]);
    handlers._notifyBackendGameResult(room, '10');
    expect(calls).to.have.length(1);

    // A second fire WITHIN the same round is still suppressed (forfeit racing).
    handlers._notifyBackendGameResult(room, '20');
    expect(calls).to.have.length(1);

    // The socket re-deals the SAME room for round 2 -> startGame resets the guard.
    expect(room.startGame(true)).to.equal(true);
    expect(room.resultReported).to.equal(false);

    // Round 2 end -> the webhook fires again (per-round, NOT per-match).
    handlers._notifyBackendGameResult(room, '20');
    expect(calls).to.have.length(2);
    // Same MATCH id across rounds (createdAt is stable); the room id is reused.
    expect(calls[1].body.match_id).to.equal(calls[0].body.match_id);
    // cumulative PERSISTS across the re-deal (startGame only seeds missing keys).
    expect(calls[1].body.cumulativeTeamScores).to.deep.equal({ teamA: 400, teamB: 300 });
  });

  it('triggerStartGame re-deals a FINISHED room and preserves cumulativeTeamScores', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }]);

    room.cumulativeTeamScores = new Map([['teamA', 600], ['teamB', 350]]);
    room.endGame('10'); // mark FINISHED (round over, not yet deleted)

    const res = handlers.triggerStartGame(room.roomId, {});
    expect(res.success).to.equal(true);
    expect(room.isInProgress()).to.equal(true);
    // Running total survives the in-place re-deal.
    expect(room.cumulativeTeamScores.get('teamA')).to.equal(600);
    expect(room.cumulativeTeamScores.get('teamB')).to.equal(350);
  });

  it('seeds cumulativeTeamScores from sync-room ONLY on first-configure (no live overwrite on re-deal)', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = service.createRoom('seed1', 2);

    // First configure of a freshly (re)created room: seed the running total.
    handlers._applyRoomSettings(room, { targetScore: 1000, cumulativeTeamScores: { teamA: 300, teamB: 200 } });
    expect(room.cumulativeTeamScores.get('teamA')).to.equal(300);
    expect(room.cumulativeTeamScores.get('teamB')).to.equal(200);

    // A later in-place sync must NOT overwrite the live in-memory total.
    handlers._applyRoomSettings(room, { cumulativeTeamScores: { teamA: 999, teamB: 999 } });
    expect(room.cumulativeTeamScores.get('teamA')).to.equal(300);
    expect(room.cumulativeTeamScores.get('teamB')).to.equal(200);
  });

  // ---- wlive settleGame enrichment: roomId + server_game_id + data ---------

  it('carries roomId/server_game_id + a wlive `data` object (winnerIndex/winningTeam/matchEnded/cumulativeTeamScores/result_id) WITHOUT changing the legacy top-level fields', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }, { id: 'bot:9', bot: true }]);

    room.targetScore = 1000;
    room.cumulativeTeamScores = new Map([['teamA', 1050], ['teamB', 400]]);
    room.lastRoundEndPayload = {
      type: 'round_ended',
      matchEnded: true,
      matchWinnerTeam: 'teamA',
      matchWinnerId: '10',
      matchWinnerIndex: 0,
      targetScore: 1000,
      cumulativeTeamScores: { teamA: 1050, teamB: 400 },
      roundWinnerId: '20',
      roundWinnerIndex: 1,
      winningTeam: 'teamA',
      playerScores: { 10: { total: 90 }, 20: { total: 60 } },
      teamScores: { teamA: { total: 150 }, teamB: { total: 80 } },
      winnerId: '10',
      winnerIndex: 0,
    };

    handlers._notifyBackendGameResult(room, '10');

    expect(calls).to.have.length(1);
    const body = calls[0].body;

    // Legacy top-level fields Buraco-Project's GameResultController reads are UNCHANGED.
    expect(body).to.have.property('match_id').that.is.a('string');
    expect(body.winner_user_id).to.equal(10);
    expect(body.player_user_ids).to.deep.equal([10, 20]);

    // New top-level Room handles for wlive.
    expect(body.roomId).to.equal('r1');
    expect(body.server_game_id).to.equal('r1');

    // The enriched game.ended `data` settleGame consumes.
    const data = body.data;
    expect(data).to.be.an('object');
    expect(data).to.have.property('result_id').that.is.a('string');
    expect(data.matchEnded).to.equal(true);
    expect(data.winnerIndex).to.equal(0);
    expect(data.winningTeam).to.equal('teamA');
    expect(data.playerScores).to.deep.equal({ 10: { total: 90 }, 20: { total: 60 } });
    expect(data.teamScores).to.deep.equal({ teamA: { total: 150 }, teamB: { total: 80 } });
    expect(data.cumulativeTeamScores).to.deep.equal({ teamA: 1050, teamB: 400 });
    expect(data.targetScore).to.equal(1000);
    expect(data.matchWinnerTeam).to.equal('teamA');
  });

  it('intermediate round: data.matchEnded=false (result_id + cumulative still present, no matchWinner*)', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }]);

    room.targetScore = 1000;
    room.cumulativeTeamScores = new Map([['teamA', 450], ['teamB', 300]]);
    room.lastRoundEndPayload = {
      type: 'round_ended',
      matchEnded: false,
      winnerId: '10',
      winnerIndex: 0,
      winningTeam: 'teamA',
      teamScores: { teamA: { total: 200 }, teamB: { total: 90 } },
    };

    handlers._notifyBackendGameResult(room, '10');

    const data = calls[0].body.data;
    expect(data.matchEnded).to.equal(false);
    expect(data).to.have.property('result_id').that.is.a('string');
    expect(data.cumulativeTeamScores).to.deep.equal({ teamA: 450, teamB: 300 });
    expect(data.winnerIndex).to.equal(0);
    expect(data).to.not.have.property('matchWinnerTeam');
    expect(data).to.not.have.property('matchWinnerId');
  });

  it('forfeit: the game-result data carries matchEnded:true + reason (and legacy top-level fields)', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);
    const room = roomWith(service, [{ id: '10' }, { id: '20' }]);
    room.status = GameRoomStatus.IN_PROGRESS;
    const leaver = room.getPlayer('20');

    handlers._handlePlayerForfeit(null, room, '20', leaver, { reason: 'opponent_left' });

    // The forfeit path also fires a room-closed webhook (teardown); isolate the
    // game-result POST.
    const resultCalls = calls.filter((c) => /\/api\/webhooks\/game-result$/.test(c.url));
    expect(resultCalls).to.have.length(1);
    const body = resultCalls[0].body;

    // Legacy fields still present: the remaining real player ('10') took the win.
    expect(body.winner_user_id).to.equal(10);
    expect(body.player_user_ids).to.deep.equal([10, 20]);
    expect(body.roomId).to.equal('r1');

    // The enriched data settles the escrow on a forfeit (terminal + reason).
    const data = body.data;
    expect(data.matchEnded).to.equal(true);
    expect(data.reason).to.equal('opponent_left');
  });
});
