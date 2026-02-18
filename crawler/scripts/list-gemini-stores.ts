import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

async function main() {
  console.log('📊 Listing Gemini File Search Stores...\n');
  
  try {
    const listOp = await ai.fileSearchStores.list({});
    const stores = listOp.fileSearchStores || [];
    
    console.log(`Found ${stores.length} stores:\n`);
    
    for (const store of stores) {
      console.log(`Store: ${store.name}`);
      console.log(`  Display Name: ${store.displayName || 'N/A'}`);
      console.log(`  Created: ${store.createTime || 'N/A'}`);
      console.log(`  Updated: ${store.updateTime || 'N/A'}`);
      
      // Try to get file count
      try {
        const filesOp = await ai.fileSearchStores.listFiles({
          fileSearchStoreName: store.name!,
          pageSize: 1
        });
        console.log(`  Files: ${filesOp.totalSize || 'Unknown'}`);
      } catch (e: any) {
        console.log(`  Files: Error - ${e.message}`);
      }
      
      console.log('');
    }
    
    console.log('\n💡 Tip: Old test stores might be consuming quota.');
    console.log('Consider deleting unused stores with:');
    console.log('  ai.fileSearchStores.delete({ name: "stores/store-id" })');
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.message.includes('RESOURCE_EXHAUSTED')) {
      console.log('\n⚠️  Storage quota exhausted - cannot list stores');
    }
  }
}

main();
