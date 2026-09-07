/* eslint-env mocha */

const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const { Card } = require('../../src/models/Deck');
const { GameRoomStatus } = require('../../src/constants');

const card = (suit, rank, cardId) => new Card(suit, rank, cardId);

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

function makeTeamRoom() {
  const service = new GameService();
  const room = service.createRoom('team-meld-contract', 4);
  const sockets = new Map();
  for (let i = 0; i < 4; i++) {
    const socket = fakeSocket(`s${i + 1}`);
    sockets.set(socket.id, socket);
    service.joinRoom(room.roomId, `p${i + 1}`, `User ${i + 1}`, socket.id);
  }
  room.status = GameRoomStatus.IN_PROGRESS;
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.ruleset = 'classic';
  room.cardsDealt = false;
  return { service, room, sockets };
}

describe('2v2 team meld wire contract', () => {
  it('routes an explicit multi-card add to the teammate owner and exposes all cards', () => {
    const { service, room, sockets } = makeTeamRoom();
    const six = card('hearts', '6', 601);
    room.playerHands.set('p1', [
      six,
      card('clubs', '9', 602),
      card('diamonds', 'K', 606),
    ]);
    room.playerMelds.set('p3', [[
      card('hearts', '3', 603),
      card('hearts', '4', 604),
      card('hearts', '5', 605),
    ]]);

    const io = fakeIo(sockets);
    const handlers = new SocketHandlers(io, service);
    handlers.handleAddToMeld(sockets.get('s1'), {
      targetPlayerIndex: 2,
      targetMeldIndex: 0,
      cards: [six.toJSON()],
    });

    const target = room.playerMelds.get('p3')[0];
    expect(target.map((entry) => entry.rank)).to.deep.equal(['3', '4', '5', '6']);
    expect(room.playerMelds.get('p1') || []).to.deep.equal([]);

    const added = io.roomEvents.find((event) => event.event === 'added_to_meld');
    expect(added.payload.targetPlayerIndex).to.equal(2);
    expect(added.payload.targetMeldIndex).to.equal(0);
    expect(added.payload.meldCards).to.have.lengthOf(4);

    const state = sockets.get('s1').events
      .filter((event) => event.event === 'game_state_update')
      .pop().payload;
    expect(state.playerMelds[2][0]).to.have.lengthOf(4);
  });

  it('assigns monotonic creation order across partners and sends every room setting', () => {
    const { service, room, sockets } = makeTeamRoom();
    room.name = 'Direct 30s Table';
    room.professionalWellMode = 'direct';
    room.turnTimeLimit = 30;
    room.targetScore = 1505;
    room.chatEnabled = false;
    room.visibility = 'private';
    room.hasPassword = true;
    room.bet = 1000000;

    room.playerHands.set('p1', [
      card('hearts', '3', 701),
      card('hearts', '4', 702),
      card('hearts', '5', 703),
      card('clubs', '9', 704),
      card('diamonds', 'K', 705),
    ]);
    expect(ActionHandlers.handlePlayMeld(room, 'p1', [
      { suit: 'hearts', rank: '3', cardId: 701 },
      { suit: 'hearts', rank: '4', cardId: 702 },
      { suit: 'hearts', rank: '5', cardId: 703 },
    ]).success).to.equal(true);

    room.currentTurn = 2;
    room.hasDrawnCard = true;
    room.playerHands.set('p3', [
      card('clubs', '3', 711),
      card('clubs', '4', 712),
      card('clubs', '5', 713),
      card('spades', '9', 714),
      card('diamonds', 'K', 715),
    ]);
    expect(ActionHandlers.handlePlayMeld(room, 'p3', [
      { suit: 'clubs', rank: '3', cardId: 711 },
      { suit: 'clubs', rank: '4', cardId: 712 },
      { suit: 'clubs', rank: '5', cardId: 713 },
    ]).success).to.equal(true);

    expect(room.playerMeldOrders.get('p1')).to.deep.equal([0]);
    expect(room.playerMeldOrders.get('p3')).to.deep.equal([1]);

    const handlers = new SocketHandlers(fakeIo(sockets), service);
    handlers._sendInitialGameState(room);
    const state = sockets.get('s1').events
      .filter((event) => event.event === 'game_state_update')
      .pop().payload;

    expect(state.playerMeldOrders).to.deep.include({ 0: [0], 2: [1] });
    expect(state).to.include({
      roomName: 'Direct 30s Table',
      professionalWellMode: 'direct',
      turnTimeLimitSeconds: 30,
      targetScore: 1505,
      chatEnabled: false,
      visibility: 'private',
      hasPassword: true,
      bet: 1000000,
    });
  });
});
