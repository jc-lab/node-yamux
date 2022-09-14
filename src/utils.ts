import * as events from 'events'

export function trackedMap<K, V> (opts?: any): Map<K, V> {
  return new Map<K, V>()
}

interface AbortSignal {
  aborted: boolean
}

export class AbortController extends events.EventEmitter {
  public signal: AbortSignal = {
    aborted: false
  }

  public abort (): void {
    this.signal.aborted = true
    this.emit('abort')
  }
}
