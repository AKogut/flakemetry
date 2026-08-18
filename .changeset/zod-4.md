---
'@flakemetry/contracts': minor
'@flakemetry/ai': patch
---

Move to zod 4. The validation shape on the wire is unchanged — `{ error, issues: [{ path, message }] }` — but the messages are more specific: an invalid commit sha now reports the pattern it had to match instead of a bare "Invalid".

`zod-to-json-schema` is gone; zod 4 generates JSON Schema itself, which the OpenAPI document and the API reference now use.
