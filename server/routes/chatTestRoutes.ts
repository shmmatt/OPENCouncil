/**
 * Chat Test Routes - Batch testing and analysis for v3 chat pipeline
 * 
 * Endpoints:
 * - POST /api/admin/test/chat-batch - Run batch of test questions
 * - POST /api/admin/test/chat-analyze - Analyze results and generate recommendations
 * - GET /api/admin/test/question-sets - Get predefined test question sets
 */

import { Router } from "express";
import { runChatV3Pipeline } from "../chatV2/chatOrchestratorV3";
import { v4 as uuidv4 } from "uuid";
import type { V3PipelineResult } from "../chatV2/types";

const router = Router();

// =====================================================
// TYPE DEFINITIONS
// =====================================================

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
  debug: {
    durationMs: number;
    localSelected: number;
    stateSelected: number;
    auditFlags: string[];
    repairRan: boolean;
    planQueries: {
      local: string[];
      state: string[];
    };
    retrievalCounts: {
      localRetrieved: number;
      localSelected: number;
      stateRetrieved: number;
      stateSelected: number;
    };
  };
  passed: boolean;
  failureReasons: string[];
}

interface AnalysisReport {
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    passRate: number;
    avgDurationMs: number;
    avgAnswerLength: number;
  };
  byCategory: Record<string, {
    total: number;
    passed: number;
    avgDurationMs: number;
  }>;
  recommendations: {
    documents: string[];
    pipelineImprovements: string[];
    configTweaks: string[];
  };
  detailedFindings: {
    retrievalIssues: string[];
    synthesisIssues: string[];
    auditIssues: string[];
  };
}

