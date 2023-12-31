import Bluebird from 'bluebird'
import { cacheProxy } from '../src'

class Manager {
  randomId: number
  concurrency: number = 0
  maxConcurrency: number = 0
  willFallback?: boolean

  constructor() {
    this.randomId = Math.random()
  }

  async doJob(id: string, delay: number) {
    await new Promise(resolve => setTimeout(resolve, delay || 0))
    return Math.random()
  }

  async doAnotherJob(id: string, delay: number) {
    await new Promise(resolve => setTimeout(resolve, delay || 0))
    return Math.random()
  }

  doJobSync() {
    return Math.random()
  }

  async fallbackJob(id: string, delay: number) {
    if (this.willFallback) {
      throw new Error('manager.fallbackJob() only pass in first invoking')
    }
    this.willFallback = true
    await new Promise(resolve => setTimeout(resolve, delay || 0))
    return Math.random()
  }

  async concurrencyJob(id: string) {
    this.concurrency = this.concurrency + 1
    this.maxConcurrency = Math.max(this.maxConcurrency, this.concurrency)
    await new Promise(resolve => setTimeout(resolve, 5))
    this.concurrency -= 1
    return Math.random()
  }
}

describe('cacheProxy', () => {
  test('Should cached async function', async () => {
    const manager = new Manager()
    const cachedManager = cacheProxy(manager)

    const resultA = await cachedManager.doJob('test-manager')
    expect(resultA > 0).toBeTruthy
    let stats = cachedManager.channel.stats()
    expect(stats.total.miss === 1).toBeTruthy
    expect(stats.total.local === 0).toBeTruthy

    const resultB = await cachedManager.doJob('test-manager')
    expect(resultB === resultA).toBeTruthy
    const resultC = await cachedManager.doJob('test-manager')
    expect(resultC === resultA).toBeTruthy
    stats = cachedManager.channel.stats()
    expect(stats.total.miss === 1).toBeTruthy
    expect(stats.total.local === 2).toBeTruthy
  })

  test('Should cached with different ttls for different methods', async () => {
    const manager = new Manager()
    const cachedManager = cacheProxy(manager, {
      ttl: 10,
      checkPeriod: 1, // 检查周期要比ttl小
      methodTtls: {
        doAnotherJob: 1000
      }
    })

    const resultA = await cachedManager.doJob('test-manager') // miss，显然在第1次请求前缓存是空的
    const resultB = await cachedManager.doAnotherJob('test-manager') // miss，同时会产生cache

    await Bluebird.delay(20) // 超过ttl的时间，让默认的 cache 过期

    const resultC = await cachedManager.doJob('test-manager') // miss
    const resultD = await cachedManager.doAnotherJob('test-manager') // hit local

    expect(resultA !== resultC).toBeTruthy
    expect(resultB === resultD).toBeTruthy

    const stats = cachedManager.channel.stats()
    expect(stats.total.miss === 3).toBeTruthy
    expect(stats.total.local === 1).toBeTruthy
  })

  test('Should avoid concurrent miss -- bluebird Promise', async () => {
    // 避免过期后突发大量并发请求
    const manager = new Manager()
    const cachedManager = cacheProxy(manager)

    const concurrency = 10
    const list: number[] = []
    for (let i = 0; i < concurrency; i++) {
      list.push(1)
    }

    await Bluebird.map(
      list,
      async i => {
        const result = await cachedManager.doJob('test2.1-manager', 50 * i)
        expect(result > 0).toBeTruthy
        expect(typeof result === 'number').toBeTruthy
      },
      { concurrency }
    )

    const stats = cachedManager.channel.stats()
    expect(stats.total.miss === 1).toBeTruthy
    expect(stats.total.wait === concurrency - 1).toBeTruthy
  })

  test('Should avoid concurrent miss -- native Promise ', async () => {
    // 避免过期后突发大量并发请求
    const manager = new Manager()
    const cachedManager = cacheProxy(manager)

    const concurrency = 10
    const list: number[] = []
    for (let i = 0; i < concurrency; i++) {
      list.push(1)
    }

    await Promise.all(
      list.map(async i => {
        const result = await cachedManager.doJob('test2.2-manager', 50 * i)
        expect(result > 0).toBeTruthy
        expect(typeof result === 'number').toBeTruthy
      })
    )

    const stats = cachedManager.channel.stats()
    expect(stats.total.miss === 1).toBeTruthy
    expect(stats.total.wait === concurrency - 1).toBeTruthy
  })

  test('Should throw TypeError', async () => {
    const manager = new Manager()

    const cachedManager = cacheProxy(manager)

    await cachedManager.doJob('test3-manager')
    await cachedManager.doJob('test3-manager')

    try {
      cachedManager.doJobSync('test3-manager-2')
    } catch (err: any) {
      expect(err.message.includes('Only Support AsyncFunction')).toBeTruthy
    }

    const stats = cachedManager.channel.stats()
    expect(stats.total.miss === 1).toBeTruthy
    expect(stats.total.local === 1).toBeTruthy
    expect(stats.methods.doJob.miss === 1).toBeTruthy
    expect(stats.methods.doJob.local === 1).toBeTruthy
  })

  test('Should fallback', async () => {
    const manager = new Manager()

    const cachedManager = cacheProxy(manager, { ttl: 10, checkPeriod: 1, fallback: true })

    const resultA = await cachedManager.fallbackJob('fallback') // 第1次, 成功，显然在第1次请求前缓存是空的，是miss
    const resultB = await cachedManager.fallbackJob('fallback') // 第2次, 使用local cache
    expect(resultA > 0).toBeTruthy
    expect(resultA === resultB).toBeTruthy
    await Bluebird.delay(20) // 让 cache 过期

    const resultC = await cachedManager.fallbackJob('fallback') // 第3次, 报错，也是miss，但使用fallback，有返回值
    expect(resultC > 0).toBeTruthy

    const stats = cachedManager.channel.stats()
    expect(stats.total.miss === 2).toBeTruthy
    expect(stats.total.local === 1).toBeTruthy
    expect(stats.total.fallback === 1).toBeTruthy
    expect(stats.methods.fallbackJob.miss === 2).toBeTruthy
    expect(stats.methods.fallbackJob.local === 1).toBeTruthy
    expect(stats.methods.fallbackJob.fallback === 1).toBeTruthy
  })

  test('Should fallbackFirst', async () => {
    const manager = new Manager()

    const cachedManager = cacheProxy(manager, { ttl: 10, checkPeriod: 1, fallback: true, fallbackFirst: true })

    const resultA = await cachedManager.fallbackJob('fallback') // 第1次, 成功，显然在第1次请求前缓存是空的，是miss
    const resultB = await cachedManager.fallbackJob('fallback') // 第2次, 使用local cache
    expect(resultA > 0).toBeTruthy
    expect(resultA === resultB).toBeTruthy
    await Bluebird.delay(20) // 让 cache 过期

    const errors: any[] = []
    cachedManager.channel.on('error', (err: any) => errors.push(err))
    const resultC = await cachedManager.fallbackJob('fallback') // 第3次, 后台报错，fallbackFirst
    const resultD = await cachedManager.fallbackJob('fallback') // 第4次, 使用local cache
    expect(resultC === resultB).toBeTruthy
    expect(resultD === resultB).toBeTruthy

    // 第3,4次fallbackJob()会在background执行，错误将异步得到
    await Bluebird.delay(25) // 等待 error 被捕捉到
    expect(errors.length === 1).toBeTruthy

    const stats = cachedManager.channel.stats()
    expect(stats.total.miss === 1).toBeTruthy
    expect(stats.total.local === 2).toBeTruthy
    expect(stats.total.fallbackFirst === 1).toBeTruthy
  })

  test('Should update background', async () => {
    const manager = new Manager()

    const cachedManager = cacheProxy(manager, {
      bgUpdate: true,
      bgUpdateDelay: 10,
      bgUpdatePeriodDelay: 1,
      bgUpdateExpired: 30
    })

    await cachedManager.doJob('update-background')
    await cachedManager.doJob('update-background')

    await new Promise((resolve, reject) => {
      cachedManager.channel.on('bg.stats', (stats: object) => {
        resolve(stats)
      })
    })

    await new Promise((resolve, reject) => {
      cachedManager.channel.on('bg.break.off', (key: string) => {
        resolve(key)
      })
    })

    const stats = cachedManager.channel.stats()
    expect(stats.total.miss === 1).toBeTruthy
    expect(stats.total.local === 1).toBeTruthy
  })

  test('Should limit concurrency in real update', async () => {
    const manager = new Manager()

    const cachedManager = cacheProxy(manager)

    const list: number[] = []
    for (let i = 0; i < 100; i++) {
      list.push(i)
    }

    await Promise.all(list.map(i => cachedManager.concurrencyJob(i)))
    const maxConcurrency = cachedManager.maxConcurrency
    expect(maxConcurrency <= 10).toBeTruthy
  })
})
