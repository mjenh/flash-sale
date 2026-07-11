# api image (ARCHITECTURE-SPINE Structural Seed): multi-stage — build client/dist,
# then node:24-alpine runs the server via native type stripping (no server build step).

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY stress/package.json stress/
RUN npm ci

FROM deps AS client-build
COPY client/ client/
RUN npm run build -w client

FROM node:24-alpine AS server-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY stress/package.json stress/
RUN npm ci --omit=dev --workspace server

FROM node:24-alpine
ENV NODE_ENV=production
ENV CLIENT_DIST_DIR=/app/client/dist
WORKDIR /app
COPY --from=server-deps /app/node_modules ./node_modules
COPY server/package.json server/
COPY server/src server/src
COPY --from=client-build /app/client/dist client/dist
EXPOSE 3000
USER node
WORKDIR /app/server
CMD ["node", "src/index.ts"]
