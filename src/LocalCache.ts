import { LRUCache } from 'lru-cache'
import { EventEmitter } from 'events'
import { OptionsType } from './Schema'

import Debug from 'debug'
const debug = Debug('cpp:LocalCache')

export class LocalCache extends EventEmitter {
  private _options: OptionsType
  private _mainCache = new Map()
  private _needBgUpdateMap = new Map()
  private _defaultTtl = 1000 * 60
  private _fallbackCache?: LRUCache<string, any>
  private _needBgUpdateTimer?: NodeJS.Timeout

  constructor(options: OptionsType) {
    super()
    this._options = options

    setTimeout(() => this._checkInvalid(), this._options.checkPeriod).unref()

    if (this._options.fallback) {
      this._fallbackCache = new LRUCache({
        max: this._options.fallbackMax,
        ttl: this._options.fallbackTtl,
        noDisposeOnSet: true, // 在set()的时候不要触发dispose()
        dispose: (key, wrapped: any) => {
          this.emit('expired', key, 'fallback', wrapped.method)
          debug('localCache.fallback.expired: ', key)
        }
      })
    }
  }

  private _checkInvalid() {
    for (const [key, wrapped] of this._mainCache.entries()) {
      if (Date.now() - wrapped.timestamp > (wrapped.ttl || this._defaultTtl)) {
        if (this._fallbackCache) {
          this._fallbackCache.set(key, { value: wrapped.value, method: wrapped.method })
        }
        this._mainCache.delete(key)
        this.emit('expired', key, 'local', wrapped.method)
        debug('localCache.expired: ', key)
      }
    }

    setTimeout(() => this._checkInvalid(), this._options.checkPeriod).unref()
  }

  has(key: string) {
    return this._mainCache.has(key)
  }

  get(key: string) {
    if (this._needBgUpdateMap.has(key)) {
      const { updateFunc } = this._needBgUpdateMap.get(key)
      this._needBgUpdateMap.set(key, { updateFunc, timestamp: Date.now() })
    }

    const wrapped = this._mainCache.get(key)
    if (wrapped) {
      return { isCached: true, value: wrapped.value }
    } else {
      return { isCached: false, value: undefined }
    }
  }

  set(key: string, value: any, ttl?: number, method?: any) {
    debug('localCache.set: ', key, ttl)
    return this._mainCache.set(key, { value, timestamp: Date.now(), ttl, method })
  }

  hasInFallback(key: string) {
    return this._fallbackCache ? this._fallbackCache.has(key) : false
  }

  getFromFallback(key: string) {
    if (!this._fallbackCache) {
      return { isCached: false, value: undefined }
    }

    const wrapped: any = this._fallbackCache.get(key)
    if (wrapped) {
      return { isCached: true, value: wrapped.value }
    } else {
      return { isCached: false, value: undefined }
    }
  }

  notInBackground(key: string) {
    return !this._needBgUpdateMap.has(key)
  }

  needBackgroundUpdate(key: string, updateFunc: any) {
    if (!this._needBgUpdateMap.has(key)) {
      debug('localCache.needBackgroundCache.set: ', key)
      this._needBgUpdateMap.set(key, { updateFunc, timestamp: Date.now() })
      if (!this._needBgUpdateTimer) {
        this._resetBgUpdateTimer()
      }
    }
  }

  private _resetBgUpdateTimer(delay = 0) {
    clearTimeout(this._needBgUpdateTimer)
    this._needBgUpdateTimer = setTimeout(() => this._updateBackground(), delay)
  }

  private async _updateBackground() {
    if (this._needBgUpdateMap.size === 0) {
      this._resetBgUpdateTimer(1000)
      return
    }

    const { bgUpdateExpired, bgUpdateDelay, bgUpdatePeriodDelay } = this._options
    const startTime = Date.now()
    let totalDelay = 0
    for (const key of this._needBgUpdateMap.keys()) {
      try {
        const { updateFunc, timestamp } = this._needBgUpdateMap.get(key)
        if (Date.now() - timestamp > bgUpdateExpired) {
          // 检测很久没有执行get操作的key，不再执行background update
          debug('localCache.needBackgroundCache.delete: ', key)
          this._needBgUpdateMap.delete(key)
          this.emit('bg.break.off', key)
          continue
        }

        const wrapped = this._mainCache.get(key)
        if (wrapped) {
          const value = await updateFunc()
          debug('localCache.updateBackground: ', key)
          const { ttl, method } = wrapped
          this._mainCache.set(key, { value, timestamp: Date.now(), ttl, method })

          await new Promise(resolve => setTimeout(resolve, bgUpdateDelay))
          totalDelay += bgUpdateDelay
        }
      } catch (err: any) {
        debug('localCache.updateBackground.error: ', key, err.message)
        this.emit('error', err)
      }
    }

    const cycleTime = Date.now() - startTime

    this.emit('bg.stats', {
      cycleTime,
      delayTime: totalDelay,
      updateTime: cycleTime - totalDelay,
      updatedSize: this._needBgUpdateMap.size
    })

    this._resetBgUpdateTimer(cycleTime > bgUpdatePeriodDelay ? 0 : bgUpdatePeriodDelay)
  }
}
