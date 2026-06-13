# Stag Production Hardening Plan

## Tranche 1 - Import and Copy Job Foundation
- Serialize renderer import sessions so multiple local-copy imports cannot overlap.
- Serialize Electron local-copy sessions as a backend safety net.
- Persist import/copy jobs in SQLite with job IDs, status, progress, payload, and errors.
- Tie copy/import progress to job IDs.

## Tranche 2 - Transactional Data Mutations
- Wrap asset inserts, updates, trash/restore, and hard deletes in SQLite transactions.
- Invalidate main query/startup caches only after successful commits.
- Keep FTS rows consistent with asset mutations and hard deletes.

## Tranche 3 - Job-Aware UI and Recovery
- Add a job list/progress surface for queued/running/failed/completed jobs.
- Surface retry/cancel actions where safe.
- On startup, detect stale running jobs and mark them interrupted or resume them.

## Tranche 4 - Cache Ownership
- Centralize renderer page cache invalidation behind asset mutation events.
- Make query cache keys and count cache invalidation explicit.
- Add targeted refreshes instead of broad reloads where possible.

## Tranche 5 - Large-Library Selection Model
- Replace giant selected/filtered ID arrays for select-all with query-based selection state.
- Keep explicit include/exclude sets for manual exceptions.

## Tranche 6 - Background Scheduler
- Coordinate thumbnail generation, FTS backfill, AI indexing, folder scans, and watcher repair under one priority/concurrency scheduler.
- Add pause/resume and backpressure.

## Tranche 7 - Tests
- Add regression tests for import-while-importing, delete-while-paging, trash hard delete, watcher removal, cache invalidation, and copy failure recovery.
