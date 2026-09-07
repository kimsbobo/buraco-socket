/* eslint-env mocha */

const http = require('http');
const { expect } = require('chai');
const PartnerWebhookRelay = require('../../src/integrations/PartnerWebhookRelay');
const FailureManager = require('../../src/managers/FailureManager');
const GameService = require('../../src/services/GameService');
const InMemoryRedis = require('../../src/utils/InMemoryRedis');
const { Card } = require('../../src/models/Deck');

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function fakeIo() {
  return {
    to: () => ({ emit() {} }),
    sockets: { sockets: new Map() },
  };
}

function startWebhookServer(statusCode, received) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({
        headers: req.headers,
        body: JSON.parse(body),
      });
      res.statusCode = statusCode;
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/webhook`,
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

describe('server restart and webhook recovery regression', () => {
  it('keeps failed partner webhook events in Redis and replays them after restart', async () => {
    const redis = new InMemoryRedis();
    const failedDeliveries = [];
    const failing = await startWebhookServer(500, failedDeliveries);

    const relay = new PartnerWebhookRelay({
      url: failing.url,
      retries: 0,
      backoffMs: 1,
      timeoutMs: 100,
      outboxTtlSeconds: 60,
    }, redis);

    relay.dispatch('game.completed', {
      roomId: 'room-outbox',
      winnerId: 'teamA',
      result: { winnerId: 'teamA' },
    });

    await waitFor(async () => (await redis.keys('partner_webhook:outbox:*')).length === 1);
    const [outboxKey] = await redis.keys('partner_webhook:outbox:*');
    const persistedEvent = JSON.parse(await redis.get(outboxKey));
    const persistedBody = JSON.parse(persistedEvent.rawBody);
    await closeServer(failing.server);

    const recoveredDeliveries = [];
    const healthy = await startWebhookServer(204, recoveredDeliveries);
    const restartedRelay = new PartnerWebhookRelay({
      url: healthy.url,
      retries: 0,
      backoffMs: 1,
      timeoutMs: 100,
      outboxTtlSeconds: 60,
    }, redis);

    const queued = await restartedRelay.recoverPending();
    expect(queued).to.equal(1);

    await waitFor(async () => recoveredDeliveries.length === 1);
    await waitFor(async () => (await redis.keys('partner_webhook:outbox:*')).length === 0);

    expect(persistedBody.event).to.equal('game.completed');
    expect(recoveredDeliveries[0].body.eventId).to.equal(persistedBody.eventId);
    expect(recoveredDeliveries[0].headers['x-sdk-event-id']).to.equal(persistedBody.eventId);

    await closeServer(healthy.server);
    await redis.quit();
  });

  it('persists and restores an in-progress room with card identities and player mappings', async () => {
    const redis = new InMemoryRedis();
    const service = new GameService();
    const failureManager = new FailureManager(fakeIo(), redis, service, silentLogger);

    service.createRoom('restart-room', 2);
    service.joinRoom('restart-room', 'p1', 'Alice', 's1');
    service.joinRoom('restart-room', 'p2', 'Bob', 's2');
    const room = service.getRoom('restart-room');
    room.startGame();
    room.dealCards();
    room.currentTurn = 1;
    room.hasDrawnCard = true;
    room.name = 'Direct 30s Table';
    room.professionalWellMode = 'direct';
    room.targetScore = 1505;
    room.chatEnabled = false;
    room.visibility = 'private';
    room.hasPassword = true;
    room.bet = 1000000;
    room.turnTimeLimit = 30;
    room.turnTimeRemaining = 0;
    room.playerMelds.set('p1', [[new Card('hearts', '3', 9001), new Card('hearts', '4', 9002), new Card('hearts', '5', 9003)]]);
    room.playerMeldOrders.set('p1', [7]);
    room.nextMeldOrder = 8;
    const p1HandIds = room.playerHands.get('p1').map((card) => card.cardId);

    await failureManager.persistGameState(room);

    const restartedService = new GameService();
    const restartedFailureManager = new FailureManager(fakeIo(), redis, restartedService, silentLogger);
    const restoredCount = await restartedFailureManager.loadPersistedGames();
    const restored = restartedService.getRoom('restart-room');

    expect(restoredCount).to.equal(1);
    expect(restored).to.exist;
    expect(restored.currentTurn).to.equal(1);
    expect(restored.hasDrawnCard).to.equal(true);
    expect(restored.name).to.equal('Direct 30s Table');
    expect(restored.professionalWellMode).to.equal('direct');
    expect(restored.targetScore).to.equal(1505);
    expect(restored.chatEnabled).to.equal(false);
    expect(restored.visibility).to.equal('private');
    expect(restored.hasPassword).to.equal(true);
    expect(restored.bet).to.equal(1000000);
    expect(restored.turnTimeLimit).to.equal(30);
    expect(restored.turnTimeRemaining).to.equal(0);
    expect(restartedService.getPlayerRoom('p1')).to.equal(restored);
    expect(restored.playerHands.get('p1').map((card) => card.cardId)).to.deep.equal(p1HandIds);
    expect(restored.playerMelds.get('p1')[0].map((card) => card.cardId)).to.deep.equal([9001, 9002, 9003]);
    expect(restored.playerMeldOrders.get('p1')).to.deep.equal([7]);
    expect(restored.nextMeldOrder).to.equal(8);

    failureManager.dispose();
    restartedFailureManager.dispose();
    service.shutdown();
    restartedService.shutdown();
    await redis.quit();
  });
});
