/* eslint-env mocha */

/**
 * PER-TEAM ROUND STATE ON THE STATE FRAME.
 *
 * Three facts about a side's round existed ONLY as live events, so a client that
 * reconnected or joined late had no way to learn them:
 *
 *   teamHasPickedDeadPile / teamDeadPileCount — the client has always PARSED
 *     these, and nothing in the server ever sent them. Its only source was the
 *     optimistic flip on POZZETTO_TAKEN, which sees takes that happen while it
 *     is connected and nothing else. This is not a scoreboard nicety: the client
 *     gates its own `canDiscardReason` on the well flags, so a stale copy
 *     answers `mustTakeWell` for a perfectly legal closing discard and the
 *     client refuses to even SEND the move.
 *
 *   teamTurnPenalty — never reached the client at all, so a minimum-meld charge
 *     was invisible above the table until the round-over board.
 *
 *   teamRequiredMeldPoints / teamMeldPointsThisTurn / teamMeldPointsThisRound —
 *     the limit HUD. The client can arm the OPENING 75 from the cumulative
 *     ledger, but every escalation after a failed going-down happens
 *     server-side, so its copy went quietly stale at 75 while the real bar
 *     climbed to 95, 115, …
 *
 * They now ride `_serializeRoomGameSettings`, i.e. EVERY state frame, players
 * and spectators alike.
 */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { GameRoom, PlayerSession } = require('../../src/models');
const { GameRoomStatus } = require('../../src/constants');

function seatedRoom(seats = 4) {
  const room = new GameRoom({ roomId: 'team-round-state', maxPlayers: seats });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = 'classicWithNoJoker';
  for (let i = 0; i < seats; i += 1) {
    room.addPlayer(
      new PlayerSession({
        playerId: `s${i + 1}`,
        playerName: `S${i + 1}`,
        playerIndex: i,
        socketId: `sock${i + 1}`,
      })
    );
    room.playerHands.set(`s${i + 1}`, []);
    room.playerMelds.set(`s${i + 1}`, []);
  }
  return room;
}

describe('#per-team round state rides every game_state_update', () => {
  it('reports the well flags a reconnecting client cannot otherwise learn', () => {
    const room = seatedRoom();

    let state = ActionHandlers.serializeTeamRoundState(room);
    expect(state.teamHasPickedDeadPile).to.deep.equal({ teamA: false, teamB: false });
    expect(state.teamDeadPileCount).to.deep.equal({ teamA: 0, teamB: 0 });

    // teamA banks a well. A client that was not listening for POZZETTO_TAKEN
    // must still be able to read this off the next state frame.
    ActionHandlers._markTeamPozzettoTaken(room, 's1', 'indirect');

    state = ActionHandlers.serializeTeamRoundState(room);
    expect(state.teamHasPickedDeadPile).to.deep.equal({ teamA: true, teamB: false });
    expect(state.teamDeadPileCount).to.deep.equal({ teamA: 1, teamB: 0 });
  });

  it('distinguishes one well banked from BOTH', () => {
    // The boolean alone cannot say whether a side still has a well coming. The
    // client would have to guess the count as 1, locking a team out of a second
    // pozzetto the house rule still entitles it to.
    const room = seatedRoom();
    ActionHandlers._markTeamPozzettoTaken(room, 's1', 'indirect');
    ActionHandlers._markTeamPozzettoTaken(room, 's1', 'direct');

    const state = ActionHandlers.serializeTeamRoundState(room);
    expect(state.teamHasPickedDeadPile.teamA).to.equal(true);
    expect(state.teamDeadPileCount.teamA).to.equal(2);
  });

  it('carries the side\'s minimum-meld charge, partner included', () => {
    const room = seatedRoom();
    room.cumulativeTeamScores.set('teamA', 1000);
    room.teamTurnPenalty.set('s3', 100); // the PARTNER, not the lead

    const state = ActionHandlers.serializeTeamRoundState(room);
    expect(
      state.teamTurnPenalty.teamA,
      'read the same way _computeScores reads it, or the HUD previews a total the round board contradicts'
    ).to.equal(100);
    expect(state.teamTurnPenalty.teamB).to.equal(0);
  });

  it('sums both seats and the legacy side-keyed entry', () => {
    const room = seatedRoom();
    room.teamTurnPenalty.set('s1', 100);
    room.teamTurnPenalty.set('s3', 100);
    room.teamTurnPenalty.set('teamA', 100); // nothing writes this today; restored state may

    expect(ActionHandlers.serializeTeamRoundState(room).teamTurnPenalty.teamA).to.equal(300);
  });

  it('is a 1v1 shape too', () => {
    const room = seatedRoom(2);
    const state = ActionHandlers.serializeTeamRoundState(room);
    expect(Object.keys(state.teamHasPickedDeadPile).sort()).to.deep.equal(['teamA', 'teamB']);
  });

  it('says NOTHING rather than all-zero for a room with no seats', () => {
    // The client treats an absent key as "the server did not say" and keeps what
    // it has; an empty/zero map would read as authoritative and wipe live state.
    const room = new GameRoom({ roomId: 'empty', maxPlayers: 4 });
    const state = ActionHandlers.serializeTeamRoundState(room);
    expect(state.teamHasPickedDeadPile).to.deep.equal({});

    const handlers = Object.create(SocketHandlers.prototype);
    handlers._nextRoundDelayMs = () => 0;
    const settings = handlers._serializeRoomGameSettings(room);
    expect(settings).to.not.have.property('teamHasPickedDeadPile');
    expect(settings).to.not.have.property('teamTurnPenalty');
  });

  it('is spread into the shared settings block every state frame is built from', () => {
    const room = seatedRoom();
    ActionHandlers._markTeamPozzettoTaken(room, 's2', 'indirect');
    room.teamTurnPenalty.set('s4', 100);

    const handlers = Object.create(SocketHandlers.prototype);
    handlers._nextRoundDelayMs = () => 0;
    const settings = handlers._serializeRoomGameSettings(room);

    expect(settings.teamHasPickedDeadPile).to.deep.equal({ teamA: false, teamB: true });
    expect(settings.teamDeadPileCount).to.deep.equal({ teamA: 0, teamB: 1 });
    expect(settings.teamTurnPenalty).to.deep.equal({ teamA: 0, teamB: 100 });
  });
});

