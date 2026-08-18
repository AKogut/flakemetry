# @flakemetry/ai

## 0.0.4

### Patch Changes

- eae093b: Move to zod 4. The validation shape on the wire is unchanged — `{ error, issues: [{ path, message }] }` — but the messages are more specific: an invalid commit sha now reports the pattern it had to match instead of a bare "Invalid".

  `zod-to-json-schema` is gone; zod 4 generates JSON Schema itself, which the OpenAPI document and the API reference now use.

- Updated dependencies [cd50173]
- Updated dependencies [eae093b]
  - @flakemetry/contracts@0.3.0

## 0.0.3

### Patch Changes

- Updated dependencies [09519db]
- Updated dependencies [a04f9f7]
  - @flakemetry/contracts@0.2.1

## 0.0.2

### Patch Changes

- Updated dependencies [6c2680d]
  - @flakemetry/contracts@0.2.0

## 0.0.1

### Patch Changes

- Updated dependencies [b2a2d3d]
  - @flakemetry/contracts@0.1.0
