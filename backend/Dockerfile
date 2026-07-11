# Backend: Node 24 native type stripping — runs .ts directly, no build step.
FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

USER node
CMD ["node", "src/index.ts"]
