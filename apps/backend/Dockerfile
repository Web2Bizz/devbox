# syntax=docker/dockerfile:1
# deps (cached layer, full workspace install — swc + nest cli needed for build)
# NPM_TOKEN via BuildKit secret only (never --build-arg / ENV):
#   docker build --secret id=NPM_TOKEN,src=$NPM_TOKEN_FILE -f apps/backend/Dockerfile .
# .npmrc + bunfig.toml [install.scopes] reference ${NPM_TOKEN} / $NPM_TOKEN placeholder.
FROM oven/bun:1.4.2 AS deps
WORKDIR /app
COPY package.json bun.lock* bunfig.toml .npmrc .bun-version ./
COPY apps/backend/package.json ./apps/backend/
RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN bun install

# build (NestJS 12 + SWC → dist/main.js, typecheck via tsc --noEmit, executed by the bun runtime)
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock* bunfig.toml tsconfig.base.json ./
COPY apps/backend ./apps/backend
WORKDIR /app/apps/backend
RUN bun run build

# runner (bun user ships with oven/bun images, production deps only)
FROM oven/bun:1.4.2 AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY package.json bun.lock* bunfig.toml .npmrc .bun-version ./
COPY apps/backend/package.json ./apps/backend/
RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN bun install --production
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
WORKDIR /app/apps/backend
USER bun
EXPOSE 3000
CMD ["bun", "dist/main.js"]
