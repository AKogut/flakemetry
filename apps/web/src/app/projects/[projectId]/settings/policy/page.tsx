import type { PolicySource } from '@flakemetry/contracts'
import { getPrismaClient } from '@flakemetry/db'
import { getEffectiveProjectPolicy, listPolicyChanges } from '@flakemetry/queries'

import { updateProjectPolicy } from '@/lib/actions'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const FIELD_LABELS: Record<string, string> = {
  flakyThreshold: 'Flaky threshold',
  minSamples: 'Minimum samples',
  quarantineEnabled: 'Auto-quarantine',
  quarantineCooldownRuns: 'Quarantine cooldown (runs)',
  aiRcaEnabled: 'AI root-cause analysis',
}

const formatDateTime = (date: Date): string =>
  new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)

const sourceLabel = (source: PolicySource): string =>
  source === 'ui' ? 'UI' : source === 'env' ? 'env' : 'default'

function SourceBadge({ source }: { source: PolicySource }) {
  return <span className={`src src-${source}`}>{sourceLabel(source)}</span>
}

function Effective({ value, source }: { value: number | boolean; source: PolicySource }) {
  const shown = typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value)
  return (
    <div className="policy-effective">
      effective <span className="mono">{shown}</span>
      <SourceBadge source={source} />
    </div>
  )
}

function EnvNote({ source }: { source: PolicySource }) {
  if (source !== 'env') return null
  return (
    <p className="policy-help" style={{ color: 'var(--flaky)' }}>
      An environment variable currently overrides this — the value above is what scoring uses.
    </p>
  )
}

function PendingNote({ live }: { live: boolean }) {
  if (live) return null
  return <p className="policy-help">Stored now; enforced once the consuming feature ships.</p>
}

export default async function PolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ saved?: string }>
}) {
  const { projectId } = await params
  const { saved } = await searchParams
  const user = await requireUser()
  const project = await requireProjectAccess(user.id, projectId)
  const canEdit = project.role === 'owner' || project.role === 'admin'

  const { effective, stored } = await getEffectiveProjectPolicy(prisma, projectId)
  const changes = await listPolicyChanges(prisma, projectId)

  const eff = effective
  const numberValue = (key: 'flakyThreshold' | 'minSamples' | 'quarantineCooldownRuns'): string =>
    stored[key] === undefined ? '' : String(stored[key])
  const tristateValue = (key: 'quarantineEnabled' | 'aiRcaEnabled'): string =>
    stored[key] === undefined ? 'inherit' : stored[key] ? 'on' : 'off'

  return (
    <>
      <h1 className="page-title">Policy</h1>
      <p className="page-subtitle">
        Scoring and quarantine thresholds for this project. Precedence is{' '}
        <span className="mono">defaults → UI → env</span>: a value you set here overrides the
        built-in default, and an <span className="mono">FLAKEMETRY_*</span> environment variable
        overrides both. Leave a field blank to inherit the default.
      </p>

      {saved ? (
        <div className="notice-box">
          {Number(saved) > 0
            ? `Saved — ${saved} field${Number(saved) === 1 ? '' : 's'} updated. New values apply on the next run.`
            : 'No changes to save.'}
        </div>
      ) : null}

      {!canEdit ? (
        <div className="notice-box" style={{ borderLeftColor: 'var(--muted)' }}>
          You have read-only access. Only owners and admins can change policy.
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <form action={updateProjectPolicy}>
          <input type="hidden" name="projectId" value={projectId} />
          <fieldset disabled={!canEdit} style={{ border: 'none', margin: 0, padding: 0 }}>
            <div className="policy-field">
              <div>
                <label htmlFor="flakyThreshold">{FIELD_LABELS.flakyThreshold}</label>
                <input
                  id="flakyThreshold"
                  name="flakyThreshold"
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  placeholder="0.8 (default)"
                  defaultValue={numberValue('flakyThreshold')}
                />
              </div>
              <Effective value={eff.flakyThreshold.value} source={eff.flakyThreshold.source} />
              <p className="policy-help">
                A test scoring at or above this is flagged as a quarantine candidate. Feeds scoring
                directly. Range 0–1.
              </p>
              <EnvNote source={eff.flakyThreshold.source} />
            </div>

            <div className="policy-field">
              <div>
                <label htmlFor="minSamples">{FIELD_LABELS.minSamples}</label>
                <input
                  id="minSamples"
                  name="minSamples"
                  type="number"
                  step="1"
                  min="1"
                  placeholder="5 (default)"
                  defaultValue={numberValue('minSamples')}
                />
              </div>
              <Effective value={eff.minSamples.value} source={eff.minSamples.source} />
              <p className="policy-help">
                Executions required before a score can flag a test. Feeds scoring directly.
              </p>
              <EnvNote source={eff.minSamples.source} />
            </div>

            <div className="policy-field">
              <div>
                <label htmlFor="quarantineEnabled">{FIELD_LABELS.quarantineEnabled}</label>
                <select
                  id="quarantineEnabled"
                  name="quarantineEnabled"
                  defaultValue={tristateValue('quarantineEnabled')}
                >
                  <option value="inherit">Default (off)</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
              <Effective
                value={eff.quarantineEnabled.value}
                source={eff.quarantineEnabled.source}
              />
              <PendingNote live={false} />
              <EnvNote source={eff.quarantineEnabled.source} />
            </div>

            <div className="policy-field">
              <div>
                <label htmlFor="quarantineCooldownRuns">
                  {FIELD_LABELS.quarantineCooldownRuns}
                </label>
                <input
                  id="quarantineCooldownRuns"
                  name="quarantineCooldownRuns"
                  type="number"
                  step="1"
                  min="1"
                  placeholder="20 (default)"
                  defaultValue={numberValue('quarantineCooldownRuns')}
                />
              </div>
              <Effective
                value={eff.quarantineCooldownRuns.value}
                source={eff.quarantineCooldownRuns.source}
              />
              <PendingNote live={false} />
              <EnvNote source={eff.quarantineCooldownRuns.source} />
            </div>

            <div className="policy-field">
              <div>
                <label htmlFor="aiRcaEnabled">{FIELD_LABELS.aiRcaEnabled}</label>
                <select
                  id="aiRcaEnabled"
                  name="aiRcaEnabled"
                  defaultValue={tristateValue('aiRcaEnabled')}
                >
                  <option value="inherit">Default (on)</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
              <Effective value={eff.aiRcaEnabled.value} source={eff.aiRcaEnabled.source} />
              <PendingNote live={false} />
              <EnvNote source={eff.aiRcaEnabled.source} />
            </div>

            {canEdit ? (
              <button className="btn" type="submit" style={{ marginTop: '1.25rem' }}>
                Save policy
              </button>
            ) : null}
          </fieldset>
        </form>
      </div>

      <h2 className="page-title" style={{ fontSize: '1.1rem' }}>
        Change history
      </h2>
      <div className="card">
        {changes.length === 0 ? (
          <div className="empty">No policy changes yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Field</th>
                <th>Change</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.id}>
                  <td className="muted">{formatDateTime(change.createdAt)}</td>
                  <td>{FIELD_LABELS[change.field] ?? change.field}</td>
                  <td className="mono">
                    {change.oldValue ?? 'default'} → {change.newValue ?? 'default'}
                  </td>
                  <td className="muted">{change.actor ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
