# Middleware

Socket middleware and error primitives.

## Files

- `errorHandler.js`  
  Wrapper for async socket handlers, structured error payload builders, and socket error emitter.

- `rateLimiter.js`  
  In-memory per-socket rate limiting based on configured window + max requests.

- `index.js`  
  Aggregated export.

## Runtime placement

Configured in `src/index.js` through `io.use(...)` before per-socket handler registration.
