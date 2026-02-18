#!/usr/bin/env python3
"""
Check status of batch embedding job
Usage: python check_batch.py <job_name.txt>
"""

import os
import sys
from google import genai

def main():
    if len(sys.argv) < 2:
        print("Usage: python check_batch.py <job_name.txt>")
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

    print(f"📊 Batch Job Status")
    print(f"   Name: {job.name}")
    print(f"   State: {job.state.name}")

    if job.state.name == 'JOB_STATE_SUCCEEDED':
        print(f"✅ Job complete!")
        print(f"   Result file: {job.dest.file_name}")
        print(f"\n📥 Download with: python download_batch.py {job_file}")
    elif job.state.name == 'JOB_STATE_FAILED':
        print(f"❌ Job failed!")
        if hasattr(job, 'error'):
            print(f"   Error: {job.error}")
    else:
        print(f"⏳ Still processing...")

if __name__ == "__main__":
    main()
