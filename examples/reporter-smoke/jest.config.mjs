export default {
  testEnvironment: 'node',
  testMatch: ['**/suites/jest/**/*.test.js'],
  reporters: ['default', '@flakemetry/jest-reporter'],
}
