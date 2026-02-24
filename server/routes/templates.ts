import { Router } from "express";
import { z } from "zod";
import { authenticateAdmin } from "../middleware/auth";
import {
  createChatTemplate,
  getChatTemplates,
  getChatTemplateById,
  updateChatTemplate,
  deleteChatTemplate,
  getActiveChatTemplate,
  deactivateAllTemplates,
  getChatTemplateBySlug,
} from "../storage/chatTemplates";
import { getLogicalDocumentById } from "../storage/documents";
import { getFileBlobById } from "../storage/fileBlobs";
import { GoogleGenAI } from "@google/genai";
import type { TemplatePayload } from "@shared/schema";

const router = Router();
const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });

const templateInputSchema = z.object({
  title: z.string().min(1),
  slug: z.string().nullable().optional(),
  bannerText: z.string().min(1),
  town: z.string().min(1),
  targetDocumentIds: z.array(z.string()).min(1),
  generatedPayload: z.any().optional(),
  isActive: z.boolean().optional(),
});

router.get("/", authenticateAdmin, async (_req, res) => {
  try {
    const templates = await getChatTemplates();
    res.json(templates);
  } catch (error) {
    console.error("Error fetching templates:", error);
    res.status(500).json({ message: "Failed to fetch templates" });
  }
});

router.get("/:id", authenticateAdmin, async (req, res) => {
  try {
    const template = await getChatTemplateById(req.params.id);
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }
    res.json(template);
  } catch (error) {
    console.error("Error fetching template:", error);
    res.status(500).json({ message: "Failed to fetch template" });
  }
});

router.post("/", authenticateAdmin, async (req, res) => {
  try {
    const parsed = templateInputSchema.parse(req.body);
    if (parsed.isActive) {
      await deactivateAllTemplates();
    }
    const template = await createChatTemplate({
      title: parsed.title,
      slug: parsed.slug || null,
      bannerText: parsed.bannerText,
      town: parsed.town,
      targetDocumentIds: parsed.targetDocumentIds,
      generatedPayload: parsed.generatedPayload || null,
      isActive: parsed.isActive ?? false,
    });
    res.json(template);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid input", errors: error.errors });
    }
    if (error instanceof Error && error.message?.includes("unique")) {
      return res.status(409).json({ message: "A template with this URL slug already exists. Please choose a different slug." });
    }
    console.error("Error creating template:", error);
    res.status(500).json({ message: "Failed to create template" });
  }
});

router.put("/:id", authenticateAdmin, async (req, res) => {
  try {
    const existing = await getChatTemplateById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Template not found" });
    }
    const parsed = templateInputSchema.partial().parse(req.body);
    if (parsed.isActive) {
      await deactivateAllTemplates();
    }
    const updated = await updateChatTemplate(req.params.id, parsed);
    res.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid input", errors: error.errors });
    }
    if (error instanceof Error && error.message?.includes("unique")) {
      return res.status(409).json({ message: "A template with this URL slug already exists. Please choose a different slug." });
    }
    console.error("Error updating template:", error);
    res.status(500).json({ message: "Failed to update template" });
  }
});

router.delete("/:id", authenticateAdmin, async (req, res) => {
  try {
    const existing = await getChatTemplateById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Template not found" });
    }
    await deleteChatTemplate(req.params.id);
    res.json({ message: "Template deleted" });
  } catch (error) {
    console.error("Error deleting template:", error);
    res.status(500).json({ message: "Failed to delete template" });
  }
});

