require('dotenv').config({ path: __dirname + '/.env' });

const { io } = require('socket.io-client');
const EventEmitter = require('events');
const { SocketEvents } = require('../src/constants');

const baseConsole = globalThis.console;
const importantLoggingEnabled = (process.env.BOT_IMPORTANT_LOGS ?? 'true') === 'true';

const importantPatterns = [
  /connected/i,
  /disconnected/i,
  /joined room/i,
  /backend room/i,
  /creating backend room/i,
  /sending start_game/i,
  /sending deal_cards/i,
  /retrying auto-start/i,
  /room closed/i,
  /game ended/i,
  /round ended/i,
  /startup failed/i,
  /server error/i,
  /connect_error/i,
];

const shouldLogImportant = (message) => {
  if (!importantLoggingEnabled) return false;
  if (typeof message !== 'string') return false;
  if (message.includes('EVENT:') || message.includes('EVENT (unhandled):')) return false;
  return importantPatterns.some((pattern) => pattern.test(message));
};

const console = {
  log: (message) => {
    if (shouldLogImportant(message)) {
      baseConsole.log(message);
    }
  },
  warn: (message) => {
    if (importantLoggingEnabled && typeof message === 'string') {
      baseConsole.warn(message);
    }
  },
  error: (message) => {
    if (importantLoggingEnabled && typeof message === 'string') {
      baseConsole.error(message);
    }
  },
};

const DEFAULT_TURN_DELAY_MS = 500;
const DEFAULT_ACTION_DELAY_MS = 500;

