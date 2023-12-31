import Joi from 'joi'
import { RemoteCache } from '../src/RemoteCache'

export type OptionsType = {
  ttl: number
  checkPeriod: number
  statsInterval: number
  randomTtl: boolean
  methodTtls: Record<string, number>
  subject: string | null
  fallback: boolean
  fallbackTtl: number
  fallbackMax: number
  fallbackFirst: boolean
  bgUpdate: boolean
  bgUpdateDelay: number
  bgUpdatePeriodDelay: number
  bgUpdateExpired: number
  concurrency: number
  remoteCache: RemoteCache | null
}

export type CacheProxyOptionsType = Partial<OptionsType>

const optionsSchema = Joi.object()
  .keys({
    ttl: Joi.number()
      .greater(0)
      .default(1000 * 60),
    checkPeriod: Joi.number()
      .greater(0)
      .default(1000 * 1),
    statsInterval: Joi.number()
      .greater(0)
      .default(1000 * 60),
    randomTtl: Joi.boolean().default(false),
    methodTtls: Joi.object()
      .pattern(
        /.*/,
        Joi.number()
          .greater(0)
          .default(1000 * 60)
      )
      .default({})
      .unknown(),
    subject: Joi.string().default(null),
    fallback: Joi.boolean().default(false),
    fallbackTtl: Joi.number()
      .greater(0)
      .default(1000 * 60 * 60),
    fallbackMax: Joi.number()
      .greater(0)
      .default(1000 * 10),
    fallbackFirst: Joi.boolean().default(false),
    bgUpdate: Joi.boolean().default(false),
    bgUpdateDelay: Joi.number().min(0).default(100),
    bgUpdatePeriodDelay: Joi.number()
      .min(0)
      .default(1000 * 5),
    bgUpdateExpired: Joi.number()
      .min(0)
      .default(1000 * 60 * 60),
    concurrency: Joi.number().greater(0).default(10),
    remoteCache: Joi.any().default(null)
  })
  .optional()

export const attemptOptionsSchema = (options?: OptionsType | CacheProxyOptionsType): OptionsType => {
  return Joi.attempt(options || {}, optionsSchema)
}

export const assertTargetSchema = (target: object) => {
  Joi.assert(target, Joi.object().required(), 'Target is required.')
}
