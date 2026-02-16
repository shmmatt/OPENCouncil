#!/usr/bin/env tsx
/**
 * Test if Gemini File Search successfully OCR'd uploaded documents
 */

import { db, sql } from '../server/storage/db';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

async function testGFSOcr() {
  console.log('======================================================================');
  console.log('🔍 Testing Gemini File Search OCR on Uploaded Documents');
  console.log('======================================================================\n');
  
  // Get recently synced documents
  const recentDocs = await db.execute(sql`
    SELECT 
      s3_key,
      gemini_store_id,
      gemini_document_id,
      town,
      category,
      board
    FROM s3_gemini_sync
    WHERE status = 'synced'
    AND synced_at > NOW() - INTERVAL '30 minutes'
    ORDER BY synced_at DESC
    LIMIT 5
  `);
  
  const docs = recentDocs.rows as Array<{
    s3_key: string;
    gemini_store_id: string;
    gemini_document_id: string;
    town: string;
    category: string;
    board: string | null;
  }>;
  
  if (docs.length === 0) {
    console.log('❌ No recently synced documents found to test\n');
    process.exit(1);
  }
  
  console.log(`📄 Found ${docs.length} recently synced documents to test:\n`);
  
  for (const doc of docs) {
    console.log(`  ${doc.s3_key}`);
  }
  
  console.log('\n🧪 Running search queries to test if documents are searchable...\n');
  
  let searchableCount = 0;
  let unsearchableCount = 0;
  
  for (const doc of docs) {
    const filename = doc.s3_key.split('/').pop();
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📄 Testing: ${filename}`);
    console.log(`   Town: ${doc.town}`);
    console.log(`   Store: ${doc.gemini_store_id}`);
    console.log(`   Document ID: ${doc.gemini_document_id}`);
    
    try {
      // Try to search for common words that should be in meeting minutes
      const searchQueries = [
        'meeting',
        'minutes',
        'board',
        'motion',
        'vote',
        'approved'
      ];
      
      let foundAny = false;
      
      for (const query of searchQueries) {
        try {
          const result = await ai.fileSearchStores.search({
            fileSearchStoreName: doc.gemini_store_id,
            config: {
              query: query,
              pageSize: 10
            }
          });
          
          // Check if this document appears in results
          const resultData = result as any;
          const chunks = resultData.relevantChunks || resultData.chunks || [];
          
          if (chunks.length > 0) {
            // Look for our document in the chunks
            for (const chunk of chunks) {
              const chunkDoc = chunk.document || chunk.documentName || '';
              if (chunkDoc.includes(doc.gemini_document_id) || chunkDoc === doc.gemini_document_id) {
                console.log(`   ✅ Found content for query "${query}"`);
                console.log(`      Snippet: ${chunk.text?.substring(0, 100) || chunk.snippet?.substring(0, 100) || 'N/A'}...`);
                foundAny = true;
                break;
              }
            }
            
            if (foundAny) break;
          }
        } catch (searchErr) {
          // Continue to next query
        }
      }
      
      if (foundAny) {
        console.log(`   ✅ SEARCHABLE - GFS successfully extracted/OCR'd text`);
        searchableCount++;
      } else {
        console.log(`   ❌ NOT SEARCHABLE - No text found with common queries`);
        console.log(`      This suggests GFS did NOT successfully OCR this document`);
        unsearchableCount++;
      }
      
    } catch (error) {
      console.log(`   ❌ ERROR testing document: ${error instanceof Error ? error.message : 'Unknown'}`);
      unsearchableCount++;
    }
  }
  
  // Summary
  console.log(`\n\n${'='.repeat(70)}`);
  console.log('📊 TEST RESULTS');
  console.log('='.repeat(70));
  console.log(`Searchable:      ${searchableCount}/${docs.length}`);
  console.log(`Not Searchable:  ${unsearchableCount}/${docs.length}`);
  
  if (searchableCount === docs.length) {
    console.log('\n✅ SUCCESS: All tested documents are searchable!');
    console.log('   Gemini File Search is successfully OCR\'ing image-based PDFs.\n');
    process.exit(0);
  } else if (searchableCount > 0) {
    console.log('\n⚠️  PARTIAL: Some documents searchable, some not.');
    console.log('   This is concerning - may need local OCR.\n');
    process.exit(1);
  } else {
    console.log('\n❌ FAILURE: NO documents are searchable!');
    console.log('   Gemini File Search is NOT successfully OCR\'ing these PDFs.');
    console.log('   We MUST install local OCR (poppler-utils + tesseract) and re-ingest.\n');
    process.exit(1);
  }
}

testGFSOcr().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
