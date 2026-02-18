# Gemini Batch API Guide for Embeddings

This guide covers Phase 2 of the pipeline: sending chunks to Gemini's Batch API for embedding.

## Why Batch API?

| Aspect | Real-time API | Batch API |
|--------|--------------|-----------|
| **Cost** | $0.004/1K tokens | $0.002/1K tokens (50% cheaper) |
| **Memory** | Your server | Google's servers |
| **Rate limits** | Yes | No |
| **Turnaround** | Instant | Up to 24 hours |

For 37,000 chunks (Carroll County), batch saves ~$0.07 and eliminates OOM risk.

## Prerequisites

1. **Google Cloud Project** with billing enabled
2. **Gemini API key** (you already have this)
3. **Python 3.8+** with `google-genai` package

```bash
pip install google-genai
```

## Step 1: Upload and Submit Batch Job

```python
#!/usr/bin/env python3
"""
submit_batch_embeddings.py
Upload JSONL and start Gemini batch embedding job
"""

import os
from google import genai

# Initialize client
client = genai.Client(api_key=os.environ.get('GEMINI_API_KEY'))

# Upload the JSONL file
print("📤 Uploading batch file...")
uploaded_file = client.files.upload(file='data/export-carroll-2026-02-18.jsonl')
print(f"   Uploaded: {uploaded_file.name}")

# Create batch embedding job
print("🚀 Starting batch job...")
batch_job = client.batches.create_embeddings(
    model="gemini-embedding-001",
    src={"file_name": uploaded_file.name}
)

print(f"✅ Batch job created: {batch_job.name}")
print(f"   State: {batch_job.state.name}")
print(f"   Monitor at: https://aistudio.google.com/batches")

# Save job name for later retrieval
with open('data/batch_job_name.txt', 'w') as f:
    f.write(batch_job.name)

print(f"\n💾 Job name saved to data/batch_job_name.txt")
print(f"⏰ Check back in 1-24 hours for results")
```

## Step 2: Check Job Status

```python
#!/usr/bin/env python3
"""
check_batch_status.py
Check status of a batch embedding job
"""

import os
from google import genai

client = genai.Client(api_key=os.environ.get('GEMINI_API_KEY'))

# Read job name
with open('data/batch_job_name.txt', 'r') as f:
    job_name = f.read().strip()

# Get job status
job = client.batches.get(name=job_name)

print(f"📊 Batch Job Status")
print(f"   Name: {job.name}")
print(f"   State: {job.state.name}")

if hasattr(job, 'metadata'):
    print(f"   Progress: {job.metadata}")

if job.state.name == 'JOB_STATE_SUCCEEDED':
    print(f"✅ Job complete! Result file: {job.dest.file_name}")
elif job.state.name == 'JOB_STATE_FAILED':
    print(f"❌ Job failed: {job.error}")
else:
    print(f"⏳ Still processing...")
```

## Step 3: Download Results

```python
#!/usr/bin/env python3
"""
download_batch_results.py
Download completed batch embedding results
"""

import os
from google import genai

client = genai.Client(api_key=os.environ.get('GEMINI_API_KEY'))

# Read job name
with open('data/batch_job_name.txt', 'r') as f:
    job_name = f.read().strip()

# Get job
job = client.batches.get(name=job_name)

if job.state.name != 'JOB_STATE_SUCCEEDED':
    print(f"❌ Job not complete. State: {job.state.name}")
    exit(1)

# Download results
print(f"📥 Downloading results...")
result_file_name = job.dest.file_name
file_content_bytes = client.files.download(file=result_file_name)

# Save to file
output_path = 'data/embeddings-carroll-2026-02-18.jsonl'
with open(output_path, 'wb') as f:
    f.write(file_content_bytes)

print(f"✅ Results saved to {output_path}")

# Count results
with open(output_path, 'r') as f:
    line_count = sum(1 for _ in f)
print(f"📊 Total embeddings: {line_count}")
```

## Output Format

The downloaded JSONL will have this format:

```json
{"key": "abc123|0|Ossipee|zoning||2024", "response": {"embeddings": [{"values": [0.123, -0.456, ...]}]}}
{"key": "abc123|1|Ossipee|zoning||2024", "response": {"embeddings": [{"values": [0.789, 0.012, ...]}]}}
```

The `key` field matches your input, allowing you to map embeddings back to document chunks:
- Format: `versionId|chunkIndex|town|category|board|year`

## Alternative: CLI Approach

If you prefer command line:

```bash
# Set API key
export GEMINI_API_KEY=your_key_here

# Submit batch (using curl)
curl -X POST \
  "https://generativelanguage.googleapis.com/v1beta/batches:createEmbeddings?key=$GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "models/gemini-embedding-001",
    "requests": {"file_uri": "gs://your-bucket/export.jsonl"}
  }'
```

## Monitoring

Track your batch jobs at: https://aistudio.google.com/batches

## Troubleshooting

### Job stuck in PENDING
- Large files may take longer to start processing
- Wait up to 1 hour before investigating

### Job failed
- Check for malformed JSONL lines
- Verify text isn't too long (max 2048 tokens per request)
- Ensure API key has batch permissions

### Missing embeddings in output
- Some requests may fail individually
- Check for error responses in the output JSONL
- Re-run failed keys in a new batch

## Next Step

Once you have `embeddings-*.jsonl`, proceed to Phase 3:

```bash
npx tsx batch-pipeline/ingest-embeddings.ts --input data/embeddings-carroll-2026-02-18.jsonl
```
