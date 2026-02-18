/**
 * CLI Script to test chat pipeline and generate analysis reports
 * 
 * Usage:
 *   npm run test:chat -- --sets basic,permits
 *   npm run test:chat -- --sets all
 *   npm run test:chat -- --analyze results.json
 * 
 * Note: Environment variables are loaded via tsx --env-file=.env
 */

import * as fs from "fs/promises";
import * as path from "path";
import { runChatV3Pipeline } from "../server/chatV2/chatOrchestratorV3";
import { v4 as uuidv4 } from "uuid";
import { program } from "commander";

interface TestQuestion {
  id: string;
  message: string;
  town?: string;
  category: string;
  description: string;
  expectedBehaviors?: {
    minSources?: number;
    minLocalChunks?: number;
    minStateChunks?: number;
    expectedTier?: "A" | "B" | "C";
    shouldMentionTopics?: string[];
    shouldNotMentionTopics?: string[];
  };
}

interface TestResult {
  questionId: string;
  question: string;
  town?: string;
  category: string;
  answerText: string;
  sourceDocumentNames: string[];
  docSourceType: string;
  docSourceTown: string | null;
  recordStrength: {
    tier: string;
    confidence: number;
    reasoning: string;
  };
  debug: any;
  passed: boolean;
  failureReasons: string[];
}

