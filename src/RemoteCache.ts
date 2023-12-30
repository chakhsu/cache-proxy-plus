export class RemoteCache {
  async set(key: string, item: any, maxAge: number) {
    throw new Error('Abstract method of RemoteCache need to be implemented.')
  }

  async get(key: string) {
    throw new Error('Abstract method of RemoteCache need to be implemented.')
  }
}
