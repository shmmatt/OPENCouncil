#!/usr/bin/env tsx
/**
 * Seed Carroll County Towns into Crawler State DB
 * 
 * Populates the crawler_towns table with all 18 Carroll County towns
 */

import { createTown, getTown } from '../server/services/crawlerState';
import type { InsertCrawlerTown } from '../shared/crawler-schema';

const CARROLL_COUNTY_TOWNS: Omit<InsertCrawlerTown, 'state' | 'county'>[] = [
  {
    name: 'Albany',
    slug: 'albany',
    url: 'https://albanynh.org',
    cms: 'WordPress',
    status: 'active',
  },
  {
    name: 'Bartlett',
    slug: 'bartlett',
    url: 'https://www.townofbartlett.nh.gov',
    cms: 'CivicPlus',
    status: 'active',
  },
  {
    name: 'Brookfield',
    slug: 'brookfield',
    url: 'https://www.brookfieldnh.gov',
    cms: 'Custom',
    status: 'active',
  },
  {
    name: 'Chatham',
    slug: 'chatham',
    url: 'https://www.chathamnh.org',
    cms: 'WordPress',
    status: 'active',
  },
  {
    name: 'Conway',
    slug: 'conway',
    url: 'https://conwaynh.gov',
    cms: 'CivicPlus',
    status: 'active',
  },
  {
    name: 'Eaton',
    slug: 'eaton',
    url: 'https://www.eatonnh.gov',
    cms: 'Custom',
    status: 'active',
  },
  {
    name: 'Effingham',
    slug: 'effingham',
    url: 'https://effinghamnh.net',
    cms: 'WordPress',
    status: 'active',
  },
  {
    name: 'Freedom',
    slug: 'freedom',
    url: 'https://townoffreedomnh.gov',
    cms: 'WordPress',
    status: 'active',
  },
  {
    name: "Hart's Location",
    slug: 'harts-location',
    url: 'https://hartslocation.com',
    cms: 'WordPress',
    status: 'active',
  },
  {
    name: 'Jackson',
    slug: 'jackson',
    url: 'https://www.jackson-nh.gov',
    cms: 'WordPress',
    status: 'active',
  },
  {
    name: 'Madison',
    slug: 'madison',
    url: 'https://madison-nh.org',
    cms: 'WordPress',
    status: 'active',
  },
  {
    name: 'Moultonborough',
    slug: 'moultonborough',
    url: 'https://moultonboroughnh.gov',
    cms: 'CivicPlus',
    status: 'active',
  },
  {
    name: 'Ossipee',
    slug: 'ossipee',
    url: 'https://www.ossipee.org',
    cms: 'Custom',
    status: 'active',
  },
  {
    name: 'Sandwich',
    slug: 'sandwich',
    url: 'https://www.sandwichnh.com',
    cms: 'WordPress',
    status: 'active',
  },
  {
    name: 'Tamworth',
    slug: 'tamworth',
    url: 'https://tamworthnh.gov',
    cms: 'WordPress',
    status: 'active',
  },
  {
    name: 'Tuftonboro',
    slug: 'tuftonboro',
    url: 'https://www.tuftonboronh.gov',
    cms: 'Custom',
    status: 'active',
  },
  {
    name: 'Wakefield',
    slug: 'wakefield',
    url: 'https://www.wakefieldnh.gov',
    cms: 'Custom',
    status: 'active',
  },
  {
    name: 'Wolfeboro',
    slug: 'wolfeboro',
    url: 'https://www.wolfeboronh.us',
    cms: 'CivicPlus',
    status: 'active',
  },
];

async function main() {
  console.log('🏛️  Seeding Carroll County Towns into Crawler State DB\n');
  
  let created = 0;
  let skipped = 0;
  
  for (const townData of CARROLL_COUNTY_TOWNS) {
    try {
      // Check if already exists
      const existing = await getTown(townData.slug);
      
      if (existing) {
        console.log(`⏭️  ${townData.name} - Already exists`);
        skipped++;
        continue;
      }
      
      // Create new town
      const town = await createTown({
        ...townData,
        state: 'NH',
        county: 'Carroll',
      });
      
      console.log(`✅ ${townData.name} - Created (ID: ${town.id})`);
      created++;
    } catch (error) {
      console.error(`❌ ${townData.name} - Error:`, error instanceof Error ? error.message : 'Unknown error');
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`📊 Summary:`);
  console.log(`   Created: ${created}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Total:   ${CARROLL_COUNTY_TOWNS.length}`);
  console.log('='.repeat(60));
}

main()
  .then(() => {
    console.log('\n✅ Seeding complete!\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Seeding failed:', error);
    process.exit(1);
  });
