-- One-time fix: Task #40 — Ossipee 2026 town meeting/election results chunk metadata
-- Executed: 2026-03-29
-- Context: These 3 documents had year=null in document_chunks metadata because enrichment
-- failed (election machine output not recognized by the board-meeting-tuned LLM prompt,
-- and the MMDDYY filename date format was not supported by crawlerExtractDateFromFilename).
-- Without year, applyTemporalBoost applies a 0.85x penalty instead of 1.4x boost.
-- Fix: patch year, meetingDate, documentType into existing chunks (no re-embedding needed).

-- 1. Patch document_chunks metadata (5 chunks across 3 blobs)

-- 031026townresults.pdf (blob f2518943) — Official Tally Report, Election Day Mar 10 2026
UPDATE document_chunks
SET metadata = metadata || '{"year":2026,"meetingDate":"2026-03-10T00:00:00.000Z","documentType":"election_results"}'::jsonb
WHERE file_blob_id = 'f2518943-cd6b-4511-a2ec-b8e33687d8b8';
-- RESULT: UPDATE 2

-- 031026dist7results.pdf (blob cf080b84) — District 7 results, Election Day Mar 10 2026
UPDATE document_chunks
SET metadata = metadata || '{"year":2026,"meetingDate":"2026-03-10T00:00:00.000Z","documentType":"election_results"}'::jsonb
WHERE file_blob_id = 'cf080b84-4344-4d39-bab6-70e6f7fdeb1d';
-- RESULT: UPDATE 1

-- 2026tmresults.pdf (blob c860804b) — Town Meeting business session results Mar 11 2026
UPDATE document_chunks
SET metadata = metadata || '{"year":2026,"meetingDate":"2026-03-11T00:00:00.000Z","documentType":"town_meeting_results"}'::jsonb
WHERE file_blob_id = 'c860804b-1d83-4183-aa8d-24dc39349f5e';
-- RESULT: UPDATE 2

-- 2. Patch document_versions.meeting_date for consistency with chunk metadata

UPDATE document_versions
SET meeting_date = '2026-03-10', is_minutes = false
WHERE id = '743c3365-27fc-40b5-9ad1-81b0b97c8ac6'; -- 031026townresults.pdf
-- RESULT: UPDATE 1

UPDATE document_versions
SET meeting_date = '2026-03-10', is_minutes = false
WHERE id = '6416029d-be16-4d6b-b479-f15c0702db08'; -- 031026dist7results.pdf
-- RESULT: UPDATE 1

UPDATE document_versions
SET meeting_date = '2026-03-11', is_minutes = false
WHERE id = 'a80c39a3-9f63-40f0-8501-63833ea0a727'; -- 2026tmresults.pdf
-- RESULT: UPDATE 1

-- 3. Patch logical_documents.board + category for consistency

UPDATE logical_documents
SET board = 'Town Clerk', category = 'election_results', updated_at = NOW()
WHERE id IN (
  'a54138c0-d8d3-44b4-abe9-c747cb64952f', -- 031026townresults.pdf
  'be10698e-bc7b-4ac2-b9ca-e8268454a74b'  -- 031026dist7results.pdf
);
-- RESULT: UPDATE 2

UPDATE logical_documents
SET board = 'Town Meeting', category = 'town_meeting_results', updated_at = NOW()
WHERE id = '62c843cf-c727-4dd0-af59-85cdad825c2a'; -- 2026tmresults.pdf
-- RESULT: UPDATE 1