// Same test sets as in chatTestRoutes.ts
const testQuestionSets: Record<string, TestQuestion[]> = {
  basic: [
    {
      id: "basic-01",
      message: "When is the next Ossipee Select Board meeting?",
      town: "Ossipee",
      category: "basic-meeting",
      description: "Simple meeting date question",
      expectedBehaviors: {
        minSources: 1,
        minLocalChunks: 2,
        expectedTier: "A",
      },
    },
    {
      id: "basic-02",
      message: "What are the office hours for the Conway town clerk?",
      town: "Conway",
      category: "basic-contact",
      description: "Basic contact information question",
      expectedBehaviors: {
        minSources: 1,
        minLocalChunks: 1,
      },
    },
    {
      id: "basic-03",
      message: "How do I register to vote in Carroll County?",
      town: "Ossipee",
      category: "basic-process",
      description: "Common procedural question",
      expectedBehaviors: {
        minSources: 1,
        minStateChunks: 1,
      },
    },
  ],
  permits: [
    {
      id: "permit-01",
      message: "How do I apply for a building permit in Ossipee?",
      town: "Ossipee",
      category: "permits",
      description: "Building permit application process",
      expectedBehaviors: {
        minSources: 2,
        minLocalChunks: 2,
        minStateChunks: 2,
        shouldMentionTopics: ["building code", "application", "fee"],
      },
    },
    {
      id: "permit-02",
      message: "What are the setback requirements for building a shed in Conway?",
      town: "Conway",
      category: "permits-zoning",
      description: "Specific zoning regulation question",
      expectedBehaviors: {
        minSources: 2,
        minLocalChunks: 2,
        shouldMentionTopics: ["zoning", "setback", "feet"],
      },
    },
  ],
  legal: [
    {
      id: "legal-01",
      message: "What is governmental immunity and how does it protect Carroll County?",
      town: "Ossipee",
      category: "legal-liability",
      description: "State law concept question",
      expectedBehaviors: {
        minSources: 2,
        minStateChunks: 3,
        expectedTier: "A",
        shouldMentionTopics: ["RSA", "immunity", "liability"],
      },
    },
  ],
  taxes: [
    {
      id: "tax-01",
      message: "How are property taxes calculated in Ossipee?",
      town: "Ossipee",
      category: "taxes-property",
      description: "Property tax calculation process",
      expectedBehaviors: {
        minSources: 2,
        minLocalChunks: 2,
        shouldMentionTopics: ["property tax", "assessment", "rate"],
      },
    },
  ],
  // Comprehensive test set - 50 real-world questions
  comprehensive: [
    // Meetings (5)
    { id: "meet-01", message: "When is the next Ossipee Select Board meeting?", town: "Ossipee", category: "meetings", description: "Meeting schedule" },
    { id: "meet-02", message: "What time does the Conway planning board meet?", town: "Conway", category: "meetings", description: "Meeting time" },
    { id: "meet-03", message: "Where can I find the agenda for the next Bartlett town meeting?", town: "Bartlett", category: "meetings", description: "Agenda access" },
    { id: "meet-04", message: "How do I get on the agenda for the Ossipee Select Board meeting?", town: "Ossipee", category: "meetings", description: "Agenda participation" },
    { id: "meet-05", message: "Are town meetings in Albany open to the public?", town: "Albany", category: "meetings", description: "Public access" },
    // Contact (5)
    { id: "cont-01", message: "What are the office hours for the Conway town clerk?", town: "Conway", category: "contact", description: "Office hours" },
    { id: "cont-02", message: "How do I contact the Ossipee tax collector?", town: "Ossipee", category: "contact", description: "Department contact" },
    { id: "cont-03", message: "What's the phone number for the Madison town office?", town: "Madison", category: "contact", description: "Phone number" },
    { id: "cont-04", message: "Is the Bartlett town hall open on weekends?", town: "Bartlett", category: "contact", description: "Weekend hours" },
    { id: "cont-05", message: "Who is the current town administrator in Ossipee?", town: "Ossipee", category: "contact", description: "Staff directory" },
    // Permits (5)
    { id: "perm-01", message: "How do I apply for a building permit in Ossipee?", town: "Ossipee", category: "permits", description: "Building permit process" },
    { id: "perm-02", message: "What documents do I need for a driveway permit in Conway?", town: "Conway", category: "permits", description: "Permit requirements" },
    { id: "perm-03", message: "How much does a building permit cost in Bartlett?", town: "Bartlett", category: "permits", description: "Permit fees" },
    { id: "perm-04", message: "Do I need a permit to install a shed in my backyard in Ossipee?", town: "Ossipee", category: "permits", description: "Permit necessity" },
    { id: "perm-05", message: "How long does it take to get a septic permit approved?", town: "Conway", category: "permits", description: "Permit timeline" },
    // Taxes (5)
    { id: "tax-comp-01", message: "When are property taxes due in Ossipee?", town: "Ossipee", category: "taxes", description: "Tax due dates" },
    { id: "tax-comp-02", message: "What is the current tax rate in Conway?", town: "Conway", category: "taxes", description: "Tax rates" },
    { id: "tax-comp-03", message: "How do I pay my property taxes online?", town: "Bartlett", category: "taxes", description: "Online payment" },
    { id: "tax-comp-04", message: "Can I set up a payment plan for my property taxes in Madison?", town: "Madison", category: "taxes", description: "Payment plans" },
    { id: "tax-comp-05", message: "How do I apply for an abatement on my property taxes?", town: "Ossipee", category: "taxes", description: "Tax abatement" },
    // Voting (5)
    { id: "vote-01", message: "How do I register to vote in Carroll County?", town: "Ossipee", category: "voting", description: "Voter registration" },
    { id: "vote-02", message: "Where is my polling place in Conway?", town: "Conway", category: "voting", description: "Polling location" },
    { id: "vote-03", message: "Can I vote absentee in the next election?", town: "Bartlett", category: "voting", description: "Absentee voting" },
    { id: "vote-04", message: "What do I need to bring to register to vote on election day?", town: "Madison", category: "voting", description: "Election day registration" },
    { id: "vote-05", message: "When is the deadline to request an absentee ballot?", town: "Ossipee", category: "voting", description: "Absentee deadline" },
    // Zoning (5)
    { id: "zone-01", message: "What is my property zoned as in Ossipee?", town: "Ossipee", category: "zoning", description: "Zoning lookup" },
    { id: "zone-02", message: "Can I run a business from my home in Conway?", town: "Conway", category: "zoning", description: "Home business" },
    { id: "zone-03", message: "What are the setback requirements for building in Bartlett?", town: "Bartlett", category: "zoning", description: "Setback requirements" },
    { id: "zone-04", message: "How do I request a zoning variance in Madison?", town: "Madison", category: "zoning", description: "Variance process" },
    { id: "zone-05", message: "Are there any wetland restrictions on my property?", town: "Ossipee", category: "zoning", description: "Wetland restrictions" },
    // Services (5)
    { id: "serv-01", message: "What day is trash pickup in my neighborhood in Ossipee?", town: "Ossipee", category: "services", description: "Trash schedule" },
    { id: "serv-02", message: "How do I get a dump sticker in Conway?", town: "Conway", category: "services", description: "Transfer station access" },
    { id: "serv-03", message: "Does Bartlett have curbside recycling?", town: "Bartlett", category: "services", description: "Recycling services" },
    { id: "serv-04", message: "What items can I bring to the transfer station?", town: "Madison", category: "services", description: "Acceptable items" },
    { id: "serv-05", message: "Is there a hazardous waste collection day coming up?", town: "Ossipee", category: "services", description: "Special collection" },
    // Recreation (5)
    { id: "rec-park-01", message: "Where are the public beaches in Ossipee?", town: "Ossipee", category: "recreation", description: "Beach locations" },
    { id: "rec-park-02", message: "How do I register my child for summer camp in Conway?", town: "Conway", category: "recreation", description: "Program registration" },
    { id: "rec-park-03", message: "Are dogs allowed at town parks in Bartlett?", town: "Bartlett", category: "recreation", description: "Park rules" },
    { id: "rec-park-04", message: "What hiking trails are maintained by the town of Madison?", town: "Madison", category: "recreation", description: "Trail info" },
    { id: "rec-park-05", message: "How much does a beach pass cost?", town: "Ossipee", category: "recreation", description: "Pass fees" },
    // Budget (5)
    { id: "budg-01", message: "What is the town budget for Ossipee this year?", town: "Ossipee", category: "budget", description: "Budget overview" },
    { id: "budg-02", message: "How much does Conway spend on schools?", town: "Conway", category: "budget", description: "School budget" },
    { id: "budg-03", message: "Where can I find the town warrant articles?", town: "Bartlett", category: "budget", description: "Warrant access" },
    { id: "budg-04", message: "What happened with the bond vote last year?", town: "Madison", category: "budget", description: "Vote history" },
    { id: "budg-05", message: "How is the town budget approved?", town: "Ossipee", category: "budget", description: "Budget process" },
    // Records (5)
    { id: "rec-pub-01", message: "How do I request public records from the town?", town: "Ossipee", category: "records", description: "Records request" },
    { id: "rec-pub-02", message: "Where can I find meeting minutes from last month?", town: "Conway", category: "records", description: "Minutes access" },
    { id: "rec-pub-03", message: "How do I get a copy of my property deed?", town: "Bartlett", category: "records", description: "Deed copy" },
    { id: "rec-pub-04", message: "Are planning board decisions public record?", town: "Madison", category: "records", description: "Public records" },
    { id: "rec-pub-05", message: "How long does it take to fulfill a records request?", town: "Ossipee", category: "records", description: "Request timeline" },
  ],
};

