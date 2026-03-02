import { db } from '../storage/db';
import { crawlerSauSources } from '../../shared/crawler-schema';
import { sql } from 'drizzle-orm';

const SAU_SOURCES = [
  {
    name: "SAU 9 - Mt. Washington Valley",
    slug: "sau-9",
    sauId: "SAU 9",
    baseUrl: "https://www.sau9.org",
    description: "Mt. Washington Valley school district covering 10 Carroll County towns",
    memberTowns: ["Conway", "Albany", "Bartlett", "Chatham", "Eaton", "Freedom", "Hart's Location", "Jackson", "Madison", "Tamworth"],
    county: "Carroll",
    state: "NH",
    targetPaths: [
      "/school-board", "/school-board/meeting-minutes", "/school-board/agendas",
      "/budget", "/annual-report", "/superintendent",
      "/policies", "/district-information",
    ],
    linkPatterns: ["budget", "minutes", "agenda", "annual-report", "school-board", "warrant", "policy", "superintendent"],
    excludePatterns: ["calendar", "lunch-menu", "athletics", "sports"],
    maxPages: 300,
    notes: "Largest Carroll County SAU — 10 member towns. Conway is the hub.",
  },
  {
    name: "SAU 49 - Governor Wentworth Regional",
    slug: "sau-49",
    sauId: "SAU 49",
    baseUrl: "https://www.gwrsd.org",
    description: "Governor Wentworth Regional School District serving 6 Carroll/Strafford County towns",
    memberTowns: ["Wolfeboro", "Ossipee", "Tuftonboro", "Effingham", "Brookfield", "New Durham"],
    county: "Carroll",
    state: "NH",
    targetPaths: [
      "/school-board", "/school-board/minutes", "/school-board/agendas",
      "/budget", "/annual-reports", "/superintendent",
      "/policies", "/district",
    ],
    linkPatterns: ["budget", "minutes", "agenda", "annual-report", "school-board", "warrant", "policy"],
    excludePatterns: ["calendar", "lunch", "athletics", "sports"],
    maxPages: 300,
    notes: "Governor Wentworth Regional — Wolfeboro is the hub. Note: Wakefield is NOT in SAU 49 (it's SAU 101).",
  },
  {
    name: "SAU 45 - Moultonborough",
    slug: "sau-45",
    sauId: "SAU 45",
    baseUrl: "https://www.moultonboroughschool.com",
    description: "Moultonborough School District — single-town SAU",
    memberTowns: ["Moultonborough"],
    county: "Carroll",
    state: "NH",
    targetPaths: [
      "/school-board", "/school-board/minutes", "/school-board/agendas",
      "/budget", "/annual-report", "/superintendent",
      "/policies",
    ],
    linkPatterns: ["budget", "minutes", "agenda", "annual-report", "school-board", "warrant", "policy"],
    excludePatterns: ["calendar", "lunch", "athletics", "sports"],
    maxPages: 200,
    notes: "Single-town SAU — Moultonborough only.",
  },
  {
    name: "SAU 2 - Inter-Lakes",
    slug: "sau-2",
    sauId: "SAU 2",
    baseUrl: "https://www.interlakes.org",
    description: "Inter-Lakes School District serving Meredith, Center Harbor, and Sandwich",
    memberTowns: ["Meredith", "Center Harbor", "Sandwich"],
    county: "Carroll",
    state: "NH",
    targetPaths: [
      "/school-board", "/school-board/minutes", "/school-board/agendas",
      "/budget", "/annual-report", "/superintendent",
      "/policies", "/district",
    ],
    linkPatterns: ["budget", "minutes", "agenda", "annual-report", "school-board", "warrant", "policy"],
    excludePatterns: ["calendar", "lunch", "athletics", "sports"],
    maxPages: 250,
    notes: "Inter-Lakes — spans Belknap/Carroll county lines. Meredith is the hub.",
  },
];

async function seedSauSources() {
  console.log("Seeding SAU sources...");

  for (const sau of SAU_SOURCES) {
    const existing = await db.select({ id: crawlerSauSources.id })
      .from(crawlerSauSources)
      .where(sql`${crawlerSauSources.slug} = ${sau.slug}`)
      .limit(1);

    if (existing.length > 0) {
      console.log(`  SKIP: ${sau.name} (slug '${sau.slug}' already exists)`);
      continue;
    }

    await db.insert(crawlerSauSources).values({
      name: sau.name,
      slug: sau.slug,
      sauId: sau.sauId,
      baseUrl: sau.baseUrl,
      description: sau.description,
      memberTowns: sau.memberTowns,
      county: sau.county,
      state: sau.state,
      targetPaths: sau.targetPaths,
      linkPatterns: sau.linkPatterns,
      excludePatterns: sau.excludePatterns,
      maxPages: sau.maxPages,
      notes: sau.notes,
      status: "active",
    });
    console.log(`  OK: ${sau.name} (${sau.sauId}) — ${sau.memberTowns.length} member towns`);
  }

  console.log("SAU source seeding complete.");
}

seedSauSources()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
