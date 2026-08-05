import { getPrismaClient } from '@flakemetry/db'
import { BADGE_VARIANTS, getBadgeMetrics, toBadge } from '@flakemetry/queries'

import { disableBadges, rotateBadgeToken } from '@/lib/actions'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const VARIANT_LABELS: Record<string, string> = {
  health: 'Flaky health',
  flakes: 'Flakes this week',
  quarantined: 'Quarantined tests',
  worst: 'Worst test score',
}

export default async function BadgesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params
  const user = await requireUser()
  const project = await requireProjectAccess(user.id, projectId)
  const canEdit = project.role === 'owner' || project.role === 'admin'

  const record = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { badgeToken: true, name: true },
  })
  const metrics = await getBadgeMetrics(prisma, projectId)

  const apiBase = (process.env.FLAKEMETRY_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
    /\/$/,
    '',
  )

  return (
    <>
      <h1 className="page-title">Badges</h1>
      <p className="page-subtitle">
        Embeddable health badges for this project&apos;s README. They are served without credentials
        — GitHub&apos;s image proxy sends none — so the token in the URL is what authorises them. It
        is read-only and exposes nothing but the numbers shown below.
      </p>

      {!record.badgeToken ? (
        <div className="card">
          <p>Badges are off for this project.</p>
          {canEdit ? (
            <form action={rotateBadgeToken}>
              <input type="hidden" name="projectId" value={projectId} />
              <button className="btn" type="submit" style={{ marginTop: '0.75rem' }}>
                Enable badges
              </button>
            </form>
          ) : (
            <p className="muted">Ask an owner or admin to enable them.</p>
          )}
        </div>
      ) : (
        <>
          {BADGE_VARIANTS.map((variant) => {
            const badge = toBadge(variant, metrics)
            const url = `${apiBase}/badge/${record.badgeToken}/${variant}.svg`
            const markdown = `[![${badge.label}](${url})](${apiBase.replace(':4000', ':3000')}/projects/${projectId}/flaky)`
            return (
              <div className="card" key={variant} style={{ marginBottom: '1rem' }}>
                <div className="row-between">
                  <div>
                    <strong>{VARIANT_LABELS[variant]}</strong>
                    <div className="muted" style={{ fontSize: '0.82rem' }}>
                      currently {badge.message}
                    </div>
                  </div>
                  <img src={url} alt={`${badge.label}: ${badge.message}`} height={20} />
                </div>
                <pre className="error-box" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                  {markdown}
                </pre>
              </div>
            )
          })}

          {canEdit ? (
            <div className="card">
              <strong>Rotating the token</strong>
              <p className="muted" style={{ fontSize: '0.85rem' }}>
                Every badge already embedded anywhere stops working and has to be updated. That is
                what makes the token revocable.
              </p>
              <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.75rem' }}>
                <form action={rotateBadgeToken}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <button className="btn btn-secondary" type="submit">
                    Rotate
                  </button>
                </form>
                <form action={disableBadges}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <button className="btn btn-secondary" type="submit">
                    Turn off
                  </button>
                </form>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  )
}