router.post("/:id/generate", authenticateAdmin, async (req, res) => {
  try {
    const template = await getChatTemplateById(req.params.id);
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    const docIds = template.targetDocumentIds as string[];
    if (!docIds || docIds.length === 0) {
      return res.status(400).json({ message: "No target documents selected" });
    }

    const documentTexts: string[] = [];
    const documentTitles: string[] = [];
    for (const docId of docIds) {
      const logicalDoc = await getLogicalDocumentById(docId);
      if (!logicalDoc) continue;
      documentTitles.push(logicalDoc.canonicalTitle);
      if (logicalDoc.currentVersionId) {
        const { getDocumentVersionById } = await import("../storage/documents");
        const version = await getDocumentVersionById(logicalDoc.currentVersionId);
        if (version?.fileBlobId) {
          const blob = await getFileBlobById(version.fileBlobId);
          if (blob?.previewText) {
            documentTexts.push(`--- ${logicalDoc.canonicalTitle} ---\n${blob.previewText.slice(0, 15000)}`);
          } else if (blob?.ocrText) {
            documentTexts.push(`--- ${logicalDoc.canonicalTitle} ---\n${blob.ocrText.slice(0, 15000)}`);
          }
        }
      }
    }

    if (documentTexts.length === 0) {
      return res.status(400).json({ message: "Could not extract text from any of the selected documents" });
    }

    const systemPrompt = `You are an expert municipal document analyst for New Hampshire towns. Your job is to analyze official municipal documents and create a structured, citizen-friendly summary that helps residents understand and explore the content.

You MUST respond with valid JSON matching this exact structure:
{
  "summary": "A 2-3 paragraph plain-English overview of the document(s), explaining what they are, why they matter, and what citizens should know. Use markdown formatting.",
  "sections": [
    {
      "title": "Section or Article title",
      "budgetAmount": "$XX,XXX (if applicable, otherwise omit this field)",
      "description": "A 2-3 sentence plain-English description of what this section/article covers and why it matters to residents.",
      "suggestedQuestions": [
        "A specific, insightful question a citizen might ask about this section",
        "Another question focusing on impact or history",
        "A third question about process or implications"
      ]
    }
  ],
  "highLevelQuestions": [
    "A thought-provoking question about the overall document",
    "A question about how this compares to previous years",
    "A question about community impact",
    "A question about what happens next"
  ]
}

Guidelines:
- Write for everyday citizens, not lawyers or bureaucrats
- Each section should have 2-3 suggested questions that are specific and actionable
- Questions should encourage citizens to dig deeper into the historical record
- Include budget amounts when they appear in the document
- The summary should make someone want to explore further
- Include 3-4 high-level questions at the end that span the entire document
- Focus on what matters most to residents: taxes, services, community changes`;

    const userPrompt = `Analyze the following municipal document(s) from ${template.town} and create a structured summary for citizens.\n\nDocuments:\n${documentTexts.join("\n\n")}`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.3,
        responseMimeType: "application/json",
      },
    });

    const responseText = response.text || "";
    let payload: TemplatePayload;
    try {
      payload = JSON.parse(responseText);
    } catch {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        payload = JSON.parse(jsonMatch[0]);
      } else {
        return res.status(500).json({ message: "Failed to parse AI response as JSON" });
      }
    }

    if (!payload.summary || !Array.isArray(payload.sections) || !Array.isArray(payload.highLevelQuestions)) {
      return res.status(500).json({ message: "AI response missing required fields" });
    }

    await updateChatTemplate(req.params.id, { generatedPayload: payload });

    res.json({ payload, documentTitles });
  } catch (error) {
    console.error("Error generating template summary:", error);
    res.status(500).json({ message: "Failed to generate summary" });
  }
});

export const templateRouter = router;

const publicRouter = Router();

publicRouter.get("/active", async (_req, res) => {
  try {
    const template = await getActiveChatTemplate();
    if (!template) {
      return res.json(null);
    }
    res.json({
      id: template.id,
      title: template.title,
      bannerText: template.bannerText,
      town: template.town,
      generatedPayload: template.generatedPayload,
    });
  } catch (error) {
    console.error("Error fetching active template:", error);
    res.status(500).json({ message: "Failed to fetch active template" });
  }
});

publicRouter.get("/by-slug/:slug", async (req, res) => {
  try {
    const template = await getChatTemplateBySlug(req.params.slug);
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }
    res.json({
      id: template.id,
      title: template.title,
      slug: template.slug,
      bannerText: template.bannerText,
      town: template.town,
      generatedPayload: template.generatedPayload,
    });
  } catch (error) {
    console.error("Error fetching template by slug:", error);
    res.status(500).json({ message: "Failed to fetch template" });
  }
});

publicRouter.get("/:id", async (req, res) => {
  try {
    const template = await getChatTemplateById(req.params.id);
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }
    res.json({
      id: template.id,
      title: template.title,
      slug: template.slug,
      bannerText: template.bannerText,
      town: template.town,
      generatedPayload: template.generatedPayload,
    });
  } catch (error) {
    console.error("Error fetching template:", error);
    res.status(500).json({ message: "Failed to fetch template" });
  }
});

export const publicTemplateRouter = publicRouter;
