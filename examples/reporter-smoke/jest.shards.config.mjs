export default {
  testEnvironment: 'node',
  testMatch: ['**/suites/sharded/jest/**/*.test.js'],
  reporters: ['default', '@flakemetry/jest-reporter'],
}
