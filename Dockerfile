# syntax=docker/dockerfile:1

# ---- build stage: install deps + build server and web ----
FROM node:22-bookworm AS build
WORKDIR /app
# Install with the lockfile first for better layer caching.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage: slim image running the API + serving the built frontend ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Dependencies (hoisted to the workspace root) + the better-sqlite3 native binary.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# Server: built JS + bundled data (sp500.json).
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/data ./server/data
# Frontend: built static assets, served by Express.
COPY --from=build /app/web/dist ./web/dist

ENV PORT=3001
ENV PUBLIC_DIR=/app/web/dist
# Keep the SQLite db on a separate path so a mounted volume doesn't shadow
# the bundled sp500.json under server/data.
ENV DATABASE_PATH=/app/data/stock_app.db
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
