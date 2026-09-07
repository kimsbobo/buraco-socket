/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { SocketEvents } = require('../../src/constants');
const GameService = require('../../src/services/GameService');

// PTW-50: realtime direct-message (social DM) transport. Verifies the per-user
// room binding on connect and the /webhooks/direct-message fan-out helper.
describe('SocketHandlers — direct messages (PTW-50)', () => {
  const createIoMock = () => {
    const io = {
      roomEmits: [],
      // Mimic socket.io's adapter.rooms (room name -> Set of socket ids).
      sockets: { adapter: { rooms: new Map() } },
      to(roomId) {
        return {
          emit: (event, payload) => io.roomEmits.push({ roomId, event, payload }),
        };
      },
    };
    return io;
  };

  const createSocketMock = (id, { authenticated, userId } = {}) => {
    const joinedRooms = [];
    return {
      id,
      data: { authenticated, userId },
      handshake: { headers: {} },
      join: (room) => joinedRooms.push(room),
      on: () => {},
      to: () => ({ emit: () => {} }),
      emit: () => {},
      get joinedRooms() {
        return joinedRooms;
      },
    };
  };

  it('authenticated sockets join their per-user room on connect', () => {
    const handler = new SocketHandlers(createIoMock(), new GameService());
    const socket = createSocketMock('s1', { authenticated: true, userId: 42 });
    handler.handleConnection(socket);
    expect(socket.joinedRooms).to.include('user:42');
  });

  it('legacy/unauthenticated sockets do NOT join a user room', () => {
    const handler = new SocketHandlers(createIoMock(), new GameService());
    const socket = createSocketMock('s2', { authenticated: false, userId: null });
    handler.handleConnection(socket);
    expect(socket.joinedRooms).to.not.include.members(['user:null']);
    expect(socket.joinedRooms.filter((r) => r.startsWith('user:'))).to.have.length(0);
  });

  it('emitDirectMessage fans the payload to recipient AND sender rooms', () => {
    const io = createIoMock();
    const handler = new SocketHandlers(io, new GameService());
    const message = { id: 7, conversation_id: 3, sender_id: 1, content: 'hi', created_at: 't' };

    const result = handler.emitDirectMessage({ recipientId: 2, senderId: 1, message });

    expect(result.success).to.equal(true);
    const targets = io.roomEmits.map((e) => e.roomId);
    expect(targets).to.have.members(['user:2', 'user:1']);
    io.roomEmits.forEach((e) => {
      expect(e.event).to.equal(SocketEvents.DIRECT_MESSAGE);
      expect(e.payload).to.deep.equal(message);
    });
  });

  it('emitDirectMessage reports delivered socket count from the adapter rooms', () => {
    const io = createIoMock();
    io.sockets.adapter.rooms.set('user:2', new Set(['a', 'b'])); // recipient: 2 devices
    const handler = new SocketHandlers(io, new GameService());

    const result = handler.emitDirectMessage({
      recipientId: 2,
      senderId: 1,
      message: { id: 1, content: 'x' },
    });

    expect(result.success).to.equal(true);
    expect(result.delivered).to.equal(2); // 2 recipient sockets, 0 sender sockets
  });

  it('emitDirectMessage rejects malformed input', () => {
    const handler = new SocketHandlers(createIoMock(), new GameService());
    expect(handler.emitDirectMessage({}).success).to.equal(false);
    expect(handler.emitDirectMessage({ recipientId: 2 }).success).to.equal(false);
  });

  it('does not echo to sender room when sender === recipient', () => {
    const io = createIoMock();
    const handler = new SocketHandlers(io, new GameService());
    handler.emitDirectMessage({ recipientId: 5, senderId: 5, message: { id: 1 } });
    expect(io.roomEmits.map((e) => e.roomId)).to.deep.equal(['user:5']);
  });
});
