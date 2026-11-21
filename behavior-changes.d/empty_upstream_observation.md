---
kind: fix
---
A failed Git fetch can leave an empty FETCH_HEAD with a recent modification time. Sync now falls back to the tracking branch's nonempty reflog for its observation time. A successful fetch of the same commit still refreshes that time.
