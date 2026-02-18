/**
 * Improved Sitemap Parser
 * 
 * Handles:
 * - Sitemap indexes (sitemaps that point to other sitemaps)
 * - Recursive sub-sitemap fetching
 * - Filtering out XML files from results
 * - Depth limiting to prevent infinite loops
 * - Deduplication
 */

interface SitemapResult {
  urls: string[];
  sitemapsProcessed: number;
  depth: number;
}

/**
 * Fetch and parse a sitemap, recursively following sitemap indexes
 */
async function parseSitemapRecursive(
  url: string,
  visited = new Set<string>(),
  currentDepth = 0,
  maxDepth = 3
): Promise<SitemapResult> {
  // Prevent infinite loops
  if (currentDepth >= maxDepth) {
    console.log(`   ⚠️  Max depth ${maxDepth} reached at ${url}`);
    return { urls: [], sitemapsProcessed: 0, depth: currentDepth };
  }

  // Prevent duplicate fetches
  if (visited.has(url)) {
    return { urls: [], sitemapsProcessed: 0, depth: currentDepth };
  }

  visited.add(url);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'OPENCouncil-Bot/1.0 (Municipal Document Crawler)'
      }
    });

    if (!response.ok) {
      console.log(`   ✗ Failed to fetch ${url}: ${response.status}`);
      return { urls: [], sitemapsProcessed: 0, depth: currentDepth };
    }

    const xml = await response.text();
    
    // Check if this is a sitemap index
    const isSitemapIndex = xml.includes('<sitemapindex');
    
    if (isSitemapIndex) {
      console.log(`   📚 Sitemap index found at depth ${currentDepth}: ${url}`);
      
      // Extract sub-sitemap URLs
      const sitemapMatches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
      const subSitemaps = Array.from(sitemapMatches).map(match => match[1].trim());
      
      console.log(`      → ${subSitemaps.length} sub-sitemaps to fetch`);
      
      // Recursively fetch all sub-sitemaps
      const allUrls: string[] = [];
      let totalSitemaps = 1; // Count this index
      
      for (const subSitemap of subSitemaps) {
        const result = await parseSitemapRecursive(subSitemap, visited, currentDepth + 1, maxDepth);
        allUrls.push(...result.urls);
        totalSitemaps += result.sitemapsProcessed;
      }
      
      return { 
        urls: allUrls, 
        sitemapsProcessed: totalSitemaps,
        depth: currentDepth
      };
      
    } else {
      // Regular sitemap - extract URLs
      const urlMatches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
      const urls = Array.from(urlMatches)
        .map(match => match[1].trim())
        .filter(url => {
          // Filter out XML files (these are likely more sitemaps)
          if (url.endsWith('.xml')) {
            console.log(`   ⊙ Skipping nested sitemap: ${url}`);
            return false;
          }
          return true;
        });
      
      console.log(`   ✓ Extracted ${urls.length} URLs from ${url}`);
      
      return { 
        urls, 
        sitemapsProcessed: 1,
        depth: currentDepth
      };
    }
    
  } catch (error) {
    console.log(`   ✗ Error fetching ${url}:`, error instanceof Error ? error.message : 'Unknown');
    return { urls: [], sitemapsProcessed: 0, depth: currentDepth };
  }
}

/**
 * Main entry point - fetch sitemap(s) from a base URL
 */
export async function parseSitemap(baseUrl: string): Promise<string[]> {
  console.log('🗺️  Fetching sitemap...');
  
  const sitemapUrl = `${baseUrl}/sitemap.xml`;
  const result = await parseSitemapRecursive(sitemapUrl);
  
  // Deduplicate URLs
  const uniqueUrls = Array.from(new Set(result.urls));
  
  console.log(`\n📊 Sitemap Summary:`);
  console.log(`   Sitemaps processed: ${result.sitemapsProcessed}`);
  console.log(`   Max depth reached: ${result.depth}`);
  console.log(`   Total URLs found: ${uniqueUrls.length}`);
  console.log(`   Duplicates removed: ${result.urls.length - uniqueUrls.length}\n`);
  
  return uniqueUrls;
}

// Test harness
if (import.meta.url === `file://${process.argv[1]}`) {
  const testUrl = process.argv[2] || 'https://www.jackson-nh.gov';
  
  console.log(`\n🧪 Testing sitemap parser on: ${testUrl}\n`);
  
  const urls = await parseSitemap(testUrl);
  
  console.log('Sample URLs (first 10):');
  urls.slice(0, 10).forEach((url, i) => {
    console.log(`  ${i + 1}. ${url}`);
  });
  
  if (urls.length > 10) {
    console.log(`  ... and ${urls.length - 10} more`);
  }
}
