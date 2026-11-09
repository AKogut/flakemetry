FROM node:22-alpine AS base
RUN apk add --no-cache openssl
RUN corepack enable
ENV COREPACK_HOME=/usr/local/share/corepack
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages
RUN corepack pnpm install --frozen-lockfile
RUN AUTH_SECRET=build-time-placeholder corepack pnpm turbo run build --filter @flakemetry/api... --filter @flakemetry/worker... --filter @flakemetry/web...

FROM build AS pruned
RUN corepack pnpm --filter @flakemetry/api deploy --legacy --prod --no-optional /prod/api
RUN corepack pnpm --filter @flakemetry/worker deploy --legacy --prod --no-optional /prod/worker
RUN corepack pnpm --filter @flakemetry/db deploy --legacy --prod /prod/migrate
RUN cp -R packages/db/src /prod/migrate/src
RUN set -eu; \
    for target in api worker migrate; do \
      cp -R node_modules/.pnpm/@prisma+client@*/node_modules/.prisma /prod/$target/node_modules/.pnpm/@prisma+client@*/node_modules/; \
      test -f /prod/$target/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/index.js; \
    done
RUN test -x /prod/migrate/node_modules/.bin/prisma && test -x /prod/migrate/node_modules/.bin/tsx
RUN test -x /prod/migrate/node_modules/.pnpm/@prisma+engines@*/node_modules/@prisma/engines/schema-engine-linux-musl*

FROM base AS migrate
COPY --from=pruned /usr/local/share/corepack /usr/local/share/corepack
COPY package.json ./
COPY --from=pruned /prod/migrate packages/db
WORKDIR /app/packages/db
CMD ["sh", "-c", "corepack pnpm exec prisma migrate deploy && corepack pnpm exec tsx prisma/seed.ts"]

FROM base AS api
ENV NODE_ENV=production
COPY --from=pruned /prod/api apps/api
CMD ["node", "apps/api/dist/index.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=pruned /prod/worker apps/worker
CMD ["node", "apps/worker/dist/index.js"]

FROM base AS web
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
CMD ["node", "apps/web/server.js"]
