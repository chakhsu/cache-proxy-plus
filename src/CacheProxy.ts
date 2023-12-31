import util from 'util'
import { CacheLayer } from './CacheLayer'
import { assertTargetSchema, attemptOptionsSchema, CacheProxyOptionsType } from './Schema'

import Debug from 'debug'
const debug = Debug('cpp:CacheProxy')

export const cacheProxy = (target: any, options?: CacheProxyOptionsType) => {
  assertTargetSchema(target)
  const newOptions = attemptOptionsSchema(options)
  debug('cacheProxy arg options: ', options, newOptions)

  const cached = new CacheLayer({
    ...newOptions,
    subject: newOptions.subject || Object.getPrototypeOf(target).constructor.name
  })

  const channel = {
    stats: () => cached.getStats(),
    on: (...args: [string, any]) => cached.on(...args)
  }

  const handler = {
    get: function (target: any, prop: string) {
      const property = target[prop]

      if (prop === 'channel') {
        return channel
      } else if (typeof property === 'function' && prop !== 'constructor') {
        if (util.types.isAsyncFunction(property)) {
          debug('**** asyncFunction', prop, ' ****')
          return cached.wrap(target, prop)
        } else {
          debug('**** non-asyncFunction', prop, ' ****')
          throw new Error('Only Support AsyncFunction ' + prop)
        }
      } else {
        debug('**** non-function', prop, ' ****')
        return property
      }
    }
  }

  return new Proxy(target, handler)
}

export const cacheProxyPlus = cacheProxy
