# Failure ownership matrix

| Failure | Automatic action | Terminal outcome |
|---|---|---|
| Missing AI request | Enqueue latest turn | Bot delivery or fallback |
| AI request/decision error | Deterministic safe fallback | Bot delivery or Sale task |
| Decision completed without reply plan | Restage | Bot delivery or fallback |
| Duplicate slide assets | Deduplicate before staging | Normal slide delivery |
| Carousel transport failure | Release truthful text fallback | Bot text delivery |
| Newer customer turn | Cancel stale response | Superseded |
| Sale/Admin/external responder replied | Cancel bot response | Resolved external/human |
| Outside Messenger window | Do not force send | Sale rescue task |
| Historical sync older than 48h | Keep for reporting only | Archived history |
| Stale outbound lock | Release and retry | Delivery or fallback |
