import Redis from 'ioredis'
import Bluebird from 'bluebird'
import { cacheProxy, RemoteCache } from '../src'

class Manager {
  async doJob(id: number) {
    return Math.random()
  }
}

class RedisCache extends RemoteCache {
  private redis = new Redis()
  constructor() {
    super()
  }

  async set(key: string, value: any, ttl: number) {
    const wrapped = { value }
    return this.redis.set(key, JSON.stringify(wrapped), 'PX', ttl + 100)
  }

  async get(key: string) {
    const wrapped = await this.redis.get(key)
    return wrapped ? JSON.parse(wrapped).value : null
  }

  quit() {
    this.redis.disconnect()
    this.redis.quit()
  }
}

describe('RemoteCache', () => {
  test('Should cache to redis', async () => {
    const remoteCache = new RedisCache()
    const manager = new Manager()
    const cachedManager = cacheProxy(manager, { ttl: 10, checkPeriod: 1, remoteCache })
    const randomId = `${Date.now()}-${Math.random()}`

    const resultA = await cachedManager.doJob('test-manager-' + randomId) // miss
    let stats = cachedManager.channel.stats()
    expect(stats.total.miss === 1).toBeTruthy

    // make local cache expired
    await Bluebird.delay(20)

    const resultB = await cachedManager.doJob('test-manager-' + randomId) // remote hit, local cache also be update
    expect(resultB === resultA).toBeTruthy
    stats = cachedManager.channel.stats()
    expect(stats.total.local === 0).toBeTruthy
    expect(stats.total.remote === 1).toBeTruthy

    const resultC = await cachedManager.doJob('test-manager-' + randomId) // local hit
    expect(resultC === resultA).toBeTruthy
    stats = cachedManager.channel.stats()
    expect(stats.total.local === 1).toBeTruthy
    expect(stats.total.remote === 1).toBeTruthy
    expect(stats.total.miss === 1).toBeTruthy
    expect(stats.total.fallback === 0).toBeTruthy
    expect(stats.total.fallbackFirst === 0).toBeTruthy

    remoteCache.quit()
  })
})
