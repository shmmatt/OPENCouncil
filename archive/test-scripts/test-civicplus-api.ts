#!/usr/bin/env tsx
/**
 * Test CivicPlus API discovery directly
 */

async function discoverCivicPlusDocuments(baseUrl: string): Promise<string[]> {
  console.log('Testing CivicPlus API discovery for:', baseUrl);
  const docs: string[] = [];
  
  // CivicPlus has predictable API endpoints
  const apiEndpoints = [
    '/api/v1/Documents/All',
    '/api/v1/AgendaItems/All',
    '/api/v1/Forms/All',
    '/AgendaCenter/Search',
    '/DocumentCenter/Search',
    '/FormCenter/Search',
  ];
  
  for (const endpoint of apiEndpoints) {
    try {
      const url = `${baseUrl}${endpoint}`;
      console.log(`\nTrying: ${url}`);
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/html, */*'
        }
      });
      
      console.log(`  Status: ${response.status}`);
      
      if (!response.ok) continue;
      
      const contentType = response.headers.get('content-type') || '';
      console.log(`  Content-Type: ${contentType}`);
      
      if (contentType.includes('application/json')) {
        const data = await response.json();
        console.log(`  Response type: JSON`);
        console.log(`  Keys: ${Object.keys(data).join(', ')}`);
        
        // Show a sample
        const sample = JSON.stringify(data).substring(0, 500);
        console.log(`  Sample: ${sample}...`);
        
        // Extract URLs
        const extractUrls = (obj: any, urls: string[]) => {
          if (typeof obj !== 'object' || obj === null) return;
          
          for (const [key, value] of Object.entries(obj)) {
            if (key.toLowerCase().includes('url') || 
                key.toLowerCase().includes('link') ||
                key.toLowerCase().includes('file')) {
              if (typeof value === 'string' && 
                  (value.includes('.pdf') || 
                   value.includes('/ViewFile/') ||
                   value.includes('/Document/'))) {
                const fullUrl = value.startsWith('http') ? value : `${baseUrl}${value}`;
                urls.push(fullUrl);
              }
            }
            
            if (typeof value === 'object') {
              extractUrls(value, urls);
            }
          }
        };
        
        extractUrls(data, docs);
        console.log(`  Extracted: ${docs.length} document URLs so far`);
      } else {
        const html = await response.text();
        console.log(`  Response type: HTML (${html.length} bytes)`);
        
        const docPattern = /(\/ViewFile\/[^"'<>\s]+|\/Document\/[^"'<>\s]+)/gi;
        const matches = html.matchAll(docPattern);
        
        for (const match of matches) {
          docs.push(`${baseUrl}${match[1]}`);
        }
        console.log(`  Extracted: ${docs.length} document URLs so far`);
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }
  
  const uniqueDocs = Array.from(new Set(docs));
  console.log(`\n✅ Total unique documents found: ${uniqueDocs.length}`);
  
  if (uniqueDocs.length > 0) {
    console.log('\nSample URLs:');
    uniqueDocs.slice(0, 10).forEach((url, i) => {
      console.log(`  ${i+1}. ${url}`);
    });
  }
  
  return uniqueDocs;
}

// Test on multiple CivicPlus towns
const towns = [
  { name: 'Moultonborough', url: 'https://moultonboroughnh.gov' },
  { name: 'Wakefield', url: 'https://www.wakefieldnh.gov' },
  { name: 'Wolfeboro', url: 'https://www.wolfeboronh.us' },
];

async function main() {
  for (const town of towns) {
    console.log('\n' + '='.repeat(70));
    console.log(`Testing: ${town.name}`);
    console.log('='.repeat(70));
    
    const docs = await discoverCivicPlusDocuments(town.url);
    console.log(`\n${town.name}: ${docs.length} documents found\n`);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main().catch(console.error);
