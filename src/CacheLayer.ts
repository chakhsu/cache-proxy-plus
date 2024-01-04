import assert from 'assert'
import pTimeout from 'p-timeout'
import PQueue from 'p-queue'
import crypto from 'crypto'

import { Deferred } from 'sync-defer'
import { EventEmitter } from 'events'
import { attemptOptionsSchema, OptionsType } from './Schema'
import { SimpleStats } from './SimpleStats'
import { RemoteCache } from './RemoteCache'
import { LocalCache } from './LocalCache'

import Debug from 'debug'
const debug = Debug('cpp:CacheLayer')

export class CacheLayer extends EventEmitter {
  private options: OptionsType
  private concurrentControl = new Map()
  private remoteCache?: RemoteCache
  private localCache: LocalCache
  private pQueue: PQueue
  private stats: SimpleStats

  constructor(options?: OptionsType) {
    super()

    this.options = attemptOptionsSchema(options)

    const { remoteCache, concurrency, statsInterval } = this.options
    if (remoteCache) {
      assert(remoteCache instanceof RemoteCache, 'options.remoteCache must be an instance of RemoteCache')
      this.remoteCache = remoteCache
    }

    this.localCache = new LocalCache(this.options)
    this.pQueue = new PQueue({ concurrency })

    this.stats = new SimpleStats(statsInterval)

    this.stats.on('stats', stats => {
      this.emit('stats', stats)
    })

    this.localCache.on('bg.stats', stats => {
      this.emit('bg.stats', stats)
    })

    this.localCache.on('bg.break.off', key => {
      this.emit('bg.break.off', key)
    })

    this.localCache.on('error', err => {
      this.emit('error', err)
    })

    this.localCache.on('expired', (key, type, method) => {
      const markType = type === 'local' ? 'expired' : 'fallbackExpired'
      this.stats.mark(method, markType)
      this.emit('expired', key, type)
    })
  }

  wrap(target: any, method: string) {
    return async (...args: any[]) => {
      const { localCache, remoteCache } = this

      debug('target', target, method)

      const key = this.makeKey(args, method)
      debug('>>>> BEGIN:\t', key)

      // 第一步，检测本地缓存
      // 1: check local cache
      if (localCache.has(key)) {
        const wrapped = localCache.get(key)
        this.stats.mark(method, 'local')
        debug('<<<< END  - [local hit]:\t', key, wrapped.value)
        return wrapped.value
      }

      // 第二步，检测远程缓存
      // 2: check remote cache
      if (remoteCache) {
        const wrapped: any = await remoteCache.get(key)
        if (wrapped) {
          this.setCache(method, key, wrapped.value, { localOnly: true })

          this.stats.mark(method, 'remote')
          debug('<<<< END  - [remote hit]:\t', key, wrapped.value)
          return wrapped.value
        }
      }

      // 第三步，检测优先后备缓存
      // 3: check first fallback cache
      if (this.options.fallbackFirst && localCache.hasInFallback(key)) {
        const { isCached, value } = localCache.getFromFallback(key)
        if (isCached) {
          this.stats.mark(method, 'fallbackFirst')
          debug('<<<< END  - [fallbackFirst]:\t', key, value)
          // 先更新localCache，避免更多并发
          this.setCache(method, key, value, { localOnly: true })
          // 后台更新，localCache和remoteCache在后台会更新
          await this.updateBackground(target, method, args, key)
          return value
        }
      }

      // 第四步，检测并发控制
      // 4: check concurrency control
      const waitInConcurrent = this.checkConcurrent(key)
      if (waitInConcurrent) {
        try {
          this.stats.mark(method, 'wait')
          const value = await pTimeout(waitInConcurrent, {
            milliseconds: this.getTtl(method),
            message: 'CacheProxy - Timeout while waiting in concurrent'
          })
          debug('<<<< END  - [wait in concurrent]:\t', key, value)
          return value
        } catch (err: any) {
          debug('<<<< END  - [error after wait]:\t', key, err.message)
          this.stats.mark(method, 'failedWait')
          this.notifyWaiting(key, err, null)
          throw err
        }
      }

      try {
        // 第五步，缓存没命中，发起真正的请求
        // 5: cache no hit, try real call
        this.stats.mark(method, 'miss')
        const value = await this.updateForeground(target, method, args, key)
        this.setCache(method, key, value, { localOnly: false })
        this.notifyWaiting(key, null, value)
        debug('<<<< END  - [miss]:\t', key, value)
        this.checkNeedBackground(target, method, args, key)
        return value
      } catch (err: any) {
        // 第六步，当错误发生，检测后备缓存
        // 6: emit error, check fallback cache
        if (this.options.fallback && localCache.hasInFallback(key)) {
          const wrapped = localCache.getFromFallback(key)
          if (wrapped) {
            this.stats.mark(method, 'fallback')
            debug('<<<< END  - [fallback]:\t', key, wrapped.value)
            this.notifyWaiting(key, null, wrapped.value)
            return wrapped.value
          }
        }

        debug('<<<< END  - [error while update]:\t', key, err.message)
        this.stats.mark(method, 'failed')
        this.notifyWaiting(key, err, null)
        throw err
      }
    }
  }

