#!/usr/bin/env tsx
/**
 * Cloudflare-Protected Town Crawler
 * Uses stealth browser to bypass Cloudflare and find meeting minutes
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { db } from '../../server/storage/db';
import { crawlerDocuments, crawlerTowns } from '../../shared/crawler-schema';
import { eq, sql } from 'drizzle-orm';
import * as crypto from 'crypto';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

chromium.use(StealthPlugin());

const S3_BUCKET = process.env.S3_BUCKET || 'opencouncil-municipal-docs';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const s3 = new S3Client({ region: S3_REGION });

interface FoundDoc {
  url: string;
  text: string;
  source: string;
}

async function s3KeyExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uploadToS3(key: string, buffer: Buffer, contentType: string): Promise<boolean> {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType
    }));
    return true;
  } catch (e) {
    console.error(`S3 upload failed: ${e}`);
    return false;
  }
}

function categorizeDoc(url: string, text: string): { category: string; board?: string } {
  const combined = (url + ' ' + text).toLowerCase();
  
  let category = 'documents';
  let board: string | undefined;
  
  if (/minute/i.test(combined)) category = 'minutes';
  else if (/agenda/i.test(combined)) category = 'agendas';
  else if (/budget|warrant/i.test(combined)) category = 'budget';
  else if (/report|annual/i.test(combined)) category = 'reports';
  else if (/ordinance/i.test(combined)) category = 'ordinances';
  else if (/zoning|subdivision/i.test(combined)) category = 'zoning';
  else if (/plan|master/i.test(combined)) category = 'planning';
  
  if (/selectmen|select\s*board|bos/i.test(combined)) board = 'selectmen';
  else if (/planning\s*board/i.test(combined)) board = 'planning';
  else if (/zoning\s*board|zba/i.test(combined)) board = 'zoning';
  else if (/conservation/i.test(combined)) board = 'conservation';
  else if (/budget\s*committee/i.test(combined)) board = 'budget';
  
  return { category, board };
}

async function crawlTown(townSlug: string): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🌐 Crawling ${townSlug} (Cloudflare bypass)`);
  console.log('='.repeat(60));
  
  const [town] = await db.select().from(crawlerTowns).where(eq(crawlerTowns.slug, townSlug));
  if (!town) {
    console.error(`Town not found: ${townSlug}`);
    return;
  }
  
  console.log(`📍 ${town.name}: ${town.url}`);
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  const page = await context.newPage();
  
  const visited = new Set<string>();
  const foundDocs: FoundDoc[] = [];
  const pagesToVisit: string[] = [];
  
  const startPaths = [
    '/',
    '/boards',
    '/government',
    '/minutes',
    '/meetings',
    '/selectmen',
    '/selectboard',
    '/board-of-selectmen',
    '/planning-board',
    '/zoning-board',
    '/conservation',
    '/documents',
    '/archives',
    '/agendas-minutes'
  ];
  
  for (const path of startPaths) {
    pagesToVisit.push(town.url + path);
  }
  
  let pagesVisited = 0;
  const maxPages = 100;
  
  while (pagesToVisit.length > 0 && pagesVisited < maxPages) {
    const url = pagesToVisit.shift()!;
    
    if (visited.has(url)) continue;
    visited.add(url);
    
    try {
      console.log(`\n[${pagesVisited + 1}/${maxPages}] ${url}`);
      
      const response = await page.goto(url, { 
        timeout: 30000, 
        waitUntil: 'domcontentloaded' 
      });
      
      const content = await page.content();
      if (content.includes('Just a moment')) {
        console.log('  ⏳ Waiting for Cloudflare...');
        await page.waitForTimeout(5000);
        
        const newContent = await page.content();
        if (newContent.includes('Just a moment')) {
          console.log('  ❌ Still blocked by Cloudflare');
          continue;
        }
      }
      
      pagesVisited++;
      
      const links = await page.evaluate((baseUrl) => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({
            href: a.href,
            text: a.textContent?.trim() || ''
          }))
          .filter(l => l.href.startsWith(baseUrl) || l.href.includes('.pdf'));
      }, town.url);
      
      for (const link of links) {
        const fullUrl = link.href;
        
        if (/\.(pdf|doc|docx)$/i.test(fullUrl)) {
          if (!foundDocs.find(d => d.url === fullUrl)) {
            foundDocs.push({
              url: fullUrl,
              text: link.text,
              source: url
            });
            console.log(`  📄 Found: ${link.text.substring(0, 50)}`);
          }
        }
        else if (fullUrl.startsWith(town.url) && !visited.has(fullUrl)) {
          const keywords = /minute|meeting|agenda|board|committee|select|planning|zoning|conservation|document|archive/i;
          if (keywords.test(fullUrl) || keywords.test(link.text)) {
            if (!pagesToVisit.includes(fullUrl)) {
              pagesToVisit.push(fullUrl);
            }
          }
        }
      }
      
    } catch (e: any) {
      console.log(`  ❌ Error: ${e.message?.substring(0, 60)}`);
    }
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 Found ${foundDocs.length} documents`);
  
  const minutes = foundDocs.filter(d => /minute/i.test(d.url + ' ' + d.text));
  console.log(`📝 ${minutes.length} appear to be minutes`);
  
  let newDocs = 0;
  let uploaded = 0;
  
  for (const doc of foundDocs) {
    const urlHash = crypto.createHash('sha256').update(doc.url).digest('hex');
    const filename = doc.url.split('/').pop() || 'document.pdf';
    const { category, board } = categorizeDoc(doc.url, doc.text);
    
    const existing = await db.select()
      .from(crawlerDocuments)
      .where(eq(crawlerDocuments.urlHash, urlHash))
      .limit(1);
    
    if (existing.length > 0) {
      continue;
    }
    
    try {
      const response = await page.goto(doc.url, { timeout: 30000 });
      if (response?.ok()) {
        const buffer = await response.body();
        const s3Key = `${townSlug}/${category}/${board || 'general'}/${filename}`;
        
        if (await s3KeyExists(s3Key)) {
          console.log(`  ⏭️  ${filename} (S3 exists)`);
          continue;
        }
        
        if (await uploadToS3(s3Key, buffer, 'application/pdf')) {
          await db.insert(crawlerDocuments).values({
            townId: town.id,
            url: doc.url,
            urlHash,
            filename,
            category,
            board,
            s3Key,
            status: 'uploaded',
            discoveredFrom: doc.source,
            s3UploadedAt: new Date()
          });
          
          newDocs++;
          uploaded++;
          console.log(`  ✅ ${filename} -> ${s3Key}`);
        }
      }
    } catch (e: any) {
      console.log(`  ❌ Download failed: ${filename} - ${e.message?.substring(0, 50)}`);
      
      await db.insert(crawlerDocuments).values({
        townId: town.id,
        url: doc.url,
        urlHash,
        filename,
        category,
        board,
        status: 'discovered',
        discoveredFrom: doc.source
      }).onConflictDoNothing();
      newDocs++;
    }
  }
  
  await browser.close();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ COMPLETE: ${newDocs} new docs, ${uploaded} uploaded`);
  console.log('='.repeat(60));
}

const townSlug = process.argv[2];
if (!townSlug) {
  console.log('Usage: crawl-cf-town.ts <town-slug>');
  console.log('Example: crawl-cf-town.ts wakefield');
  process.exit(1);
}

crawlTown(townSlug).then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
