/**
 * Items 7/8 (supersedes PTW-235 grace-pause): a player who backgrounds the app
 * (socket disconnect) on THEIR turn keeps a reconnectable seat. The seat is NOT
 * paused/held and is NOT bot-converted. The turn timer keeps running; when it
 * expires on a disconnected seat the turn is skipped and a consecutive
 * "inactive turn" is accrued, and at MAX consecutive inactives the game ends
 * with the active player as winner. Reconnecting before that restores normal
 * human play and resets the counter on the first manual action.
 *
 * This test covers the disconnect ENTRY + reconnect: entering grace must not
 * advance the turn, auto-draw, bot-convert, or pause the timer; reconnect must
 * restore the human seat.
 */

const { expect } = require('chai');
const FailureManager = require('../../src/managers/FailureManager');
const GameService = require('../../src/services/GameService');

const noopLogger = { info() {}, warn() {}, debug() {}, error() {} };

// Minimal in-memory Redis mock covering the calls FailureManager makes.
function fakeRedis() {
  const store = new Map();
  return {
    store,
    async setex(key, _ttl, val) { store.set(key, val); },
    async set(key, val) { store.set(key, val); },
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async del(key) { store.delete(key); },
    async exists(key) { return store.has(key) ? 1 : 0; },
    async keys() { return Array.from(store.keys()); },
  };
}

// Capture turn-timer pause/resume + count emits without a live SocketHandlers.
function harness() {
  const emits = [];
  const io = { to: () => ({ emit: (event, payload) => emits.push({ event, payload }) }) };
  const redis = fakeRedis();
  const service = new GameService();
  const manager = new FailureManager(io, redis, service, noopLogger);

  const timerCalls = { pause: 0, resume: 0 };
  manager.turnTimerControl = {
    pause: () => { timerCalls.pause += 1; },
    resume: () => { timerCalls.resume += 1; },
  };

  return { emits, redis, service, manager, timerCalls };
}

function startedRoom(service) {
  const room = service.createRoom('grace', 2);
  service.joinRoom('grace', 'p1', 'P1', 's-p1');
  service.joinRoom('grace', 'p2', 'P2', 's-p2');
  room.startGame();
  room.dealCards();
  room.currentTurn = 0; // p1's turn
  room.phase = 'draw';
  room.hasDrawnCard = false;
  return room;
}

describe('#PTW-235 grace reconnect keeps seat human (no auto-skip)', () => {
  it('disconnect on own turn does NOT advance turn or auto-draw, and keeps the timer running', async () => {
    const { manager, service, timerCalls, emits } = harness();
    const room = startedRoom(service);
    const handBefore = (room.playerHands.get('p1') || []).length;

    await manager.handlePlayerDisconnection({ id: 's-p1' }, 'p1', 'grace');

    // Turn is HELD, not skipped.
    expect(room.currentTurn).to.equal(0);
    // No auto-draw stole the turn.
    expect((room.playerHands.get('p1') || []).length).to.equal(handBefore);
    // Seat still human — not bot-converted.
    const p1 = room.getPlayer('p1');
    expect(p1.isBot).to.equal(false);
    // Item 8: the timer is NOT paused — it keeps running so the disconnected
    // seat accrues inactive turns toward the inactivity forfeit.
    expect(timerCalls.pause).to.equal(0);
    // No turn_skipped emitted.
    expect(emits.find((e) => e.event === 'turn_skipped')).to.equal(undefined);

    manager.dispose();
    service.deleteRoom('grace');
  });

  it('reconnect within grace restores the seat to human and resumes the timer (turn not advanced)', async () => {
    const { manager, service, redis, timerCalls } = harness();
    const room = startedRoom(service);

    // Seed the previous session so reconnection validates identity.
    await redis.setex(
      'session:s-p1',
      7200,
      JSON.stringify({ userId: 'p1', roomId: 'grace', userName: 'P1' })
    );

    // Disconnect (enters grace, pauses timer).
    await manager.handlePlayerDisconnection({ id: 's-p1' }, 'p1', 'grace');
    expect(room.getPlayer('p1').isConnected).to.equal(false);

    // Reconnect before grace expiry with a new socket id.
    const newSocket = { id: 's-p1-new', emit() {}, join() {} };
    const result = await manager.handlePlayerConnection(newSocket, {
      userId: 'p1',
      roomId: 'grace',
      previousSocketId: 's-p1',
      userName: 'P1',
    });

    expect(result).to.deep.include({ success: true, isReconnection: true });

    const p1 = room.getPlayer('p1');
    expect(p1.isBot).to.equal(false);
    expect(p1.isConnected).to.equal(true);
    expect(p1.status).to.equal('connected');
    // Turn still owned by the returning human.
    expect(room.currentTurn).to.equal(0);
    // Timer was re-armed for the restored turn.
    expect(timerCalls.resume).to.equal(1);
    // Grace marker cleared so expiry can't later bot-convert a present player.
    expect(await redis.exists('grace:p1:grace')).to.equal(0);

    manager.dispose();
    service.deleteRoom('grace');
  });
});
