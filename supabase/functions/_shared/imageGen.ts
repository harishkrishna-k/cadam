import { Buffer } from 'node:buffer';
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.9';
import { GoogleGenAI, Modality } from 'npm:@google/genai';
import { fal } from 'npm:@fal-ai/client';
import { reformatSignedUrl } from './messageUtils.ts';

const DEBUG_LOGS =
  Deno.env.get('ENVIRONMENT') === 'local' ||
  Deno.env.get('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

export const INSTRUCTIONS_3D =
  'You are generating a fully textured and rendered 3D model. Output one centered 3D model or multiple centered objects, no text. Plain white background (or an empty background which provides optimal contrast with the textures of the 3D model), neutral lighting, and a soft shadow directly under the 3D model. Keep the entire object fully in-frame with 5–10% padding; no cropping. Make sure the description strongly impacts the form and shape of the 3D Model not just the surface texture';

fal.config({
  credentials: Deno.env.get('FAL_KEY') ?? '',
});

export type GptImageQuality = 'low' | 'medium' | 'high';

export interface ImageGenerationResult {
  imageBytes: Buffer;
  contentType: string;
  imageCallId?: string;
}

export const generateImageWithGeminiMultiTurn = async (
  userId: string,
  conversationId: string,
  prompt: string,
  images: string[],
  mesh?: string,
  options?: { meshModel?: string },
): Promise<{ imageBytes: Buffer; contentType: string }> => {
  debugLog('Generating image with Gemini 2.5 Pro', {
    userId,
    conversationId,
    prompt,
    imagesCount: images.length,
  });

  const apiKey = Deno.env.get('GOOGLE_API_KEY') ?? '';
  const googleGenAI = new GoogleGenAI({ apiKey });

  let imagePart: { inlineData: { mimeType: string; data: string } } | undefined;

  if (images.length > 0) {
    const latestImageId = images[images.length - 1];
    const { data: imageData } = await googleGenAI.storage
      .from('images')
      .download(`${userId}/${conversationId}/${latestImageId}`);

    if (!imageData) {
      throw new Error(`Failed to download image ${latestImageId}`);
    }

    const imageArrayBuffer = await imageData.arrayBuffer();
    const buffer = Buffer.from(imageArrayBuffer);
    const base64Image = buffer.toString('base64');
    const mimeType =
      imageData.type && imageData.type.startsWith('image/')
        ? imageData.type
        : 'image/png';

    imagePart = {
      inlineData: {
        mimeType,
        data: base64Image,
      },
    };
  }

  const model = googleGenAI.getGenerativeModel({ model: 'gemini-2.5-pro-preview' });

  const messageContent: {
    text?: string;
    inlineData?: { mimeType: string; data: string };
  }[] = [{ text: prompt || 'Generate an image' }];
  if (imagePart) {
    messageContent.push(imagePart);
  }

  debugLog('Sending message to Gemini 2.5 Pro');

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: messageContent }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  });

  let generatedImageData: string | undefined;

  if (
    result.candidates &&
    result.candidates[0] &&
    result.candidates[0].content &&
    result.candidates[0].content.parts
  ) {
    for (const part of result.candidates[0].content.parts) {
      if (part.text) {
        debugLog('Gemini Text Response:', part.text);
      } else if (part.inlineData) {
        generatedImageData = part.inlineData.data;
      }
    }
  }

  if (!generatedImageData) {
    throw new Error('No generated image data from Gemini 2.5 Pro');
  }

  const imageBytes = Buffer.from(generatedImageData, 'base64');
  return {
    imageBytes,
    contentType: 'image/png',
  };
};

export const generateImageWithFalFlux = async (
  supabaseClient: SupabaseClient,
  userId: string,
  conversationId: string,
  promptText: string,
  images: string[],
) => {
  const contextImages: string[] = [];

  if (images.length > 0) {
    await Promise.all(
      images.map(async (image) => {
        const { data: exists } = await supabaseClient.storage
          .from('images')
          .exists(`${userId}/${conversationId}/${image}`);

        if (exists) {
          contextImages.push(image);
        }
      }),
    );
  }

  const enhancedPrompt =
    contextImages.length > 0
      ? `${INSTRUCTIONS_3D} Based on the provided image(s), ${promptText}. Maintain visual consistency and style with the reference image(s).`
      : `${INSTRUCTIONS_3D} ${promptText}`;

  let imageInputs: string[] = [];
  if (contextImages.length > 0) {
    const imageFiles = contextImages.map((image) => {
      return `${userId}/${conversationId}/${image}`;
    });

    const { data: rawImageUrls } = await supabaseClient.storage
      .from('images')
      .createSignedUrls(imageFiles, 60 * 60);

    if (!rawImageUrls) {
      throw new Error('No image URL from Flux');
    }

    imageInputs = rawImageUrls.map((url) => reformatSignedUrl(url.signedUrl));
  }

  let inputImage: { url: string } | undefined;
  if (imageInputs.length > 0) {
    inputImage = { url: imageInputs[0] };
  }

  const result = await fal.subscribe('fal-ai/flux/i2g', {
    input: {
      prompt: enhancedPrompt,
      ...(inputImage && { image_url: inputImage.url }),
    },
  });

  const data = result.data;
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid response from Flux');
  }

  const imageUrl = data.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error('No image URL in Flux response');
  }

  const imageResponse = await fetch(imageUrl);
  const imageBuffer = await imageResponse.arrayBuffer();
  const imageBytes = Buffer.from(imageBuffer);

  return imageBytes;
};