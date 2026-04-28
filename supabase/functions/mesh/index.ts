import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { fal } from 'npm:@fal-ai/client';
import { GoogleGenAI } from 'npm:@google/genai';
import {
  generateImageWithGeminiMultiTurn,
  INSTRUCTIONS_3D as instructions3D,
} from '../_shared/imageGen.ts';
import { Model, MeshFileType } from '@shared/types.ts';
import {
  getServiceRoleSupabaseClient,
  SupabaseClient,
} from '../_shared/supabaseClient.ts';
import { reformatSignedUrl } from '../_shared/messageUtils.ts';
import { initSentry, logError } from '../_shared/sentry.ts';
import { Buffer } from 'node:buffer';

initSentry();

const TEXTURELESS_MAX_POLYGONS = 50000;

const DEBUG_LOGS =
  Deno.env.get('ENVIRONMENT') === 'local' ||
  Deno.env.get('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

const GEMINI_API_KEY = Deno.env.get('GOOGLE_API_KEY') ?? '';
const GEMINI_MODEL = 'gemini-2.5-pro-preview';

async function getRecentMeshPreview(
  supabaseClient: SupabaseClient,
  userId: string,
  conversationId: string,
) {
  try {
    const { data: recentMesh } = await supabaseClient
      .from('meshes')
      .select('id')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!recentMesh) return null;

    const { data: previewFiles, error: previewError } = await supabaseClient.storage
      .from('images')
      .list(`${userId}/${conversationId}`, {
        search: `preview-${recentMesh.id}`,
        limit: 1,
      });

    if (previewError || !previewFiles || previewFiles.length === 0) {
      return null;
    }

    return previewFiles[0].name;
  } catch (error) {
    console.warn('Failed to get recent mesh preview:', error);
    return null;
  }
}

fal.config({
  credentials: Deno.env.get('FAL_KEY') ?? '',
});

const supabaseClient = getServiceRoleSupabaseClient();

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

function streamMessage(
  controller: ReadableStreamDefaultController,
  message: Record<string, unknown>,
) {
  controller.enqueue(new TextEncoder().encode(JSON.stringify(message) + '\n'));
}

