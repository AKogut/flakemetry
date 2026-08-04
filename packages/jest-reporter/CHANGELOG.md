# @flakemetry/jest-reporter

## 0.1.2

### Patch Changes

- a755500: Keep the expected and received values from a Jest failure instead of only its first line. Jest renders one string rather than a structured error, and that first line is the matcher header — identical for every `toBe` in a project — so every assertion failure arrived with the same message, collapsing unrelated tests onto one error signature and giving root-cause analysis nothing to work with. ANSI colour codes are stripped from both the message and the stack.

## 0.1.1

### Patch Changes

- Updated dependencies [3187041]
  - @flakemetry/sdk@0.2.0
