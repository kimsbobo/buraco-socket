const crypto = require('crypto');
const http = require('http');
const https = require('https');
const logger = require('../utils/logger');

class PartnerWebhookRelay {
  constructor(options = {}, durableStore = null) {
    this.url = options.url || null;
    this.secret = options.secret || null;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000;
    this.retries = Number.isFinite(options.retries) ? options.retries : 3;
    this.backoffMs = Number.isFinite(options.backoffMs) ? options.backoffMs : 500;
    this.outboxTtlSeconds = Number.isFinite(options.outboxTtlSeconds) ? options.outboxTtlSeconds : 86400;
    this.enabledEvents = Array.isArray(options.events) ? options.events : [];
    this.enabled = Boolean(this.url);
    this.durableStore = durableStore;
    this.outboxPrefix = 'partner_webhook:outbox:';
  }

  isEnabledFor(eventName) {
    if (!this.enabled) return false;
    if (!this.enabledEvents.length) return true;
    return this.enabledEvents.includes(eventName);
  }

  dispatch(eventName, payload = {}) {
    if (!this.isEnabledFor(eventName)) return;

    const eventId = this._createEventId();
    const timestamp = new Date().toISOString();
    const body = {
      event: eventName,
      eventId,
      timestamp,
      ...payload,
    };

    const rawBody = JSON.stringify(body);
    const signature = this.secret
      ? `sha256=${crypto.createHmac('sha256', this.secret).update(rawBody).digest('hex')}`
      : null;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(rawBody),
      'X-SDK-Event': eventName,
      'X-SDK-Event-Id': eventId,
      'X-SDK-Timestamp': timestamp,
    };

    if (signature) {
      headers['X-SDK-Signature'] = signature;
    }

    const outboxEvent = {
      rawBody,
      headers,
      eventName,
      eventId,
      createdAt: timestamp,
    };

    this._persistOutboxEvent(eventId, outboxEvent)
      .then(() => this._postWithRetry(rawBody, headers, eventName, eventId, 0))
      .catch((error) => {
        logger.error('[PARTNER_WEBHOOK] final failure', {
          source: 'partner_webhook',
          event: eventName,
          eventId,
          error: error.message,
        });
      });
  }

  async _postWithRetry(rawBody, headers, eventName, eventId, attempt) {
    try {
      const response = await this._post(rawBody, headers);
      const statusCode = response.statusCode || 0;

      if (statusCode >= 200 && statusCode < 300) {
        await this._deleteOutboxEvent(eventId);
        logger.info('[PARTNER_WEBHOOK] delivered', {
          source: 'partner_webhook',
          event: eventName,
          eventId,
          statusCode,
          attempt,
        });
        return;
      }

      const retriable = statusCode >= 500 || statusCode === 429;
      if (!retriable || attempt >= this.retries) {
        throw new Error(`HTTP ${statusCode}`);
      }

      await this._sleep(this._computeBackoff(attempt));
      return this._postWithRetry(rawBody, headers, eventName, eventId, attempt + 1);
    } catch (error) {
      if (attempt >= this.retries) {
        throw error;
      }

      logger.warn('[PARTNER_WEBHOOK] retrying', {
        source: 'partner_webhook',
        event: eventName,
        eventId,
        attempt,
        error: error.message,
      });

      await this._sleep(this._computeBackoff(attempt));
      return this._postWithRetry(rawBody, headers, eventName, eventId, attempt + 1);
    }
  }

  _post(rawBody, headers) {
    const target = new URL(this.url);
    const transport = target.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers,
          timeout: this.timeoutMs,
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve({ statusCode: res.statusCode }));
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });

      req.on('error', reject);
      req.write(rawBody);
      req.end();
    });
  }

  _computeBackoff(attempt) {
    const jitter = Math.floor(Math.random() * 200);
    return this.backoffMs * Math.pow(2, attempt) + jitter;
  }

  _createEventId() {
    return crypto.randomBytes(16).toString('hex');
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async recoverPending() {
    if (!this.enabled || !this.durableStore?.keys) return 0;

    const keys = await this.durableStore.keys(`${this.outboxPrefix}*`);
    let queued = 0;

    for (const key of keys) {
      try {
        const persisted = await this.durableStore.get(key);
        if (!persisted) continue;

        const event = JSON.parse(persisted);
        if (!event?.rawBody || !event?.headers || !event?.eventName || !event?.eventId) {
          await this.durableStore.del(key);
          continue;
        }

        queued += 1;
        this._postWithRetry(event.rawBody, event.headers, event.eventName, event.eventId, 0)
          .catch((error) => {
            logger.error('[PARTNER_WEBHOOK] recovered event final failure', {
              source: 'partner_webhook',
              event: event.eventName,
              eventId: event.eventId,
              error: error.message,
            });
          });
      } catch (error) {
        logger.error('[PARTNER_WEBHOOK] failed to recover pending event', {
          source: 'partner_webhook',
          key,
          error: error.message,
        });
      }
    }

    if (queued > 0) {
      logger.warn('[PARTNER_WEBHOOK] recovered pending events', {
        source: 'partner_webhook',
        count: queued,
      });
    }

    return queued;
  }

  async _persistOutboxEvent(eventId, event) {
    if (!this.durableStore?.setex) return;

    try {
      await this.durableStore.setex(`${this.outboxPrefix}${eventId}`, this.outboxTtlSeconds, JSON.stringify(event));
    } catch (error) {
      logger.error('[PARTNER_WEBHOOK] failed to persist outbox event', {
        source: 'partner_webhook',
        event: event.eventName,
        eventId,
        error: error.message,
      });
    }
  }

  async _deleteOutboxEvent(eventId) {
    if (!this.durableStore?.del) return;
    try {
      await this.durableStore.del(`${this.outboxPrefix}${eventId}`);
    } catch (error) {
      logger.error('[PARTNER_WEBHOOK] failed to delete outbox event', {
        source: 'partner_webhook',
        eventId,
        error: error.message,
      });
    }
  }
}

module.exports = PartnerWebhookRelay;
