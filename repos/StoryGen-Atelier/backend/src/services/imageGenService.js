const { GoogleGenerativeAI } = require("@google/generative-ai");

const BASE_IMAGE_STYLE = process.env.GEMINI_IMAGE_STYLE || "Cinematic neon-noir, teal-magenta palette, volumetric rain and fog, soft bloom, anamorphic lens, shallow depth of field, subtle film grain, 16:9 composition";

// Use Gemini 3 Pro Image Preview to generate frame-level artwork.
// referenceImageBase64: base64 string of the first shot image (for character consistency)
// heroSubject: detailed character description from shot 1
exports.generateImage = async (prompt, previousStyleHint = "", styleOverride, referenceImageBase64 = null, heroSubject = "") => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === "" || apiKey.startsWith("your_")) {
    console.log("No valid GEMINI_API_KEY found. Using placeholder image.");
    const encodedPrompt = encodeURIComponent(prompt.substring(0, 50) + "...");
    return `https://placehold.co/600x400/222/FFF?text=${encodedPrompt}`;
  }

  const imageModel = process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image-preview";
  const appliedStyle = styleOverride && styleOverride.trim() !== '' ? styleOverride.trim() : BASE_IMAGE_STYLE;
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: imageModel });

  // Build character consistency instruction
  const heroInstruction = heroSubject
    ? `CRITICAL - Main Character Description (MUST match exactly): ${heroSubject}.`
    : "";

  // Slightly tighten the prompt for visual fidelity and cross-shot consistency.
  const styleGlue = previousStyleHint
    ? `Maintain exact style continuity with previous shot: "${previousStyleHint}".`
    : "Establish the base look; following shots must keep this style.";
  const imagePrompt = `
    Role: Cinematic frame artist.
    Goal: Render a single storyboard frame that matches the shared style and camera feel.
    ${heroInstruction}
    Style: ${appliedStyle}.
    Continuity: ${styleGlue}
    Frame description: ${prompt}.
    Constraints: no text, no captions, 16:9, high fidelity. The main character MUST look identical to the reference image if provided.
  `;

  // Build content parts - include reference image if available
  const contentParts = [];
  if (referenceImageBase64) {
    contentParts.push({
      inlineData: {
        mimeType: "image/png",
        data: referenceImageBase64,
      },
    });
    contentParts.push({ text: "Reference image above shows the main character. Generate a new image where this SAME character (identical appearance, clothing, colors) performs the action described below:\n\n" + imagePrompt });
  } else {
    contentParts.push({ text: imagePrompt });
  }

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: contentParts,
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig:{
          aspectRatio: "16:9"
        }
      },
    });

    const candidates = result?.response?.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const mimeType = part.inlineData.mimeType || "image/png";
          const base64 = part.inlineData.data;
          console.log("Image generated successfully via Gemini.");
          // Return a data URL so the frontend can render directly.
          return `data:${mimeType};base64,${base64}`;
        }
      }
    }

    console.log("Gemini did not return inline image data; using placeholder.");
  } catch (error) {
    console.error("Error generating image with Gemini:", error);
    console.log("Falling back to placeholder.");
  }

  // Fallback Placeholder
  const encodedPrompt = encodeURIComponent(prompt.substring(0, 50) + "...");
  return `https://placehold.co/600x400/222/FFF?text=${encodedPrompt}`;
};
