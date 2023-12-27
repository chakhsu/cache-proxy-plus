import { hello } from '../src'

test('String', () => {
  expect(hello()).toBe('Hello!')
})
