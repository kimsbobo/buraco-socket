/**
 * Tests for RoomOwnerLease (PTW-43, Phase 2) — the per-room single-owner
 * guard that prevents split-brain room mutation across a multi-node cluster.
 *
 * Two nodes share ONE InMemoryRedis instance to simulate a shared Redis. The
 * in-memory fallback exercises the get-then-act path (no `eval`); the same
 * module uses atomic Lua on a real Redis in production.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const InMemoryRedis = require('../src/utils/InMemoryRedis');
const RoomOwnerLease = require('../src/managers/RoomOwnerLease');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RoomOwnerLease', () => {
  let redis;
  let nodeA;
  let nodeB;

  beforeEach(() => {
    redis = new InMemoryRedis();
    nodeA = new RoomOwnerLease(redis, 'node-A', { ttlMs: 200 });
    nodeB = new RoomOwnerLease(redis, 'node-B', { ttlMs: 200 });
  });

  afterEach(async () => {
    await redis.quit();
  });

  it('grants the lease to exactly one node under contention', async () => {
    const [aWon, bWon] = await Promise.all([nodeA.acquire('r1'), nodeB.acquire('r1')]);
    // Exactly one acquires; the other must report not-owned.
    expect([aWon, bWon].filter(Boolean)).to.have.lengthOf(1);
    expect(await nodeA.isOwner('r1')).to.equal(aWon);
    expect(await nodeB.isOwner('r1')).to.equal(bWon);
  });

  it('re-acquire by the current owner is idempotent (true)', async () => {
    expect(await nodeA.acquire('r1')).to.equal(true);
    expect(await nodeA.acquire('r1')).to.equal(true);
    expect(await nodeB.acquire('r1')).to.equal(false);
  });

  it('owner can renew; non-owner cannot', async () => {
    await nodeA.acquire('r1');
    expect(await nodeA.renew('r1')).to.equal(true);
    expect(await nodeB.renew('r1')).to.equal(false);
    expect(await nodeA.getOwner('r1')).to.equal('node-A');
  });

  it('only the owner can release (compare-and-del); then another node can take over', async () => {
    await nodeA.acquire('r1');
    expect(await nodeB.release('r1')).to.equal(false); // B must not steal A's lease
    expect(await nodeA.isOwner('r1')).to.equal(true);
    expect(await nodeA.release('r1')).to.equal(true);
    expect(await nodeA.getOwner('r1')).to.equal(null);
    expect(await nodeB.acquire('r1')).to.equal(true);
  });

  it('lease expires after TTL so a dead owner does not freeze the room', async () => {
    expect(await nodeA.acquire('r1')).to.equal(true);
    // node-A "dies" — stops renewing. After the TTL the lease must be free.
    await delay(260);
    expect(await nodeA.getOwner('r1')).to.equal(null);
    expect(await nodeB.acquire('r1')).to.equal(true);
    expect(await nodeB.isOwner('r1')).to.equal(true);
  });

  it('renew keeps the lease alive past the original TTL', async () => {
    await nodeA.acquire('r1');
    await delay(120);
    expect(await nodeA.renew('r1')).to.equal(true);
    await delay(120); // total > ttl, but renew reset it
    expect(await nodeA.isOwner('r1')).to.equal(true);
  });

  it('uses room:{id}:owner key shape from the scaling plan', () => {
    expect(nodeA.key('abc')).to.equal('room:abc:owner');
  });
});
