FROM node:22-alpine AS base
RUN apk add --no-cache openssl
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages
RUN corepack pnpm install --frozen-lockfile
ENV AUTH_SECRET=build-time-placeholder
RUN corepack pnpm build

FROM build AS migrate
WORKDIR /app/packages/db
CMD ["sh", "-c", "corepack pnpm exec prisma migrate deploy && corepack pnpm exec tsx prisma/seed.ts"]

FROM build AS api
ENV NODE_ENV=production
CMD ["node", "apps/api/dist/index.js"]

FROM build AS worker
ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/index.js"]

FROM base AS web
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
CMD ["node", "apps/web/server.js"]
