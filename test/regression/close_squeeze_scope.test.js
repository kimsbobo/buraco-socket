/* eslint-env mocha */

/**
 * THE SQUEEZE — hand==1 versus a ONE-card discard pile: the one spot where a
 * professional player may not take the pile and must draw from the deck instead.
 *
 * There used to be an OPTION here ("makart") whose only surviving effect was to
 * let a hand inside that squeeze close with ZERO close requirements — no
 * Brazilia, well not taken — which finalized rounds with the pozzetto still on
 * the table. The option is gone and so is the bypass: the squeeze now enforces
 * exactly the same close rules as every other position.
 *
 * These tests pin that, so nobody reintroduces a requirement-free close by the
 * back door. Removing the bypass wedges nothing, because the guard that blocks
 * the pile take only ever fires while a deck draw is still possible (it suspends
 * itself on a dead stock — see deck_out_stuck.test.js).
 */

const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');
const GameService = require('../../src/services/GameService');
const { Deck } = require('../../src/models/Deck');

const card = (suit, rank) => ({ suit, rank });

// PRO room in the squeeze: p1 holds ONE card, team has NO brazilia, wells untaken.
function makeSqueezeRoom(service, { pileLen }) {
  const room = service.createRoom('close-squeeze', 2);
  service.joinRoom('close-squeeze', 'p1', 'P1', 's1');
  service.joinRoom('close-squeeze', 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();

  room.ruleset = 'professional';
  room.professionalWellMode = 'indirect';
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.deck = new Deck();
  room.deck.cards = [card('clubs', 'K')]; // stock alive — bypass must not depend on it
  room.discardPile = Array.from({ length: pileLen }, (_, i) => card('diamonds', String(i + 4)));
  room.playerHands.set('p1', [card('hearts', '5')]);
  room.playerMelds.set('p1', []); // no brazilia
  room.playerMelds.set('p2', []);
  return room;
}

describe('#the squeeze (hand==1 && pile==1) has NO close bypass', () => {
  afterEach(function cleanup() {
    if (this.currentService) {
      this.currentService.deleteRoom('close-squeeze');
      this.currentService = null;
    }
  });

  it('enforces the normal close rules INSIDE the squeeze (pile == 1)', function () {
    // This is the case the removed option used to wave through. A side with no
    // brazilia and an untaken well may not go out here any more than anywhere
    // else — the old bypass ended rounds with the pozzetto still on the table.
    const service = new GameService();
    this.currentService = service;
    const room = makeSqueezeRoom(service, { pileLen: 1 });

    const v = GameValidator.validateDiscard(room, 'p1', card('hearts', '5'));
    expect(v.isValid).to.equal(false);
    expect(v.reason).to.equal('mustTakeWell');
  });

  it('enforces the normal close rules OUTSIDE the squeeze (pile > 1): well not taken → mustTakeWell', function () {
    const service = new GameService();
    this.currentService = service;
    const room = makeSqueezeRoom(service, { pileLen: 2 });

    const v = GameValidator.validateDiscard(room, 'p1', card('hearts', '5'));
    expect(v.isValid).to.equal(false);
    expect(v.reason).to.equal('mustTakeWell');
  });

  it('still requires a Brazilia outside the squeeze once the wells are gone', function () {
    const service = new GameService();
    this.currentService = service;
    const room = makeSqueezeRoom(service, { pileLen: 3 });
    room.deadPiles = [[], []]; // both wells consumed
    room.playerHasTakenPozzetto.set('p1', true);

    const v = GameValidator.validateDiscard(room, 'p1', card('hearts', '5'));
    expect(v.isValid).to.equal(false);
    expect(v.reason).to.equal('noBrazilia');
  });

  it('classic close rules hold inside the squeeze too', function () {
    const service = new GameService();
    this.currentService = service;
    const room = makeSqueezeRoom(service, { pileLen: 1 });
    room.ruleset = 'classic';
    // Wells consumed so this is a genuine CLOSE (an available well would make
    // the discard a legal auto-take continuation instead).
    room.deadPiles = [[], []];
    room.playerHasTakenPozzetto.set('p1', true);
    room.playerDeadPileCount.set('p1', 1);
    room.playerHands.set('p1', [card('hearts', '2')]); // classic: cannot close on a wild

    const v = GameValidator.validateDiscard(room, 'p1', card('hearts', '2'));
    expect(v.isValid).to.equal(false);
    expect(v.reason).to.equal('invalidClose');
  });
});
