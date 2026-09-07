/**
 * "Pemenang harusnya yang pertama kali jalan (jadi ga perlu undian lagi untuk
 * memulai game berikutnya)… saat start otomatis jalan dengan skor terbanyak"
 * — product decision 2026-08-27.
 *
 * The high-card draw belongs to the start of a MATCH. From round 2 on, leading
 * the scoreboard is what earns the first move, and no ceremony plays.
 *
 * Note what this reverses: two days earlier the report was the opposite — that
 * the previous winner always started and there should be a draw. The draw was
 * running correctly all along; what was broken was the pre-deal GAME_STARTED
 * announcing seat 0 (fixed in bd06795). With that gone, this is a clean product
 * change rather than a fix.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');

function fakeSocket(id, emitted) {
  return {
    id,
    join: () => {},
    leave: () => {},
    emit: (event, payload) => emitted.push({ scope: 'socket', id, event, payload }),
    to: () => ({ emit: () => {} }),
  };
}
function fakeIo(emitted, registry) {
  return {
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ scope: 'room', roomId, event, payload }),
    }),
    sockets: { sockets: registry },
  };
}

describe('multi-round — the leader starts, and the undian does not replay', () => {
  const services = [];
  let emitted;
  let registry;
  let handlers;
  let service;
  let origFetch;

  beforeEach(() => {
    origFetch = global.fetch;
    global.fetch = () => Promise.resolve({ ok: true });
    emitted = [];
    registry = new Map();
    for (const s of ['s10', 's20', 's30', 's40']) {
      registry.set(s, fakeSocket(s, emitted));
    }
    service = new GameService();
    services.push(service);
    handlers = new SocketHandlers(fakeIo(emitted, registry), service);
  });

  afterEach(() => {
    global.fetch = origFetch;
    while (services.length > 0) services.pop().shutdown();
  });

  function room2p(roomId) {
    const room = service.createRoom(roomId, 2);
    service.joinRoom(roomId, '10', 'A', 's10'); // seat 0 -> teamA
    service.joinRoom(roomId, '20', 'B', 's20'); // seat 1 -> teamB
    return room;
  }

  function room4p(roomId) {
    const room = service.createRoom(roomId, 4);
    service.joinRoom(roomId, '10', 'A', 's10'); // seat 0 -> teamA
    service.joinRoom(roomId, '20', 'B', 's20'); // seat 1 -> teamB
    service.joinRoom(roomId, '30', 'C', 's30'); // seat 2 -> teamA
    service.joinRoom(roomId, '40', 'D', 's40'); // seat 3 -> teamB
    return room;
  }

  /** Deal round 1 the way the real start path does. */
  function dealRound1(room) {
    room.startGame(true);
    handlers._dealCardsForRoom(room, 'test round 1');
  }

  /** Reset to a fresh deal and run the round-2 deal. */
  function dealNextRound(room) {
    room.startGame(true);
    handlers._dealCardsForRoom(room, 'test next round');
  }

  it('round 1 still runs the draw and ships the reveal', () => {
    const room = room2p('lead1');
    dealRound1(room);

    expect(room.roundNumber).to.equal(1);
    expect(room.firstTurnDraw, 'round 1 must still animate').to.not.equal(null);
    expect(room.currentTurn).to.equal(room.firstTurnDraw.winnerIndex);
  });

  it('round 2 starts with the leading side and animates nothing', () => {
    const room = room2p('lead2');
    dealRound1(room);

    // teamB (seat 1) is ahead, and seat 1 closed the round.
    room.cumulativeTeamScores = new Map([['teamA', 120], ['teamB', 480]]);
    room.lastRoundWinnerIndex = 1;
    dealNextRound(room);

    expect(room.roundNumber).to.equal(2);
    expect(room.currentTurn).to.equal(1);
    expect(room.firstTurnDraw, 'no ceremony from round 2 on').to.equal(null);
    // Play still proceeds clockwise from whoever starts.
    expect(room.turnOrder).to.deep.equal([1, 0]);
  });

  it('the leading side starts even when the OTHER side closed the round', () => {
    const room = room2p('lead3');
    dealRound1(room);
    // teamA leads on the match, but teamB took the last round.
    room.cumulativeTeamScores = new Map([['teamA', 900], ['teamB', 300]]);
    room.lastRoundWinnerIndex = 1;
    dealNextRound(room);

    expect(room.currentTurn).to.equal(0);
  });

  it('2v2: the partner who CLOSED the round starts, not the lower seat', () => {
    const room = room4p('lead4');
    dealRound1(room);
    // teamA (seats 0 and 2) leads; seat 2 is the one who went out.
    room.cumulativeTeamScores = new Map([['teamA', 700], ['teamB', 200]]);
    room.lastRoundWinnerIndex = 2;
    dealNextRound(room);

    expect(room.currentTurn).to.equal(2);
    expect(room.turnOrder).to.deep.equal([2, 3, 0, 1]);
  });

  it('2v2: with no batida to honour it falls to the leading side\'s lower seat', () => {
    const room = room4p('lead5');
    dealRound1(room);
    // A deck-out round: nobody closed it.
    room.cumulativeTeamScores = new Map([['teamA', 200], ['teamB', 640]]);
    room.lastRoundWinnerIndex = null;
    dealNextRound(room);

    expect(room.currentTurn).to.equal(1); // teamB's seats are 1 and 3
  });

  it('level sides fall back to the draw — the one case it still earns', () => {
    const room = room2p('lead6');
    dealRound1(room);
    room.cumulativeTeamScores = new Map([['teamA', 350], ['teamB', 350]]);
    room.lastRoundWinnerIndex = 0;
    dealNextRound(room);

    expect(room.firstTurnDraw, 'nobody is ahead, so the draw decides').to.not.equal(null);
    expect(room.currentTurn).to.equal(room.firstTurnDraw.winnerIndex);
  });
});
