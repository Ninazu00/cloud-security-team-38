FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY fixtures ./fixtures

ENV NODE_ENV=production
ENV PORT=3002

USER node
EXPOSE 3002

CMD ["node", "src/server.js"]
