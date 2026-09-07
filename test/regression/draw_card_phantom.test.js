/**
 * draw_card with {fromDeck:false} used to "succeed" — emitting CARD_DRAWN and
 * marking the player active — but NEVER moved a card or set hasDrawnCard (the
 * mutation was gated on `fromDeck`). The turn then could not complete (discard
 * rejected: "must draw first") and hung until the timer. Pile pickup is a
 * separate action (pick_up_pile), so draw_card must reject !fromDeck cleanly.
 */

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const { SocketEvents } = require('../../src/constants');

function fakeIo(reg) {
  return { to: () => ({ emit: () => {} }), sockets: { sockets: reg } };
}
function fakeSocket(id, emitted) {
  return {
    id,
    emit: (event, payload) => emitted.push({ event, payload }),
    join: () => {},
    leave: () => {},
    to: () => ({ emit: () => {} }),
  };
}

describe('#draw_card phantom pile-draw', () => {
  function setup() {
    const service = new GameService();
    const room = service.createRoom('draw', 2);
    service.joinRoom('draw', 'p1', 'P1', 's1');
    service.joinRoom('draw', 'p2', 'P2', 's2');
    room.startGame();
    room.dealCards();
    room.currentTurn = 0;
    room.hasDrawnCard = false;
    const reg = new Map();
    const emitted = [];
    reg.set('s1', fakeSocket('s1', emitted));
    reg.set('s2', fakeSocket('s2', emitted));
    const handlers = new SocketHandlers(fakeIo(reg), service);
    handlers._stopTurnTimer(room);
    return { service, room, handlers, emitted, s1: reg.get('s1') };
  }

  it('rejects fromDeck:false without a phantom draw (no CARD_DRAWN, hasDrawnCard stays false)', () => {
    const { service, room, handlers, emitted, s1 } = setup();

    handlers.handleDrawCard(s1, { fromDeck: false });

    const err = emitted.find((e) => e.event === SocketEvents.ERROR);
    const drawn = emitted.find((e) => e.event === SocketEvents.CARD_DRAWN);
    expect(err, 'should emit an ERROR').to.not.equal(undefined);
    expect(drawn, 'must NOT emit CARD_DRAWN for a phantom pile-draw').to.equal(undefined);
    expect(room.hasDrawnCard).to.equal(false);

    service.deleteRoom('draw');
  });

  it('still allows a real fromDeck:true draw (CARD_DRAWN + hasDrawnCard true)', () => {
    const { service, room, handlers, emitted, s1 } = setup();
    const before = room.playerHands.get('p1') || [];
    const beforeLength = before.length;
    const beforeIds = before.map((card) => card.cardId);

    handlers.handleDrawCard(s1, { fromDeck: true });

    const drawn = emitted.find((e) => e.event === SocketEvents.CARD_DRAWN);
    const after = room.playerHands.get('p1') || [];
    expect(drawn, 'should emit CARD_DRAWN').to.not.equal(undefined);
    expect(room.hasDrawnCard).to.equal(true);
    expect(after).to.have.lengthOf(beforeLength + 1);
    expect(after.slice(0, beforeLength).map((card) => card.cardId)).to.deep.equal(beforeIds);
    expect(after[after.length - 1].cardId).to.equal(drawn.payload.card.cardId);

    service.deleteRoom('draw');
  });

  it('appends a picked discard pile after the existing hand', () => {
    const { service, room, handlers, s1 } = setup();
    const before = room.playerHands.get('p1') || [];
    const beforeLength = before.length;
    const beforeIds = before.map((card) => card.cardId);
    const picked = room.deck.draw();
    room.discardPile = [picked];
    room.hasDrawnCard = false;

    handlers.handlePickUpPile(s1, {});

    const after = room.playerHands.get('p1') || [];
    expect(after).to.have.lengthOf(beforeLength + 1);
    expect(after.slice(0, beforeLength).map((card) => card.cardId)).to.deep.equal(beforeIds);
    expect(after[after.length - 1].cardId).to.equal(picked.cardId);
    expect(room.discardPile).to.be.empty;

    service.deleteRoom('draw');
  });
});
