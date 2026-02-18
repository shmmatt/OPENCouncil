import { generateEmbedding } from "../server/services/embeddingService";

async function test() {
  try {
    console.log("Testing embedding generation...");
    const result = await generateEmbedding("test text");
    console.log("✅ Embedding works! Length:", result.length);
    process.exit(0);
  } catch (error) {
    console.error("❌ Embedding failed:");
    console.error(error);
    process.exit(1);
  }
}

test();
