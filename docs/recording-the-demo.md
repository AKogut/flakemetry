# Recording the demo GIF

`docs/demo.gif` is a three-frame slideshow of the dashboard on the demo dataset: the **flaky board**,
an **explainable score** with reason codes, and the **AI root-cause** panel. It is generated
headlessly — no manual screen capture — so it stays reproducible as the UI evolves.

The one wrinkle is auth: the dashboard is behind GitHub OAuth. Rather than automate a real sign-in, the
recipe inserts a database session directly (Auth.js uses `session.strategy: 'database'`) and hands its
token to the browser as a cookie.

## Prerequisites

`ffmpeg`, a Playwright Chromium build (`npx playwright install chromium`), and a Postgres instance.

## 1. Seed the demo dataset and a signed-in session

```bash
export DATABASE_URL="postgresql://flakemetry:flakemetry@localhost:5432/flakemetry?schema=public"
pnpm --filter @flakemetry/db exec prisma migrate deploy
pnpm demo   # seeds the org / project / runs / flaky scores / RCA report
```

Create a demo user with a membership and a session row, and print the ids the screenshots need
(run this as a throwaway `tsx` script inside `packages/db`, importing `PrismaClient` from
`@prisma/client`):

```ts
const org = await prisma.org.findFirstOrThrow()
const project = await prisma.project.findFirstOrThrow()
const user = await prisma.user.upsert({
  where: { email: 'demo@flakemetry.dev' },
  update: {},
  create: { name: 'Demo User', email: 'demo@flakemetry.dev' },
})
await prisma.membership.upsert({
  where: { userId_orgId: { userId: user.id, orgId: org.id } },
  update: {},
  create: { userId: user.id, orgId: org.id, role: 'owner' },
})
const sessionToken = randomBytes(24).toString('hex')
await prisma.session.create({
  data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 7 * 864e5) },
})
// print sessionToken, project.id, a flaky testIdentityId, and the RCA test's testIdentityId
```

## 2. Serve the dashboard

```bash
pnpm --filter @flakemetry/web build
DATABASE_URL="$DATABASE_URL" AUTH_SECRET="demo-only" AUTH_GITHUB_ID=x AUTH_GITHUB_SECRET=x \
  AUTH_URL=http://localhost:3100 AUTH_TRUST_HOST=true \
  pnpm --filter @flakemetry/web exec next start -p 3100
```

## 3. Screenshot the three beats

With `playwright-core`, add the session cookie and capture each page at a fixed viewport:

```js
await context.addCookies([
  { name: 'authjs.session-token', value: sessionToken, url: 'http://localhost:3100', httpOnly: true, sameSite: 'Lax' },
])
// /projects/<id>/flaky            → frame01.png  (the ranked board)
// /projects/<id>/tests/<flakyId>  → frame02.png  (score + reason codes)
// /projects/<id>/tests/<rcaId>    → frame03.png  (the RCA panel)
```

## 4. Stitch into a GIF

```bash
ffmpeg -y -framerate 1/3 -i frame%02d.png -vf "scale=1200:-1:flags=lanczos,palettegen=stats_mode=diff" palette.png
ffmpeg -y -framerate 1/3 -i frame%02d.png -i palette.png \
  -lavfi "scale=1200:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" -loop 0 docs/demo.gif
```

Three frames, ~3s each, ~260 KB — small enough to render inline on GitHub.
