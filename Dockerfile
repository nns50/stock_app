# syntax=docker/dockerfile:1

# ---- build stage: install ALL deps (dev tooling included) + build server and web ----
FROM node:22-bookworm AS build
WORKDIR /app
# Install with the lockfile first for better layer caching.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci
COPY . .
RUN npm run build

# ---- prod-deps stage: the runtime's node_modules, dev tooling excluded ----
# A separate `npm ci --omit=dev` install (not a copy of the build stage's
# node_modules): the build needs typescript/vite/vitest/eslint, the runtime
# does not, and shipping them roughly triples the image's node_modules while
# widening its attack surface for zero benefit. Same lockfile → identical
# prod dependency resolution, and better-sqlite3's native build runs here on
# the full (non-slim) image exactly as it does in the build stage.
FROM node:22-bookworm AS proddeps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev

# ---- runtime stage: slim image running the API + serving the built frontend ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Dependencies: BOTH the hoisted root node_modules AND the server's nested
# ones. npm nests a package under a workspace whenever its version conflicts
# with the hoisted copy — server/node_modules/undici today — and copying only
# the root silently dropped those: the server's require('undici') then
# resolved to whatever same-named package some OTHER workspace happened to
# hoist (for a long time, jsdom's older undici — a different major than the
# one the server declares), and to nothing at all once that coincidence went
# away. (web/ nests only build tooling; its runtime output is static files.)
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=proddeps /app/server/node_modules ./server/node_modules
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
# Liveness probe via the app's own health endpoint (Node has global fetch; the
# slim image has no curl).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
