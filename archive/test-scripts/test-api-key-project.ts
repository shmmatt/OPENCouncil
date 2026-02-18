#!/usr/bin/env tsx
import 'dotenv/config';

const API_KEY = process.env.GEMINI_API_KEY;

async function testAPIKey() {
  console.log('🔑 Testing API key to identify project...\n');
  console.log(`API Key: ${API_KEY?.substring(0, 20)}...`);
  
  // Try to get quota info from a failed upload attempt
  // Create a tiny test file
  const testContent = Buffer.from('Test file for quota check').toString('base64');
  
  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${API_KEY}`;
  
  console.log('\n📤 Attempting test upload to trigger quota response...');
  
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'multipart'
    },
    body: JSON.stringify({
      file: {
        display_name: 'quota_test.txt'
      }
    })
  });
  
  const data = await response.json();
  console.log('\nResponse:', JSON.stringify(data, null, 2));
  
  // Try to list stores with verbose headers
  console.log('\n📦 Checking file search stores...');
  const storesUrl = `https://generativelanguage.googleapis.com/v1beta/fileSearchStores?pageSize=5`;
  const storesResponse = await fetch(storesUrl, {
    headers: {
      'x-goog-api-key': API_KEY!
    }
  });
  
  const storesData = await storesResponse.json();
  console.log('\nStores response:', JSON.stringify(storesData, null, 2));
  
  // Check response headers for project info
  console.log('\n📋 Response headers:');
  for (const [key, value] of storesResponse.headers.entries()) {
    if (key.toLowerCase().includes('project') || key.toLowerCase().includes('quota') || key.toLowerCase().includes('billing')) {
      console.log(`  ${key}: ${value}`);
    }
  }
}

testAPIKey().catch(console.error);