// =====================================================
// TEST QUESTION SETS
// =====================================================

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
    {
      id: "permit-03",
      message: "Do I need a permit to build a deck in Ossipee?",
      town: "Ossipee",
      category: "permits",
      description: "Permit requirement clarification",
      expectedBehaviors: {
        minSources: 2,
        minLocalChunks: 1,
        minStateChunks: 1,
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
    {
      id: "legal-02",
      message: "What are ADA requirements for public buildings in New Hampshire?",
      town: "Conway",
      category: "legal-compliance",
      description: "Federal/state compliance question",
      expectedBehaviors: {
        minSources: 2,
        minStateChunks: 2,
        shouldMentionTopics: ["ADA", "accessibility", "compliance"],
      },
    },
    {
      id: "legal-03",
      message: "Can the town be sued for a slip and fall on a sidewalk?",
      town: "Ossipee",
      category: "legal-liability",
      description: "Liability question requiring state law interpretation",
      expectedBehaviors: {
        minSources: 2,
        minStateChunks: 2,
        shouldMentionTopics: ["liability", "negligence", "immunity"],
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
    {
      id: "tax-02",
      message: "What is the process for applying for a property tax abatement?",
      town: "Conway",
      category: "taxes-abatement",
      description: "Tax abatement process question",
      expectedBehaviors: {
        minSources: 2,
        minStateChunks: 1,
        shouldMentionTopics: ["abatement", "application", "deadline"],
      },
    },
    {
      id: "tax-03",
      message: "Are there tax exemptions for elderly residents in Carroll County?",
      town: "Ossipee",
      category: "taxes-exemptions",
      description: "Tax exemption eligibility question",
      expectedBehaviors: {
        minSources: 2,
        minStateChunks: 1,
        shouldMentionTopics: ["exemption", "elderly", "RSA"],
      },
    },
  ],
  
  complex: [
    {
      id: "complex-01",
      message: "What is the complete process for subdividing a property in Ossipee, including all required permits and approvals?",
      town: "Ossipee",
      category: "complex-multi-step",
      description: "Multi-step process requiring multiple document types",
      expectedBehaviors: {
        minSources: 4,
        minLocalChunks: 4,
        minStateChunks: 2,
        expectedTier: "A",
        shouldMentionTopics: ["subdivision", "planning board", "permit"],
      },
    },
    {
      id: "complex-02",
      message: "If I want to convert my residential property to a home business in Conway, what regulations apply and what approvals do I need?",
      town: "Conway",
      category: "complex-regulatory",
      description: "Complex regulatory question crossing multiple domains",
      expectedBehaviors: {
        minSources: 3,
        minLocalChunks: 3,
        minStateChunks: 2,
        shouldMentionTopics: ["zoning", "home business", "permit"],
      },
    },
    {
      id: "complex-03",
      message: "What are my rights and the town's responsibilities regarding a drainage issue affecting my property?",
      town: "Ossipee",
      category: "complex-liability",
      description: "Rights and responsibilities question",
      expectedBehaviors: {
        minSources: 3,
        minStateChunks: 2,
        shouldMentionTopics: ["drainage", "liability", "responsibility"],
      },
    },
  ],
  
  edge: [
    {
      id: "edge-01",
      message: "What's the weather like today?",
      town: "Ossipee",
      category: "edge-out-of-scope",
      description: "Completely out of scope question",
      expectedBehaviors: {
        minSources: 0,
        shouldNotMentionTopics: ["weather"],
      },
    },
    {
      id: "edge-02",
      message: "Tell me about the history of Carroll County",
      town: "Ossipee",
      category: "edge-general",
      description: "Very general non-actionable question",
      expectedBehaviors: {
        minSources: 1,
      },
    },
    {
      id: "edge-03",
      message: "help",
      town: "Ossipee",
      category: "edge-vague",
      description: "Extremely vague question",
      expectedBehaviors: {
        minSources: 0,
      },
    },
  ],
};

// =====================================================
// ENDPOINTS
// =====================================================

/**
 * GET /api/admin/test/question-sets
 * Get all available test question sets
 */
router.get("/question-sets", async (req, res) => {
  try {
    const sets = Object.keys(testQuestionSets).map(key => ({
      id: key,
      name: key,
      count: testQuestionSets[key].length,
      questions: testQuestionSets[key],
    }));

    res.json({
      success: true,
      sets,
    });
  } catch (error: any) {
    console.error("[ChatTest] Error fetching question sets:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/admin/test/chat-batch
 * Run batch of test questions and return detailed results
 * 
 * Body:
 * - questionSetIds: string[] (optional, defaults to ["basic"])
 * - customQuestions: TestQuestion[] (optional)
 */
router.post("/chat-batch", async (req, res) => {
  try {
    const { questionSetIds, customQuestions } = req.body;
    
    // Collect questions to test
    let questionsToTest: TestQuestion[] = [];
    
    if (customQuestions && Array.isArray(customQuestions)) {
      questionsToTest = customQuestions;
    } else {
      const setIds = questionSetIds || ["basic"];
      for (const setId of setIds) {
        if (testQuestionSets[setId]) {
          questionsToTest.push(...testQuestionSets[setId]);
        }
      }
    }
    
    if (questionsToTest.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No questions to test. Provide questionSetIds or customQuestions.",
      });
    }
    
    console.log(`[ChatTest] Running batch test with ${questionsToTest.length} questions`);
    
    const results: TestResult[] = [];
    
    // Run each question through the pipeline
    for (const question of questionsToTest) {
      const logContext = {
        requestId: uuidv4(),
        sessionId: `test-${question.id}`,
        startTime: Date.now(),
      };
      
      console.log(`[ChatTest] Testing: ${question.id} - "${question.message}"`);
      
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
          failureReasons.push(`Expected at least ${expected.minSources} sources, got ${pipelineResult.sourceDocumentNames.length}`);
        }
        
        if (expected.minLocalChunks && pipelineResult.debug.retrievalCounts.localSelected < expected.minLocalChunks) {
          failureReasons.push(`Expected at least ${expected.minLocalChunks} local chunks, got ${pipelineResult.debug.retrievalCounts.localSelected}`);
        }
        
        if (expected.minStateChunks && pipelineResult.debug.retrievalCounts.stateSelected < expected.minStateChunks) {
          failureReasons.push(`Expected at least ${expected.minStateChunks} state chunks, got ${pipelineResult.debug.retrievalCounts.stateSelected}`);
        }
        
        if (expected.expectedTier && pipelineResult.recordStrength.tier !== expected.expectedTier) {
          failureReasons.push(`Expected tier ${expected.expectedTier}, got ${pipelineResult.recordStrength.tier}`);
        }
        
        if (expected.shouldMentionTopics) {
          for (const topic of expected.shouldMentionTopics) {
            if (!pipelineResult.answerText.toLowerCase().includes(topic.toLowerCase())) {
              failureReasons.push(`Answer should mention "${topic}" but doesn't`);
            }
          }
        }
        
        if (expected.shouldNotMentionTopics) {
          for (const topic of expected.shouldNotMentionTopics) {
            if (pipelineResult.answerText.toLowerCase().includes(topic.toLowerCase())) {
              failureReasons.push(`Answer should NOT mention "${topic}" but does`);
            }
          }
        }
        
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
          passed: failureReasons.length === 0,
          failureReasons,
        });
        
        console.log(`[ChatTest] ${question.id}: ${failureReasons.length === 0 ? "PASS" : "FAIL"}`);
        if (failureReasons.length > 0) {
          console.log(`[ChatTest] Failures: ${failureReasons.join("; ")}`);
        }
        
      } catch (error: any) {
        console.error(`[ChatTest] Error testing ${question.id}:`, error);
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
    
    // Generate summary
    const summary = {
      totalTests: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      passRate: results.length > 0 ? (results.filter(r => r.passed).length / results.length) * 100 : 0,
      avgDurationMs: results.reduce((sum, r) => sum + r.debug.durationMs, 0) / results.length,
    };
    
    console.log(`[ChatTest] Batch complete: ${summary.passed}/${summary.totalTests} passed (${summary.passRate.toFixed(1)}%)`);
    
    res.json({
      success: true,
      summary,
      results,
    });
    
  } catch (error: any) {
    console.error("[ChatTest] Batch test error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

/**
 * POST /api/admin/test/chat-analyze
 * Analyze test results and generate recommendations
 * 
 * Body:
 * - results: TestResult[] (from chat-batch endpoint)
 */
router.post("/chat-analyze", async (req, res) => {
  try {
    const { results } = req.body;
    
    if (!results || !Array.isArray(results)) {
      return res.status(400).json({
        success: false,
        error: "Results array is required",
      });
    }
    
    console.log(`[ChatTest] Analyzing ${results.length} test results`);
    
    const analysis: AnalysisReport = {
      summary: {
        totalTests: results.length,
        passed: results.filter((r: TestResult) => r.passed).length,
        failed: results.filter((r: TestResult) => !r.passed).length,
        passRate: results.length > 0 ? (results.filter((r: TestResult) => r.passed).length / results.length) * 100 : 0,
        avgDurationMs: results.reduce((sum: number, r: TestResult) => sum + r.debug.durationMs, 0) / results.length,
        avgAnswerLength: results.reduce((sum: number, r: TestResult) => sum + r.answerText.length, 0) / results.length,
      },
      byCategory: {},
      recommendations: {
        documents: [],
        pipelineImprovements: [],
        configTweaks: [],
      },
      detailedFindings: {
        retrievalIssues: [],
        synthesisIssues: [],
        auditIssues: [],
      },
    };
    
    // Analyze by category
    const categoryMap = new Map<string, TestResult[]>();
    for (const result of results) {
      if (!categoryMap.has(result.category)) {
        categoryMap.set(result.category, []);
      }
      categoryMap.get(result.category)!.push(result);
    }
    
    for (const [category, categoryResults] of categoryMap) {
      analysis.byCategory[category] = {
        total: categoryResults.length,
        passed: categoryResults.filter(r => r.passed).length,
        avgDurationMs: categoryResults.reduce((sum, r) => sum + r.debug.durationMs, 0) / categoryResults.length,
      };
    }
    
    // Analyze retrieval issues
    const lowRetrievalResults = results.filter((r: TestResult) => 
      r.debug.localSelected < 2 && r.debug.stateSelected < 2
    );
    if (lowRetrievalResults.length > 0) {
      analysis.detailedFindings.retrievalIssues.push(
        `${lowRetrievalResults.length} questions retrieved < 2 chunks from both local and state sources`
      );
      analysis.recommendations.pipelineImprovements.push(
        "Improve retrieval query generation - some questions are not finding enough relevant chunks"
      );
    }
    
    // Analyze state vs local balance
    const stateHeavyResults = results.filter((r: TestResult) => 
      r.debug.stateSelected > r.debug.localSelected * 2 && r.town
    );
    if (stateHeavyResults.length > 0) {
      analysis.detailedFindings.retrievalIssues.push(
        `${stateHeavyResults.length} town-specific questions retrieved 2x more state than local chunks`
      );
      analysis.recommendations.documents.push(
        `Consider adding more local documents for: ${[...new Set(stateHeavyResults.map(r => r.town))].join(", ")}`
      );
    }
    
    // Analyze repair frequency
    const repairResults = results.filter((r: TestResult) => r.debug.repairRan);
    if (repairResults.length > results.length * 0.3) {
      analysis.detailedFindings.synthesisIssues.push(
        `${repairResults.length} questions (${((repairResults.length/results.length)*100).toFixed(1)}%) triggered repair`
      );
      analysis.recommendations.pipelineImprovements.push(
        "High repair rate suggests initial synthesis could be improved"
      );
    }
    
    // Analyze audit flags
    const auditFlagCounts = new Map<string, number>();
    for (const result of results) {
      for (const flag of result.debug.auditFlags) {
        const flagType = flag.split(":")[0];
        auditFlagCounts.set(flagType, (auditFlagCounts.get(flagType) || 0) + 1);
      }
    }
    
    for (const [flagType, count] of auditFlagCounts) {
      if (count > results.length * 0.2) {
        analysis.detailedFindings.auditIssues.push(
          `${flagType} appears in ${count} answers (${((count/results.length)*100).toFixed(1)}%)`
        );
        
        if (flagType === "missing_citations") {
          analysis.recommendations.pipelineImprovements.push(
            "Improve citation extraction or prompt to ensure all answers include source citations"
          );
        } else if (flagType === "vague_reference") {
          analysis.recommendations.pipelineImprovements.push(
            "Reduce vague references - answers should be more specific and cite exact sources"
          );
        } else if (flagType === "format_violation") {
          analysis.recommendations.pipelineImprovements.push(
            "Improve answer formatting to match expected structure"
          );
        }
      }
    }
    
    // Analyze tier distribution
    const tierCounts = { A: 0, B: 0, C: 0 };
    for (const result of results) {
      const tier = result.recordStrength.tier as "A" | "B" | "C";
      tierCounts[tier]++;
    }
    
    if (tierCounts.C > results.length * 0.3) {
      analysis.recommendations.documents.push(
        `${tierCounts.C} answers (${((tierCounts.C/results.length)*100).toFixed(1)}%) were Tier C - consider adding more comprehensive documentation`
      );
    }
    
    // Analyze failed questions by category
    const failedByCategory = new Map<string, string[]>();
    for (const result of results) {
      if (!result.passed) {
        if (!failedByCategory.has(result.category)) {
          failedByCategory.set(result.category, []);
        }
        failedByCategory.get(result.category)!.push(result.questionId);
      }
    }
    
    for (const [category, questionIds] of failedByCategory) {
      if (questionIds.length > 1) {
        analysis.recommendations.documents.push(
          `Category "${category}" has ${questionIds.length} failures - may need more documents in this domain`
        );
      }
    }
    
    // Config tweaks based on performance
    if (analysis.summary.avgDurationMs > 5000) {
      analysis.recommendations.configTweaks.push(
        "Average duration > 5s - consider reducing MAX_QUERIES_PER_LANE or enabling ENABLE_EARLY_EXIT"
      );
    }
    
    if (analysis.summary.avgAnswerLength < 500) {
      analysis.recommendations.configTweaks.push(
        "Average answer length is short - consider adjusting SYNTHESIS_CHAR_TARGET_MIN"
      );
    } else if (analysis.summary.avgAnswerLength > 2000) {
      analysis.recommendations.configTweaks.push(
        "Average answer length is long - consider adjusting SYNTHESIS_CHAR_TARGET_MAX"
      );
    }
    
    console.log(`[ChatTest] Analysis complete`);
    console.log(`[ChatTest] Pass rate: ${analysis.summary.passRate.toFixed(1)}%`);
    console.log(`[ChatTest] Recommendations: ${analysis.recommendations.documents.length + analysis.recommendations.pipelineImprovements.length + analysis.recommendations.configTweaks.length} total`);
    
    res.json({
      success: true,
      analysis,
    });
    
  } catch (error: any) {
    console.error("[ChatTest] Analysis error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

export default router;
