# syntax=docker/dockerfile:1
#
# One image for the API, the background worker and the migration runner —
# they are the same compiled code with a different entry point:
#   API       node dist/index.js      (default CMD)
#   worker    node dist/worker.js
#   migrate   node dist/db/migrate.js
#
# Multi-stage so the runtime image carries production dependencies and
# compiled JavaScript only — no TypeScript, no tsx, no test tooling.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# tsc emits dist/, and the build script copies the .sql migrations beside
# dist/db/migrate.js, which resolves them relative to its own file.
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Uploaded documents and tesseract's downloaded language data are the only
# things written at runtime, so only those two directories belong to `node`.
# Not `chown -R /app`: re-owning files an earlier layer copied rewrites every
# one of them into a new layer, doubling the image (~250 MB of node_modules).
RUN mkdir -p storage .tesseract && chown node:node storage .tesseract
USER node
EXPOSE 5000
CMD ["node", "dist/index.js"]
