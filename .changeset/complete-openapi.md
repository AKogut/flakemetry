---
'@flakemetry/contracts': patch
---

`/openapi.json` now describes the whole API rather than the read half. It was generated from the read-route table, so ingestion, the quality gate, artifact presigning and quarantine were invisible to anything generating a client — with nothing in the document to say a client was seeing a fraction of it. Request bodies are now included, generated from the same zod schemas the endpoints validate against.
