import { generateEmbeddingBatch } from "../server/services/embeddingService";

async function test() {
  try {
    console.log("Testing batch embedding generation...");
    const texts = ["first chunk about zoning", "second chunk about permits"];
    const results = await generateEmbeddingBatch(texts);
    console.log("✅ Batch embedding works!");
    console.log(`  Generated ${results.length} embeddings`);
    console.log(`  First embedding length: ${results[0].length}`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Batch embedding failed:");
    console.error(error);
    process.exit(1);
  }
}

test();
