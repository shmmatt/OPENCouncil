/**
 * Crawler State Extensions for V3 Integration
 * 
 * Additional helper functions for V3 crawler integration
 */

import { db } from '../storage/db';
import { crawlerTowns, type InsertCrawlerTown, type CrawlerTown } from '../../shared/crawler-schema';
import { eq } from 'drizzle-orm';

// ============================================================
// TOWN HELPERS
// ============================================================

/**
 * Get or create a town record (upsert)
 */
export async function ensureTown(params: {
  name: string;
  slug: string;
  url: string;
  status?: string;
  cms?: string;
  county?: string;
}): Promise<CrawlerTown> {
  // Try to get existing
  const [existing] = await db.select()
    .from(crawlerTowns)
    .where(eq(crawlerTowns.slug, params.slug));
  
  if (existing) {
    return existing;
  }
  
  // Create new
  const [created] = await db.insert(crawlerTowns)
    .values({
      name: params.name,
      slug: params.slug,
      url: params.url,
      status: params.status || 'active',
      cms: params.cms,
      county: params.county,
      state: 'NH',
    })
    .returning();
  
  return created;
}

/**
 * Create a slug from town name
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ============================================================
// S3 KEY GENERATION
// ============================================================

export interface S3KeyParams {
  town: string; // slug format: "conway", "ossipee"
  url: string;
  filename: string;
  discoveredFrom?: string | null;
}

export interface DocumentMetadata {
  category: string;
  board?: string;
  year?: string;
}

/**
 * Generate S3 key matching existing structure:
 * {town}/{category}/[{board}/][{year}/]{filename}
 * 
 * CRITICAL: Must match existing Conway/Ossipee structure
 */
export function generateS3Key(params: S3KeyParams): string {
  const { town, url, filename, discoveredFrom } = params;
  
  // Extract metadata from URL and filename
  const metadata = extractDocumentMetadata(url, filename, discoveredFrom);
  
  // Build path components
  const parts = [town];
  
  // Category (required)
  parts.push(metadata.category);
  
  // Board (optional, but common)
  if (metadata.board) {
    parts.push(metadata.board);
  }
  
  // Year (optional)
  if (metadata.year) {
    parts.push(metadata.year);
  }
  
  // Filename (sanitized)
  const sanitizedFilename = sanitizeFilename(filename);
  parts.push(sanitizedFilename);
  
  return parts.join('/');
}

/**
 * Extract document metadata from URL and filename
 */
export function extractDocumentMetadata(
  url: string,
  filename: string,
  source?: string | null
): DocumentMetadata {
  const lower = url.toLowerCase();
  const filenameLower = filename.toLowerCase();
  
  let category = 'documents'; // default
  let board: string | undefined;
  let year: string | undefined;
  
  // ========== CATEGORY DETECTION ==========
  
  // Priority 1: Check URL path
  if (lower.includes('/minute')) {
    category = 'minutes';
  } else if (lower.includes('/agenda')) {
    category = 'agendas';
  } else if (lower.includes('/ordinance')) {
    category = 'ordinances';
  } else if (lower.includes('/budget')) {
    category = 'budget';
  } else if (lower.includes('/report')) {
    category = 'reports';
  } else if (lower.includes('/form')) {
    category = 'forms';
  } else if (lower.includes('/regulation')) {
    category = 'regulations';
  }
  
  // Priority 2: Check filename
  if (category === 'documents') {
    if (filenameLower.includes('minute')) {
      category = 'minutes';
    } else if (filenameLower.includes('agenda')) {
      category = 'agendas';
    } else if (filenameLower.includes('ordinance')) {
      category = 'ordinances';
    } else if (filenameLower.includes('budget')) {
      category = 'budget';
    } else if (filenameLower.includes('report')) {
      category = 'reports';
    }
  }
  
  // ========== BOARD DETECTION ==========
  
  // Common board name patterns (normalized to match existing S3 structure)
  const boardPatterns = [
    { pattern: /board[_\-\s]of[_\-\s]selectmen/i, name: 'Board_of_Selectmen' },
    { pattern: /select[_\-\s]board/i, name: 'Select_Board' },
    { pattern: /planning[_\-\s]board/i, name: 'Planning_Board' },
    { pattern: /zoning[_\-\s]board/i, name: 'Zoning_Board' },
    { pattern: /budget[_\-\s]committee/i, name: 'Budget_Committee' },
    { pattern: /conservation[_\-\s]commission/i, name: 'Conservation_Commission' },
    { pattern: /school[_\-\s]board/i, name: 'School_Board' },
    { pattern: /recreation[_\-\s]committee/i, name: 'Recreation_Committee' },
    { pattern: /heritage[_\-\s]commission/i, name: 'Heritage_Commission' },
    { pattern: /library[_\-\s]trustees/i, name: 'Library_Trustees' },
  ];
  
  // Check both URL and filename
  const textToCheck = `${url} ${filename}`;
  
  for (const { pattern, name } of boardPatterns) {
    if (pattern.test(textToCheck)) {
      board = name;
      break;
    }
  }
  
  // ========== YEAR DETECTION ==========
  
  // Extract 4-digit year (2020-2099)
  const yearMatch = filename.match(/\b(20[2-9]\d)\b/);
  if (yearMatch) {
    year = yearMatch[1];
  } else {
    // Try URL
    const urlYearMatch = url.match(/\b(20[2-9]\d)\b/);
    if (urlYearMatch) {
      year = urlYearMatch[1];
    }
  }
  
  return { category, board, year };
}

/**
 * Sanitize filename for S3 storage
 */
export function sanitizeFilename(filename: string): string {
  // Replace problematic characters while preserving readability
  return filename
    .replace(/[^\w\-\.]/g, '_') // Replace non-word chars with underscore
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, '') // Trim underscores
    .substring(0, 200); // Limit length
}

/**
 * Extract filename from URL
 */
export function extractFilename(url: string): string {
  try {
    const u = new URL(url);
    const pathname = u.pathname;
    const segments = pathname.split('/').filter(Boolean);
    
    // Get last segment
    let filename = segments[segments.length - 1] || 'document';
    
    // Add .pdf if no extension
    if (!filename.match(/\.\w+$/)) {
      filename += '.pdf';
    }
    
    return decodeURIComponent(filename);
  } catch {
    return 'document.pdf';
  }
}
