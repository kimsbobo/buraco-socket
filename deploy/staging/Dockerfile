# Socket node image for the multi-node soak staging cluster (PTW-95).
# Same image serves as a socket node (CMD) and as a load generator
# (override CMD with `node bot/load-soak.js ...`).
FROM node:20-alpine

WORKDIR /app

# Install prod deps only (adapter + ioredis are prod deps).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App + soak driver.
COPY src ./src
COPY bot ./bot

EXPOSE 8080

# A socket node boots with the Redis adapter on; NODE_ID/PORT/REDIS_* come from
# the environment (compose / k8s downward API). See deploy/staging/README.md.
CMD ["node", "src/index.js"]
