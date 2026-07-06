import 'dotenv/config';
import process from 'node:process';
import { Room } from '@livekit/rtc-node';
import { voice, initializeLogger } from '@livekit/agents';
import * as bey from '@livekit/agents-plugin-bey';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as openai from '@livekit/agents-plugin-openai';
import { ConvaiPipeline, normalizeConvaiLanguageCode, resolveConvaiWsUrl } from './convai_pipeline.js';

const LIVEKIT_URL = (process.env.AGENT_LIVEKIT_URL || process.env.LIVEKIT_URL || '').trim();
const LIVEKIT_TOKEN = (process.env.AGENT_LIVEKIT_TOKEN || '').trim();
const ROOM_NAME = (process.env.AGENT_ROOM_NAME || '').trim();
const PARTICIPANT_IDENTITY = (process.env.AGENT_PARTICIPANT_IDENTITY || '').trim() || null;

const beyAvatarId = (process.env.BEY_AVATAR_ID || '').trim() || undefined;
const elevenAgentId = (process.env.ELEVEN_AGENT_ID || '').trim();
const elevenApiKey = (process.env.ELEVEN_API_KEY || '').trim();
const elevenVoiceId = (process.env.ELEVEN_VOICE_ID || '').trim();
const elevenTtsModel = (process.env.ELEVEN_TTS_MODEL || 'eleven_flash_v2_5').trim();
const elevenIntegrationMode = (process.env.ELEVEN_INTEGRATION_MODE || 'convai').trim();
const llmModel = (process.env.OPENAI_LLM_MODEL || 'gpt-4o-mini').trim();
const speakToVideoText = (process.env.SPEAK_TO_VIDEO_TEXT || '').trim();
const speakToVideoOnly = (process.env.SPEAK_TO_VIDEO_ONLY || 'true') !== 'false';
const elevenDynamicName = (process.env.ELEVEN_DYNAMIC_NAME || 'friend').trim();
// Default to "auto" so ElevenLabs's language_detection system tool can switch
// the agent's language mid-call whenever the user changes the language they speak.
const convaiLanguage =
  normalizeConvaiLanguageCode(process.env.ELEVEN_AGENT_LANGUAGE) ||
  normalizeConvaiLanguageCode(process.env.AGENT_CONVAI_LANGUAGE) ||
  'auto';
const convaiLanguageIsAuto = convaiLanguage === 'auto';

/** RoomIO default mic pipeline sample rate (mono). */
const ROOM_MIC_SAMPLE_RATE = 24_000;
/** Beyond Presence / agent audio path sample rate. */
const BEY_PIPELINE_SAMPLE_RATE = 24_000;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

async function run() {
  initializeLogger({ pretty: true, level: process.env.LK_LOG_LEVEL || 'info' });

  requireEnv('AGENT_LIVEKIT_URL (or LIVEKIT_URL)', LIVEKIT_URL);
  requireEnv('AGENT_LIVEKIT_TOKEN', LIVEKIT_TOKEN);

  const room = new Room();
  await room.connect(LIVEKIT_URL, LIVEKIT_TOKEN);
  console.log(`[agent] connected to room ${ROOM_NAME || room.name}`);

  const convaiMode = elevenIntegrationMode === 'convai' && Boolean(elevenAgentId);
  const classicMode = !convaiMode;

  const voiceAgentSession = new voice.AgentSession(
    classicMode
      ? {
          stt: new openai.STT({
            model: 'whisper-1',
            // Omit language so whisper auto-detects when convaiLanguage is "auto".
            ...(convaiLanguageIsAuto ? {} : { language: convaiLanguage }),
          }),
          llm: new openai.LLM({ model: llmModel, temperature: 0.8 }),
          tts: new elevenlabs.TTS({
            apiKey: elevenApiKey,
            voiceId: elevenVoiceId,
            model: elevenTtsModel,
          }),
        }
      : {},
  );

  const voiceAgent = new voice.Agent({
    instructions: 'You are a friendly AI with a visual avatar',
  });

  const beyAvatarSession = new bey.AvatarSession({
    avatarId: beyAvatarId,
    avatarParticipantIdentity: 'avatar_worker',
    avatarParticipantName: 'avatar_worker',
  });

  await voiceAgentSession.start({
    agent: voiceAgent,
    room,
    inputOptions: convaiMode
      ? {
          textEnabled: false,
          audioEnabled: false,
        }
      : undefined,
    outputOptions: speakToVideoOnly
      ? {
          audioEnabled: false,
          transcriptionEnabled: false,
        }
      : undefined,
  });

  await beyAvatarSession.start(voiceAgentSession, room);

  if (speakToVideoOnly) {
    voiceAgentSession.output.setAudioEnabled(true);
    voiceAgentSession.output.setTranscriptionEnabled(false);
  }

  let convai = null;
  if (convaiMode) {
    const url = await resolveConvaiWsUrl(elevenAgentId, elevenApiKey);
    convai = new ConvaiPipeline({
      url,
      roomInputSampleRate: ROOM_MIC_SAMPLE_RATE,
      beyPipelineSampleRate: BEY_PIPELINE_SAMPLE_RATE,
      room,
      participantIdentity: PARTICIPANT_IDENTITY,
      dynamicName: elevenDynamicName,
      language: convaiLanguage,
      session: voiceAgentSession,
    });
    console.log(
      convaiLanguageIsAuto
        ? '[convai] starting with auto language detection'
        : `[convai] starting with locked language=${convaiLanguage}`,
    );
    convai.on('error', (err) => console.warn('[convai]', err));
    convai.on('language-change', ({ language, source, previous, reason }) => {
      const detail = reason ? ` (${reason})` : '';
      console.log(
        `[convai] language-change [${source}] ${previous || 'unknown'} → ${language}${detail}`,
      );
    });
    // Start convai only after we are connected; it will wait for mic track publish.
    await convai.start();

    // Bridge UI text chat messages (`lk.chat`) into ElevenLabs convai.
    // This keeps replies working even when voice activity detection misses speech.
    room.registerTextStreamHandler('lk.chat', async (reader, sender) => {
      try {
        const text = (await reader.readAll()).trim();
        if (!text) return;
        console.log(`[convai] text bridge from ${sender?.identity ?? 'unknown'}: ${text}`);
        convai?.sendUserMessage(text);
      } catch (err) {
        console.warn('[convai] text bridge failed', err);
      }
    });

    if (speakToVideoText) {
      convai.sendUserMessage(speakToVideoText);
    }
    voiceAgentSession.once('close', () => convai?.stop());
  }

  if (speakToVideoText && classicMode) {
    voiceAgentSession.say(speakToVideoText, {
      allowInterruptions: true,
      addToChatCtx: false,
    });
  }

  const shutdown = async () => {
    try {
      convai?.stop();
    } catch {}
    try {
      await voiceAgentSession.close();
    } catch {}
    try {
      room.disconnect();
    } catch {}
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

run().catch((e) => {
  console.error('[agent] fatal', e);
  process.exit(1);
});

