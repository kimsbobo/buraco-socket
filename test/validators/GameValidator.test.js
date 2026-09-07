/**
 * GameValidator Tests
 * Unit tests for server-side game validation
 */

const { expect } = require('chai');
const { GameValidator } = require('../../src/validators');
const { GameRoom, PlayerSession } = require('../../src/models');
const { GameRoomStatus } = require('../../src/constants');
const { Card } = require('../../src/models/Deck');

describe('GameValidator', () => {
  describe('Turn Validation', () => {
    it('should validate correct turn', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.currentTurn = 0;

      const result = GameValidator.validateTurn(room, 'p1');

      expect(result.isValid).to.be.true;
    });

    it('should reject wrong turn', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.currentTurn = 0;

      const result = GameValidator.validateTurn(room, 'p2');

      expect(result.isValid).to.be.false;
      expect(result.error).to.include('Not your turn');
    });

    it('should reject if game not in progress', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.status = GameRoomStatus.WAITING;

      const result = GameValidator.validateTurn(room, 'p1');

      expect(result.isValid).to.be.false;
      expect(result.error).to.include('not in progress');
    });
  });

  describe('Draw Card Validation', () => {
    it('should allow drawing from deck', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.currentTurn = 0;
      room.hasDrawnCard = false;

      const result = GameValidator.validateDrawCard(room, 'p1', true);

      expect(result.isValid).to.be.true;
    });

    it('should reject multiple draws', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.currentTurn = 0;
      room.hasDrawnCard = true; // Already drawn

      const result = GameValidator.validateDrawCard(room, 'p1', true);

      expect(result.isValid).to.be.false;
      expect(result.error).to.include('already drawn');
    });

    it('should reject drawing from empty deck', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.deck.cards = []; // Empty deck
      room.currentTurn = 0;

      const result = GameValidator.validateDrawCard(room, 'p1', true);

      expect(result.isValid).to.be.false;
      expect(result.error).to.include('empty');
    });
  });

  describe('Meld Validation', () => {
    it('should validate correct sequence', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.currentTurn = 0;

      room.hasDrawnCard = true;
      const cards = [
        { suit: 'hearts', rank: '3' },
        { suit: 'hearts', rank: '4' },
        { suit: 'hearts', rank: '5' },
      ];
      room.playerHands.set('p1', cards);

      const result = GameValidator.validateMeld(room, 'p1', cards);

      expect(result.isValid).to.be.true;
    });

    it('should validate correct set', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.currentTurn = 0;

      room.hasDrawnCard = true;
      const cards = [
        { suit: 'hearts', rank: 'K' },
        { suit: 'diamonds', rank: 'K' },
        { suit: 'clubs', rank: 'K' },
      ];
      room.playerHands.set('p1', cards);

      const result = GameValidator.validateMeld(room, 'p1', cards);

      expect(result.isValid).to.be.true;
    });

    it('should reject meld with less than 3 cards', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.currentTurn = 0;

      room.hasDrawnCard = true;
      const cards = [
        { suit: 'hearts', rank: '3' },
        { suit: 'hearts', rank: '4' },
      ];
      room.playerHands.set('p1', cards);

      const result = GameValidator.validateMeld(room, 'p1', cards);

      expect(result.isValid).to.be.false;
      expect(result.error).to.include('at least 3 cards');
    });

    it('should reject invalid sequence', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.currentTurn = 0;

      room.hasDrawnCard = true;
      const cards = [
        { suit: 'hearts', rank: '3' },
        { suit: 'hearts', rank: '5' }, // Gap!
        { suit: 'hearts', rank: '6' },
      ];
      room.playerHands.set('p1', cards);

      const result = GameValidator.validateMeld(room, 'p1', cards);

      expect(result.isValid).to.be.false;
    });
  });

  describe('Discard Validation', () => {
    it('should allow valid discard', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.currentTurn = 0;
      room.hasDrawnCard = true;

      const card = room.playerHands.get('p1')[0];
      const result = GameValidator.validateDiscard(room, 'p1', card);

      expect(result.isValid).to.be.true;
    });

    it('should reject discard before drawing', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.currentTurn = 0;
      room.hasDrawnCard = false; // Not drawn

      const card = room.playerHands.get('p1')[0];
      const result = GameValidator.validateDiscard(room, 'p1', card);

      expect(result.isValid).to.be.false;
      expect(result.error).to.include('must draw');
    });

    it('should reject card not in hand', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.currentTurn = 0;
      room.hasDrawnCard = true;

      // Deterministic hand that definitely does NOT contain the fake card.
      // (Relying on the random deal made this flaky: ~sometimes the dealt hand
      // actually held the Ace of hearts, so the "not in hand" rejection failed.)
      room.playerHands.set('p1', [
        { suit: 'spades', rank: '7' },
        { suit: 'clubs', rank: '8' },
      ]);

      const fakeCard = { suit: 'hearts', rank: 'A' };
      const result = GameValidator.validateDiscard(room, 'p1', fakeCard);

      expect(result.isValid).to.be.false;
      expect(result.error).to.include('not found in hand');
    });
  });

  describe('Pozzetto (Dead Pile) Validation', () => {
    it('should allow taking pozzetto with empty hand', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.currentTurn = 0;
      room.playerHands.set('p1', []); // Empty hand
      room.playerMelds.set('p1', [
        // Add a brazilia
        Array(7).fill({ suit: 'hearts', rank: '3' }),
      ]);

      const result = GameValidator.validateTakePozzetto(room, 'p1');

      expect(result.isValid).to.be.true;
    });

    it('should reject taking pozzetto with non-empty hand', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.currentTurn = 0;
      // Hand has cards

      const result = GameValidator.validateTakePozzetto(room, 'p1');

      expect(result.isValid).to.be.false;
      expect(result.error).to.include('Hand must be empty');
    });

    it('should reject taking pozzetto without brazilia in professional mode', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.ruleset = 'professional';
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.currentTurn = 0;
      room.playerHands.set('p1', []); // Empty hand
      room.playerMelds.set('p1', []); // No melds

      const result = GameValidator.validateTakePozzetto(room, 'p1');

      expect(result.isValid).to.be.false;
      expect(result.error).to.include('Brazilia');
    });

    it('should reject taking more wells than allowed', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.currentTurn = 0;
      room.playerHands.set('p1', []); // Empty hand
      room.playerDeadPileCount.set('p1', 2); // Already took BOTH wells (the cap)
      room.ruleset = 'classic'; // House rule: up to 2 wells per team

      const result = GameValidator.validateTakePozzetto(room, 'p1');

      expect(result.isValid).to.be.false;
      expect(result.error).to.include('already taken');
    });
  });

  describe('Victory Conditions', () => {
    it('should require brazilia to go out in classic mode', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.ruleset = 'classic';
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.currentTurn = 0;
      room.hasDrawnCard = true;
      room.playerHasTakenPozzetto.set('p1', true);
      room.playerDeadPileCount.set('p1', 2);
      // Both wells already gone, so emptying the hand is a GO-OUT (not another
      // well take) — the close then requires a Brazilia.
      room.deadPiles = [];

      // Set hand to 1 safe card (will be empty after discard)
      const lastCard = { suit: 'hearts', rank: '3' };
      room.playerHands.set('p1', [lastCard]);

      // No brazilia
      room.playerMelds.set('p1', [
        [{ suit: 'hearts', rank: '3' }],
      ]);

      const result = GameValidator.validateDiscard(room, 'p1', lastCard);

      expect(result.isValid).to.be.false;
      expect(result.error).to.include('Brazilia');
    });

    it('should allow going out with brazilia and pozzetto taken', () => {
      const room = new GameRoom({ roomId: 'test', maxPlayers: 2 });
      room.ruleset = 'classic';
      room.addPlayer(new PlayerSession({
        playerId: 'p1',
        playerName: 'Alice',
        playerIndex: 0,
        socketId: 's1',
      }));
      room.addPlayer(new PlayerSession({
        playerId: 'p2',
        playerName: 'Bob',
        playerIndex: 1,
        socketId: 's2',
      }));
      room.startGame();
      room.dealCards();
      room.currentTurn = 0;
      room.hasDrawnCard = true;
      room.playerHasTakenPozzetto.set('p1', true);
      room.deadPiles = []; // No pozzetto available

      // Use a fixed, safe card to close with. Picking the first DEALT card was
      // non-deterministic: ~9% of deals it was a 2/joker, which the closing rule
      // legitimately rejects, making this test flaky (S-L7). A 5 is always a
      // valid card to discard when going out.
      const lastCard = { suit: 'spades', rank: '5' };
      room.playerHands.set('p1', [lastCard]);

      // Has brazilia
      room.playerMelds.set('p1', [
        Array(7).fill({ suit: 'hearts', rank: '3' }),
      ]);

      const result = GameValidator.validateDiscard(room, 'p1', lastCard);

      expect(result.isValid).to.be.true;
    });
  });
});
