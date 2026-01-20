-- Add OCR-related columns to file_blobs table
ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS extracted_text_char_count integer NOT NULL DEFAULT 0;
ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS needs_ocr boolean NOT NULL DEFAULT false;
ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS ocr_status text NOT NULL DEFAULT 'none';
ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS ocr_failure_reason text;
ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS ocr_text text;
ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS ocr_text_char_count integer NOT NULL DEFAULT 0;
ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS ocr_queued_at timestamptz;
ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS ocr_started_at timestamptz;
ALTER TABLE file_blobs ADD COLUMN IF NOT EXISTS ocr_completed_at timestamptz;

-- Update existing rows to have proper char counts based on preview_text
UPDATE file_blobs 
SET extracted_text_char_count = COALESCE(LENGTH(preview_text), 0)
WHERE extracted_text_char_count = 0;

-- Create index for efficient OCR queue polling
CREATE INDEX IF NOT EXISTS idx_file_blobs_ocr_queue ON file_blobs(ocr_status) WHERE ocr_status = 'queued';
CREATE INDEX IF NOT EXISTS idx_file_blobs_needs_ocr ON file_blobs(needs_ocr) WHERE needs_ocr = true;
