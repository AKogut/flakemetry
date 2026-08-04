---
'@flakemetry/jest-reporter': patch
---

Keep the expected and received values from a Jest failure instead of only its first line. Jest renders one string rather than a structured error, and that first line is the matcher header — identical for every `toBe` in a project — so every assertion failure arrived with the same message, collapsing unrelated tests onto one error signature and giving root-cause analysis nothing to work with. ANSI colour codes are stripped from both the message and the stack.
