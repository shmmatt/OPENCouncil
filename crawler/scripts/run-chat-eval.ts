import { runChatV3Pipeline } from "../server/chatV2/chatOrchestratorV3";
import { v4 as uuidv4 } from "uuid";
import logger from "../server/utils/logger";

// --- START: Golden Set Definition (to be moved to tests/golden_set.json later) ---
interface GoldenQuestion {
    message: string;
    town: string;
    expectedSources: number; // Minimal check for retrieval efficacy
    description: string;
}

const goldenSet: GoldenQuestion[] = [
    {
        message: "When is the next meeting of the Ossipee Select Board?",
        town: "Ossipee",
        expectedSources: 1,
        description: "Standard question for a local government body in Ossipee."
    },
    {
        message: "What is the zoning ordinance for building a shed in Conway?",
        town: "Conway",
        expectedSources: 2, // Should retrieve the zoning ordinance AND the town name doc
        description: "Specific ordinance question for Conway to test cross-town pollution."
    },
    {
        message: "How does the town of Ossipee handle property tax abatements?",
        town: "Ossipee",
        expectedSources: 1,
        description: "Complex process question to test deep retrieval."
    },
];
// --- END: Golden Set Definition ---

async function runChatEvaluation() {
    logger.info("--- Starting Automated Chat Evaluation (Golden Set) ---");

    const results: any[] = [];
    let passedCount = 0;

    for (const question of goldenSet) {
        const sessionId = uuidv4();
        const logContext = {
            requestId: uuidv4(),
            sessionId: sessionId,
            startTime: Date.now(),
        };

        logger.info("\n[EVAL] Running Test: " + question.description + " (Town: " + question.town + ")");
        logger.info("[EVAL] Query: \"" + question.message + "\"");

        let result;
        try {
            // Run the full pipeline
            result = await runChatV3Pipeline({
                userMessage: question.message,
                sessionHistory: [],
                townPreference: question.town,
                situationContext: null,
                sessionSources: [],
                logContext
            });

            // Perform basic validation
            const actualSources = result.sourceDocumentNames.length;
            const sourcePass = actualSources >= question.expectedSources;
            const overallPass = sourcePass; // For now, only validate source count

            if (overallPass) {
                passedCount++;
            }

            results.push({
                test: question.description,
                query: question.message,
                town: question.town,
                passed: overallPass,
                details: {
                    answerTextSnippet: result.answerText.substring(0, 100).replace(/\\n/g, " ") + "...",
                    sourcesRetrieved: actualSources,
                    expectedMinSources: question.expectedSources,
                    durationMs: result.durationMs,
                    auditFlags: result.debug.auditFlags,
                    queries: result.debug.planQueries,
                }
            });

            logger.info("[RESULT] Passed: " + (overallPass ? "Yes" : "No") + " | Sources: " + actualSources + " (Min: " + question.expectedSources + ")");
            logger.info("[SNIPPET] " + result.answerText.substring(0, 100).replace(/\n/g, " ") + "...");

        } catch (error) {
            logger.error("[CRITICAL ERROR] Test failed with exception: " + (error as Error).message, error);
            results.push({
                test: question.description,
                query: question.message,
                town: question.town,
                passed: false,
                details: {
                    error: (error as Error).message,
                }
            });
        }
    }

    logger.info(\`\n--- Evaluation Summary ---\`);
    logger.info(\`Total Tests: \${goldenSet.length}\`);
    logger.info(\`Passed: \${passedCount}\`);
    logger.info(\`Failed: \${goldenSet.length - passedCount}\`);
    logger.info(\`------------------------\`);

    // Print detailed results as JSON for easy consumption/storage
    console.log("\n### Detailed JSON Results ###");
    console.log(JSON.stringify(results, null, 2));

    // For command line piping
    process.exit(passedCount === goldenSet.length ? 0 : 1);
}

runChatEvaluation().catch(err => {
    logger.error("Global Error during evaluation run:", err);
    process.exit(1);
});
