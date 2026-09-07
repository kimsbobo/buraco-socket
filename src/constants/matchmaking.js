/**
 * Matchmaking Constants
 */

const MatchmakingEvents = {
  // Client -> Server
  JOIN_QUEUE: 'matchmaking:join',
  LEAVE_QUEUE: 'matchmaking:leave',
  GET_STATUS: 'matchmaking:status',
  
  // Server -> Client
  QUEUE_JOINED: 'matchmaking:queue_joined',
  QUEUE_LEFT: 'matchmaking:queue_left',
  MATCH_FOUND: 'matchmaking:match_found',
  MATCHMAKING_TIMEOUT: 'matchmaking:timeout',
  MATCHMAKING_ERROR: 'matchmaking:error',
  QUEUE_UPDATE: 'matchmaking:queue_update',
};

const MatchmakingStatus = {
  IDLE: 'idle',
  IN_QUEUE: 'in_queue',
  MATCHED: 'matched',
  TIMEOUT: 'timeout',
  ERROR: 'error',
};

const SkillLevel = {
  BEGINNER: 'beginner',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced',
  ANY: 'any',
};

module.exports = {
  MatchmakingEvents,
  MatchmakingStatus,
  SkillLevel,
};
