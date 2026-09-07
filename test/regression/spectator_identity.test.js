/* eslint-env mocha */

/**
 * The spectator roster shows WHO is watching — name and face.
 *
 * REPORTED: "the spectator list should show the photo and the name; right now it
 * only says Spectator, not the user who is watching."
 *
 * The list itself was fine, and so was the join path. What leaked was the two
 * SEAT-TO-STANDS transitions: a player stepping down, and the host moving
 * someone to the stands. Both carried the name across and dropped the avatar, so
 * the person reappeared in the roster faceless — and `_addSpectator` defaults a
 * missing name to the literal string 'Spectator'.
 */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function fakeIo(emitted, registry) {
  return {
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ roomId, event, payload }),
    }),
    sockets: { sockets: registry },
  };
}
const fakeSocket = (id) => ({
  id,
  emit: () => {},
  join: () => {},
  leave: () => {},
  to: () => ({ emit: () => {} }),
});

describe('#the spectator roster keeps name AND face', () => {
  it('carries both through a normal spectator join', () => {
    const service = new GameService();
    const room = service.createRoom('spec', 2);
    const emitted = [];
    const registry = new Map([['s9', fakeSocket('s9')]]);
    const handlers = new SocketHandlers(fakeIo(emitted, registry), service);

    handlers._addSpectator(
      registry.get('s9'),
      room.roomId,
      'u9',
      'Nadia',
      'https://cdn/photo.jpg'
    );
    handlers._broadcastSpectatorsChanged(room.roomId);

    const list = emitted.filter((e) => e.event === 'spectators_changed').pop();
    expect(list.payload.spectators[0]).to.deep.equal({
      spectatorId: 'u9',
      spectatorName: 'Nadia',
      avatarUrl: 'https://cdn/photo.jpg',
    });
    service.deleteRoom('spec');
  });

  it('a NAMELESS join is the only thing that should ever read "Spectator"', () => {
    const service = new GameService();
    const room = service.createRoom('spec2', 2);
    const emitted = [];
    const registry = new Map([['s8', fakeSocket('s8')]]);
    const handlers = new SocketHandlers(fakeIo(emitted, registry), service);

    handlers._addSpectator(registry.get('s8'), room.roomId, 'u8', null, null);
    handlers._broadcastSpectatorsChanged(room.roomId);

    const list = emitted.filter((e) => e.event === 'spectators_changed').pop();
    expect(list.payload.spectators[0].spectatorName).to.equal('Spectator');
    service.deleteRoom('spec2');
  });

  it('a seat stepping down into the stands keeps its face', () => {
    // The leak: the seat knew the avatar, the roster entry did not.
    const service = new GameService();
    const room = service.createRoom('spec3', 2);
    service.joinRoom('spec3', 'u1', 'Host', 's1');
    service.joinRoom('spec3', 'u2', 'Nadia', 's2');
    const seat = room.getPlayer('u2');
    seat.avatarUrl = 'https://cdn/nadia.jpg';

    const emitted = [];
    const registry = new Map([['s2', fakeSocket('s2')]]);
    const handlers = new SocketHandlers(fakeIo(emitted, registry), service);

    // Exactly what the step-down path does with the values it captured.
    const name = seat.playerName;
    const avatar = seat.avatarUrl || null;
    room.removePlayer('u2');
    handlers._addSpectator(registry.get('s2'), room.roomId, 'u2', name, avatar);
    handlers._broadcastSpectatorsChanged(room.roomId);

    const list = emitted.filter((e) => e.event === 'spectators_changed').pop();
    const entry = list.payload.spectators.find((x) => x.spectatorId === 'u2');
    expect(entry.spectatorName).to.equal('Nadia');
    expect(entry.avatarUrl, 'the face survives the move').to.equal(
      'https://cdn/nadia.jpg'
    );
    service.deleteRoom('spec3');
  });

  /**
   * THE ACTUAL LEAK, found on the re-report ("kenapa spectator masih tertera
   * spectator"): the join stored the real identity, and then the very next
   * `get_game_state` — which every spectator client fires moments after joining,
   * and again on each resync — re-registered the SAME socket under the hardcoded
   * literal 'Spectator' with no avatar, clobbering the good entry and
   * broadcasting the degraded roster to the whole room.
   */
  it('survives the get_game_state that follows every spectator join', () => {
    const service = new GameService();
    const room = service.createRoom('spec4', 2);
    service.joinRoom('spec4', 'u1', 'Host', 's1');
    const emitted = [];
    const registry = new Map([['s9', fakeSocket('s9')]]);
    const handlers = new SocketHandlers(fakeIo(emitted, registry), service);
    const socket = registry.get('s9');

    // The exact sequence the client emits on connect: join_room (carrying the
    // real identity) and then, one line later, the spectator snapshot pull.
    return handlers
      .handleJoinRoom(socket, {
        playerId: 'u9',
        playerName: 'Nadia',
        avatarUrl: 'https://cdn/n.jpg',
        roomId: room.roomId,
        isSpectator: true,
      })
      .then(() => {
        // The client's normal follow-up. It carries no name — it never had to.
        handlers.handleGetGameState(socket, { gameId: room.roomId, playerId: 'u9' });

        const list = emitted.filter((e) => e.event === 'spectators_changed').pop();
        const entry = list.payload.spectators.find((x) => x.spectatorId === 'u9');
        expect(entry.spectatorName, 'the resync must not rename the viewer').to.equal(
          'Nadia'
        );
        expect(entry.avatarUrl, 'nor erase their face').to.equal('https://cdn/n.jpg');
        service.deleteRoom('spec4');
      });
  });

  it('honours the identity get_game_state carries, when it carries one', () => {
    const service = new GameService();
    const room = service.createRoom('spec5', 2);
    service.joinRoom('spec5', 'u1', 'Host', 's1');
    const emitted = [];
    const registry = new Map([['s7', fakeSocket('s7')]]);
    const handlers = new SocketHandlers(fakeIo(emitted, registry), service);
    const socket = registry.get('s7');

    // Cold path: an owner-controller / reconnected viewer with no prior record.
    handlers._addSpectator(socket, room.roomId, 'u7', null, null);
    handlers.handleGetGameState(socket, {
      gameId: room.roomId,
      playerId: 'u7',
      playerName: 'Rafael',
      avatarUrl: 'https://cdn/r.jpg',
    });

    const list = emitted.filter((e) => e.event === 'spectators_changed').pop();
    const entry = list.payload.spectators.find((x) => x.spectatorId === 'u7');
    expect(entry.spectatorName).to.equal('Rafael');
    expect(entry.avatarUrl).to.equal('https://cdn/r.jpg');
    service.deleteRoom('spec5');
  });

  /**
   * A display name reaches EVERY other player's roster via
   * `spectators_changed`, so it is bounded and stripped like any other
   * user-supplied text that lands on someone else's screen.
   *
   * This got worse before it got better: the merge above means a hostile name
   * now STICKS, where previously the next get_game_state happened to clobber it
   * back to the placeholder and limited the damage by accident.
   */
  it('bounds a hostile name instead of broadcasting it whole', () => {
    const service = new GameService();
    const room = service.createRoom('spec6', 2);
    const emitted = [];
    const registry = new Map([['s6', fakeSocket('s6')]]);
    const handlers = new SocketHandlers(fakeIo(emitted, registry), service);

    handlers._addSpectator(registry.get('s6'), room.roomId, 'u6', 'A'.repeat(5000), null);
    handlers._broadcastSpectatorsChanged(room.roomId);

    const list = emitted.filter((e) => e.event === 'spectators_changed').pop();
    const entry = list.payload.spectators[0];
    expect(entry.spectatorName.length).to.be.at.most(32);
    service.deleteRoom('spec6');
  });

  it('strips control characters rather than relaying them', () => {
    const service = new GameService();
    const room = service.createRoom('spec7', 2);
    const emitted = [];
    const registry = new Map([['s7', fakeSocket('s7')]]);
    const handlers = new SocketHandlers(fakeIo(emitted, registry), service);

    handlers._addSpectator(registry.get('s7'), room.roomId, 'u7', 'Na\ndia\u0000X', null);
    handlers._broadcastSpectatorsChanged(room.roomId);

    const list = emitted.filter((e) => e.event === 'spectators_changed').pop();
    const name = list.payload.spectators[0].spectatorName;
    expect(name).to.not.match(/[\x00-\x1F]/);
    expect(name).to.contain('Na');
    service.deleteRoom('spec7');
  });

  it('a bounded name still survives the resync, like any other', () => {
    const service = new GameService();
    const room = service.createRoom('spec8', 2);
    service.joinRoom('spec8', 'u1', 'Host', 's1');
    const emitted = [];
    const registry = new Map([['s8', fakeSocket('s8')]]);
    const handlers = new SocketHandlers(fakeIo(emitted, registry), service);
    const socket = registry.get('s8');

    handlers._addSpectator(socket, room.roomId, 'u8', '  Nadia  ', 'https://cdn/n.jpg');
    handlers.handleGetGameState(socket, { gameId: room.roomId, playerId: 'u8' });

    const list = emitted.filter((e) => e.event === 'spectators_changed').pop();
    const entry = list.payload.spectators.find((x) => x.spectatorId === 'u8');
    expect(entry.spectatorName, 'trimmed, not mangled').to.equal('Nadia');
    service.deleteRoom('spec8');
  });
});
