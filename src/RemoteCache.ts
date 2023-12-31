export class RemoteCache {
  async set(key: string, value: any, ttl: number): Promise<any> {
    throw new Error('Abstract method of RemoteCache need to be implemented.')
  }

  async get(key: string): Promise<any> {
    throw new Error('Abstract method of RemoteCache need to be implemented.')
  }
}
