#!/usr/bin/env python3
"""
Download completed batch embedding results
Usage: python download_batch.py <job_name.txt>
"""

import os
import sys
from google import genai

def main():
    if len(sys.argv) < 2:
        print("Usage: python download_batch.py <job_name.txt>")
        sys.exit(1)

    job_file = sys.argv[1]
    if not os.path.exists(job_file):
        print(f"❌ File not found: {job_file}")
        sys.exit(1)

    with open(job_file, 'r') as f:
        job_name = f.read().strip()

    api_key = os.environ.get('GEMINI_API_KEY')
    if not api_key:
        print("❌ GEMINI_API_KEY environment variable not set")
        sys.exit(1)

    client = genai.Client(api_key=api_key)
    job = client.batches.get(name=job_name)

    if job.state.name != 'JOB_STATE_SUCCEEDED':
        print(f"❌ Job not complete. State: {job.state.name}")
        sys.exit(1)

    # Download results
    print(f"📥 Downloading results...")
    result_file_name = job.dest.file_name
    file_content = client.files.download(file=result_file_name)

    # Determine output path
    output_path = job_file.replace('_job.txt', '_embeddings.jsonl')
    output_path = output_path.replace('export-', 'embeddings-')
    
    with open(output_path, 'wb') as f:
        f.write(file_content)

    print(f"✅ Results saved to: {output_path}")

    # Count results
    with open(output_path, 'r') as f:
        line_count = sum(1 for _ in f)
    print(f"📊 Total embeddings: {line_count}")
    
    print(f"\n📋 Next step: npx tsx batch-pipeline/ingest-embeddings.ts --input {output_path}")

if __name__ == "__main__":
    main()
