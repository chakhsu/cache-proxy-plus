import { EventEmitter } from 'events'
import { cloneDeep } from 'lodash-es'

export class SimpleStats extends EventEmitter {
  private _currentStats: Record<string, number>
  private _totalStats: Record<string, number>
  private _methodStats: Record<string, Record<string, number>>

  constructor(statsInterval: number) {
    super()

    this._currentStats = this._buildEmptyStats()
    this._totalStats = this._buildEmptyStats()
    this._methodStats = {}

    setInterval(() => {
      const { current, total, methods } = this.get()
      this.reset()

      this.emit('stats', { current, total, methods })
    }, statsInterval).unref()
  }

  private _buildEmptyStats() {
    return {
      local: 0,
      remote: 0,
      update: 0,
      miss: 0,
      expired: 0,
      wait: 0,
      failed: 0,
      failedWait: 0,
      background: 0,
      failedBackground: 0,
      fallback: 0,
      fallbackFirst: 0,
      fallbackExpired: 0
    }
  }

  reset() {
    // total stats 不会被重置
    this._currentStats = this._buildEmptyStats()

    Object.keys(this._methodStats).map(key => {
      this._methodStats[key] = this._buildEmptyStats()
    })
  }

  mark(method: string, type: string) {
    this._currentStats[type] += 1
    this._totalStats[type] += 1

    this._methodStats[method] = this._methodStats[method] || this._buildEmptyStats()
    this._methodStats[method][type] += 1
  }

  get() {
    return {
      total: Object.assign({}, this._totalStats),
      current: Object.assign({}, this._currentStats),
      methods: cloneDeep(this._methodStats)
    }
  }
}