  makeKey(args: any[], method: string) {
    const hash = crypto.createHash('sha1').update(JSON.stringify(args)).digest('base64').replace(/\W/g, '')
    return `${this.options.subject}:${method}:${hash}`
  }

  getStats() {
    return this.stats.get()
  }

  clear(method?: string) {
    if (method) {
      const fuzzyKey = `${this.options.subject}:${method}`
      this.localCache.fuzzyDelete(fuzzyKey)
    } else {
      this.localCache.clear()
    }
  }

  async updateBackground(target: any, method: string, args: any[], key: string) {
    setImmediate(async () => {
      try {
        this.stats.mark(method, 'background')
        const value = await this.updateForeground(target, method, args, key)
        this.setCache(method, key, value, { localOnly: false })
      } catch (err: any) {
        debug('updateBackground error:\t', err.message)
        err.message = `[Error CacheProxy UpdateBackground] ${err.message}`
        this.stats.mark(method, 'failedBackground')
        this.emit('error', err)
      }
    })
  }

  async updateForeground(target: any, method: string, args: any[], key: string) {
    debug('--->>>> try update:  ', key)
    this.stats.mark(method, 'update')
    const value = await this.pQueue.add(() =>
      pTimeout(target[method](...args), {
        milliseconds: this.getTtl(method),
        message: 'CacheProxy - Timeout while waiting in concurrent'
      })
    )
    debug('---<<<<  updated  :  ', key, value)
    return value
  }

  async setCache(method: string, key: string, value: any, { localOnly = false } = {}) {
    const ttl = this.randomTtl(method)
    this.localCache.set(key, value, ttl, method)
    if (!localOnly && this.remoteCache) {
      try {
        debug('  remoteCache.set: ', key, ttl)
        const wrapped = { value }
        await this.remoteCache.set(key, wrapped, ttl)
      } catch (err: any) {
        debug('updateCache error:\t', err.message)
        err.message = `[Error CacheProxy UpdateRemoteCache] ${err.message}`
        // remote cache 不影响继续运行，所以不抛出错误
        this.emit('error', err)
      }
    }
  }

  randomTtl(method: string) {
    const age = this.getTtl(method)
    if (this.options.randomTtl) {
      return age * (0.8 + 0.3 * Math.random())
    } else {
      return age
    }
  }

  getTtl(method: string) {
    const { methodTtls } = this.options
    return (methodTtls || {})[method] || this.options.ttl
  }

  checkConcurrent(key: string) {
    const { concurrentControl } = this
    if (concurrentControl.has(key)) {
      const deferred = new Deferred()
      const control = concurrentControl.get(key)
      control.waitingList.push(deferred)
      return deferred.promise
    } else {
      concurrentControl.set(key, { waitingList: [] })
      return null
    }
  }

  notifyWaiting(key: string, err: any, value: any) {
    const { concurrentControl } = this
    if (concurrentControl.has(key)) {
      const { waitingList } = concurrentControl.get(key)
      concurrentControl.delete(key)
      for (const deferred of waitingList) {
        err ? deferred.reject(err) : deferred.resolve(value)
      }
    }
  }

  checkNeedBackground(target: any, method: string, args: any[], key: string) {
    if (this.options.bgUpdate && this.localCache.notInBackground(key)) {
      const updateFunc = async () => {
        this.stats.mark(method, 'background')
        return this.updateForeground(target, method, args, key)
      }
      this.localCache.needBackgroundUpdate(key, updateFunc)
    }
  }
}
