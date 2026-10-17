# syntax=docker/dockerfile:1
# Next.js frontend (App Router) — oven/bun:1.4.2 multi-stage (matches engines bun>=1.4.2, node>=22 fallback).
# NEXT_PUBLIC_* vars are inlined into the browser bundle at `next build` time,
# so they must arrive as build ARGs (see docker-compose.yml), not runtime env.
# NPM_TOKEN via BuildKit secret only (never --build-arg / ENV):
#   docker build --secret id=NPM_TOKEN,src=$NPM_TOKEN_FILE -f apps/frontend/Dockerfile .

FROM oven/bun:1.4.2 AS deps
WORKDIR /app
COPY package.json bun.lock* bunfig.toml .npmrc .bun-version ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN bun install

FROM oven/bun:1.4.2 AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock* bunfig.toml ./
COPY tsconfig.base.json ./
COPY apps/frontend ./apps/frontend
WORKDIR /app/apps/frontend
RUN bun run build:next

# standalone server (next.config.mjs: output 'standalone'), executed by the bun runtime
FROM oven/bun:1.4.2 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=bun:bun /app/apps/frontend/.next/standalone ./
COPY --from=build --chown=bun:bun /app/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=build --chown=bun:bun /app/apps/frontend/public ./apps/frontend/public
RUN mkdir -p ./apps/frontend/.next/cache/images && chown -R bun:bun ./apps/frontend/.next
USER bun
EXPOSE 3000
CMD ["bun", "apps/frontend/server.js"]
