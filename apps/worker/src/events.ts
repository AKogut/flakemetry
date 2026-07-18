export interface DomainEventMap {
  'run.processed': {
    runId: string
    projectId: string
    executions: number
    newIdentities: number
    movedIdentities: number
  }
  'identity.created': {
    testIdentityId: string
    projectId: string
    fingerprint: string
  }
  'identity.moved': {
    testIdentityId: string
    projectId: string
    alias: string
  }
  'score.updated': {
    testIdentityId: string
    projectId: string
    score: number
    quarantineCandidate: boolean
  }
}

export type DomainEventName = keyof DomainEventMap

export type DomainEventHandler<K extends DomainEventName> = (payload: DomainEventMap[K]) => void

export interface EventBus {
  emit: <K extends DomainEventName>(name: K, payload: DomainEventMap[K]) => void
  on: <K extends DomainEventName>(name: K, handler: DomainEventHandler<K>) => () => void
}

export const createEventBus = (
  onHandlerError: (error: unknown) => void = () => undefined,
): EventBus => {
  const handlers = new Map<DomainEventName, Set<DomainEventHandler<DomainEventName>>>()

  return {
    emit(name, payload) {
      for (const handler of handlers.get(name) ?? []) {
        try {
          ;(handler as DomainEventHandler<typeof name>)(payload)
        } catch (error) {
          onHandlerError(error)
        }
      }
    },
    on(name, handler) {
      const set = handlers.get(name) ?? new Set()
      set.add(handler as DomainEventHandler<DomainEventName>)
      handlers.set(name, set)
      return () => {
        set.delete(handler as DomainEventHandler<DomainEventName>)
      }
    },
  }
}
