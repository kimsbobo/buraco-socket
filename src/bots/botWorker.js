const BotStrategy = require('./BotStrategy');

const strategy = new BotStrategy();

process.on('message', (message = {}) => {
  if (message.type !== 'decide') return;

  try {
    const intent = strategy.decide(message.state || {});
    process.send?.({
      type: 'intent',
      requestId: message.requestId,
      intent,
    });
  } catch (error) {
    process.send?.({
      type: 'error',
      requestId: message.requestId,
      error: error.message,
    });
  }
});

process.on('uncaughtException', (error) => {
  process.send?.({ type: 'worker_error', error: error.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.send?.({ type: 'worker_error', error: message });
  process.exit(1);
});
