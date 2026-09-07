/**
 * ErrorHandler.wrap must emit an `error` event back to the SOCKET when a handler
 * throws, so the client never hangs. The old signature read the socket from
 * args[0] (which is the event payload), so errors were silently swallowed.
 */

const { expect } = require('chai');
const ErrorHandler = require('../../src/middleware/errorHandler');

describe('#ErrorHandler.wrap', () => {
  it('emits an error event to the socket when the handler throws (no ack)', async () => {
    const emitted = [];
    const socket = { emit: (event, payload) => emitted.push({ event, payload }) };

    const wrapped = ErrorHandler.wrap(socket, (data) => {
      // simulate a handler that throws on a bad/empty payload
      const { cards } = data; // throws if data is undefined
      return cards;
    });

    await wrapped(undefined); // client emitted with no payload

    const err = emitted.find((e) => e.event === 'error');
    expect(err, 'an error event must be emitted to the socket').to.not.equal(undefined);
    expect(err.payload.success).to.equal(false);
  });

  it('uses the ack callback when one is provided', async () => {
    const socket = { emit: () => { throw new Error('should not emit when ack present'); } };
    let acked = null;
    const wrapped = ErrorHandler.wrap(socket, () => {
      throw new Error('boom');
    });

    await wrapped({ some: 'data' }, (resp) => { acked = resp; });

    expect(acked).to.not.equal(null);
    expect(acked.success).to.equal(false);
    expect(acked.message).to.equal('boom');
  });

  it('does not throw if the handler succeeds', async () => {
    const socket = { emit: () => { throw new Error('no error expected'); } };
    let ran = false;
    const wrapped = ErrorHandler.wrap(socket, () => { ran = true; });
    await wrapped({});
    expect(ran).to.equal(true);
  });
});
