import { cacheProxyPlus } from '../lib/index.js'

class Base {
  async doBase(id) {
    const res = Math.random()
    console.debug({ id, res }, 'Do base job !!!!!')
    return res
  }
}

class Manager extends Base {
  async doJob(id) {
    const res = Math.random()
    console.debug({ id, res }, 'Do heavy job !!!!!')
    return res
  }
}

const manager = new Manager()
const managerProxy = cacheProxyPlus(manager, { ttl: 2000, statsInterval: 1000 * 10, exclude: ['doBase'] })
managerProxy.channel.on('stats', s => console.info(s))

let i = 0
setInterval(async () => {
  i++
  const res1 = await managerProxy.doJob(1)
  const res2 = await managerProxy.doJob(2)
  const res3 = await managerProxy.doBase(3)
  console.log(res1, res2, res3, i)
}, 1000)
