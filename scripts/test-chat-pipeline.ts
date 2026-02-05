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
