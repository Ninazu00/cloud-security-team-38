# Multi-stage: build dependencies with dev packages available, then copy only
# what production needs into a runtime image that cannot install anything.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app

# The container runs as the unprivileged user the image already provides.
# Without this a compromise inside the process starts as root.
USER node

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# The image's own health is the process's liveness, not its ability to reach the
# database: the platform restarts on this, and a database timeout must not
# become a restart loop.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form so node is PID 1 and receives SIGTERM directly; `npm start` would
# swallow the signal and the 10-second drain would never run.
CMD ["node", "src/server.js"]
