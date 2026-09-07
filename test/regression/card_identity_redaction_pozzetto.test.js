/* eslint-env mocha */

const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const { GameRoom, PlayerSession } = require('../../src/models');
const { Card } = require('../../src/models/Deck');
const { GameRoomStatus } = require('../../src/constants');

const card = (suit, rank, cardId) => new Card(suit, rank, cardId);

function makeRoom({ roomId = 'identity', maxPlayers = 2 } = {}) {
  const room = new GameRoom({ roomId, maxPlayers });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  for (let i = 0; i < maxPlayers; i++) {
    room.addPlayer(new PlayerSession({
      playerId: `p${i + 1}`,
      playerName: `P${i + 1}`,
      playerIndex: i,
      socketId: `s${i + 1}`,
    }));
  }
  return room;
}

function fakeSocket(id) {
  const events = [];
  return {
    id,
    events,
    emit(event, payload) { events.push({ event, payload }); },
    join() {},
    leave() {},
    to() { return { emit() {} }; },
  };
}

function fakeIo(registry) {
  const roomEvents = [];
  return {
    roomEvents,
    to() {
      return {
        emit(event, payload) { roomEvents.push({ event, payload }); },
      };
    },
    sockets: { sockets: registry },
  };
}

describe('card identity, redaction, and pozzetto regression', () => {
  it('allows duplicate suit/rank cards when cardId differs and removes exact hand cards', () => {
    const room = makeRoom();
    const a1 = card('hearts', 'A', 101);
    const a2 = card('hearts', 'A', 102);
    const a3 = card('diamonds', 'A', 103);
    const filler = card('clubs', '7', 104);
    room.playerHands.set('p1', [a1, a2, a3, filler]);
    // A takeable well on the table: melding down to one card is then a legal
    // continuation (that last card could be discarded to take the well), so the
    // keep-a-discardable-card guard allows it. The well is auto-taken only on an
    // EMPTY hand, so the 7♣ stays put and the identity assertions below hold.
    room.deadPiles = [Array.from({ length: 11 }, (_, i) => card('clubs', String((i % 9) + 2), 900 + i))];

    const result = ActionHandlers.handlePlayMeld(room, 'p1', [
      a1.toJSON(),
      a2.toJSON(),
      a3.toJSON(),
    ]);

    expect(result.success).to.equal(true);
    expect(room.playerMelds.get('p1')[0].map((c) => c.cardId)).to.deep.equal([101, 102, 103]);
    expect(room.playerHands.get('p1').map((c) => c.cardId)).to.deep.equal([104]);
  });

  it('adds multiple cards to a meld atomically (emptying the hand auto-takes the well)', () => {
    const room = makeRoom();
    room.playerHands.set('p1', [card('hearts', '6', 201), card('hearts', '7', 202)]);
    room.playerMelds.set('p1', [[card('hearts', '3', 203), card('hearts', '4', 204), card('hearts', '5', 205)]]);
    // A takeable pozzetto: emptying the hand here is a well take, NOT a close
    // (the R2 close-requirement guard rejects an empty hand with no well left —
    // covered by close_requirement_guard.test.js).
    room.deadPiles = [Array.from({ length: 11 }, (_, i) => card('clubs', String((i % 9) + 2), 900 + i))];
    room.playerHasTakenPozzetto.set('p1', false);
    room.playerDeadPileCount.set('p1', 0);

    const result = ActionHandlers.handleAddToMeld(room, 'p1', [
      { suit: 'hearts', rank: '6', cardId: 201 },
      { suit: 'hearts', rank: '7', cardId: 202 },
    ], 0, 0);

    expect(result.success).to.equal(true);
    expect(result.broadcast.cards).to.have.lengthOf(2);
    expect(result.broadcast.pozzettoTaken).to.equal(11); // timer re-arm signal
    expect(room.playerHands.get('p1')).to.have.lengthOf(11); // refilled from the well
    expect(room.playerMelds.get('p1')[0].map((c) => c.rank)).to.deep.equal(['3', '4', '5', '6', '7']);
  });

  it('redacts opponent hands from game_state_update payloads', () => {
    const room = makeRoom();
    room.cardsDealt = false;
    room.playerHands.set('p1', [card('hearts', 'A', 301)]);
    room.playerHands.set('p2', [card('spades', 'K', 302), card('clubs', 'Q', 303)]);

    const s1 = fakeSocket('s1');
    const s2 = fakeSocket('s2');
    const registry = new Map([['s1', s1], ['s2', s2]]);
    const handlers = new SocketHandlers(fakeIo(registry), null);

    handlers._sendInitialGameState(room);

    const p1State = s1.events.find((e) => e.event === 'game_state_update').payload;
    expect(p1State).to.not.have.property('otherPlayersHands');
    expect(p1State.otherPlayersHandCounts).to.deep.equal({ 0: 1, 1: 2 });
  });

  it('rejects get_game_state attempts to fetch another player hand', () => {
    const room = makeRoom();
    room.cardsDealt = true;
    room.playerHands.set('p1', [card('hearts', 'A', 311)]);
    room.playerHands.set('p2', [card('spades', 'K', 312)]);

    const socket = fakeSocket('s1');
    socket.data = { authenticated: true, userId: 'p1' };
    const handlers = new SocketHandlers(fakeIo(new Map([['s1', socket]])), {
      getRoom: () => room,
    });

    handlers.handleGetGameState(socket, { gameId: room.roomId, playerId: 'p2' });

    expect(socket.events.some((e) => e.event === 'game_state_update')).to.equal(false);
    expect(socket.events.some((e) => e.event === 'error')).to.equal(true);
  });

  it('manual pozzetto sends a complete game_state_update instead of a partial hand patch', () => {
    const service = new GameService();
    const room = service.createRoom('poz', 2);
    service.joinRoom('poz', 'p1', 'P1', 's1');
    service.joinRoom('poz', 'p2', 'P2', 's2');
    room.startGame();
    room.status = GameRoomStatus.IN_PROGRESS;
    room.currentTurn = 0;
    room.hasDrawnCard = true;
    room.cardsDealt = false;
    room.deck = { count: 10 };
    room.discardPile = [card('clubs', '9', 401)];
    room.playerHands.set('p1', []);
    room.playerHands.set('p2', [card('spades', '4', 402)]);
    room.deadPiles = [[card('hearts', '5', 403), card('diamonds', '6', 404)]];

    const s1 = fakeSocket('s1');
    const s2 = fakeSocket('s2');
    const io = fakeIo(new Map([['s1', s1], ['s2', s2]]));
    const handlers = new SocketHandlers(io, service);

    handlers.handleTakePozzetto(s1, {});

    const fullState = s1.events.find((e) => e.event === 'game_state_update')?.payload;
    expect(fullState).to.include.keys('yourPlayerIndex', 'currentPlayerIndex', 'discardPile', 'playerMelds', 'otherPlayersHandCounts');
    expect(fullState.yourHand).to.have.lengthOf(2);
    service.deleteRoom('poz');
    service.shutdown();
  });
});
