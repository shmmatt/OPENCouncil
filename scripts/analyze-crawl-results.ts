#!/usr/bin/env tsx
/**
 * Analyze batch crawl results and generate insights
 */

import { promises as fs } from 'fs';
import * as path from 'path';

const RESULTS_FILE = '/home/ubuntu/.openclaw/workspace/OPENCouncil/crawl-logs/batch-results.json';
const ANALYSIS_FILE = '/home/ubuntu/.openclaw/workspace/OPENCouncil/crawl-logs/analysis.md';

interface TownResult {
  name: string;
  url: string;
  success: boolean;
  docsFound: number;
  strategiesUsed: string[];
  cms: string;
  workingPages: string[];
  categories: Record<string, number>;
  error?: string;
}

async function analyze() {
  const data = await fs.readFile(RESULTS_FILE, 'utf-8');
  const results: TownResult[] = JSON.parse(data);
  
  let analysis = '# Crawl Results Analysis\n\n';
  
  // Overall stats
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const totalDocs = results.reduce((sum, r) => sum + r.docsFound, 0);
  
  analysis += '## Overall Statistics\n\n';
  analysis += `- **Total towns:** ${results.length}\n`;
  analysis += `- **Successful:** ${successful.length}\n`;
  analysis += `- **Failed:** ${failed.length}\n`;
  analysis += `- **Total documents:** ${totalDocs}\n`;
  analysis += `- **Average per town:** ${Math.round(totalDocs / successful.length)}\n\n`;
  
  // CMS breakdown
  analysis += '## CMS Distribution\n\n';
  const cmsCounts: Record<string, number> = {};
  const cmsDocCounts: Record<string, number> = {};
  
  successful.forEach(r => {
    cmsCounts[r.cms] = (cmsCounts[r.cms] || 0) + 1;
    cmsDocCounts[r.cms] = (cmsDocCounts[r.cms] || 0) + r.docsFound;
  });
  
  Object.entries(cmsCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cms, count]) => {
      const avgDocs = Math.round(cmsDocCounts[cms] / count);
      analysis += `- **${cms}:** ${count} towns, avg ${avgDocs} docs/town\n`;
    });
  
  analysis += '\n';
  
  // Strategy effectiveness
  analysis += '## Strategy Effectiveness\n\n';
  
  const indexOnly = successful.filter(r => r.strategiesUsed.length === 1 && r.strategiesUsed.includes('Index Pages'));
  const usedNavigation = successful.filter(r => r.strategiesUsed.includes('Navigation Following'));
  
  analysis += `- **Index pages only:** ${indexOnly.length} towns\n`;
  analysis += `  - Avg docs: ${Math.round(indexOnly.reduce((sum, r) => sum + r.docsFound, 0) / indexOnly.length)}\n`;
  analysis += `- **Required navigation:** ${usedNavigation.length} towns\n`;
  analysis += `  - Avg docs: ${Math.round(usedNavigation.reduce((sum, r) => sum + r.docsFound, 0) / usedNavigation.length)}\n\n`;
  
  // Working index pages
  analysis += '## Most Effective Index Pages\n\n';
  
  const pageFrequency: Record<string, number> = {};
  successful.forEach(r => {
    r.workingPages.forEach(page => {
      pageFrequency[page] = (pageFrequency[page] || 0) + 1;
    });
  });
  
  const sortedPages = Object.entries(pageFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  
  sortedPages.forEach(([page, count]) => {
    const percentage = Math.round((count / successful.length) * 100);
    analysis += `- \`${page}\`: ${count} towns (${percentage}%)\n`;
  });
  
  analysis += '\n';
  
  // CMS-specific patterns
  analysis += '## CMS-Specific Patterns\n\n';
  
  ['WordPress', 'CivicPlus', 'Custom'].forEach(cms => {
    const cmsResults = successful.filter(r => r.cms === cms);
    if (cmsResults.length === 0) return;
    
    analysis += `### ${cms} (${cmsResults.length} towns)\n\n`;
    
    const cmsPages: Record<string, number> = {};
    cmsResults.forEach(r => {
      r.workingPages.forEach(page => {
        cmsPages[page] = (cmsPages[page] || 0) + 1;
      });
    });
    
    const topPages = Object.entries(cmsPages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    analysis += 'Top working pages:\n';
    topPages.forEach(([page, count]) => {
      const percentage = Math.round((count / cmsResults.length) * 100);
      analysis += `- \`${page}\`: ${percentage}%\n`;
    });
    
    analysis += '\n';
  });
  
  // Category analysis
  analysis += '## Document Categories\n\n';
  
  const allCategories: Record<string, number> = {};
  successful.forEach(r => {
    Object.entries(r.categories).forEach(([cat, count]) => {
      allCategories[cat] = (allCategories[cat] || 0) + count;
    });
  });
  
  Object.entries(allCategories)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => {
      const percentage = Math.round((count / totalDocs) * 100);
      analysis += `- **${cat}:** ${count} docs (${percentage}%)\n`;
    });
  
  analysis += '\n';
  
  // Towns with good coverage
  analysis += '## High Coverage Towns (100+ docs)\n\n';
  
  const highCoverage = successful
    .filter(r => r.docsFound >= 100)
    .sort((a, b) => b.docsFound - a.docsFound);
  
  highCoverage.forEach(r => {
    const hasMinutes = r.categories.minutes || 0;
    const hasAgendas = r.categories.agendas || 0;
    analysis += `- **${r.name}:** ${r.docsFound} docs (${r.cms})\n`;
    analysis += `  - Minutes: ${hasMinutes}, Agendas: ${hasAgendas}\n`;
    analysis += `  - Strategies: ${r.strategiesUsed.join(' → ')}\n`;
  });
  
  analysis += '\n';
  
  // Towns with low coverage
  analysis += '## Low Coverage Towns (< 50 docs)\n\n';
  
  const lowCoverage = successful
    .filter(r => r.docsFound < 50)
    .sort((a, b) => a.docsFound - b.docsFound);
  
  lowCoverage.forEach(r => {
    analysis += `- **${r.name}:** ${r.docsFound} docs (${r.cms})\n`;
    analysis += `  - Working pages: ${r.workingPages.length > 0 ? r.workingPages.join(', ') : 'none'}\n`;
    analysis += `  - Categories: ${Object.keys(r.categories).join(', ') || 'none'}\n`;
  });
  
  analysis += '\n';
  
  // Failed towns
  if (failed.length > 0) {
    analysis += '## Failed Towns\n\n';
    failed.forEach(r => {
      analysis += `- **${r.name}:** ${r.error}\n`;
    });
    analysis += '\n';
  }
  
  // Recommendations
  analysis += '## Recommendations\n\n';
  
  // Find patterns we're missing
  const missingPatterns: string[] = [];
  
  // Check if there are node patterns we should add
  const civicPlusResults = successful.filter(r => r.cms === 'CivicPlus');
  if (civicPlusResults.length > 0) {
    const nodePages = civicPlusResults
      .flatMap(r => r.workingPages)
      .filter(p => p.includes('/node/'));
    
    const nodeIds = nodePages
      .map(p => p.match(/\/node\/(\d+)/)?.[1])
      .filter(Boolean) as string[];
    
    const uniqueNodes = [...new Set(nodeIds)].sort((a, b) => parseInt(a) - parseInt(b));
    
    if (uniqueNodes.length > 0) {
      analysis += `### CivicPlus Node IDs\n`;
      analysis += `Working node IDs found: ${uniqueNodes.join(', ')}\n`;
      analysis += `Consider prioritizing these in the crawler.\n\n`;
    }
  }
  
  // Check for WordPress patterns
  const wpResults = successful.filter(r => r.cms === 'WordPress');
  if (wpResults.length > 0) {
    const wpPages = wpResults.flatMap(r => r.workingPages);
    const wpUnique = [...new Set(wpPages)];
    
    const notCurrentlyChecked = wpUnique.filter(p => 
      !['/documents', '/minutes', '/agendas', '/boards', '/forms', '/applications', '/regulations'].includes(p)
    );
    
    if (notCurrentlyChecked.length > 0) {
      analysis += `### WordPress Patterns to Add\n`;
      notCurrentlyChecked.forEach(p => {
        const count = wpPages.filter(page => page === p).length;
        const percentage = Math.round((count / wpResults.length) * 100);
        if (percentage >= 20) {
          analysis += `- \`${p}\`: ${percentage}% of WP sites\n`;
        }
      });
      analysis += '\n';
    }
  }
  
  // Coverage assessment tuning
  const needNavigation = usedNavigation.filter(r => {
    const initialDocs = Math.round(r.docsFound / 3); // Rough estimate
    return initialDocs >= 50 && r.docsFound >= 100;
  });
  
  if (needNavigation.length > 0) {
    analysis += `### Coverage Threshold Tuning\n`;
    analysis += `${needNavigation.length} towns had 50+ docs in Strategy 1 but benefited from Strategy 2.\n`;
    analysis += `Consider raising the "adequate coverage" threshold or always running Strategy 2 in thorough mode.\n\n`;
  }
  
  // Save analysis
  await fs.writeFile(ANALYSIS_FILE, analysis);
  
  console.log(analysis);
  console.log(`\nAnalysis saved to: ${ANALYSIS_FILE}`);
}

analyze().catch(console.error);
