import 'dotenv/config';
import { spawn } from 'node:child_process';
import process from 'node:process';
import express from 'express';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);

const LIVEKIT_URL = (process.env.LIVEKIT_URL || '').trim();
const LIVEKIT_API_KEY = (process.env.LIVEKIT_API_KEY || '').trim();
const LIVEKIT_API_SECRET = (process.env.LIVEKIT_API_SECRET || '').trim();

function requireEnv(name, value) {
  if (!value) {
    const err = new Error(`Missing required server env var: ${name}`);
    err.code = 'MISSING_ENV';
    throw err;
  }
}

async function createToken({ identity, room, name, canPublish = true, canSubscribe = true, kind }) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name });
  if (kind) {
    at.kind = kind;
  }
  at.addGrant({
    room,
    roomJoin: true,
    canPublish,
    canSubscribe,
  });
  return await at.toJwt();
}

const app = express();
app.use(express.json({ limit: '1mb' }));
const N8N_LOAN_WEBHOOK_URL = (
  process.env.N8N_LOAN_WEBHOOK_URL ||
  process.env.N8N_HOME_LOAN_WEBHOOK_URL ||
  'https://eva-ramanik.app.n8n.cloud/webhook/ResponseFormat'
).trim();
const N8N_LIVE_SEARCH_WEBHOOK_URL = (
  process.env.N8N_LIVE_SEARCH_WEBHOOK_URL ||
  'https://eva-ramanik.app.n8n.cloud/webhook/hdfc_live_search'
).trim();

let currentAgentProc = null;
let currentRoomName = null;

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    agentRunning: Boolean(currentAgentProc && !currentAgentProc.killed),
    room: currentRoomName,
  });
});

app.post('/api/start', async (req, res) => {
  try {
    requireEnv('LIVEKIT_URL', LIVEKIT_URL);
    requireEnv('LIVEKIT_API_KEY', LIVEKIT_API_KEY);
    requireEnv('LIVEKIT_API_SECRET', LIVEKIT_API_SECRET);

    const clientIdentity = String(req.body?.identity || 'user').trim() || 'user';
    const displayName = String(req.body?.name || clientIdentity).trim() || clientIdentity;
    const convaiDynamicName = String(req.body?.name || process.env.ELEVEN_DYNAMIC_NAME || 'friend').trim() || 'friend';
    const bodyLanguage =
      req.body?.language ??
      req.body?.variables?.language ??
      req.body?.variables?.preferred_language ??
      req.body?.variables?.locale;
    const convaiLanguage = String(bodyLanguage || process.env.ELEVEN_AGENT_LANGUAGE || '')
      .trim()
      .toLowerCase()
      .split(/[-_]/)[0];

    const roomName = `eva-${randomUUID()}`;
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await roomService.createRoom({ name: roomName, emptyTimeout: 60, maxParticipants: 10 });

    const clientToken = await createToken({
      identity: clientIdentity,
      name: displayName,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    // This token is for the local "controller" process (our runner).
    // The Bey avatar itself joins separately using LiveKit server credentials
    // and will publish as `avatar_worker` (configured in `agent/runner.js`).
    const agentToken = await createToken({
      identity: 'agent_controller',
      name: 'EVA Controller',
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      kind: 'agent',
    });

    // Stop any previous agent (single-call dev semantics).
    if (currentAgentProc && !currentAgentProc.killed) {
      currentAgentProc.kill('SIGTERM');
      currentAgentProc = null;
      currentRoomName = null;
    }

    currentRoomName = roomName;
    currentAgentProc = spawn(
      process.execPath,
      ['agent/runner.js'],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: {
          ...process.env,
          AGENT_LIVEKIT_URL: LIVEKIT_URL,
          AGENT_LIVEKIT_TOKEN: agentToken,
          AGENT_ROOM_NAME: roomName,
          AGENT_PARTICIPANT_IDENTITY: clientIdentity,
          ELEVEN_DYNAMIC_NAME: convaiDynamicName,
          ...(convaiLanguage ? { AGENT_CONVAI_LANGUAGE: convaiLanguage } : {}),
        },
      },
    );
    currentAgentProc.on('exit', () => {
      currentAgentProc = null;
      currentRoomName = null;
    });

    res.json({
      livekit_url: LIVEKIT_URL,
      livekit_token: clientToken,
      room: roomName,
      identity: clientIdentity,
    });
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    res.status(500).json({ error: message });
  }
});

app.post('/api/stop', async (_req, res) => {
  if (currentAgentProc && !currentAgentProc.killed) {
    currentAgentProc.kill('SIGTERM');
    currentAgentProc = null;
    currentRoomName = null;
  }
  res.json({ ok: true });
});

async function postN8nWebhookProxy(req, res, options) {
  try {
    const webhookUrl = String(options.url || '').trim();
    if (!webhookUrl) {
      throw new Error(options.missingUrlError || 'n8n webhook URL is not configured');
    }

    const userMessage = String(req.body?.message || '').trim();
    const userName = String(req.body?.name || '').trim();
    const room = String(req.body?.room || currentRoomName || '').trim();

    if (!userMessage) {
      return res.status(400).json({ error: 'message is required' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const webhookResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        journey: options.journey,
        trigger: options.trigger,
        // The n8n live-search workflow keys off `query`; keep `message` too for
        // backwards-compatibility with the loan workflow.
        query: userMessage,
        message: userMessage,
        name: userName || undefined,
        room: room || undefined,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!webhookResponse.ok) {
      const responseText = await webhookResponse.text().catch(() => '');
      throw new Error(`n8n webhook failed (${webhookResponse.status}): ${responseText || webhookResponse.statusText}`);
    }

    const contentType = webhookResponse.headers.get('content-type') || '';
    const rawBody = await webhookResponse.text();
    let parsed = null;
    if (!rawBody.trim()) {
      parsed = {};
    } else if (contentType.includes('application/json')) {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = { response: rawBody };
      }
    } else {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = { response: rawBody };
      }
    }

    const responseMessage =
      parsed?.voice_response ||
      parsed?.response ||
      parsed?.message ||
      parsed?.text ||
      parsed?.output ||
      parsed?.description ||
      parsed?.data?.voice_response ||
      parsed?.data?.response ||
      parsed?.data?.message ||
      '';

    const trimmed = String(responseMessage || '').trim();

    res.json({
      ok: true,
      response: trimmed,
      raw: parsed,
    });
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    res.status(500).json({ error: message });
  }
}

function postN8nLoanJourneyWebhook(req, res) {
  return postN8nWebhookProxy(req, res, {
    url: N8N_LOAN_WEBHOOK_URL,
    journey: 'loan',
    trigger: 'user-loan-intent',
    missingUrlError: 'N8N loan webhook URL is not configured',
  });
}

function postN8nLiveSearchWebhook(req, res) {
  return postN8nWebhookProxy(req, res, {
    url: N8N_LIVE_SEARCH_WEBHOOK_URL,
    journey: 'live-search',
    trigger: 'user-question',
    missingUrlError: 'N8N live search webhook URL is not configured',
  });
}

app.post('/api/n8n/home-loan', postN8nLoanJourneyWebhook);
app.post('/api/n8n/loan', postN8nLoanJourneyWebhook);
app.post('/api/n8n/live-search', postN8nLiveSearchWebhook);

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

