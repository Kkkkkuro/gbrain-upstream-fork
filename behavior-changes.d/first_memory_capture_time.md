---
kind: fix
---
A new member or shared memory page records the first save request time as `captured_at`. The timestamp survives a delayed or retried publication and gives the generated page temporal provenance for lint.
