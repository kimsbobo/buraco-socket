/* eslint-env mocha */

/**
 * _buildBotState is the contract between the live server and the bot brain, and
 * every BotStrategy unit test fakes it by hand. Nothing used to check that the
 * hand-written fake matched reality: renaming a field here would leave all the
 * strategy tests green while the live bot silently lost a rule gate (the
 * professional well check, the squeeze guard, the drawn-card restriction...).
 *
 * These tests build a REAL room and assert on the actual snapshot, plus the
 * turn-pacing the coordinator applies between chained actions.
 */

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const BotCoordinator = require('../../src/bots/BotCoordinator');

function fakeIo(emitted) {
  return {
    to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }),
    sockets: { sockets: new Map() },
  };
}

const stubLogger = { info() {}, warn() {}, error() {}, debug() {} };
const card = (suit, rank) => ({ suit, rank, cardId: `${suit}-${rank}-${Math.random()}` });

function makeRoom(service, roomId, seats = 4) {
  const room = service.createRoom(roomId, seats);
  for (let i = 0; i < seats; i += 1) {
    service.joinRoom(roomId, `p${i}`, `P${i}`, `s${i}`);
  }
  room.startGame();
  room.dealCards();
  room.getPlayer('p0').isBot = true;
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.turnTimeLimit = 30;
  room.turnTimerDeadline = null;
  return room;
}

function makeCoordinator(service, emitted, config = {}) {
  const socketHandlers = new SocketHandlers(fakeIo(emitted), service);
  const coordinator = new BotCoordinator({
    gameService: service,
    socketHandlers,
    logger: stubLogger,
    config: { bot: config },
  });
  socketHandlers.botCoordinator = coordinator;
  return coordinator;
}

describe('BotCoordinator._buildBotState — the live contract the strategy reads', () => {
  it('exposes every field BotStrategy consumes, with the right shapes', () => {
    const service = new GameService();
    const room = makeRoom(service, 'state-shape');
    const coordinator = makeCoordinator(service, []);

    room.ruleset = 'professional';
    room.professionalWellMode = 'direct';
    room.playerHands.set('p0', [card('clubs', '5'), card('clubs', '6')]);
    room.playerHands.set('p1', [card('hearts', 'K')]);
    room.playerMelds.set('p2', [[card('spades', '4'), card('spades', '5'), card('spades', '6')]]);
    room.deadPiles = [[card('clubs', '7')], [card('clubs', '8')]];
    room.discardPile = [card('diamonds', '9')];

    const state = coordinator._buildBotState(room, room.getPlayer('p0'));

    // Everything BotStrategy.decide reads, asserted by name so a rename here
    // fails loudly instead of silently disarming a rule gate.
    const consumed = [
      'cardsDealt', 'currentPlayerIndex', 'playerIndex', 'hasDrawnCard', 'meldedThisTurn',
      'ruleset', 'professionalWellMode', 'yourHand', 'playerMelds',
      'meldFlags', 'discardPile', 'deckCount', 'deadPileCounts', 'pozzettosAvailable',
      'drawnCardRestriction', 'teamHasTakenPozzetto', 'opponentTeamHasTakenPozzetto',
      'teamWellsTaken', 'opponentWellsTaken', 'handCounts', 'botLevel',
      'targetScore', 'teamScore', 'opponentScore',
      'requiredMeldPoints', 'meldPointsThisTurn', 'discardHistory',
    ];
    consumed.forEach((key) => {
      expect(state, `missing snapshot field: ${key}`).to.have.property(key);
    });

    expect(state.ruleset).to.equal('professional');
    expect(state.professionalWellMode).to.equal('direct');
    expect(state.playerIndex).to.equal(0);
    expect(state.currentPlayerIndex).to.equal(0);
    expect(state.yourHand).to.have.length(2);
    expect(state.pozzettosAvailable).to.equal(true);
    expect(state.deadPileCounts).to.deep.equal([1, 1]);

    service.deleteRoom('state-shape');
  });

  it('reports hand counts for every seat (public info, already sent to humans)', () => {
    const service = new GameService();
    const room = makeRoom(service, 'state-counts');
    const coordinator = makeCoordinator(service, []);

    room.playerHands.set('p0', [card('clubs', '5')]);
    room.playerHands.set('p1', [card('hearts', 'K'), card('hearts', 'Q')]);
    room.playerHands.set('p2', []);
    room.playerHands.set('p3', [card('spades', '2'), card('spades', '3'), card('spades', '4')]);

    const state = coordinator._buildBotState(room, room.getPlayer('p0'));
    expect(state.handCounts).to.deep.equal({ 0: 1, 1: 2, 2: 0, 3: 3 });

    // Counts only: the ONLY hand in the snapshot is the bot's own. Anything else
    // would be the bot cheating rather than reasoning.
    expect(state.yourHand).to.have.length(1);
    expect(Object.values(state.handCounts).every((v) => typeof v === 'number')).to.equal(true);
    const opponentCards = [
      ...room.playerHands.get('p1'),
      ...room.playerHands.get('p3'),
    ].map((c) => String(c.cardId));
    const serialized = JSON.stringify(state);
    opponentCards.forEach((id) => {
      expect(serialized, 'another seat\'s card leaked into the bot snapshot')
        .to.not.include(id);
    });

    service.deleteRoom('state-counts');
  });

  it('reports well counts per TEAM, not a single lossy boolean', () => {
    const service = new GameService();
    const room = makeRoom(service, 'state-wells');
    const coordinator = makeCoordinator(service, []);

    // p0/p2 = teamA (the bot's side), p1/p3 = teamB.
    room.playerDeadPileCount.set('teamA', 1);
    room.playerDeadPileCount.set('teamB', 2);
    room.playerHasTakenPozzetto.set('teamA', true);
    room.playerHasTakenPozzetto.set('teamB', true);

    const state = coordinator._buildBotState(room, room.getPlayer('p0'));
    expect(state.teamWellsTaken).to.equal(1);
    expect(state.opponentWellsTaken).to.equal(2);
    expect(state.teamHasTakenPozzetto).to.equal(true);
    expect(state.opponentTeamHasTakenPozzetto).to.equal(true);

    service.deleteRoom('state-wells');
  });

  it('carries the STICKY clean/dirty flag, which cards alone cannot reproduce', () => {
    const service = new GameService();
    const room = makeRoom(service, 'state-dirty');
    const coordinator = makeCoordinator(service, []);
    room.ruleset = 'professional';

    const meld = [card('spades', '4'), card('spades', '5'), card('spades', '6')];
    room.playerMelds.set('p0', [meld]);
    room.meldDirtyFlags.set('p0', new Set([0]));

    const state = coordinator._buildBotState(room, room.getPlayer('p0'));
    expect(state.meldFlags[0][0]).to.have.property('clean', false);
    expect(state.meldFlags[0][0]).to.have.property('isBuraco', false);

    service.deleteRoom('state-dirty');
  });

  it('keeps the discard history across a pile take, unlike discardPile', () => {
    const service = new GameService();
    const room = makeRoom(service, 'state-history');
    const coordinator = makeCoordinator(service, []);

    const before = room.discardHistory.length; // dealCards flips one card up
    room.discardPile = [];                     // simulate somebody taking the pile
    expect(room.discardHistory).to.have.length(before);

    const state = coordinator._buildBotState(room, room.getPlayer('p0'));
    expect(state.discardPile).to.have.length(0);
    expect(state.discardHistory).to.have.length(before);

    service.deleteRoom('state-history');
  });
});

