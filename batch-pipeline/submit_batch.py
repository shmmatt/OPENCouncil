#!/usr/bin/env python3
"""
Submit batch embedding job to Gemini API
Usage: python submit_batch.py <input.jsonl>
"""

import os
import sys
from google import genai

def main():
    if len(sys.argv) < 2:
        print("Usage: python submit_batch.py <input.jsonl>")
        sys.exit(1)

    input_file = sys.argv[1]
    if not os.path.exists(input_file):
        print(f"❌ File not found: {input_file}")
        sys.exit(1)

    api_key = os.environ.get('GEMINI_API_KEY')
    if not api_key:
        print("❌ GEMINI_API_KEY environment variable not set")
        sys.exit(1)

    client = genai.Client(api_key=api_key)

    # Upload file
    print(f"📤 Uploading {input_file}...")
    uploaded_file = client.files.upload(file=input_file, config={"mime_type": "application/jsonl"})
    print(f"   Uploaded: {uploaded_file.name}")

    # Create batch job
    print("🚀 Starting batch embedding job...")
    batch_job = client.batches.create_embeddings(
        model="gemini-embedding-001",
        src={"file_name": uploaded_file.name}
    )

    print(f"✅ Batch job created!")
    print(f"   Name: {batch_job.name}")
    print(f"   State: {batch_job.state.name}")

    # Save job name
    job_file = input_file.replace('.jsonl', '_job.txt')
    with open(job_file, 'w') as f:
        f.write(batch_job.name)
    print(f"💾 Job name saved to: {job_file}")

    print(f"\n⏰ Check status with: python check_batch.py {job_file}")
    print(f"🌐 Or monitor at: https://aistudio.google.com/batches")

if __name__ == "__main__":
    main()
