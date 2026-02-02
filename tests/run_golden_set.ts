import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';

// --- Configuration ---
const BASE_URL = 'https://council-gemini.replit.app';
const ADMIN_EMAIL = 'shmmatt@gmail.com';
const ADMIN_PASSWORD = 'Lui2011#'; // This is a placeholder for the actual secret
const GOLDEN_SET_PATH = path.join(process.cwd(), 'tests', 'golden_set.json');
const RESULTS_DIR = path.join(process.cwd(), 'tests');
const DATE_STRING = new Date().toISOString().slice(0, 10);
const RESULTS_FILE_PATH = path.join(RESULTS_DIR, 'golden_set_results_' + DATE_STRING + '.json');
// ---------------------

// Ensure RESULTS_DIR exists
async function ensureDir() {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
}

interface GoldenQuestion {
    id: string;
    town: string;
    question: string;
    expected_document_keywords: string[];
}

interface TestResult {
    id: string;
    town: string;
    question: string;
    success: boolean;
    answer: string;
    sources: string[];
    debug: any;
    error?: string;
}

async function getAdminToken(): Promise<string> {
    console.log("Attempting admin login...");
    const loginUrl = BASE_URL + '/api/admin/login';
    const response = await axios.post(loginUrl, {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD
    });

    if (response.data.token) {
        console.log("Login successful. Received JWT.");
        return response.data.token;
    }
    throw new Error("Login failed: No token received.");
}

async function runEvaluation() {
    await ensureDir();
    
    // NOTE: In a real environment, load credentials from a secure environment
    // For this specific, immediate execution, we use the provided hardcoded values.
    
    const token = await getAdminToken();
    const headers = { 'Authorization': 'Bearer ' + token };
    const questionsData = await fs.readFile(GOLDEN_SET_PATH, 'utf-8');
    const questions: GoldenQuestion[] = JSON.parse(questionsData);
    
    console.log('Loaded ' + questions.length + ' questions from golden set.');

    const results: TestResult[] = [];
    const debugPipelineUrl = BASE_URL + '/api/admin/debug/debug-pipeline';
    let passedCount = 0;

    for (const [index, q] of questions.entries()) {
        console.log('[\u0020' + (index + 1) + '/'+ questions.length + ' ] Testing ' + q.id + ' (' + q.town + '): ' + q.question.slice(0, 50) + '...');
        
        let result: TestResult = {
            id: q.id,
            town: q.town,
            question: q.question,
            success: false,
            answer: '',
            sources: [],
            debug: {}
        };

        try {
            const pipelineResponse = await axios.post(
                debugPipelineUrl,
                {
                    message: q.question,
                    town: q.town,
                },
                { headers, timeout: 60000 } // 60 second timeout
            );

            const data = pipelineResponse.data;
            result.answer = data.answer;
            result.sources = data.sources;
            result.debug = data.debug;

            // Simple pass/fail logic: did we get an answer and any sources?
            const hasAnswer = result.answer && result.answer.length > 50;
            const hasSources = result.sources && result.sources.length > 0;
            
            result.success = hasAnswer && hasSources;
            if (result.success) {
                passedCount++;
            }

        } catch (error: any) {
            const message = error.response?.data?.error || error.message;
            result.error = 'API Call Failed: ' + message;
            console.error('FAIL: ' + result.error);
        }

        results.push(result);
        // Throttle requests slightly to avoid rate-limiting the host
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const summary = {
        total: questions.length,
        passed: passedCount,
        failed: questions.length - passedCount,
        timestamp: new Date().toISOString(),
        results,
    };

    await fs.writeFile(RESULTS_FILE_PATH, JSON.stringify(summary, null, 2));
    console.log('\nEvaluation complete. Results saved to: ' + path.basename(RESULTS_FILE_PATH));
    console.log('Summary: ' + summary.passed + '/' + summary.total + ' tests passed (simple check).');
    
    // Return the summary for the main agent
    return summary;
}

// Wrap for CLI execution
runEvaluation().then(summary => {
    // DO NOT Print the summary to console. Rely only on the file write.
    // The summary is too large and causes token overflow when processed by the agent.
    console.log('Evaluation script complete. Results written to file.');
    process.exit(0);
}).catch(err => {
    console.error("Script execution failed.", err);
    process.exit(1);
});

// To run this script: npx tsx OPENCouncil/tests/run_golden_set.ts