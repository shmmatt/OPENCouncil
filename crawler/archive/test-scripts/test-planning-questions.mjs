import { runChatV3Pipeline } from './server/chatV2/chatOrchestratorV3.js';
import { v4 as uuidv4 } from 'uuid';

const questions = [
  {
    text: "When does the Ossipee Planning Board meet?",
    description: "Meeting schedule"
  },
  {
    text: "What is the process for getting a site plan approved by the Ossipee Planning Board?",
    description: "Site plan process"
  },
  {
    text: "Who are the current members of the Ossipee Planning Board?",
    description: "Board members"
  }
];

console.log('🧪 Testing Ossipee Planning Board Questions\n');

for (const q of questions) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📋 ${q.description.toUpperCase()}`);
  console.log(`❓ ${q.text}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  try {
    const result = await runChatV3Pipeline({
      userMessage: q.text,
      sessionHistory: [],
      townPreference: 'Ossipee',
      situationContext: null,
      sessionSources: [],
      logContext: { 
        requestId: uuidv4(), 
        sessionId: 'planning-test', 
        startTime: Date.now() 
      }
    });
    
    console.log('\n📊 RESULTS:');
    console.log(`  Sources: ${result.sourceDocumentNames.length}`);
    console.log(`  Chunks: ${result.debug.retrievalCounts.localSelected} local + ${result.debug.retrievalCounts.stateSelected} state`);
    console.log(`  Tier: ${result.recordStrength.tier} (confidence: ${result.recordStrength.confidence})`);
    console.log(`  Duration: ${result.durationMs}ms`);
    
    console.log('\n🔍 QUERIES GENERATED:');
    console.log(`  Local: ${result.debug.planQueries.local.join(', ')}`);
    console.log(`  State: ${result.debug.planQueries.state.join(', ')}`);
    
    console.log('\n💬 ANSWER:');
    console.log(result.answerText);
    console.log('\n');
    
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    console.log('\n');
  }
}
