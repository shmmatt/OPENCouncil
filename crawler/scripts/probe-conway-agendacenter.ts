#!/usr/bin/env tsx

async function main() {
  console.log("=".repeat(70));
  console.log("Probing Conway CivicPlus AgendaCenter for historic minutes");
  console.log("=".repeat(70));

  const baseUrl = "https://conwaynh.gov";
  const agendaPaths = [
    "/AgendaCenter",
    "/agendacenter",
    "/Archive.aspx",
    "/archive.aspx",
    "/AgendaCenter/Search",
    "/DocumentCenter",
    "/documentcenter",
  ];

  for (const path of agendaPaths) {
    const url = baseUrl + path;
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; OPENCouncil/1.0)" },
      });
      console.log(`\n${url}: ${res.status} ${res.statusText}`);
      if (res.status === 200) {
        const html = await res.text();
        const hasMinutes = /minutes/i.test(html);
        const hasPlanning = /planning\s*board/i.test(html);
        const hasZoning = /zoning\s*board/i.test(html);
        const hasAgenda = /agenda/i.test(html);
        const pageSize = html.length;

        console.log(`  Page size: ${pageSize} bytes`);
        console.log(`  Contains 'minutes': ${hasMinutes}`);
        console.log(`  Contains 'planning board': ${hasPlanning}`);
        console.log(`  Contains 'zoning board': ${hasZoning}`);
        console.log(`  Contains 'agenda': ${hasAgenda}`);

        const pdfLinks = html.match(/href="[^"]*\.pdf[^"]*"/gi) || [];
        console.log(`  PDF links found: ${pdfLinks.length}`);
        if (pdfLinks.length > 0) {
          console.log(`  Sample PDF links:`);
          pdfLinks.slice(0, 10).forEach((link) => console.log(`    ${link}`));
        }

        const yearMentions = html.match(/\b20[012]\d\b/g) || [];
        const uniqueYears = [...new Set(yearMentions)].sort();
        console.log(`  Years mentioned: ${uniqueYears.join(", ")}`);

        const categoryLinks = html.match(/href="[^"]*(?:AgendaCenter|DocumentCenter|Archive)[^"]*"/gi) || [];
        if (categoryLinks.length > 0) {
          console.log(`  Category/archive links:`);
          categoryLinks.slice(0, 15).forEach((link) => console.log(`    ${link}`));
        }

        const boardSections = html.match(/<(?:h[1-6]|a|option)[^>]*>[^<]*(?:Planning|Zoning|Select|Budget|Conservation)[^<]*/gi) || [];
        if (boardSections.length > 0) {
          console.log(`  Board-related sections:`);
          boardSections.slice(0, 15).forEach((s) => console.log(`    ${s.substring(0, 120)}`));
        }
      }
    } catch (e: any) {
      console.log(`\n${url}: ERROR - ${e.message}`);
    }
  }

  console.log("\n\n--- Checking /uploads path for minute patterns ---");
  const minutePatterns = [
    "/uploads/pb-minutes",
    "/uploads/zba-minutes",
    "/uploads/planning-board-minutes",
    "/minutes",
    "/government/boards-commissions/planning-board",
    "/government/boards-commissions/zoning-board",
    "/government/boards-and-commissions/planning-board",
  ];

  for (const path of minutePatterns) {
    const url = baseUrl + path;
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; OPENCouncil/1.0)" },
      });
      console.log(`${url}: ${res.status}`);
      if (res.status === 200) {
        const html = await res.text();
        const pdfLinks = html.match(/href="[^"]*\.pdf[^"]*"/gi) || [];
        console.log(`  ${pdfLinks.length} PDF links, page size: ${html.length}`);
        if (pdfLinks.length > 0) {
          pdfLinks.slice(0, 5).forEach((l) => console.log(`    ${l}`));
        }
      }
    } catch (e: any) {
      console.log(`${url}: ERROR - ${e.message}`);
    }
  }

  console.log("\n\n--- Summary ---");
  console.log("Conway uses CivicPlus CMS with Google Drive for meeting minutes.");
  console.log("The Google Drive only has PB/ZBA minutes from 2020 onward.");
  console.log("Pre-2020 PB/ZBA minutes may need to be sourced from the town directly.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