describe('BotCoordinator — turn pacing', () => {
  it('uses the SHORT follow-up pause between chained actions, not the turn delay', () => {
    const service = new GameService();
    const coordinator = makeCoordinator(service, [], {
      turnDelayMinMs: 1200,
      turnDelayMaxMs: 2200,
      followUpDelayMinMs: 600,
      followUpDelayMaxMs: 900,
      animatedFollowUpDelayMinMs: 1150,
      animatedFollowUpDelayMaxMs: 1450,
    });

    // A discard/draw animates nothing on the client, so it gets the short pause.
    const quick = coordinator._followUpDelayFor('discard_card');
    expect(quick).to.be.at.least(600);
    expect(quick).to.be.at.most(900);

    // A meld triggers a card-flight animation the online client does NOT queue,
    // so the next action must clear the animation window (~1.13s for a 3-card
    // meld at the slow speed) or the two flights visibly overlap.
    const animated = coordinator._followUpDelayFor('play_meld');
    expect(animated).to.be.at.least(1150);
    expect(animated).to.be.at.most(1450);
    ['add_to_meld', 'pick_up_pile', 'take_pozzetto'].forEach((type) => {
      expect(coordinator._followUpDelayFor(type)).to.be.at.least(1150);
    });

    coordinator.shutdown();
  });

  it('suppresses the re-entrant schedule fired by a handler mid-intent', () => {
    // Every handler broadcasts a state update, which calls back into
    // onRoomStateChanged while the intent is still executing. That re-entry used
    // to arm a fresh 1200-2200ms turn delay, which is what actually paced
    // chained actions — making followUpDelay dead configuration.
    const service = new GameService();
    const room = makeRoom(service, 'pacing-reentry');
    const coordinator = makeCoordinator(service, []);

    coordinator.executingRooms.add('pacing-reentry');
    coordinator.onRoomStateChanged(room);
    expect(coordinator.actionTimers.size).to.equal(0);

    coordinator.executingRooms.delete('pacing-reentry');
    coordinator.onRoomStateChanged(room);
    expect(coordinator.actionTimers.size).to.equal(1);

    coordinator.shutdown();
    service.deleteRoom('pacing-reentry');
  });

  it('holds a single flight per bot so one turn cannot arm two pipelines', () => {
    const service = new GameService();
    const room = makeRoom(service, 'pacing-single');
    const coordinator = makeCoordinator(service, []);

    coordinator.onRoomStateChanged(room);
    expect(coordinator.actionTimers.size).to.equal(1);

    // A different observed state (a card moved) must NOT arm a second pipeline.
    room.playerHands.set('p0', [card('clubs', '5')]);
    coordinator.onRoomStateChanged(room);
    expect(coordinator.actionTimers.size).to.equal(1);

    coordinator.shutdown();
    service.deleteRoom('pacing-single');
  });
});
