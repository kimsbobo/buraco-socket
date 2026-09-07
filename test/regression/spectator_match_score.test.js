/* eslint-env mocha */

/**
 * The match ledger has to ride EVERY state frame, not just the round-end one.
 *
 * REPORTED: "skor berikutnya malah kereset dari sisi spektator — round berikutnya
 * (game 1505 atau 2000) malah 0 dan deduction score kaga keliatan."
 *
 * `cumulativeTeamScores` was produced in exactly one place: the round-end result.
 * Anyone not listening at that instant — a spectator who joined mid-match, or one
 * whose board re-synced on the next deal — had no source for the running total,
 * so a match already past 1000 rendered as 0 with no deductions in sight.
 *
 * The client has always parsed the field off a state update; the server simply
 * never sent it there.
 */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

const fakeIo = () => ({ to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } });

function spectatorFrames(room, service) {
  const frames = [];
  const socket = {
    id: 'spec',
    emit: (event, payload) => frames.push({ event, payload }),
    join: () => {},
    leave: () => {},
    to: () => ({ emit: () => {} }),
  };
  const handlers = new SocketHandlers(fakeIo(), service);
  handlers._sendStateToSpectator(socket, room, 'u9', 'Nadia');
  return frames.filter((f) => f.event === 'game_state_update');
}

function dealtRoom(service, id, targetScore) {
  const room = service.createRoom(id, 2);
  service.joinRoom(id, 'p1', 'P1', 's1');
  service.joinRoom(id, 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  room.targetScore = targetScore;
  return room;
}

describe('#a spectator can read the match score at any moment', () => {
  it('carries the running ledger on an ordinary state frame', () => {
    const service = new GameService();
    const room = dealtRoom(service, 'ms1', 1505);
    room.cumulativeTeamScores = new Map([['0', 1015], ['1', 840]]);

    const [frame] = spectatorFrames(room, service);

    expect(frame.payload.cumulativeTeamScores).to.deep.equal({ '0': 1015, '1': 840 });
    expect(frame.payload.targetScore, 'and what it is measured against').to.equal(1505);
    service.deleteRoom('ms1');
  });

  it('OMITS the key before any round is banked, rather than sending zeros', () => {
    // An empty object would read to the client as an authoritative all-zero and
    // wipe a total it already had; an absent key means "no news, keep yours".
    const service = new GameService();
    const room = dealtRoom(service, 'ms2', 1505);
    room.cumulativeTeamScores = new Map();

    const [frame] = spectatorFrames(room, service);

    expect(frame.payload).to.not.have.property('cumulativeTeamScores');
    service.deleteRoom('ms2');
  });

  it('a seated player gets it on the same frame', () => {
    // Both boards read one ledger — they cannot be allowed to drift apart.
    const service = new GameService();
    const room = dealtRoom(service, 'ms3', 2000);
    room.cumulativeTeamScores = new Map([['0', 1200], ['1', 300]]);

    const handlers = new SocketHandlers(fakeIo(), service);
    const settings = handlers._serializeRoomGameSettings(room);

    expect(settings.cumulativeTeamScores).to.deep.equal({ '0': 1200, '1': 300 });
    expect(settings.targetScore).to.equal(2000);
    service.deleteRoom('ms3');
  });
});