describe('#the limit HUD rides the same frame', () => {
  it('reports the bar, the turn and the round for each side', () => {
    const room = seatedRoom(2);
    // Fresh deal: GameRoom seeds the bar to null ("never been past 1000"),
    // which the client must be able to tell apart from 0 ("already satisfied").
    room.teamRequiredMeldPoints.set('teamA', null);
    room.teamRequiredMeldPoints.set('teamB', null);

    let state = ActionHandlers.serializeTeamRoundState(room);
    expect(state.teamRequiredMeldPoints).to.deep.equal({ teamA: null, teamB: null });
    expect(state.teamMeldPointsThisTurn).to.deep.equal({ teamA: 0, teamB: 0 });
    expect(state.teamMeldPointsThisRound).to.deep.equal({ teamA: 0, teamB: 0 });

    // teamA is past 1000 and has already failed once, so the bar has climbed.
    room.teamRequiredMeldPoints.set('teamA', 95);
    room.teamMeldPointsThisTurn.set('teamA', 45);
    room.playerMelds.set('s1', [
      ['3', '4', '5', '6', '7', '8', '9'].map((rank, i) => ({
        suit: 'hearts',
        rank,
        cardId: 900 + i,
      })),
    ]);

    state = ActionHandlers.serializeTeamRoundState(room);
    expect(state.teamRequiredMeldPoints.teamA).to.equal(95);
    expect(state.teamRequiredMeldPoints.teamB).to.equal(null);
    expect(state.teamMeldPointsThisTurn.teamA).to.equal(45);
    // 3-7 are 5 each, 8 and 9 are 10 each.
    expect(state.teamMeldPointsThisRound.teamA).to.equal(45);
    expect(state.teamMeldPointsThisRound.teamB).to.equal(0);
  });

  it('counts a 2v2 side ONCE, not once per seat', () => {
    const room = seatedRoom(4);
    const meld = ['3', '4', '5'].map((rank, i) => ({
      suit: 'spades',
      rank,
      cardId: 800 + i,
    }));
    // The same meld visible on both partners' storage — deduped by card id, or
    // the side's melding session reads double.
    room.playerMelds.set('s1', [meld]);
    room.playerMelds.set('s3', [meld.map((c) => ({ ...c }))]);

    const state = ActionHandlers.serializeTeamRoundState(room);
    expect(state.teamMeldPointsThisRound.teamA).to.equal(15);
  });

  it('rides the state frame itself, not just the serializer', () => {
    const room = seatedRoom(2);
    room.teamRequiredMeldPoints.set('teamA', 75);

    const handlers = Object.create(SocketHandlers.prototype);
    handlers._nextRoundDelayMs = () => 0;
    const settings = handlers._serializeRoomGameSettings(room);

    expect(settings).to.have.property('teamRequiredMeldPoints');
    expect(settings).to.have.property('teamMeldPointsThisTurn');
    expect(settings).to.have.property('teamMeldPointsThisRound');
    expect(settings.teamRequiredMeldPoints.teamA).to.equal(75);
  });
});
