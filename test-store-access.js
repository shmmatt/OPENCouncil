const { GoogleGenAI } = require("@google/genai");

async function testStoreAccess() {
  const key1 = "AIzaSyBhrOV_7rKaB-OVtK261nYxw-srCO7wzKk";
  const key2 = "AIzaSyAlsJUQjGnSKpQNrkmKBHbXbcIRLfc8uKk";
  const storeId = "fileSearchStores/opencouncil-ossipee-efnhpf60017r";
  
  console.log("Testing Key 1:");
  try {
    const ai1 = new GoogleGenAI({ apiKey: key1 });
    const resp1 = await ai1.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: "test query about Ossipee" }] }],
      config: {
        tools: [{ fileSearch: { fileSearchStoreNames: [storeId] } }],
      },
    });
    console.log("✅ Key 1 works - grounding chunks:", resp1.candidates[0]?.groundingMetadata?.groundingChunks?.length || 0);
  } catch (e) {
    console.log("❌ Key 1 failed:", e.message);
  }
  
  console.log("\nTesting Key 2:");
  try {
    const ai2 = new GoogleGenAI({ apiKey: key2 });
    const resp2 = await ai2.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: "test query about Ossipee" }] }],
      config: {
        tools: [{ fileSearch: { fileSearchStoreNames: [storeId] } }],
      },
    });
    console.log("✅ Key 2 works - grounding chunks:", resp2.candidates[0]?.groundingMetadata?.groundingChunks?.length || 0);
  } catch (e) {
    console.log("❌ Key 2 failed:", e.message);
  }
}

testStoreAccess();
