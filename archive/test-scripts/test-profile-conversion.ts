/**
 * Quick script to test converting JSON profile to markdown
 */

import * as fs from "fs/promises";
import { profileToMarkdown } from "@shared/town-profile-schema";
import type { TownProfile } from "@shared/town-profile-schema";

async function testConversion() {
  const jsonPath = "town-profiles/ossipee-profile-2026-02-05-manual.json";
  const json = await fs.readFile(jsonPath, "utf-8");
  const profile: TownProfile = JSON.parse(json);
  
  const markdown = profileToMarkdown(profile);
  
  const mdPath = jsonPath.replace(".json", ".md");
  await fs.writeFile(mdPath, markdown);
  
  console.log(`✅ Converted ${jsonPath} to ${mdPath}`);
  console.log(`\nFirst 1000 chars of markdown:\n`);
  console.log(markdown.substring(0, 1000));
  console.log("\n...\n");
}

testConversion().catch(console.error);
