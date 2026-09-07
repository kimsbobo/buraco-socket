/* eslint-env mocha */
//
// A bot must never be seated at a STAKED table.
//
// A bot escrows nothing, and the backend derives the pot from the seats that
// actually escrowed. That makes a paid room with a bot in it a game you can
// neither win nor lose:
//   * human beats bot -> only one paying seat, so the pot is the human's own
//     stake, the losing stake is 0 and the bonus with it. You risk your stake,
//     you win, and you get exactly your stake back.
//   * bot beats human -> the winning seat resolves to no paying user, the
//     backend refuses to pay out and 500s, the socket burns its retries, and
//     the stale-room reaper eventually voids the match and refunds everyone.
//
// Before the guard this was only ACCIDENTALLY safe (no shipped UI called
// invite_bot, and wlive-api never seeds bots over sync-room). These tests pin
// the guard at the single choke point both entry paths funnel through, so it
// cannot quietly regress the day someone adds an "Invite bot" button.

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

describe('SocketHandlers — bots are refused at a staked table', () => {
  const createIoMock = () => {
    const io = {
      roomEmits: [],
      sockets: { sockets: new Map() },
      to: (roomId) => ({
        emit: (event, payload) => io.roomEmits.push({ roomId, event, payload }),
      }),
    };
    return io;
  };

  let service;
  let handler;

  beforeEach(() => {
    service = new GameService();
    handler = new SocketHandlers(createIoMock(), service);
  });

  afterEach(() => {
    service.shutdown();
  });

  it('seats a bot in a FREE room', () => {
    service.createRoom('room-free', 4);
    expect(service.getRoom('room-free').bet).to.equal(0);

    const result = handler.inviteBotToRoom({ roomId: 'room-free', botName: 'Bot 1' });

    expect(result.success).to.equal(true);
    expect(service.getRoom('room-free').players.size).to.equal(1);
  });

  it('refuses a bot once the room carries a stake', () => {
    service.createRoom('room-paid', 4);
    service.getRoom('room-paid').bet = 10000;

    const result = handler.inviteBotToRoom({ roomId: 'room-paid', botName: 'Bot 1' });

    expect(result.success).to.equal(false);
    expect(result.error).to.match(/staked room/i);
    expect(service.getRoom('room-paid').players.size).to.equal(0);
  });

  it('refuses on the BACKEND sync path too, not just the socket event', () => {
    // syncRoomFromBackend applies the room settings (including `bet`) before it
    // walks the bot specs, so the guard sees the real stake. This is the path a
    // second backend sharing this socket would use.
    handler.syncRoomFromBackend({
      roomId: 'room-synced',
      maxPlayers: 4,
      bet: 10000,
      botCount: 2,
    });

    const room = service.getRoom('room-synced');
    expect(room, 'room was created by the sync').to.not.equal(undefined);
    expect(room.bet).to.equal(10000);
    expect(room.players.size, 'no bot was seated').to.equal(0);
  });

  it('still seeds bots over the sync path for a FREE room', () => {
    handler.syncRoomFromBackend({
      roomId: 'room-synced-free',
      maxPlayers: 4,
      bet: 0,
      botCount: 2,
    });

    const room = service.getRoom('room-synced-free');
    expect(room.players.size).to.equal(2);
  });
});