async function runTests(setNames: string[]): Promise<TestResult[]> {
  const questionsToTest: TestQuestion[] = [];
  
  if (setNames.includes("all")) {
    for (const questions of Object.values(testQuestionSets)) {
      questionsToTest.push(...questions);
    }
  } else {
    for (const setName of setNames) {
      if (testQuestionSets[setName]) {
        questionsToTest.push(...testQuestionSets[setName]);
      } else {
        console.warn(`⚠️  Unknown test set: ${setName}`);
      }
    }
  }
  
  if (questionsToTest.length === 0) {
    throw new Error("No questions to test");
  }
  
  console.log(`🧪 Running ${questionsToTest.length} tests...\n`);
  
  const results: TestResult[] = [];
  
  for (const question of questionsToTest) {
    const logContext = {
      requestId: uuidv4(),
      sessionId: `test-${question.id}`,
      startTime: Date.now(),
    };
    
    process.stdout.write(`Testing ${question.id}: "${question.message.substring(0, 60)}..." `);
    
    try {
      const pipelineResult = await runChatV3Pipeline({
        userMessage: question.message,
        sessionHistory: [],
        townPreference: question.town || null,
        situationContext: null,
        sessionSources: [],
        logContext,
      });
      
      // Validate against expected behaviors
      const failureReasons: string[] = [];
      const expected = question.expectedBehaviors || {};
      
      if (expected.minSources && pipelineResult.sourceDocumentNames.length < expected.minSources) {
        failureReasons.push(`Expected ≥${expected.minSources} sources, got ${pipelineResult.sourceDocumentNames.length}`);
      }
      
      if (expected.minLocalChunks && pipelineResult.debug.retrievalCounts.localSelected < expected.minLocalChunks) {
        failureReasons.push(`Expected ≥${expected.minLocalChunks} local chunks, got ${pipelineResult.debug.retrievalCounts.localSelected}`);
      }
      
      if (expected.minStateChunks && pipelineResult.debug.retrievalCounts.stateSelected < expected.minStateChunks) {
        failureReasons.push(`Expected ≥${expected.minStateChunks} state chunks, got ${pipelineResult.debug.retrievalCounts.stateSelected}`);
      }
      
      if (expected.expectedTier && pipelineResult.recordStrength.tier !== expected.expectedTier) {
        failureReasons.push(`Expected tier ${expected.expectedTier}, got ${pipelineResult.recordStrength.tier}`);
      }
      
      if (expected.shouldMentionTopics) {
        for (const topic of expected.shouldMentionTopics) {
          if (!pipelineResult.answerText.toLowerCase().includes(topic.toLowerCase())) {
            failureReasons.push(`Should mention "${topic}"`);
          }
        }
      }
      
      const passed = failureReasons.length === 0;
      
      results.push({
        questionId: question.id,
        question: question.message,
        town: question.town,
        category: question.category,
        answerText: pipelineResult.answerText,
        sourceDocumentNames: pipelineResult.sourceDocumentNames,
        docSourceType: pipelineResult.docSourceType,
        docSourceTown: pipelineResult.docSourceTown,
        recordStrength: pipelineResult.recordStrength,
        debug: {
          durationMs: pipelineResult.durationMs,
          localSelected: pipelineResult.debug.retrievalCounts.localSelected,
          stateSelected: pipelineResult.debug.retrievalCounts.stateSelected,
          auditFlags: pipelineResult.debug.auditFlags,
          repairRan: pipelineResult.debug.repairRan,
          planQueries: pipelineResult.debug.planQueries,
          retrievalCounts: pipelineResult.debug.retrievalCounts,
        },
        passed,
        failureReasons,
      });
      
      if (passed) {
        console.log(`✅ PASS (${pipelineResult.durationMs}ms)`);
      } else {
        console.log(`❌ FAIL`);
        failureReasons.forEach(reason => console.log(`   - ${reason}`));
      }
      
    } catch (error: any) {
      console.log(`💥 ERROR: ${error.message}`);
      results.push({
        questionId: question.id,
        question: question.message,
        town: question.town,
        category: question.category,
        answerText: "",
        sourceDocumentNames: [],
        docSourceType: "none",
        docSourceTown: null,
        recordStrength: { tier: "C", confidence: 0, reasoning: "Pipeline error" },
        debug: {
          durationMs: 0,
          localSelected: 0,
          stateSelected: 0,
          auditFlags: [],
          repairRan: false,
          planQueries: { local: [], state: [] },
          retrievalCounts: {
            localRetrieved: 0,
            localSelected: 0,
            stateRetrieved: 0,
            stateSelected: 0,
          },
        },
        passed: false,
        failureReasons: [`Pipeline error: ${error.message}`],
      });
    }
  }
  
  return results;
}

