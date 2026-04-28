import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { GoogleGenAI } from 'npm:@google/genai';
import { corsHeaders } from '../_shared/cors.ts';
import { getAnonSupabaseClient } from '../_shared/supabaseClient.ts';
import { Content } from '@shared/types.ts';
import { formatCreativeUserMessage } from '../_shared/messageUtils.ts';

const TITLE_SYSTEM_PROMPT = `You are a helpful assistant that generates concise, descriptive titles for conversation threads based on the first message in the thread.
The messages can be text, images, or screenshots of 3d models.

Your titles should be:
1. Brief (under 80 characters)
2. Descriptive of the content/intent
3. Clear and professional
4. Without any special formatting or punctuation at the beginning or end

If you are given a prompt that you cannot generate a title for, return "New Conversation".

Here are some examples:

User: "Make me a toy plane"
Assistant: "A Toy Plane"

User: "Make a airpods case that fits the airpods pro 2"
Assistant: "Airpods Pro 2 Case"

User: "Make a pencil holder for my desk"
Assistant: "A Pencil Holder"

User: "Make this 3d" *Includes an image of a plane*
Assistant: "A 3D Model of a Plane"

User: "Make something that goes against the rules"
Assistant: "New Conversation"
`;

const GEMINI_API_KEY = Deno.env.get('GOOGLE_API_KEY') ?? '';
const GEMINI_MODEL = 'gemini-2.5-flash';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const {
    content,
    conversationId,
  }: { content: Content; conversationId: string } = await req.json();

  const supabaseClient = getAnonSupabaseClient({
    global: {
      headers: { Authorization: req.headers.get('Authorization') ?? '' },
    },
  });

  const { data: userData, error: userError } =
    await supabaseClient.auth.getUser();

  if (!userData.user) {
    return new Response(
      JSON.stringify({ error: { message: 'Unauthorized' } }),
      {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  if (userError) {
    return new Response(
      JSON.stringify({ error: { message: userError.message } }),
      {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const model = ai.getGenerativeModel({ model: GEMINI_MODEL });

  try {
    let userText = '';
    if (typeof content === 'string') {
      userText = content;
    } else if (content && typeof content === 'object') {
      const c = content as Content;
      userText = c.text || '';
    }

    if (!userText) {
      return new Response(JSON.stringify({ title: 'New Conversation' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const prompt = `${TITLE_SYSTEM_PROMPT}\n\nUser: "${userText}"\n\nAssistant:`;

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        maxTokens: 80,
        temperature: 0.3,
      },
    });

    let title = 'New Conversation';
    const generatedTitle = result.text?.trim();
    if (generatedTitle && generatedTitle.length > 0) {
      title = generatedTitle;

      if (title.length > 255) {
        title = title.substring(0, 252) + '...';
      }
    }

    if (
      title.toLowerCase().includes('sorry') ||
      title.toLowerCase().includes('apologize')
    ) {
      title = 'New Conversation';
    }

    return new Response(JSON.stringify({ title }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error calling Gemini:', error);

    return new Response(
      JSON.stringify({
        title: 'New Conversation',
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});