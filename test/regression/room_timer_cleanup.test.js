/**
 * Per-room timers (turn timer, deal-animation fallback, post-match finalize
 * cleanup) must never outlive their room. A leaked timer keeps the event loop
 * alive on shutdown and can fire a closure into a torn-down room. GameRoom now
 * centralizes cancellation in disposeTimers(), called by _deleteRoom and on
 * GameService.shutdown().
 */

const { expect } = require('chai');
const GameService = require('../../src/services/GameService');

function makeFakeHandle() {
  // setInterval returns a handle clearTimeout/clearInterval both accept; a
  // plain object is enough since we only assert it gets nulled, but use a real
  // (immediately-cleared) timer so clearTimeout/clearInterval are exercised.
  return setTimeout(() => {}, 60000);
}

describe('#room timer cleanup', () => {
  it('disposeTimers cancels and nulls every per-room timer handle', () => {
    const service = new GameService();
    const room = service.createRoom('rt1', 2);
    room.turnTimerHandle = makeFakeHandle();
    room.turnTimerTickHandle = makeFakeHandle();
    room.dealAnimationFallbackHandle = makeFakeHandle();
    room.finalizeCleanupHandle = makeFakeHandle();
    room.turnTimerDeadline = Date.now() + 60000;

    room.disposeTimers();

    expect(room.turnTimerHandle).to.equal(null);
    expect(room.turnTimerTickHandle).to.equal(null);
    expect(room.dealAnimationFallbackHandle).to.equal(null);
    expect(room.finalizeCleanupHandle).to.equal(null);
    expect(room.turnTimerDeadline).to.equal(null);

    service.shutdown();
  });

  it('is idempotent (safe to call twice)', () => {
    const service = new GameService();
    const room = service.createRoom('rt2', 2);
    room.turnTimerHandle = makeFakeHandle();
    room.disposeTimers();
    expect(() => room.disposeTimers()).to.not.throw();
    expect(room.turnTimerHandle).to.equal(null);
    service.shutdown();
  });

  it('deleteRoom disposes the room timers', () => {
    const service = new GameService();
    const room = service.createRoom('rt3', 2);
    room.turnTimerTickHandle = makeFakeHandle();
    room.finalizeCleanupHandle = makeFakeHandle();

    service.deleteRoom('rt3');

    expect(room.turnTimerTickHandle).to.equal(null);
    expect(room.finalizeCleanupHandle).to.equal(null);
    service.shutdown();
  });

  it('shutdown sweeps timers across all live rooms', () => {
    const service = new GameService();
    const a = service.createRoom('rt4a', 2);
    const b = service.createRoom('rt4b', 2);
    a.turnTimerHandle = makeFakeHandle();
    b.dealAnimationFallbackHandle = makeFakeHandle();

    service.shutdown();

    expect(a.turnTimerHandle).to.equal(null);
    expect(b.dealAnimationFallbackHandle).to.equal(null);
    // cleanup interval is cleared too
    expect(service.cleanupTimer).to.equal(null);
  });
});
