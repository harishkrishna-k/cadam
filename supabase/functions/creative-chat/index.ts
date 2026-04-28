import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { GoogleGenAI } from 'npm:@google/genai';
import {
  Message,
  Model,
  Content,
  Prompt,
  MeshData,
  CoreMessage,
} from '@shared/types.ts';
import {
  getAnonSupabaseClient,
  SupabaseClient,
} from '../_shared/supabaseClient.ts';
import Tree from '@shared/Tree.ts';
import { initSentry, logError } from '../_shared/sentry.ts';
import {
  getSignedUrl,
  getSignedUrls,
  formatCreativeUserMessage,
} from '../_shared/messageUtils.ts';

initSentry();

const DEBUG_LOGS =
  Deno.env.get('ENVIRONMENT') === 'local' ||
  Deno.env.get('DEBUG_LOGS') === 'true';
const debugLog = (...args: unknown[]) => {
  if (DEBUG_LOGS) console.log(...args);
};

const GEMINI_API_KEY = Deno.env.get('GOOGLE_API_KEY') ?? '';
const GEMINI_MODEL = 'gemini-2.5-pro-preview';

async function formatAssistantMessage(
  message: CoreMessage,
  supabaseClient: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<Array<{ role: string; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>> {
  const messages: Array<{ role: string; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> = [];

  if (message.content.text) {
    messages.push({
      role: 'model',
      parts: [{ text: message.content.text }],
    });
  }

  if (message.content.error) {
    messages.push({
      role: 'model',
      parts: [{ text: 'Error generating image or mesh' }],
    });
  }

  return messages;
}

const SYSTEM_PROMPT = `You are Adam, an expert AI creative assistant that helps users create 3D models through natural conversation.

Your personality:
- Friendly and helpful
- Confident in your creative abilities
- You explain options and ask clarifying questions when needed
- You guide users through the creative process naturally

Guidelines:
- Be conversational and natural in your responses
- When users describe what they want, help them visualize the end result
- Ask follow-up questions to refine the vision
- Explain how features or options work in context`;

const MESH_TOOL = {
  name: 'generate_mesh',
  description: 'Generate a 3D mesh from the user\'s vision. Use this when the user wants to create or modify a 3D model.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'User\'s vision for the model' },
      mode: { type: 'string', enum: ['quality', 'fast'], description: 'Generation mode' },
      imageIds: { type: 'array', items: { type: 'string' }, description: 'Reference image IDs' },
    },
    required: ['prompt'],
  },
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: corsHeaders,
    });
  }

  const supabaseClient = getAnonSupabaseClient({
    global: {
      headers: { Authorization: req.headers.get('Authorization') ?? '' },
    },
  });

  const { data: userData, error: userError } =
    await supabaseClient.auth.getUser();
  if (!userData.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (userError) {
    return new Response(JSON.stringify({ error: userError.message }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const {
    messageId,
    conversationId,
    model,
    newMessageId,
  }: {
    messageId: string;
    conversationId: string;
    model: Model;
    newMessageId: string;
  } = await req.json();

  const { data: messages, error: messagesError } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .overrideTypes<Array<{ content: Content; role: 'user' | 'assistant' }>>();

  if (messagesError) {
    return new Response(
      JSON.stringify({
        error: messagesError instanceof Error ? messagesError.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      },
    );
  }

  if (!messages || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'Messages not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let content: Content = { model };
  const { data: newMessageData, error: newMessageError } = await supabaseClient
    .from('messages')
    .insert({
      id: newMessageId,
      conversation_id: conversationId,
      role: 'assistant',
      content,
      parent_message_id: messageId,
    })
    .select()
    .single()
    .overrideTypes<{ content: Content; role: 'assistant' }>();

  if (!newMessageData) {
    return new Response(
      JSON.stringify({
        error: newMessageError instanceof Error ? newMessageError.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      },
    );
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const geminiModel = ai.getGenerativeModel({ model: GEMINI_MODEL });

  try {
    const messageTree = new Tree<Message>(messages);
    const newMessage = messages.find((m) => m.id === messageId);
    if (!newMessage) {
      throw new Error('Message not found');
    }
    const currentMessageBranch = messageTree.getPath(newMessage.id);

    const messagesToSend = currentMessageBranch.map((message) => {
      return {
        id: message.id,
        role: message.role,
        content: message.content,
      };
    });

    const formattedHistory = await Promise.all(
      messagesToSend.map(async (message: CoreMessage) => {
        if (message.role === 'user') {
          const formatted = await formatCreativeUserMessage(
            message,
            supabaseClient,
            userData.user.id,
            conversationId,
          );
          return formatted;
        } else {
          return formatAssistantMessage(message, supabaseClient, userData.user.id, conversationId);
        }
      })
    );

    const flatHistory = formattedHistory.flat();
    const userText = typeof newMessage.content === 'string' 
      ? newMessage.content 
      : (newMessage.content as Content)?.text || '';

    const responseStream = new ReadableStream({
      async start(controller) {
        try {
          const prompt = `${SYSTEM_PROMPT}

User's message: ${userText}

Please respond to the user naturally and help them create their 3D vision. If they want to generate a model, acknowledge their request and guide them through the process:`;

          const result = await geminiModel.generateContentStream({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
          });

          let fullResponse = '';
          for await (const chunk of result.stream) {
            const text = chunk.text || '';
            fullResponse += text;
            
            content = { ...content, text: fullResponse };
            streamMessage(controller, { ...newMessageData, content });
          }

          if (userText.toLowerCase().match(/create|generate|make|3d|model/i)) {
            const toolCallMessage = `\n\nI'd be happy to help create that 3D model for you! I'll generate it now.`;
            content = { ...content, text: fullResponse + toolCallMessage };
            streamMessage(controller, { ...newMessageData, content });

            content = {
              ...content,
              toolCalls: [
                {
                  id: crypto.randomUUID(),
                  name: 'generate_mesh',
                  status: 'pending',
                },
              ],
            };
            streamMessage(controller, { ...newMessageData, content });
          }

          controller.close();
        } catch (error) {
          console.error('Stream error:', error);
          
          if (!content.text && !content.mesh) {
            content = {
              ...content,
              text: 'An error occurred while processing your request.',
            };
          }
          
          streamMessage(controller, { ...newMessageData, content });
          controller.close();
        }
      },
    });

    return new Response(responseStream, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders,
      },
    });
  } catch (error) {
    console.error(error);

    if (!content.text && !content.mesh) {
      content = {
        ...content,
        text: 'An error occurred while processing your request.',
      };
    }

    const { data: updatedMessageData } = await supabaseClient
      .from('messages')
      .update({ content })
      .eq('id', newMessageData.id)
      .select()
      .single()
      .overrideTypes<{ content: Content; role: 'assistant' }>>();

    if (updatedMessageData) {
      return new Response(JSON.stringify({ message: updatedMessageData }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      },
    );
  }
});

function streamMessage(
  controller: ReadableStreamDefaultController,
  message: { content: Content },
) {
  const encoded = new TextEncoder().encode(JSON.stringify(message) + '\n');
  try {
    controller.enqueue(encoded);
  } catch {
    // Controller closed
  }
}