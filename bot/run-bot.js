const BotPlayer = require('./BotPlayer');

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    index += 1;
  }

  return result;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;

  const normalized = String(value).toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;

  return fallback;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const bot = new BotPlayer({
    serverUrl: args.url,
    roomId: args.room,
    playerName: args.name,
    playerId: args.id,
    autoStart: toBoolean(args['auto-start']),
    autoDeal: toBoolean(args['auto-deal']),
    turnDelayMs: args.delay,
    actionDelayMs: args['action-delay'],
    createBackendRoom: toBoolean(args['create-backend-room']),
    backendUrl: args['backend-url'],
    backendToken: args['backend-token'],
    backendGameType: args['backend-game-type'],
    backendMaxPlayers: args['backend-max-players'],
    backendRoomName: args['backend-room-name'],
    backendIsPrivate: toBoolean(args['backend-is-private']),
    backendPassword: args['backend-password'],
  });

  await bot.start();

  process.on('SIGINT', () => {
    console.log('\n[BOT] SIGINT received. Stopping bot...');
    bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[BOT] SIGTERM received. Stopping bot...');
    bot.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(`[BOT] startup failed: ${error.message}`);
  process.exit(1);
});