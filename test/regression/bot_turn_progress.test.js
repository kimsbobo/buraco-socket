/* eslint-env mocha */

/**
 * Bug: a bot with no legal card to discard (a lone uncloseable card) — or an
 * emptied hand it cannot fill from a well — used to sit idle, retrying until the
 * ~30s turn timer force-advanced it. The human just watched a frozen table.
 *
 * BotCoordinator._forceTurnProgress guarantees a drawn bot's turn ends
 * immediately: take the well when the hand is empty, else discard any legal card,
 * else force-advance the turn.
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
const card = (suit, rank) => ({ suit, rank });

// A dealt, in-progress 2-player classic room with p1 = a bot on turn (drawn),
// and a small 2-card well as the only dead pile.
function makeBotRoom(service, roomId) {
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, 'p1', 'P1', 's1');
  service.joinRoom(roomId, 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  room.getPlayer('p1').isBot = true;
  room.ruleset = 'classic';
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.turnTimeLimit = 30;
  room.turnTimerDeadline = null;
  room.deadPiles = [[card('clubs', '7'), card('clubs', '8')]];
  room.discardPile = [];
  return room;
}

function makeCoordinator(service, emitted) {
  const socketHandlers = new SocketHandlers(fakeIo(emitted), service);
  const botCoordinator = new BotCoordinator({
    gameService: service,
    socketHandlers,
    logger: stubLogger,
    config: {},
  });
  socketHandlers.botCoordinator = botCoordinator;
  return botCoordinator;
}

describe('BotCoordinator._forceTurnProgress — never stall a wedged bot', () => {
  it('takes the well when the bot has emptied its hand', async () => {
    const service = new GameService();
    const emitted = [];
    const room = makeBotRoom(service, 'bot-empty-hand');
    room.playerHands.set('p1', []); // melded out — must take the well to continue

    const coordinator = makeCoordinator(service, emitted);
    const moved = await coordinator._forceTurnProgress(room, 'p1');

    expect(moved).to.equal(true);
    // Well taken, still the bot's turn (it will discard on the next cycle).
    expect(room.currentTurn).to.equal(0);
    expect(room.playerHands.get('p1')).to.have.length(2);

    service.deleteRoom('bot-empty-hand');
  });

  it('discards a legal card instead of stalling', async () => {
    const service = new GameService();
    const emitted = [];
    const room = makeBotRoom(service, 'bot-legal-discard');
    // Two cards, neither restricted → a legal discard exists; the turn must end.
    room.playerHands.set('p1', [card('spades', '9'), card('hearts', '4')]);

    const coordinator = makeCoordinator(service, emitted);
    const moved = await coordinator._forceTurnProgress(room, 'p1');

    expect(moved).to.equal(true);
    expect(room.currentTurn).to.equal(1); // discard ended the turn
    expect(room.discardPile).to.have.length(1);

    service.deleteRoom('bot-legal-discard');
  });

  it('force-advances when the lone card cannot be legally discarded', async () => {
    const service = new GameService();
    const emitted = [];
    const room = makeBotRoom(service, 'bot-wedged');
    // No well left to take and no Brazilia: discarding the lone card would be an
    // illegal go-out (noBrazilia), so NO legal discard exists — and with a non-empty
    // hand the well can't be taken either. The bot is genuinely wedged.
    room.deadPiles = [];
    room.pozzetto = null;
    room.playerHands.set('p1', [card('spades', '9')]);
    room.playerMelds.set('p1', []);

    const coordinator = makeCoordinator(service, emitted);
    const moved = await coordinator._forceTurnProgress(room, 'p1');

    expect(moved).to.equal(true);
    expect(room.currentTurn).to.equal(1); // turn skipped forward, not frozen
    const forced = emitted.find((e) => e.event === 'turn_changed' && e.payload.forced === true);
    expect(forced, 'forced turn_changed emitted').to.exist;

    service.deleteRoom('bot-wedged');
  });
});