Deno.serve(async (req) => {
  try {
    debugLog('=== MESH FUNCTION ENTRY POINT ===');

    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    const { data: userData, error: userError } =
      await supabaseClient.auth.getUser(token);

    if (!userData.user) {
      logError(new Error('No user found in token'), {
        functionName: 'mesh',
        statusCode: 401,
      });
      return new Response(
        JSON.stringify({ error: { message: 'Unauthorized' } }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    if (userError) {
      logError(userError, {
        functionName: 'mesh',
        statusCode: 401,
      });
      return new Response(
        JSON.stringify({ error: { message: userError.message } }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    const {
      text,
      images,
      mesh,
      model = 'quality',
      conversationId,
      meshTopology = 'quads',
      polygonCount = 'medium',
      parentMessageId,
    } = await req.json();

    let fileType: MeshFileType = 'glb';

    if (meshTopology === 'quads') {
      fileType = 'fbx';
    }

    const { data: meshData, error: meshError } = await supabaseClient
      .from('meshes')
      .insert({
        user_id: userData.user.id,
        images: images ?? null,
        conversation_id: conversationId,
        file_type: fileType,
        prompt: {
          ...(text && { text: text }),
          ...(images && images.length > 0 && { images: images }),
          ...(mesh && { mesh: mesh }),
          ...(model && { model: model }),
        },
      })
      .select()
      .single();

    if (meshError) {
      logError(meshError, {
        functionName: 'mesh',
        statusCode: 500,
        userId: userData.user?.id,
        conversationId,
        additionalContext: { operation: 'insert_mesh_record', fileType, model },
      });
      return new Response(
        JSON.stringify({ error: { message: meshError.message } }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
    }

    if (model !== 'quality') {
      EdgeRuntime.waitUntil(
        submitPreviewJob(
          supabaseClient,
          text,
          images,
          mesh,
          userData.user.id,
          conversationId,
          meshData.id,
        ),
      );
    }

    debugLog('=== SUBMITTING MESH JOB ===');

    EdgeRuntime.waitUntil(
      submitMeshJob(
        supabaseClient,
        text,
        images,
        mesh,
        userData.user.id,
        conversationId,
        meshData.id,
        model,
        meshTopology,
        polygonCount,
      ),
    );

    return new Response(JSON.stringify({ id: meshData.id, fileType }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (unexpectedError) {
    console.error('=== UNEXPECTED ERROR ===');
    console.error('Unexpected error:', unexpectedError);

    return new Response(
      JSON.stringify({
        error: {
          message:
            unexpectedError instanceof Error
              ? unexpectedError.message
              : 'An unexpected error occurred',
        },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});

async function submitPreviewJob(
  supabaseClient: SupabaseClient,
  text: string | undefined,
  images: string[] | undefined,
  mesh: string | undefined,
  userId: string,
  conversationId: string,
  meshId: string,
) {
  debugLog('=== SUBMITTING PREVIEW JOB ===');

  const { data: previewData, error: previewError } = await supabaseClient
    .from('previews')
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      mesh_id: meshId,
    })
    .select()
    .single();

  if (previewError) {
    throw new Error(previewError.message);
  }

  try {
    let meshImages: string[] = [];

    if (mesh) {
      const { data: meshData } = await supabaseClient
        .from('meshes')
        .select('images')
        .eq('id', mesh)
        .single();

      if (meshData?.images && Array.isArray(meshData.images)) {
        meshImages = meshData.images;
      }
    }

    const allImages = [...(images || []), ...meshImages];

    if (text && text.trim() !== '') {
      const newPrompt =
        allImages.length > 0
          ? `${instructions3D} Edit the provided image(s) to: ${text}`
          : `${instructions3D} Generate a new image: ${text}`;

      const { imageBytes, contentType } = await generateImageWithGeminiMultiTurn(
        userId,
        conversationId,
        newPrompt,
        allImages,
        mesh,
        { meshModel: 'fast' },
      );

      const imageId = crypto.randomUUID();

      await supabaseClient.storage
        .from('images')
        .upload(`${userId}/${conversationId}/${imageId}`, imageBytes, {
          contentType,
        });

      await supabaseClient
        .from('images')
        .insert({
          user_id: userId,
          conversation_id: conversationId,
          status: 'success',
        })
        .select()
        .single();
    }

    await supabaseClient
      .from('previews')
      .update({ status: 'success' })
      .eq('id', previewData.id);
  } catch (error) {
    console.error('Preview job error:', error);
    await supabaseClient
      .from('previews')
      .update({ status: 'failed' })
      .eq('id', previewData.id);
  }
}

async function submitMeshJob(
  supabaseClient: SupabaseClient,
  text: string | undefined,
  images: string[] | undefined,
  mesh: string | undefined,
  userId: string,
  conversationId: string,
  meshId: string,
  model: Model,
  meshTopology: string,
  polygonCount: string,
) {
  debugLog('=== SUBMITTING MESH JOB (Hunyuan3D) ===');

  const { data: previewData, error: previewError } = await supabaseClient
    .from('previews')
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      mesh_id: meshId,
    })
    .select()
    .single();

  if (previewError) {
    throw new Error(previewError.message);
  }

  let imageInputs: string[] = [];
  let imageIdForRecord: string | undefined;

  try {
    let meshImages: string[] = [];

    if (mesh) {
      const { data: meshData } = await supabaseClient
        .from('meshes')
        .select('images')
        .eq('id', mesh)
        .single();

      if (meshData?.images && Array.isArray(meshData.images)) {
        meshImages = meshData.images;
      }
    }

    const allImages = [...(images || []), ...meshImages];

    const imageGuidance =
      'You are generating a fully textured and rendered 3D model. Output one centered 3D model or multiple centered objects, no text. Plain white background, neutral lighting, and a soft shadow directly under the 3D model. Keep the entire object fully in-frame with 5–10% padding; no cropping. Make sure the description strongly impacts the form and shape of the 3D Model not just the surface texture';

    if (text && text.trim() !== '') {
      const newPrompt =
        allImages.length > 0
          ? `Edit the provided image(s) to: ${text} Style: ${imageGuidance}`
          : `Generate a new image: ${text} Style: ${imageGuidance}`;

      const { imageBytes, contentType } = await generateImageWithGeminiMultiTurn(
        userId,
        conversationId,
        newPrompt,
        allImages,
        mesh,
        { meshModel: model },
      );

      imageIdForRecord = crypto.randomUUID();

      const { error: imageUploadError } = await supabaseClient.storage
        .from('images')
        .upload(`${userId}/${conversationId}/${imageIdForRecord}`, imageBytes, {
          contentType,
        });

      if (imageUploadError) {
        throw new Error(imageUploadError.message);
      }

      const { data: imageSignedUrl } = await supabaseClient.storage
        .from('images')
        .createSignedUrl(
          `${userId}/${conversationId}/${imageIdForRecord}`,
          3600,
        );

      if (imageSignedUrl) {
        imageInputs = [reformatSignedUrl(imageSignedUrl.signedUrl)];
      }
    }

    if (imageInputs.length === 0 && images && images.length > 0) {
      for (const imgId of images) {
        const { data: signedUrlData } = await supabaseClient.storage
          .from('images')
          .createSignedUrl(`${userId}/${conversationId}/${imgId}`, 3600);

        if (signedUrlData) {
          imageInputs.push(reformatSignedUrl(signedUrlData.signedUrl));
        }
      }
    }

    if (imageInputs.length === 0) {
      throw new Error('No images available for mesh generation');
    }

    const faceCount = polygonCount === 'high' ? 500000 : polygonCount === 'medium' ? 200000 : 50000;

    const supabaseHost =
      Deno.env.get('ENVIRONMENT') === 'local'
        ? Deno.env.get('NGROK_URL')
        : Deno.env.get('SUPABASE_URL');

    const webhookUrl = `${supabaseHost?.trim()}/functions/v1/fal-webhook?id=${meshId}`;

    const result = await fal.submit('fal-ai/hunyuan-3d/v3.1/pro/image-to-3d', {
      input: {
        input_image_url: imageInputs[0],
        enable_pbr: true,
        face_count: faceCount,
      },
      webhookUrl,
    });

    debugLog('Fal queue result:', result);

    await supabaseClient
      .from('meshes')
      .update({
        status: 'processing',
        fal_request_id: result.requestId,
      })
      .eq('id', meshId);

    await supabaseClient
      .from('previews')
      .update({ status: 'success' })
      .eq('id', previewData.id);
  } catch (error) {
    console.error('Mesh job error:', error);

    await supabaseClient
      .from('meshes')
      .update({ status: 'failed' })
      .eq('id', meshId);

    await supabaseClient
      .from('previews')
      .update({ status: 'failed' })
      .eq('id', previewData.id);
  }
}