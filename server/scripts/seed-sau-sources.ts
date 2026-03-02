import { db } from '../storage/db';
import { crawlerSauSources } from '../../shared/crawler-schema';
import { sql } from 'drizzle-orm';

const BROADENED_LINK_PATTERNS = [
  "budget", "minutes", "agenda", "annual-report", "school-board", "warrant", "policy",
  "report", "form", "agreement", "contract", "handbook", "plan", "assessment",
  "finance", "enrollment", "annual", "meeting", "document", "memo", "notice",
  "superintendent",
];

const TIGHTENED_EXCLUDE_PATTERNS = [
  "/athletics/", "/lunch-menu", "/sports/", "/calendar/month", "/calendar/week",
  "/calendar/day", "/lunch/menu", "/breakfast-menu",
];

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
      "/school-boards", "/school-boards-home", "/sau9-reports",
      "/forms", "/district", "/district-home", "/departments", "/curriculum",
      "/negotiated-agreements-personnel-pol", "/evaluations", "/benefits",
      "/sau9", "/staff",
      "/albany", "/bartlett", "/chatham", "/conway-home", "/eaton",
      "/freedom", "/harts-location", "/jackson", "/madison", "/tamworth",
      "/students-families", "/strategic-plan-2022-2025", "/transportation",
      "/technology", "/student-services", "/title-ix", "/schools",
      "/tuitions", "/food-services",
    ],
    linkPatterns: BROADENED_LINK_PATTERNS,
    excludePatterns: TIGHTENED_EXCLUDE_PATTERNS,
    maxPages: 300,
    notes: "Largest Carroll County SAU — 10 member towns. Conway is the hub. Uses SmartSites/ParentSquare CMS with reCAPTCHA v3 (non-blocking).",
  },
  {
    name: "SAU 49 - Governor Wentworth Regional",
    slug: "sau-49",
    sauId: "SAU 49",
    baseUrl: "https://gwrsd.sau49nh.gov",
    description: "Governor Wentworth Regional School District serving 6 Carroll/Strafford County towns",
    memberTowns: ["Wolfeboro", "Ossipee", "Tuftonboro", "Effingham", "Brookfield", "New Durham"],
    county: "Carroll",
    state: "NH",
    targetPaths: [
      "/school-board", "/school-board/meeting-minutes", "/school-board/meeting-minutes-clone",
      "/school-board/agendas", "/school-board/annual-meeting",
      "/school-board/school-board-policy", "/school-board/school-board-committees",
      "/school-board/meeting-schedule", "/school-board/school-board-member-ethics",
      "/about-gwrsd/sau-office", "/about-gwrsd/budget-finance",
      "/about-gwrsd/district-reports", "/about-gwrsd/strategic-plan",
      "/about-gwrsd/commencement-goals", "/about-gwrsd/data-reporting",
      "/about-gwrsd/right-to-know-requests", "/about-gwrsd/superintendent",
      "/special-education", "/staff/pd-master-plan-and-appendices",
      "/staff/required-trainings", "/families/family-engagement-policy",
      "/forms", "/transportation", "/food-service2",
    ],
    linkPatterns: BROADENED_LINK_PATTERNS,
    excludePatterns: TIGHTENED_EXCLUDE_PATTERNS,
    maxPages: 400,
    notes: "Governor Wentworth Regional — Wolfeboro is the hub. Uses Finalsite CMS (docs via /fs/resource-manager/view/). gwrsd.org redirects to gwrsd.sau49nh.gov. Note: Wakefield is NOT in SAU 49 (it's SAU 101).",
  },
  {
    name: "SAU 45 - Moultonborough",
    slug: "sau-45",
    sauId: "SAU 45",
    baseUrl: "https://sau45.org/en-US",
    description: "Moultonborough School District — single-town SAU",
    memberTowns: ["Moultonborough"],
    county: "Carroll",
    state: "NH",
    targetPaths: [
      "/en-US/school-board-355f9053", "/en-US/pages/355f9053-9876-4f0a-b85e-522d0fdffb7b",
      "/en-US/pages/95ecc2a1-e316-41f8-991c-f11dd5bd6adc",
      "/employment", "/for-staff",
    ],
    linkPatterns: BROADENED_LINK_PATTERNS,
    excludePatterns: TIGHTENED_EXCLUDE_PATTERNS,
    maxPages: 200,
    notes: "Single-town SAU — Moultonborough only. Uses SchoolBlocks CMS. Documents often hosted on Google Drive. SAU admin site is sau45.org, not ma-hs.sau45.org (which is the school campus site).",
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
      "/school-board/school-board-documents",
      "/departments/human-resources", "/departments/human-resources/collective-bargaining-agreements",
      "/departments/human-resources/forms", "/departments/human-resources/jlmc-minutes",
      "/family-resources",
    ],
    linkPatterns: BROADENED_LINK_PATTERNS,
    excludePatterns: TIGHTENED_EXCLUDE_PATTERNS,
    maxPages: 250,
    notes: "Inter-Lakes — spans Belknap/Carroll county lines. Meredith is the hub. Uses Finalsite CMS (docs via /fs/resource-manager/view/ and resources.finalsite.net).",
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
      await db.execute(sql`
        UPDATE crawler_sau_sources SET
          name = ${sau.name},
          sau_id = ${sau.sauId},
          base_url = ${sau.baseUrl},
          description = ${sau.description},
          member_towns = ${JSON.stringify(sau.memberTowns)}::jsonb,
          target_paths = ${JSON.stringify(sau.targetPaths)}::jsonb,
          link_patterns = ${JSON.stringify(sau.linkPatterns)}::jsonb,
          exclude_patterns = ${JSON.stringify(sau.excludePatterns)}::jsonb,
          max_pages = ${sau.maxPages},
          notes = ${sau.notes}
        WHERE slug = ${sau.slug}
      `);
      console.log(`  UPDATE: ${sau.name} (slug '${sau.slug}' updated)`);
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
    console.log(`  INSERT: ${sau.name} (${sau.sauId}) — ${sau.memberTowns.length} member towns`);
  }

  console.log("SAU source seeding complete.");
}

seedSauSources()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
