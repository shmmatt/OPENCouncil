-- Backfill: copy year from document_versions.meeting_date into document_chunks.metadata
-- Executed: 2026-03-29
-- Context: 91,274 chunks had year=null in metadata because enrichment ran after embedding
-- and the pipeline bridge (added in Task #40) only helps new documents going forward.
-- This one-time backfill fixes all chunks where the year is already known via
-- document_versions.meeting_date — no LLM calls, no re-embedding needed.
--
-- RESULT: UPDATE 14,072 chunks across Ossipee, Conway, Freedom, Madison, Moultonborough,
--         Jackson, Chatham, Albany, Tamworth, Wolfeboro, Eaton, Brookfield, Wakefield,
--         Tuftonboro, Effingham.

UPDATE document_chunks dc
SET metadata = metadata || jsonb_build_object(
  'year', EXTRACT(YEAR FROM dv.meeting_date)::int,
  'meetingDate', dv.meeting_date::text
)
FROM document_versions dv
WHERE dc.file_blob_id = dv.file_blob_id
  AND (dc.metadata->>'year' IS NULL OR dc.metadata->>'year' = '')
  AND dv.meeting_date IS NOT NULL;

-- Post-run null-year counts by town:
-- Ossipee:        6,432 remaining (was ~12,976) — ~6,544 fixed
-- Conway:         4,553 remaining (was ~5,640)  — ~1,087 fixed
-- Freedom:        5,981 remaining (was ~6,941)  — ~960 fixed
-- Madison:        1,537 remaining (was ~2,145)  — ~608 fixed
-- Moultonborough: 8,069 remaining (was ~8,284)  — ~215 fixed
-- Wolfeboro:      7,019 remaining (was ~7,074)  — ~55 fixed
-- (remaining null-year chunks have no meeting_date anywhere in the DB)