class BotPlayer {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || process.env.BOT_SERVER_URL || 'http://localhost:8080';
    this.roomId = options.roomId || process.env.BOT_ROOM_ID;
    this.playerName = options.playerName || process.env.BOT_PLAYER_NAME || 'Socket Bot';
    this.playerId = options.playerId || process.env.BOT_PLAYER_ID || `bot-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    this.autoStart = options.autoStart !== undefined
      ? options.autoStart
      : process.env.BOT_AUTO_START === 'true';
    this.autoDeal = options.autoDeal !== undefined
      ? options.autoDeal
      : process.env.BOT_AUTO_DEAL !== 'false';
    this.turnDelayMs = Number(options.turnDelayMs || process.env.BOT_TURN_DELAY_MS || DEFAULT_TURN_DELAY_MS);
    this.actionDelayMs = Number(options.actionDelayMs || process.env.BOT_ACTION_DELAY_MS || DEFAULT_ACTION_DELAY_MS);
    this.maxReconnectAttempts = Number(options.maxReconnectAttempts || process.env.BOT_MAX_RECONNECT || 10);
    this.backendUrl = options.backendUrl || process.env.BOT_BACKEND_URL || '';
    this.backendToken = options.backendToken || process.env.BOT_BACKEND_TOKEN || '';
    this.createBackendRoom = options.createBackendRoom !== undefined
      ? options.createBackendRoom
      : process.env.BOT_CREATE_BACKEND_ROOM === 'true';
    this.backendGameType = options.backendGameType || process.env.BOT_BACKEND_GAME_TYPE || 'Classic';
    this.backendMaxPlayers = Number(
      options.backendMaxPlayers || process.env.BOT_BACKEND_MAX_PLAYERS || 2
    );
    this.backendRoomName = options.backendRoomName || process.env.BOT_BACKEND_ROOM_NAME || '';
    this.backendIsPrivate = options.backendIsPrivate !== undefined
      ? options.backendIsPrivate
      : process.env.BOT_BACKEND_IS_PRIVATE === 'true';
    this.backendPassword = options.backendPassword || process.env.BOT_BACKEND_PASSWORD || '';

    this.socket = null;
    this.connected = false;
    this.currentState = null;
    this.myPlayerIndex = null;
    this.hasJoinedRoom = false;
    this.joinRetryCount = 0;
    this.maxRoomFullRetries = Number(
      options.maxRoomFullRetries || process.env.BOT_ROOM_FULL_RETRIES || 2
    );
    this.originalRoomId = this.roomId;
    this.lastTurnToken = null;
    this.turnTimer = null;
    this.processingTurn = false;
    this.autoStartRequested = false;
    this.autoDealRequested = false;
    this.startRetryTimer = null;
    this.gameStartedSeen = false;
    this.previousSocketId = null;
    this.myPozzettoTakenCount = 0;
    this.lastPozzettoPileCount = null;
    this.events = new EventEmitter();
    this.events.on('error', () => {});
  }

  on(eventName, callback) {
    this.events.on(eventName, callback);
    return this;
  }

  off(eventName, callback) {
    this.events.off(eventName, callback);
    return this;
  }

  waitFor(eventName, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.events.off(eventName, onEvent);
        reject(new Error(`Timeout waiting for event: ${eventName}`));
      }, timeoutMs);

      const onEvent = (payload) => {
        clearTimeout(timeout);
        this.events.off(eventName, onEvent);
        resolve(payload);
      };

      this.events.on(eventName, onEvent);
    });
  }

  async start() {
    if (this.socket) return;

    if (this.createBackendRoom) {
      await this._createRoomOnBackend();
    }

    this.socket = io(this.serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      timeout: 10000,
    });

    this._registerHandlers();
  }

  async _createRoomOnBackend() {
    if (!this.backendUrl) {
      throw new Error('BOT_BACKEND_URL is required when BOT_CREATE_BACKEND_ROOM=true');
    }

    if (!this.backendToken) {
      throw new Error('BOT_BACKEND_TOKEN is required when BOT_CREATE_BACKEND_ROOM=true');
    }

    const roomsUrl = this._getBackendRoomsUrl();
    const roomName = this.backendRoomName || `${this.playerName} Bot Room`;

    const payload = {
      name: roomName,
      game_type: this.backendGameType,
      max_players: this.backendMaxPlayers,
      is_private: this.backendIsPrivate,
    };

    if (this.backendIsPrivate && this.backendPassword) {
      payload.password = this.backendPassword;
    }

    console.log(`[BOT:${this.playerName}] creating backend room via ${roomsUrl}`);

    const response = await fetch(roomsUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.backendToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }

    if (!response.ok) {
      const backendError = data?.message || data?.error || JSON.stringify(data) || response.statusText;
      throw new Error(`Backend room create failed (${response.status}): ${backendError}`);
    }

    if (!data || (data.id === undefined || data.id === null)) {
      throw new Error('Backend room create response missing room id');
    }

    this.roomId = String(data.id);
    this.originalRoomId = this.roomId;

    console.log(`[BOT:${this.playerName}] backend room ready: ${this.roomId}`);
  }

  _getBackendRoomsUrl() {
    const base = this.backendUrl.replace(/\/+$/, '');
    if (base.endsWith('/api')) {
      return `${base}/rooms`;
    }
    return `${base}/api/rooms`;
  }

  stop() {
    this._clearTurnTimer();

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    this.connected = false;
    this.currentState = null;
    this.myPlayerIndex = null;
    this.hasJoinedRoom = false;
    this.processingTurn = false;
    this.lastTurnToken = null;
    this.autoStartRequested = false;
    this.autoDealRequested = false;
    this.gameStartedSeen = false;
    if (this.startRetryTimer) {
      clearTimeout(this.startRetryTimer);
      this.startRetryTimer = null;
    }
    this.previousSocketId = null;
    this.myPozzettoTakenCount = 0;
    this.lastPozzettoPileCount = null;
  }

  _registerHandlers() {
    this.socket.on('connect', () => {
      this.connected = true;
      console.log(`[BOT:${this.playerName}] connected (${this.socket.id})`);
      this.events.emit('connected', {
        playerId: this.playerId,
        socketId: this.socket.id,
        roomId: this.roomId,
      });
      this._joinRoom();
    });

    this.socket.on('disconnect', (reason) => {
      if (this.socket?.id) {
        this.previousSocketId = this.socket.id;
      }
      this.connected = false;
      console.log(`[BOT:${this.playerName}] disconnected: ${reason}`);
      this.events.emit('disconnected', {
        playerId: this.playerId,
        roomId: this.roomId,
        reason,
        previousSocketId: this.previousSocketId,
      });
    });

    this.socket.on('connect_error', (error) => {
      console.error(`[BOT:${this.playerName}] connect_error: ${error.message}`);
    });

    this.socket.on(SocketEvents.PLAYER_JOINED, (payload) => {
      console.log(`[BOT:${this.playerName}] EVENT: PLAYER_JOINED`, JSON.stringify(payload, null, 2));
      if (!payload) return;

      if (payload.playerId === this.playerId) {
        this.hasJoinedRoom = true;

        const joinedRoomId = payload.roomId || payload?.data?.roomId || this.roomId;
        if (joinedRoomId) {
          this.roomId = joinedRoomId;
        }

        // Handle multiple payload formats
        let playerIndex = payload.playerIndex;
        if (playerIndex === undefined && payload.data) {
          playerIndex = payload.data.playerIndex;
        }
        if (playerIndex === undefined && payload.success && typeof payload.success === 'object') {
          playerIndex = payload.success.playerIndex;
        }

        if (Number.isInteger(playerIndex)) {
          this.myPlayerIndex = playerIndex;
        }

        console.log(
          `[BOT:${this.playerName}] joined room ${this.roomId} as index ${playerIndex ?? 'unknown'}`
        );

        this.events.emit('self_joined', {
          playerId: this.playerId,
          roomId: this.roomId,
          playerIndex: this.myPlayerIndex,
          payload,
        });

        this._maybeRequestStartGame();
      } else if (this.hasJoinedRoom) {
        // Another player joined this room. If we are host with auto-start, retry start now.
        if (this.myPlayerIndex === 0) {
          this.autoStartRequested = false;
          this._maybeRequestStartGame();
        }
        this._scheduleStartRetry('another player joined');
      }
    });

    this.socket.on(SocketEvents.HOST_CHANGED, (payload) => {
      console.log(`[BOT:${this.playerName}] EVENT: HOST_CHANGED`, JSON.stringify(payload, null, 2));
      this.events.emit('host_changed', payload);
      const newHostId = payload?.newHostId;
      if (newHostId && newHostId === this.playerId) {
        this.myPlayerIndex = 0;
        this.autoStartRequested = false;
        this.autoDealRequested = false;
        this._scheduleStartRetry('host migrated to this bot');
      }
    });

    this.socket.on(SocketEvents.PLAYER_DISCONNECTED, (payload) => {
      console.log(`[BOT:${this.playerName}] EVENT: PLAYER_DISCONNECTED`, JSON.stringify(payload, null, 2));
      this.events.emit('player_disconnected', payload);
    });

    this.socket.on(SocketEvents.PLAYER_RECONNECTED, (payload) => {
      console.log(`[BOT:${this.playerName}] EVENT: PLAYER_RECONNECTED`, JSON.stringify(payload, null, 2));
      this.events.emit('player_reconnected', payload);

      if (String(payload?.playerId || '') === String(this.playerId || '')) {
        setTimeout(() => {
          this._requestGameState();
        }, 150);
      }
    });

    this.socket.on(SocketEvents.PLAYER_LEFT, (payload) => {
      console.log(`[BOT:${this.playerName}] EVENT: PLAYER_LEFT`, JSON.stringify(payload, null, 2));
      this.events.emit('player_left', payload);
    });

    this.socket.on(SocketEvents.GAME_STARTED, (payload) => {
      console.log(`[BOT:${this.playerName}] EVENT: GAME_STARTED`, JSON.stringify(payload, null, 2));
      this.gameStartedSeen = true;
      this.myPozzettoTakenCount = 0;
      this.lastPozzettoPileCount = null;
      const isMyStart = payload && Number.isInteger(payload.yourPlayerIndex);
      if (Number.isInteger(payload?.yourPlayerIndex)) {
        this.myPlayerIndex = payload.yourPlayerIndex;
      }
      console.log(
        `[BOT:${this.playerName}] game started${
          isMyStart ? ` (my index ${payload.yourPlayerIndex})` : ''
        }`
      );

      this.events.emit('game_started', payload);

      this._maybeRequestDealCards(payload);
    });

    this.socket.on(SocketEvents.GAME_STATE_UPDATE, (state) => {
      console.log(`[BOT:${this.playerName}] EVENT: GAME_STATE_UPDATE cardsDealt=${state?.cardsDealt}, currentPlayerIndex=${state?.currentPlayerIndex}, yourPlayerIndex=${state?.yourPlayerIndex}`);
      this.currentState = state;
      const pozzettoPileCount = this._getPozzettoPileCountFromState(state);
      if (this.lastPozzettoPileCount === null || this.lastPozzettoPileCount !== pozzettoPileCount) {
        console.log(`[BOT:${this.playerName}] pozzetto piles remaining: ${pozzettoPileCount}`);
        this.lastPozzettoPileCount = pozzettoPileCount;
      }
      if (state?.cardsDealt === true) {
        this.gameStartedSeen = true;
      }
      if (Number.isInteger(state?.yourPlayerIndex)) {
        this.myPlayerIndex = state.yourPlayerIndex;
      }

      this.events.emit('game_state_update', state);

      // Safety net: if host sees undealt game state, try to ensure game is started.
      if (this.myPlayerIndex === 0 && !this.gameStartedSeen && state?.cardsDealt === false) {
        this.autoStartRequested = false;
        this._maybeRequestStartGame();
      }

      this._maybeRequestDealCards(state);
      this._queueTurnIfNeeded();
    });

    this.socket.on(SocketEvents.TURN_COMPLETED, (data) => {
      console.log(`[BOT:${this.playerName}] EVENT: TURN_COMPLETED`, JSON.stringify(data, null, 2));
      const previous = data?.previousTurnIndex;
      const next = data?.newTurnIndex;
      if (Number.isInteger(previous) && Number.isInteger(next)) {
        console.log(`[BOT:${this.playerName}] turn completed: ${previous} -> ${next}`);
      }
      this.events.emit('turn_completed', data);
    });

    this.socket.on(SocketEvents.POZZETTO_TAKEN, (payload) => {
      const takerIndex = payload?.playerIndex;
      const cardCount = payload?.cardCount;

      if (Number.isInteger(takerIndex) && Number.isInteger(this.myPlayerIndex) && takerIndex === this.myPlayerIndex) {
        this.myPozzettoTakenCount += 1;
        const maxPozzetto = this._maxPozzettoPerPlayerForRuleset(this.currentState?.ruleset);
        console.log(
          `[BOT:${this.playerName}] took pozzetto (${this.myPozzettoTakenCount}/${maxPozzetto}) cards=${cardCount ?? 'n/a'}`
        );
      } else {
        console.log(`[BOT:${this.playerName}] pozzetto taken by playerIndex=${takerIndex ?? 'n/a'} cards=${cardCount ?? 'n/a'}`);
      }

      this.events.emit('pozzetto_taken', payload);
    });

    this.socket.on(SocketEvents.ROUND_ENDED, (data) => {
      console.log(`[BOT:${this.playerName}] EVENT: ROUND_ENDED`, JSON.stringify(data, null, 2));
      console.log(`[BOT:${this.playerName}] round ended. Winner index: ${data?.winnerPlayerIndex ?? 'unknown'}`);
      this.events.emit('round_ended', data);
    });

    this.socket.on(SocketEvents.GAME_ENDED, () => {
      console.log(`[BOT:${this.playerName}] EVENT: GAME_ENDED`);
      console.log(`[BOT:${this.playerName}] game ended.`);
      this.events.emit('game_ended', {
        playerId: this.playerId,
        roomId: this.roomId,
      });
    });

    this.socket.on(SocketEvents.ROOM_CLOSED, (payload) => {
      console.log(`[BOT:${this.playerName}] EVENT: ROOM_CLOSED`, JSON.stringify(payload, null, 2));
      console.log(`[BOT:${this.playerName}] room closed: ${payload?.reason || 'unknown reason'}`);
      this.events.emit('room_closed', payload);
      this.stop();
    });

    this.socket.on(SocketEvents.ERROR, (payload) => {
      console.log(`[BOT:${this.playerName}] EVENT: ERROR`, JSON.stringify(payload, null, 2));
      const message = payload?.error || payload?.message || 'Unknown error';
      console.warn(`[BOT:${this.playerName}] server error: ${message}`);
      this.events.emit('error', payload);

      if (typeof message === 'string' && message.toLowerCase().includes('only the host can start the game')) {
        this.autoStartRequested = true;
      }

      if (typeof message === 'string' && message.toLowerCase().includes('room is not full')) {
        // Keep auto-start enabled and retry once more when room fills.
        this.autoStartRequested = false;
        this._scheduleStartRetry('room not full');
      }

      if (typeof message === 'string' && message.toLowerCase().includes('room is full')) {
        this._handleRoomFull();
      }

      if (typeof message === 'string' && message.toLowerCase().includes('room is not ready on realtime server')) {
        this.hasJoinedRoom = false;
        setTimeout(() => {
          this._joinRoom();
        }, 400);
      }

      if (typeof message === 'string' && message.toLowerCase().includes('deck is empty')) {
        this._handleDeckEmpty();
      }

      if (typeof message === 'string' && (
        message.toLowerCase().includes('card not found in hand') ||
        message.toLowerCase().includes('you must draw or pick up before discarding') ||
        message.toLowerCase().includes('you must take the well before going out') ||
        message.toLowerCase().includes('not your turn')
      )) {
        this._requestGameState();
      }
    });

    // Catch-all for unhandled events (debugging)
    this.socket.onAny((eventName, ...args) => {
      if (!eventName.startsWith('ping') && !eventName.startsWith('pong')) {
        console.log(`[BOT:${this.playerName}] EVENT (unhandled): ${eventName}`, args.length > 0 ? JSON.stringify(args[0], null, 2) : '');
      }
    });
  }

  _joinRoom() {
    if (!this.socket || !this.connected) return;

    console.log(`[BOT:${this.playerName}] joining room: ${this.roomId || 'auto-match'}`);
    const previousSocketId = this.previousSocketId;
    this.socket.emit(SocketEvents.JOIN_ROOM, {
      playerId: this.playerId,
      playerName: this.playerName,
      roomId: this.roomId,
      ...(previousSocketId ? { previousSocketId } : {}),
    });

    this.previousSocketId = null;
  }

  simulateNetworkDrop() {
    if (!this.socket) return;

    if (this.socket.id) {
      this.previousSocketId = this.socket.id;
    }

    if (this.socket.io && this.socket.io.engine && typeof this.socket.io.engine.close === 'function') {
      this.socket.io.engine.close();
      return;
    }

    this.socket.disconnect();
    this.socket.connect();
  }

  _handleRoomFull() {
    if (this.hasJoinedRoom) return;
    if (this.joinRetryCount >= this.maxRoomFullRetries) {
      console.warn(
        `[BOT:${this.playerName}] room full retry limit reached (${this.maxRoomFullRetries}).`
      );
      return;
    }

    this.joinRetryCount += 1;
    this.roomId = this._buildFallbackRoomId();
    this.autoStartRequested = false;

    console.log(
      `[BOT:${this.playerName}] retrying with fallback room: ${this.roomId} (${this.joinRetryCount}/${this.maxRoomFullRetries})`
    );

    setTimeout(() => {
      this._joinRoom();
    }, 350);
  }

  _buildFallbackRoomId() {
    const base = this.originalRoomId || this.roomId || 'brazilia-bot-room';
    const now = new Date();
    const stamp = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
      String(now.getUTCHours()).padStart(2, '0'),
      String(now.getUTCMinutes()).padStart(2, '0'),
    ].join('');

    // Deterministic per-minute suffix helps multiple bots converge on same fallback room.
    return `${base}-${stamp}`;
  }

  _maybeRequestStartGame() {
    if (!this.socket || !this.connected) return;
    if (!this.autoStart) return;
    if (!this.roomId) return;
    if (this.autoStartRequested) return;
    if (this.gameStartedSeen) return;

    if (this.myPlayerIndex !== 0) {
      console.log(
        `[BOT:${this.playerName}] auto-start skipped (not host, my index: ${this.myPlayerIndex ?? 'unknown'})`
      );
      return;
    }

    this.autoStartRequested = true;
    console.log(`[BOT:${this.playerName}] will request game start in 500ms (host in room: ${this.roomId})`);

    setTimeout(() => {
      if (!this.connected || !this.socket) return;
      console.log(`[BOT:${this.playerName}] sending start_game request as host`);
      this.socket.emit(SocketEvents.START_GAME, { roomId: this.roomId });
    }, 500);
  }

  _scheduleStartRetry(reason) {
    if (!this.autoStart) return;
    if (this.startRetryTimer) return;

    this.startRetryTimer = setTimeout(() => {
      this.startRetryTimer = null;
      console.log(`[BOT:${this.playerName}] retrying auto-start (${reason})`);
      this._maybeRequestStartGame();
    }, 700);
  }

  _maybeRequestDealCards(sourceState = null) {
    if (!this.socket || !this.connected) return;
    if (!this.autoDeal) return;
    if (this.autoDealRequested) return;

    const cardsAlreadyDealt = Boolean(sourceState?.cardsDealt ?? this.currentState?.cardsDealt);
    if (cardsAlreadyDealt) return;

    if (this.myPlayerIndex !== 0) {
      console.log(
        `[BOT:${this.playerName}] auto-deal skipped (not host, my index: ${this.myPlayerIndex ?? 'unknown'})`
      );
      return;
    }

    this.autoDealRequested = true;
    console.log(`[BOT:${this.playerName}] will request deal_cards in 500ms (host in room: ${this.roomId})`);

    setTimeout(() => {
      if (!this.connected || !this.socket) return;
      console.log(`[BOT:${this.playerName}] sending deal_cards request as host`);
      this.socket.emit(SocketEvents.DEAL_CARDS, { roomId: this.roomId });
    }, 500);
  }

  _queueTurnIfNeeded() {
    if (!this.currentState || this.processingTurn) return;
    if (!Number.isInteger(this.currentState.currentPlayerIndex)) return;
    if (!Number.isInteger(this.currentState.yourPlayerIndex)) return;
    if (!this.currentState.cardsDealt) return;

    const isMyTurn = this.currentState.currentPlayerIndex === this.currentState.yourPlayerIndex;
    if (!isMyTurn) return;

    const turnToken = `${this.currentState.currentPlayerIndex}-${Boolean(this.currentState.hasDrawnCard)}`;
    if (turnToken === this.lastTurnToken) return;

    this.lastTurnToken = turnToken;
    this._clearTurnTimer();
    this.turnTimer = setTimeout(() => this._playTurn(), this.turnDelayMs);
  }

  async _playTurn() {
    if (!this.socket || !this.connected || !this.currentState) return;
    this.processingTurn = true;

    try {
      const { hasDrawnCard } = this.currentState;

      if (!hasDrawnCard) {
        this._drawForTurn();
        return;
      }

      const workingHand = this._cloneCards(this.currentState.yourHand || []);
      const workingMelds = this._getOwnMeldsFromState();

      await this._executeMeldPhase(workingHand, workingMelds);

      if (this._maybeTakePozzetto(workingHand)) {
        return;
      }

      await this._waitActionDelay();

      const cardToDiscard = this._pickDiscard(workingHand);
      if (!cardToDiscard) {
        console.warn(`[BOT:${this.playerName}] no card available to discard.`);
        return;
      }

      this._discardCard(cardToDiscard);
    } finally {
      this.processingTurn = false;
    }
  }

  async _executeMeldPhase(workingHand, workingMelds) {
    const maxActions = 4;
    let actionCount = 0;
    let hasPlayedAnyMeld = false;

    while (actionCount < maxActions) {
      const addAction = this._findAddToMeldAction(workingHand, workingMelds);
      if (addAction) {
        const remainingCards = workingHand.length - addAction.cards.length;
        if (this._wouldLeaveIllegalSingleCard(remainingCards)) {
          break;
        }

        this._emitAddToMeld(addAction);
        this._removeCardsFromHand(workingHand, addAction.cards);
        if (Array.isArray(workingMelds[addAction.meldIndex])) {
          workingMelds[addAction.meldIndex].push(...this._cloneCards(addAction.cards));
        }
        actionCount += 1;
        await this._waitActionDelay();
        continue;
      }

      const newMeld = this._findBestNewMeld(workingHand);
      if (!newMeld) {
        break;
      }

      const remainingCards = workingHand.length - newMeld.cards.length;
      if (this._wouldLeaveIllegalSingleCard(remainingCards)) {
        break;
      }

      if (!hasPlayedAnyMeld && this._estimateMeldPoints(newMeld.cards) >= 50) {
        this._emitGoDown([newMeld.cards]);
        await this._waitActionDelay();
      }

      this._emitPlayMeld(newMeld.cards);
      this._removeCardsFromHand(workingHand, newMeld.cards);
      workingMelds.push(this._cloneCards(newMeld.cards));
      hasPlayedAnyMeld = true;
      actionCount += 1;
      await this._waitActionDelay();
    }
  }

  async _waitActionDelay() {
    const delayMs = Number.isFinite(this.actionDelayMs) ? this.actionDelayMs : DEFAULT_ACTION_DELAY_MS;
    if (delayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  _drawForTurn() {
    const deckCount = Number(this.currentState?.deckCount || 0);
    const discardCount = Array.isArray(this.currentState?.discardPile)
      ? this.currentState.discardPile.length
      : 0;

    if (discardCount > 0 && this._shouldTakeDiscardPile()) {
      this._pickUpPile();
      return;
    }

    if (deckCount > 0) {
      this._drawFromDeck();
      return;
    }

    if (discardCount > 0) {
      this._pickUpPile();
      return;
    }

    console.warn(
      `[BOT:${this.playerName}] cannot draw: deckCount=${deckCount}, discardCount=${discardCount}. Requesting state sync.`
    );
    this._requestGameState();
  }

  _shouldTakeDiscardPile() {
    if (!this.currentState) return false;

    const discardPile = Array.isArray(this.currentState.discardPile)
      ? this.currentState.discardPile
      : [];
    if (discardPile.length === 0) return false;

    const topCard = discardPile[discardPile.length - 1];
    if (!topCard) return false;

    const hand = Array.isArray(this.currentState.yourHand)
      ? this.currentState.yourHand
      : [];
    const melds = this._getOwnMeldsFromState();

    const canExtendMeld = melds.some((meld) => this._canAddCardToMeld(meld, topCard));
    if (canExtendMeld) return true;

    if (this._canFormPotentialMeldWithCard(topCard, hand)) return true;

    // If pile has many cards, be slightly more aggressive if top card is not a dangerous throwaway.
    if (discardPile.length >= 2 && !this._isWild(topCard)) {
      return this._rankValue(topCard.rank) >= 7;
    }

    return false;
  }

  _canFormPotentialMeldWithCard(card, hand) {
    if (!card || !Array.isArray(hand)) return false;
    if (this._isWild(card)) return true;

    const rank = String(card.rank);
    const suit = String(card.suit);
    const cardRankValue = this._rankValue(rank);

    // Set potential: same-rank cards in hand (excluding wilds)
    const sameRankCount = hand.filter(
      (c) => !this._isWild(c) && String(c.rank) === rank
    ).length;
    if (sameRankCount >= 2) return true;

    // Sequence potential: neighboring same-suit cards + possible wildcard support
    const sameSuit = hand.filter(
      (c) => !this._isWild(c) && String(c.suit) === suit
    );
    const wildCount = hand.filter((c) => this._isWild(c)).length;

    let neighborCount = 0;
    for (const c of sameSuit) {
      const diff = Math.abs(this._rankValue(c.rank) - cardRankValue);
      if (diff === 1 || diff === 2) neighborCount += 1;
    }

    if (neighborCount >= 2) return true;
    if (neighborCount >= 1 && wildCount >= 1) return true;

    return false;
  }

  _drawFromDeck() {
    if (!this.socket || !this.connected) return;
    console.log(`[BOT:${this.playerName}] action: draw_card from deck`);
    this.socket.emit(SocketEvents.DRAW_CARD, {
      fromDeck: true,
    });
  }

  _pickUpPile() {
    if (!this.socket || !this.connected) return;
    console.log(`[BOT:${this.playerName}] action: pick_up_pile (deck empty)`);
    this.socket.emit(SocketEvents.PICK_UP_PILE, {});
  }

  _emitPlayMeld(cards) {
    if (!this.socket || !this.connected) return;
    if (!Array.isArray(cards) || cards.length < 3) return;
    console.log(`[BOT:${this.playerName}] action: play_meld (${cards.length} cards)`);
    this.socket.emit(SocketEvents.PLAY_MELD, {
      cards: this._cloneCards(cards),
    });
  }

  _emitAddToMeld(action) {
    if (!this.socket || !this.connected) return;
    if (!action || !Array.isArray(action.cards) || action.cards.length === 0) return;
    console.log(
      `[BOT:${this.playerName}] action: add_to_meld (meld ${action.meldIndex}, ${action.cards.length} card)`
    );
    this.socket.emit(SocketEvents.ADD_TO_MELD, {
      card: this._cloneCards(action.cards)[0],
      targetPlayerIndex: this.currentState?.yourPlayerIndex,
      targetMeldIndex: action.meldIndex,
    });
  }

  _emitGoDown(melds) {
    if (!this.socket || !this.connected) return;
    console.log(`[BOT:${this.playerName}] action: go_down`);
    this.socket.emit(SocketEvents.GO_DOWN, {
      melds: melds.map((meld) => this._cloneCards(meld)),
    });
  }

  _maybeTakePozzetto(workingHand) {
    if (!this.socket || !this.connected) return false;
    const hasCards = Array.isArray(workingHand) && workingHand.length > 0;
    if (hasCards) return false;
    if (!this.currentState?.pozzettosAvailable) return false;

    console.log(`[BOT:${this.playerName}] action: take_pozzetto`);
    this.socket.emit(SocketEvents.TAKE_POZZETTO, {});
    return true;
  }

  _handleDeckEmpty() {
    if (!this.currentState) return;

    const isMyTurn = this.currentState.currentPlayerIndex === this.currentState.yourPlayerIndex;
    const hasDrawnCard = Boolean(this.currentState.hasDrawnCard);
    if (!isMyTurn || hasDrawnCard) return;

    const discardCount = Array.isArray(this.currentState.discardPile)
      ? this.currentState.discardPile.length
      : 0;

    if (discardCount > 0) {
      this._pickUpPile();
      return;
    }

    this._requestGameState();
  }

  _requestGameState() {
    if (!this.socket || !this.connected) return;
    if (!this.roomId || !this.playerId) return;

    this.socket.emit('get_game_state', {
      gameId: this.roomId,
      playerId: this.playerId,
    });
  }

  _getPozzettoPileCountFromState(state) {
    if (!state) return 0;

    if (Array.isArray(state.deadPileCounts)) {
      return state.deadPileCounts.filter((count) => Number(count) > 0).length;
    }

    const totalPozzettoCards = Number(state.pozzettosCardCount || 0);
    if (totalPozzettoCards >= 22) return 2;
    if (totalPozzettoCards >= 11) return 1;
    if (state.pozzettosAvailable) return 1;
    return 0;
  }

  _maxPozzettoPerPlayerForRuleset(ruleset) {
    return String(ruleset || 'classic').toLowerCase() === 'professional' ? 2 : 1;
  }

  _wouldLeaveIllegalSingleCard(remainingCards) {
    const ruleset = String(this.currentState?.ruleset || 'classic').toLowerCase();
    if (ruleset !== 'classic') return false;
    if (!this.currentState?.pozzettosAvailable) return false;
    return remainingCards === 1;
  }

  _discardCard(card) {
    if (!this.socket || !this.connected) return;
    console.log(`[BOT:${this.playerName}] action: discard_card ${card.rank} of ${card.suit}`);
    this.socket.emit(SocketEvents.DISCARD_CARD, {
      card: {
        suit: card.suit,
        rank: card.rank,
      },
    });
  }

  _pickDiscard(hand) {
    if (!Array.isArray(hand) || hand.length === 0) return null;

    const groupedByRank = new Map();
    const groupedBySuit = new Map();
    hand.forEach((card) => {
      const rank = String(card.rank);
      const suit = String(card.suit);
      groupedByRank.set(rank, (groupedByRank.get(rank) || 0) + 1);
      if (!groupedBySuit.has(suit)) groupedBySuit.set(suit, []);
      groupedBySuit.get(suit).push(card);
    });

    const sorted = [...hand].sort((left, right) => {
      const leftScore = this._discardScore(left, groupedByRank, groupedBySuit, hand);
      const rightScore = this._discardScore(right, groupedByRank, groupedBySuit, hand);
      return rightScore - leftScore;
    });

    return sorted[0];
  }

  _discardScore(card, groupedByRank, groupedBySuit, hand) {
    const rankValueMap = {
      joker: 0,
      A: 1,
      '2': 2,
      '3': 6,
      '4': 7,
      '5': 8,
      '6': 9,
      '7': 10,
      '8': 11,
      '9': 12,
      '10': 13,
      J: 14,
      Q: 15,
      K: 16,
    };

    const rank = String(card.rank);
    const suit = String(card.suit);
    const rankCount = groupedByRank.get(rank) || 1;
    const base = rankValueMap[rank] || 5;
    const pairPenalty = rankCount > 1 ? 6 : 0;
    const jokerPenalty = rank === 'joker' ? 99 : 0;
    const wildcardPenalty = rank === '2' ? 20 : 0;
    const runPotentialPenalty = this._runPotentialPenalty(card, groupedBySuit.get(suit) || [], hand);

    return base - pairPenalty - jokerPenalty - wildcardPenalty - runPotentialPenalty;
  }

  _runPotentialPenalty(card, sameSuitCards, hand) {
    if (this._isWild(card)) return 0;
    const value = this._rankValue(card.rank);
    if (value <= 0) return 0;

    let hasNeighbor = false;
    let hasTwoStep = false;
    for (const candidate of sameSuitCards) {
      if (candidate === card || this._isWild(candidate)) continue;
      const diff = Math.abs(this._rankValue(candidate.rank) - value);
      if (diff === 1) hasNeighbor = true;
      if (diff === 2) hasTwoStep = true;
    }

    const wildCount = Array.isArray(hand)
      ? hand.filter((c) => this._isWild(c)).length
      : 0;

    if (hasNeighbor && hasTwoStep) return 10;
    if (hasNeighbor) return 6;
    if (hasTwoStep && wildCount > 0) return 4;
    return 0;
  }

  _getOwnMeldsFromState() {
    const myIndex = this.currentState?.yourPlayerIndex;
    const allMelds = this.currentState?.playerMelds || {};
    const own = allMelds?.[myIndex] || [];
    if (!Array.isArray(own)) return [];
    return own.map((meld) => this._cloneCards(meld));
  }

  _findAddToMeldAction(hand, melds) {
    if (!Array.isArray(hand) || hand.length === 0) return null;
    if (!Array.isArray(melds) || melds.length === 0) return null;

    for (let meldIndex = 0; meldIndex < melds.length; meldIndex += 1) {
      const meld = melds[meldIndex];
      if (!Array.isArray(meld) || meld.length < 3) continue;

      const meldCopy = [...meld];
      const selectedCards = [];
      let searching = true;

      while (searching) {
        searching = false;
        for (const card of hand) {
          if (selectedCards.includes(card)) continue;
          if (this._canAddCardToMeld(meldCopy, card)) {
            selectedCards.push(card);
            meldCopy.push(card);
            searching = true;
          }
        }
      }

      if (selectedCards.length > 0) {
        return { meldIndex, cards: selectedCards };
      }
    }

    return null;
  }

  _findBestNewMeld(hand) {
    const allMelds = [
      ...this._findSequenceMelds(hand),
      ...this._findSetMelds(hand),
    ].filter((meld) => this._isMeldCandidateValid(meld));

    if (allMelds.length === 0) return null;

    allMelds.sort((left, right) => {
      const leftScore = this._meldStrategicScore(left);
      const rightScore = this._meldStrategicScore(right);
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      if (right.cards.length !== left.cards.length) {
        return right.cards.length - left.cards.length;
      }
      return this._estimateMeldPoints(right.cards) - this._estimateMeldPoints(left.cards);
    });

    return allMelds[0];
  }

  _findSetMelds(hand) {
    const byRank = new Map();
    hand.forEach((card) => {
      if (this._isWild(card)) return;
      const rank = String(card.rank);
      if (!byRank.has(rank)) byRank.set(rank, []);
      byRank.get(rank).push(card);
    });

    const melds = [];
    byRank.forEach((cards) => {
      const uniqueBySuit = [];
      const seen = new Set();
      cards.forEach((card) => {
        const suit = this._normalizeSuit(card.suit);
        if (seen.has(suit)) return;
        seen.add(suit);
        uniqueBySuit.push(card);
      });

      if (uniqueBySuit.length >= 3) {
        melds.push({ type: 'set', cards: uniqueBySuit.slice(0, 4) });
      }
    });

    return melds;
  }

  _isMeldCandidateValid(meld) {
    if (!meld || !Array.isArray(meld.cards) || meld.cards.length < 3) return false;
    if (meld.type !== 'set') return true;

    const naturals = meld.cards.filter((card) => !this._isWild(card));
    if (naturals.length < 2) return true;

    const baseRank = String(naturals[0].rank);
    if (!naturals.every((card) => String(card.rank) === baseRank)) {
      return false;
    }

    const uniqueSuits = new Set(naturals.map((card) => this._normalizeSuit(card.suit)));
    return uniqueSuits.size === naturals.length;
  }

  _findSequenceMelds(hand) {
    const melds = [];
    const bySuit = new Map();
    const wildCards = hand.filter((card) => this._isWild(card));

    hand.forEach((card) => {
      if (this._isWild(card)) return;
      if (card.suit === 'joker') return;
      const suit = String(card.suit);
      if (!bySuit.has(suit)) bySuit.set(suit, []);
      bySuit.get(suit).push(card);
    });

    bySuit.forEach((cards) => {
      const sorted = [...cards].sort(
        (left, right) => this._rankValue(left.rank) - this._rankValue(right.rank)
      );

      if (sorted.length >= 3) {
        let run = [sorted[0]];
        for (let i = 1; i < sorted.length; i += 1) {
          const prev = run[run.length - 1];
          const diff = this._rankValue(sorted[i].rank) - this._rankValue(prev.rank);
          if (diff === 1) {
            run.push(sorted[i]);
          } else {
            if (run.length >= 3) {
              melds.push({ type: 'sequence', cards: [...run] });
            }
            run = [sorted[i]];
          }
        }
        if (run.length >= 3) {
          melds.push({ type: 'sequence', cards: [...run] });
        }
      }

      if (wildCards.length === 0 || sorted.length < 2) return;

      for (let start = 0; start < sorted.length; start += 1) {
        const candidate = [sorted[start]];
        let usedWilds = 0;
        let previousValue = this._rankValue(sorted[start].rank);

        for (let next = start + 1; next < sorted.length; next += 1) {
          const nextValue = this._rankValue(sorted[next].rank);
          if (nextValue <= previousValue) continue;

          const gap = nextValue - previousValue - 1;
          if (gap === 0) {
            candidate.push(sorted[next]);
            previousValue = nextValue;
            continue;
          }

          const remainingWilds = wildCards.length - usedWilds;
          if (gap <= remainingWilds) {
            for (let i = 0; i < gap; i += 1) {
              candidate.push(wildCards[usedWilds + i]);
            }
            usedWilds += gap;
            candidate.push(sorted[next]);
            previousValue = nextValue;
          }
        }

        while (candidate.length < 3 && usedWilds < wildCards.length) {
          candidate.push(wildCards[usedWilds]);
          usedWilds += 1;
        }

        if (candidate.length >= 3) {
          melds.push({ type: 'sequence', cards: [...candidate] });
        }
      }
    });

    return melds;
  }

  _meldStrategicScore(meld) {
    if (!meld || !Array.isArray(meld.cards)) return 0;
    const isSequence = meld.type === 'sequence';
    const wildCount = meld.cards.filter((c) => this._isWild(c)).length;
    const points = this._estimateMeldPoints(meld.cards);
    const lengthBonus = meld.cards.length * 20;
    const sequenceBonus = isSequence ? 40 : 0;
    const wildPenalty = wildCount * 8;
    return lengthBonus + sequenceBonus + points - wildPenalty;
  }

  _rankValue(rank) {
    const rankOrder = {
      A: 1,
      '2': 2,
      '3': 3,
      '4': 4,
      '5': 5,
      '6': 6,
      '7': 7,
      '8': 8,
      '9': 9,
      '10': 10,
      J: 11,
      Q: 12,
      K: 13,
    };

    return rankOrder[String(rank)] || 0;
  }

  _canAddCardToMeld(meld, card) {
    if (!Array.isArray(meld) || meld.length < 3) return false;
    if (!card || this._isWild(card)) return false;

    const nonWild = meld.filter((m) => !this._isWild(m));
    if (nonWild.length < 2) return false;

    const isSet = nonWild.every((m) => String(m.rank) === String(nonWild[0].rank));
    if (isSet) {
      if (String(card.rank) !== String(nonWild[0].rank)) return false;
      const targetSuit = this._normalizeSuit(card.suit);
      return !nonWild.some((m) => this._normalizeSuit(m.suit) === targetSuit);
    }

    const sameSuit = nonWild.every((m) => String(m.suit) === String(nonWild[0].suit));
    if (!sameSuit) return false;
    if (String(card.suit) !== String(nonWild[0].suit)) return false;

    const values = nonWild
      .map((m) => this._rankValue(m.rank))
      .sort((left, right) => left - right);
    const candidate = this._rankValue(card.rank);
    const min = values[0];
    const max = values[values.length - 1];
    return candidate === min - 1 || candidate === max + 1;
  }

  _normalizeSuit(suit) {
    return String(suit || '').trim().toLowerCase();
  }

  _estimateMeldPoints(cards) {
    if (!Array.isArray(cards)) return 0;
    return cards.reduce((sum, card) => sum + this._cardValue(card), 0);
  }

  _cardValue(card) {
    const rank = String(card?.rank || '');
    if (rank === 'joker') return 30;
    if (rank === '2') return 20;
    if (rank === 'A') return 15;
    if (['K', 'Q', 'J', '10', '9', '8'].includes(rank)) return 10;
    if (['7', '6', '5', '4', '3'].includes(rank)) return 5;
    return 0;
  }

  _isWild(card) {
    const rank = String(card?.rank || '');
    return rank === '2' || rank === 'joker';
  }

  _cloneCards(cards) {
    if (!Array.isArray(cards)) return [];
    return cards.map((card) => ({ suit: card.suit, rank: card.rank }));
  }

  _removeCardsFromHand(hand, cardsToRemove) {
    if (!Array.isArray(hand) || !Array.isArray(cardsToRemove)) return;
    cardsToRemove.forEach((card) => {
      const index = hand.findIndex(
        (h) => String(h.suit) === String(card.suit) && String(h.rank) === String(card.rank)
      );
      if (index >= 0) {
        hand.splice(index, 1);
      }
    });
  }

  _clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }
}

module.exports = BotPlayer;