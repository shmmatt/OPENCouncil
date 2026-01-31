
import { runChatV3Pipeline } from "../server/chatV2/chatOrchestratorV3";
import { v4 as uuidv4 } from "uuid";

// Ensure env vars are loaded
import * as dotenv from "dotenv";
dotenv.config({ path: "OPENCouncil/.env" });

async function runTest() {
  const args = process.argv.slice(2);
  const town = args[0] || "conway";
  const question = args[1] || "What happened at the last selectmen meeting?";

  console.log(`[TestChat] Town: ${town}`);
  console.log(`[TestChat] Question: ${question}`);
  console.log("---------------------------------------------------");

  try {
    const result = await runChatV3Pipeline({
      userMessage: question,
      sessionHistory: [], // Stateless test
      townPreference: town,
      situationContext: null,
      sessionSources: [],
      logContext: {
        requestId: uuidv4(),
        sessionId: "test-session",
        startTime: Date.now(),
      }
    });

    console.log("\n=== ANSWER ===");
    console.log(result.answerText);
    
    console.log("\n=== SOURCES ===");
    if (result.sourceDocumentNames && result.sourceDocumentNames.length > 0) {
      result.sourceDocumentNames.forEach((doc, i) => {
        console.log(`[${i+1}] ${doc}`);
      });
    } else {
      console.log("No sources cited.");
    }

    console.log("\n=== DEBUG INFO ===");
    console.log(`Duration: ${result.durationMs}ms`);
    console.log(`Doc Source Type: ${result.docSourceType}`);
    console.log(`Retrieval: Local=${result.debug.retrievalCounts.localSelected}, State=${result.debug.retrievalCounts.stateSelected}`);
    
    if (result.debug.issueMapSummary) {
        console.log("\n--- Planner ---");
        console.log("Entities:", result.debug.issueMapSummary.entities);
        console.log("Legal Topics:", result.debug.issueMapSummary.legalTopics);
    }

  } catch (error) {
    console.error("Pipeline Error:", error);
  }
}

runTest();
