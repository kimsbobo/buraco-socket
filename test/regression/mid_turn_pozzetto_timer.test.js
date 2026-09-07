/* eslint-env mocha */

/**
 * Bug: "if you finish your cards and take the 11 pozzetto it is still your turn,
 * without remaining time."
 *
 * Emptying the hand by melding auto-takes the pot (pozzetto) and the SAME player
 * keeps the turn (they must still discard) — but the meld / going-down /
 * add-to-meld handlers and the manual take-pozzetto handler never re-armed the
 * turn timer. The timer from BEFORE the meld-out kept running and could expire
 * with a full new 11-card hand to play, force-skipping the player. Taking the pot
 * mid-turn must arm a FRESH full-duration turn timer for the same player.
 */

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function fakeIo(emitted) {
  return {
    to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }),
    sockets: { sockets: new Map() },
  };
}

const card = (suit, rank) => ({ suit, rank });

// A 2-player classic room, dealt and in progress, with p1 on turn (already
// drawn) and a small 2-card well as the only dead pile so an emptied hand
// auto-takes exactly 2 cards.
function makeStartedRoom(service, roomId) {
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, 'p1', 'P1', 's1');
  service.joinRoom(roomId, 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  room.ruleset = 'classic';
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.turnTimeLimit = 30;
  room.turnTimerDeadline = null;
  room.deadPiles = [[card('clubs', '7'), card('clubs', '8')]];
  room.discardPile = [];
  return room;
}

const fakeSocket = (id) => ({ id, emit() {} });

describe('mid-turn pozzetto pickup re-arms the turn timer', () => {
  it('handlePlayMeld: melding out + auto-taking the pot keeps the turn and starts a fresh timer', () => {
    const service = new GameService();
    const room = makeStartedRoom(service, 'pot-timer-meld');
    // A valid 3-card set that empties p1's hand when melded.
    const meld = [card('spades', '5'), card('hearts', '5'), card('diamonds', '5')];
    room.playerHands.set('p1', meld.map((c) => ({ ...c })));

    const emitted = [];
    const handlers = new SocketHandlers(fakeIo(emitted), service);

    handlers.handlePlayMeld(fakeSocket('s1'), { cards: meld });

    // Same player keeps the turn; the 2-card well refilled the hand.
    expect(room.currentTurn).to.equal(0);
    expect(room.playerHands.get('p1')).to.have.length(2);

    // The meld broadcast surfaced the pickup...
    const meldPlayed = emitted.find((e) => e.event === 'meld_played');
    expect(meldPlayed, 'meld_played emitted').to.exist;
    expect(meldPlayed.payload.pozzettoTaken).to.equal(2);

    // ...and a FRESH full-duration timer was armed for the SAME player (the bug
    // was: no turn_timer_started here, so the old near-expiry timer stayed).
    const timerStarted = emitted.filter((e) => e.event === 'turn_timer_started');
    expect(timerStarted.length, 'turn_timer_started emitted').to.be.greaterThan(0);
    const last = timerStarted[timerStarted.length - 1];
    expect(last.payload.playerIndex).to.equal(0);
    expect(last.payload.seconds).to.equal(30);
    expect(room.turnTimerTickHandle, 'timer armed').to.not.equal(null);
    expect(room.turnTimerDeadline).to.be.a('number');

    service.deleteRoom('pot-timer-meld');
    expect(room.turnTimerTickHandle, 'timer cleaned up').to.equal(null);
  });

  it('handleTakePozzetto: taking the pot manually keeps the turn and starts a fresh timer', () => {
    const service = new GameService();
    const room = makeStartedRoom(service, 'pot-timer-manual');
    // Empty hand → eligible to take the well directly.
    room.playerHands.set('p1', []);

    const emitted = [];
    const handlers = new SocketHandlers(fakeIo(emitted), service);

    handlers.handleTakePozzetto(fakeSocket('s1'), {});

    expect(room.currentTurn).to.equal(0);
    expect(room.playerHands.get('p1')).to.have.length(2);

    const pozzettoTaken = emitted.find((e) => e.event === 'pozzetto_taken');
    expect(pozzettoTaken, 'pozzetto_taken emitted').to.exist;

    const timerStarted = emitted.filter((e) => e.event === 'turn_timer_started');
    expect(timerStarted.length, 'turn_timer_started emitted').to.be.greaterThan(0);
    expect(timerStarted[timerStarted.length - 1].payload.playerIndex).to.equal(0);
    expect(room.turnTimerTickHandle, 'timer armed').to.not.equal(null);

    service.deleteRoom('pot-timer-manual');
    expect(room.turnTimerTickHandle, 'timer cleaned up').to.equal(null);
  });
});