function generateReport(results: TestResult[]): string {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const passRate = (passed / results.length) * 100;
  const avgDuration = results.reduce((sum, r) => sum + r.debug.durationMs, 0) / results.length;
  
  let report = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 CHAT PIPELINE TEST REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📈 SUMMARY
  Total Tests:     ${results.length}
  Passed:          ${passed} ✅
  Failed:          ${failed} ❌
  Pass Rate:       ${passRate.toFixed(1)}%
  Avg Duration:    ${avgDuration.toFixed(0)}ms

`;

  // By category
  const byCategory = new Map<string, TestResult[]>();
  for (const result of results) {
    if (!byCategory.has(result.category)) {
      byCategory.set(result.category, []);
    }
    byCategory.get(result.category)!.push(result);
  }
  
  report += `📁 BY CATEGORY\n`;
  for (const [category, categoryResults] of byCategory) {
    const catPassed = categoryResults.filter(r => r.passed).length;
    const catTotal = categoryResults.length;
    const catRate = (catPassed / catTotal) * 100;
    report += `  ${category.padEnd(25)} ${catPassed}/${catTotal} (${catRate.toFixed(0)}%)\n`;
  }
  
  // Failed tests
  const failedResults = results.filter(r => !r.passed);
  if (failedResults.length > 0) {
    report += `\n❌ FAILED TESTS\n`;
    for (const result of failedResults) {
      report += `\n  ${result.questionId}: ${result.question}\n`;
      report += `  Town: ${result.town || "N/A"}\n`;
      result.failureReasons.forEach(reason => {
        report += `   - ${reason}\n`;
      });
    }
  }
  
  // Recommendations
  report += `\n💡 RECOMMENDATIONS\n`;
  
  const lowRetrieval = results.filter(r => r.debug.localSelected < 2 && r.debug.stateSelected < 2);
  if (lowRetrieval.length > 0) {
    report += `  • ${lowRetrieval.length} questions retrieved < 2 chunks total\n`;
    report += `    → Improve query generation or add more documents\n`;
  }
  
  const highRepair = results.filter(r => r.debug.repairRan);
  if (highRepair.length > results.length * 0.3) {
    report += `  • ${highRepair.length} questions (${((highRepair.length/results.length)*100).toFixed(0)}%) triggered repair\n`;
    report += `    → Improve initial synthesis quality\n`;
  }
  
  const tierC = results.filter(r => r.recordStrength.tier === "C");
  if (tierC.length > results.length * 0.3) {
    report += `  • ${tierC.length} questions (${((tierC.length/results.length)*100).toFixed(0)}%) were Tier C\n`;
    report += `    → Add more comprehensive documentation\n`;
  }
  
  report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  
  return report;
}

// CLI setup
program
  .name("test-chat-pipeline")
  .description("Test chat pipeline and generate analysis reports");

program
  .command("run")
  .description("Run test sets")
  .option("-s, --sets <sets>", "Comma-separated test set names (or 'all')", "basic")
  .option("-o, --output <file>", "Save results to JSON file")
  .action(async (options) => {
    try {
      const setNames = options.sets.split(",").map((s: string) => s.trim());
      const results = await runTests(setNames);
      
      const report = generateReport(results);
      console.log(report);
      
      if (options.output) {
        const outputPath = path.resolve(options.output);
        await fs.writeFile(outputPath, JSON.stringify(results, null, 2));
        console.log(`\n💾 Results saved to: ${outputPath}`);
      }
      
      const passed = results.filter(r => r.passed).length;
      process.exit(passed === results.length ? 0 : 1);
      
    } catch (error: any) {
      console.error(`\n💥 Error: ${error.message}`);
      console.error(error.stack);
      process.exit(1);
    }
  });

program
  .command("analyze")
  .description("Analyze results from a previous run")
  .argument("<file>", "JSON results file")
  .action(async (file) => {
    try {
      const filePath = path.resolve(file);
      const content = await fs.readFile(filePath, "utf-8");
      const results = JSON.parse(content) as TestResult[];
      
      const report = generateReport(results);
      console.log(report);
      
    } catch (error: any) {
      console.error(`\n💥 Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List available test sets")
  .action(() => {
    console.log("\n📋 Available Test Sets:\n");
    for (const [name, questions] of Object.entries(testQuestionSets)) {
      console.log(`  ${name.padEnd(15)} (${questions.length} questions)`);
    }
    console.log("");
  });

program.parse();
