/**
 * ElevenLabs Conversational AI WebSocket: stream user mic to convai (`user_audio_chunk`),
 * stream agent PCM (`audio` events) into LiveKit Agents for Beyond Presence lipsync.
 *
 * Copied from `livekit-agent/convai_pipeline.js` and used by the root-level agent runner.
 *
 * @see https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket
 */
import { EventEmitter } from "node:events";
import {
  AudioFrame,
  AudioResampler,
  AudioResamplerQuality,
  AudioStream,
  RoomEvent,
  TrackSource,
} from "@livekit/rtc-node";
import { WebSocket } from "ws";

/** @param {string} fmt e.g. pcm_16000 */
export function parsePcmSampleRate(fmt) {
  if (!fmt || typeof fmt !== "string") return null;
  const m = /^pcm_(\d+)$/i.exec(fmt.trim());
  return m ? Number(m[1]) : null;
}

/** ISO 639-1 codes supported by typical ElevenLabs agent language presets. */
const LANGUAGE_ALIASES = {
  en: "en",
  english: "en",
  hi: "hi",
  hindi: "hi",
  mr: "mr",
  marathi: "mr",
  hinglish: "hi",
};

/** Sentinel meaning: do not send a language override — let `language_detection` auto-switch. */
const LANGUAGE_AUTO_SENTINELS = new Set(["auto", "detect", "automatic", "any", "multi", "multilingual"]);

/**
 * @param {unknown} raw
 * @returns {string | null} ISO 639-1 code, "auto", or null if invalid/empty.
 */
export function normalizeConvaiLanguageCode(raw) {
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;
  if (LANGUAGE_AUTO_SENTINELS.has(text)) return "auto";
  const token = text.split(/[-_]/)[0];
  if (LANGUAGE_AUTO_SENTINELS.has(token)) return "auto";
  if (LANGUAGE_ALIASES[token]) return LANGUAGE_ALIASES[token];
  if (/^[a-z]{2}$/.test(token)) return token;
  return null;
}

export async function resolveConvaiWsUrl(agentId, apiKey) {
  if (!agentId) throw new Error("ELEVEN_AGENT_ID is required");
  if (!apiKey) {
    return `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`;
  }
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { "xi-api-key": apiKey } },
  );
  if (!res.ok) {
    throw new Error(`ElevenLabs signed URL failed (${res.status})`);
  }
  const body = await res.json();
  if (!body?.signed_url) throw new Error("ElevenLabs signed URL missing");
  return body.signed_url;
}

function int16FromBuffer(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = buf.readInt16LE(i * 2);
  }
  return out;
}

export class ConvaiPipeline extends EventEmitter {
  /** @type {WebSocket | null} */
  #ws = null;
  /** @type {string} */
  #url;
  /** @type {number} */
  #roomInRate;
  /** @type {number} */
  #beyRate;
  /** @type {import("@livekit/agents").voice.AgentSession} */
  #session;
  /** @type {import("@livekit/rtc-node").Room} */
  #room;
  /** @type {string | null} */
  #participantIdentity;
  /** @type {string} */
  #dynamicName;
  /** @type {string | null} */
  #language;
  /** @type {string | null} */
  #activeLanguage = null;
  #userTargetRate = 16_000;
  #agentSourceRate = 24_000;
  /** @type {AudioResampler | null} */
  #upResampler = null;
  /** @type {AudioResampler | null} */
  #downResampler = null;
  /** @type {import("node:stream/web").ReadableStreamDefaultController<AudioFrame> | null} */
  #outCtrl = null;
  #idleTimer = null;
  #uplinkAbort = false;
  #metaReceived = false;
  #uplinkFrameCount = 0;
  #uplinkChunkCount = 0;
  #lastAudioEventAt = 0;
  /** When true, mic frames are read but not sent to ElevenLabs (e.g. loan → n8n handoff). */
  #micSuppressUplink = false;
  #onDataReceived = (payload) => {
    try {
      const text = new TextDecoder().decode(payload);
      const msg = JSON.parse(text);
      if (msg?.eva === "suppress-convai-mic") {
        this.#micSuppressUplink = Boolean(msg.suppress);
        console.log("[convai] mic uplink suppress", this.#micSuppressUplink);
      }
    } catch {
      /* ignore non-json / other data packets */
    }
  };

  /**
   * @param {{
   *   url: string;
   *   roomInputSampleRate: number;
   *   beyPipelineSampleRate: number;
   *   room: import("@livekit/rtc-node").Room;
   *   participantIdentity: string | null;
   *   dynamicName?: string;
   *   language?: string | null;
   *   session: import("@livekit/agents").voice.AgentSession;
   * }} opts
   */
  constructor({
    url,
    roomInputSampleRate,
    beyPipelineSampleRate,
    room,
    participantIdentity,
    dynamicName,
    language,
    session,
  }) {
    super();
    this.#url = url;
    this.#roomInRate = roomInputSampleRate;
    this.#beyRate = beyPipelineSampleRate;
    this.#room = room;
    this.#participantIdentity = participantIdentity;
    this.#dynamicName = (dynamicName && String(dynamicName).trim()) || "friend";
    this.#language = normalizeConvaiLanguageCode(language);
    this.#session = session;
  }

  async start() {
    this.#room.on(RoomEvent.DataReceived, this.#onDataReceived);
    await this.#connectWs();
    // Do not block on metadata; some agents send it only after first audio chunk.
    if (!this.#metaReceived) {
      this.emit("ready", {
        userInputRate: this.#userTargetRate,
        agentOutputRate: this.#agentSourceRate,
      });
    }
    void this.#runUplink().catch((e) => this.emit("error", e));
  }

  async #connectWs() {
    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    console.log("[convai] websocket connected");

    /** @type {Record<string, unknown>} */
    const initiation = {
      type: "conversation_initiation_client_data",
      dynamic_variables: { name: this.#dynamicName },
    };
    // Only lock the language when an explicit ISO code was passed.
    // "auto" (or no value) lets ElevenLabs's `language_detection` system tool
    // switch the agent mid-call based on the user's spoken language.
    if (this.#language && this.#language !== "auto") {
      initiation.conversation_config_override = {
        agent: { language: this.#language },
      };
      console.log("[convai] initial language hint (locked):", this.#language);
    } else {
      console.log(
        "[convai] auto language detection — agent will switch when user speaks another supported language (enable language_detection tool in ElevenLabs)",
      );
    }

    ws.send(JSON.stringify(initiation));
    ws.on("message", (raw) => this.#onServerMessage(raw));
    ws.on("close", () => {
      this.#finishAgentStream();
      this.emit("close");
    });
    ws.on("error", (err) => this.emit("error", err));
  }

  /** @param {Buffer | ArrayBuffer | string} raw */
  #onServerMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      // Non-JSON frames are unexpected for convai payload events.
      console.log("[convai] non-json message received");
      return;
    }
    // VAD pings are very chatty — skip the per-event log so the language flow stays visible.
    if (msg?.type && msg.type !== "vad_score" && msg.type !== "audio") {
      console.log("[convai] event", msg.type);
    }
    if (msg?.type === "user_transcript" && msg?.user_transcription_event?.user_transcript) {
      console.log("[convai] user_transcript", msg.user_transcription_event.user_transcript);
      void this.#publishChatMessage(
        msg.user_transcription_event.user_transcript,
        this.#participantIdentity || "user",
      );
      return;
    }
    if (msg?.type === "agent_response" && msg?.agent_response_event?.agent_response) {
      console.log("[convai] agent_response", msg.agent_response_event.agent_response);
      void this.#publishChatMessage(
        msg.agent_response_event.agent_response,
        "elevenlabs-agent",
      );
      // Some agents might be configured without voice output.
      if (Date.now() - this.#lastAudioEventAt > 2000) {
        console.log("[convai] warning: got text response but no audio event yet");
      }
      return;
    }
    if (msg?.type === "ping" && msg?.ping_event?.event_id != null) {
      this.#ws?.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id }));
      return;
    }
    if (msg?.type === "conversation_initiation_metadata" && msg?.conversation_initiation_metadata_event) {
      const ev = msg.conversation_initiation_metadata_event;
      const inRate = parsePcmSampleRate(ev.user_input_audio_format);
      const outRate = parsePcmSampleRate(ev.agent_output_audio_format);
      if (inRate) {
        this.#userTargetRate = inRate;
        this.#upResampler?.close();
        this.#upResampler = new AudioResampler(
          this.#roomInRate,
          this.#userTargetRate,
          1,
          AudioResamplerQuality.MEDIUM,
        );
      }
      if (outRate) {
        this.#agentSourceRate = outRate;
        this.#downResampler?.close();
        this.#downResampler = new AudioResampler(
          this.#agentSourceRate,
          this.#beyRate,
          1,
          AudioResamplerQuality.MEDIUM,
        );
      }
      if (!this.#metaReceived) {
        this.#metaReceived = true;
        // ElevenLabs only sends format info in conversation_initiation_metadata_event;
        // the language is determined either by the agent default or by a future
        // language_detection tool call. We optimistically read any forward-compatible
        // `language` field but fall back to whatever we locked the agent to.
        const lockedLang = this.#language && this.#language !== "auto" ? this.#language : null;
        const initialLang =
          ev?.language ||
          ev?.agent_output_language ||
          ev?.conversation?.language ||
          lockedLang ||
          null;
        if (initialLang) {
          this.#activeLanguage = String(initialLang).toLowerCase();
          console.log("[convai] initial conversation language", this.#activeLanguage);
          this.#publishLanguageEvent(this.#activeLanguage, "initial");
        }
        console.log("[convai] metadata", {
          conversation_id: ev.conversation_id,
          user_input_audio_format: ev.user_input_audio_format,
          agent_output_audio_format: ev.agent_output_audio_format,
          language: initialLang,
        });
        this.emit("ready", {
          userInputRate: this.#userTargetRate,
          agentOutputRate: this.#agentSourceRate,
          language: initialLang,
        });
      }
      return;
    }
    // Tool calls (including the built-in `language_detection` system tool) MUST be
    // acknowledged with a `client_tool_result` reply on the same socket. If we skip
    // this, ElevenLabs treats the tool as unfulfilled and the language switch never
    // takes effect mid-call.
    // See https://elevenlabs.io/docs/eleven-agents/customization/events/client-events
    if (msg?.type === "client_tool_call" && msg?.client_tool_call) {
      this.#handleClientToolCall(msg.client_tool_call);
      return;
    }
    if (msg?.type === "interruption") {
      this.#session.interrupt({ force: true }).catch(() => {});
      this.#finishAgentStream();
      return;
    }
    if (msg?.type === "audio" && msg?.audio_event?.audio_base_64) {
      this.#lastAudioEventAt = Date.now();
      const buf = Buffer.from(msg.audio_event.audio_base_64, "base64");
      if (buf.length < 2) return;
      const int16 = int16FromBuffer(buf);
      const frame = new AudioFrame(int16, this.#agentSourceRate, 1, int16.length);
      this.#ensureAgentStream();
      const frames = this.#downResampler ? this.#downResampler.push(frame) : [frame];
      for (const f of frames) {
        try {
          this.#outCtrl?.enqueue(f);
        } catch {
          /* stream closed */
        }
      }
      this.#bumpIdleClose();
      return;
    }
    // Ignore high-frequency events we don't need.
    if (
      msg?.type === "vad_score" ||
      msg?.type === "internal_tentative_agent_response" ||
      msg?.type === "agent_response_complete" ||
      msg?.type === "agent_response_correction" ||
      msg?.type === "contextual_update"
    ) {
      return;
    }
    if (msg?.error || msg?.message || msg?.detail) {
      console.warn("[convai] unhandled message payload", msg);
    }
  }

  /**
   * Canonical UI screen IDs the agent may request via `ui_show_screen`.
   * Adding a new screen?
   *   1. Add the ID here.
   *   2. Add a handler under `#dispatchUiShowScreen` in `demo.ts` (browser side).
   *   3. Mention the new ID in the ElevenLabs agent's tool description.
   */
  static UI_SCREEN_IDS = new Set([
    "forex",
    "details",
    "best-card",
    "address-verify",
    "address-consent",
    "address-next",
    "address-verified-success",
    "address-select",
    "address-select-review",
    "address-request-submitted",
    "self-verify",
    "face-scan",
    "home-loan",
    "home-loan-summary",
    "home-loan-payment-received",
    "home-loan-prepayment-adjusted",
    "cash-withdraw",
    "cash-withdraw-consent",
    "cash-withdraw-debit-slot",
    "cash-withdraw-bank-details",
    "otp-verify",
    "cash-withdraw-collect",
  ]);

  /**
   * Handle a `client_tool_call` event. Acknowledges every tool call with a
   * `client_tool_result` reply (mandatory per the ConvAI WebSocket spec) and
   * surfaces `language_detection` switches plus `ui_show_screen` events to
   * the room so the browser can react in any conversation language.
   *
   * @param {{ tool_name?: string; tool_call_id?: string; parameters?: unknown }} call
   */
  #handleClientToolCall(call) {
    const toolName = String(call?.tool_name || "").trim();
    const toolCallId = String(call?.tool_call_id || "").trim();
    const params = this.#coerceToolParameters(call?.parameters);

    if (toolName === "language_detection") {
      const rawLang = params?.language;
      const nextLang = rawLang ? String(rawLang).trim().toLowerCase().split(/[-_]/)[0] : null;
      const reason = typeof params?.reason === "string" ? params.reason : "";

      console.log(
        `[convai] language_detection client_tool_call → ${nextLang || "(none)"} (reason: ${reason || "—"}, id: ${toolCallId || "—"})`,
      );

      if (nextLang && nextLang !== this.#activeLanguage) {
        const previous = this.#activeLanguage;
        this.#activeLanguage = nextLang;
        console.log(
          `[convai] language switched ${previous || "unknown"} → ${nextLang}${reason ? ` (${reason})` : ""}`,
        );
        this.#publishLanguageEvent(nextLang, "auto-detect", { previous, reason });
      } else if (nextLang) {
        console.log(`[convai] language_detection no-op (already ${nextLang})`);
      }

      this.#sendClientToolResult(toolCallId, `Switched to ${nextLang || "detected"}`, false);
      return;
    }

    // Language-agnostic screen routing — the agent (in any language) calls
    // `ui_show_screen({ screen, reason? })` and we forward the intent to the
    // browser via a room data payload so `demo.ts` can flip the UI without
    // transcript sniffing.
    if (toolName === "ui_show_screen" || toolName === "show_screen") {
      const requested = String(params?.screen || params?.name || "").trim().toLowerCase();
      const reason = typeof params?.reason === "string" ? params.reason : "";
      const known = ConvaiPipeline.UI_SCREEN_IDS.has(requested);

      console.log(
        `[convai] ui_show_screen client_tool_call → ${requested || "(none)"} (reason: ${reason || "—"}, id: ${toolCallId || "—"})`,
      );

      if (!requested) {
        this.#sendClientToolResult(toolCallId, "Missing `screen` parameter", true);
        return;
      }
      if (!known) {
        const allowed = [...ConvaiPipeline.UI_SCREEN_IDS].join(", ");
        console.warn(
          `[convai] ui_show_screen unknown screen "${requested}". Allowed: ${allowed}`,
        );
        this.#sendClientToolResult(
          toolCallId,
          `Unknown screen "${requested}". Allowed: ${allowed}`,
          true,
        );
        return;
      }

      void this.#publishUiShowScreen(requested, reason, params);
      this.#sendClientToolResult(toolCallId, `Showing screen "${requested}"`, false);
      return;
    }

    // Unknown / unimplemented client tool — still ACK so the agent doesn't stall.
    console.warn(`[convai] unhandled client_tool_call: ${toolName}`, params);
    this.#sendClientToolResult(
      toolCallId,
      `Client tool "${toolName}" is not implemented`,
      true,
    );
  }

  /**
   * Forward a screen request to the browser via a room data packet.
   * @param {string} screen
   * @param {string} reason
   * @param {Record<string, unknown>} params
   */
  async #publishUiShowScreen(screen, reason, params) {
    try {
      await this.#room.localParticipant.publishData(
        new TextEncoder().encode(
          JSON.stringify({
            eva: "ui-show-screen",
            screen,
            reason: reason || null,
            details: params || null,
            language: this.#activeLanguage,
            timestamp: Date.now(),
          }),
        ),
        { reliable: true },
      );
    } catch (err) {
      console.warn("[convai] ui-show-screen publish failed", err?.message ?? err);
    }
  }
  /**
   * 
   * ElevenLabs occasionally sends parameters as a JSON-encoded string instead of
   * an object (matches the OpenAI function-call wire format). Normalize both.
   * @param {unknown} raw
   * @returns {Record<string, unknown>}
   */
  #coerceToolParameters(raw) {
    if (raw && typeof raw === "object") return /** @type {Record<string, unknown>} */ (raw);
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        /* fall through */
      }
    }
    return {};
  }

  /**
   * @param {string} toolCallId
   * @param {string} result
   * @param {boolean} isError
   */
  #sendClientToolResult(toolCallId, result, isError) {
    if (!toolCallId) {
      console.warn("[convai] cannot ack client_tool_call (missing tool_call_id)");
      return;
    }
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      console.warn("[convai] cannot ack client_tool_call (socket not open)");
      return;
    }
    this.#ws.send(
      JSON.stringify({
        type: "client_tool_result",
        tool_call_id: toolCallId,
        result,
        is_error: Boolean(isError),
      }),
    );
  }

  /**
   * Push a language-change event to the room so the browser UI can react.
   * @param {string} language
   * @param {"initial" | "auto-detect" | "manual"} source
   * @param {{ previous?: string | null, reason?: string } | undefined} extra
   */
  async #publishLanguageEvent(language, source, extra) {
    try {
      this.emit("language-change", { language, source, ...(extra || {}) });
      await this.#room.localParticipant.publishData(
        new TextEncoder().encode(
          JSON.stringify({
            eva: "language-change",
            language,
            source,
            previous: extra?.previous ?? null,
            reason: extra?.reason ?? null,
            timestamp: Date.now(),
          }),
        ),
        { reliable: true },
      );
    } catch (err) {
      console.warn("[convai] language event publish failed", err?.message ?? err);
    }
  }

  async #publishChatMessage(text, senderIdentity) {
    const line = text?.trim();
    if (!line) return;
    try {
      // Playground chat panel consumes lk.chat text streams.
      const prefix = senderIdentity === "elevenlabs-agent" ? "ElevenLabs" : "You";
      await this.#room.localParticipant.sendText(`${prefix}: ${line}`, {
        topic: "lk.chat",
      });
    } catch (err) {
      console.warn("[convai] chat publish failed", err);
    }
  }

  #ensureAgentStream() {
    if (this.#outCtrl) return;

    const stream = new ReadableStream({
      start: (controller) => {
        this.#outCtrl = controller;
      },
    });

    // The session can close during participant disconnects.
    // In that case, ignore say() failures so the worker doesn't crash.
    try {
      this.#session.say("", {
        audio: stream,
        allowInterruptions: true,
        addToChatCtx: false,
      });
    } catch (err) {
      console.warn('[convai] session.say threw (likely closing):', err?.message ?? err);
    }
  }

  #bumpIdleClose() {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.#finishAgentStream(), 1200);
  }

  #finishAgentStream() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    try {
      this.#outCtrl?.close();
    } catch {
      /* already closed */
    }
    this.#outCtrl = null;
  }

  async #runUplink() {
    console.log("[convai] waiting for participant mic track");
    const micTrack = await this.#waitForMicTrack();
    console.log("[convai] participant mic track subscribed");
    const micStream = new AudioStream(micTrack, this.#roomInRate, 1);
    const reader = micStream.getReader();
    const startedAt = Date.now();
    while (!this.#uplinkAbort) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) break;
      this.#uplinkFrameCount += 1;
      if (this.#uplinkFrameCount === 1) {
        console.log("[convai] first mic frame received");
      } else if (this.#uplinkFrameCount % 200 === 0) {
        // Quick sanity check: if this rises, microphone capture path is alive.
        console.log("[convai] mic frame count", this.#uplinkFrameCount);
      }
      if (!this.#upResampler) {
        this.#upResampler = new AudioResampler(
          this.#roomInRate,
          this.#userTargetRate,
          1,
          AudioResamplerQuality.MEDIUM,
        );
      }
      const outFrames = this.#upResampler.push(value);
      for (const f of outFrames) {
        if (this.#micSuppressUplink) continue;
        const b = Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength);
        this.#ws.send(JSON.stringify({ user_audio_chunk: b.toString("base64") }));
        this.#uplinkChunkCount += 1;
        if (this.#uplinkChunkCount === 1) {
          console.log("[convai] first user_audio_chunk sent");
        } else if (this.#uplinkChunkCount % 100 === 0) {
          console.log("[convai] user_audio_chunk count", this.#uplinkChunkCount);
        }
      }
      if (Date.now() - startedAt > 8000 && this.#uplinkChunkCount === 0) {
        console.log("[convai] warning: mic frames seen but no uplink chunks yet");
      }
    }
    reader.releaseLock();
  }

  async #waitForMicTrack() {
    const pickFromCurrent = () => {
      const participant = this.#participantIdentity
        ? this.#room.remoteParticipants.get(this.#participantIdentity)
        : [...this.#room.remoteParticipants.values()][0];
      if (!participant) return null;
      for (const publication of participant.trackPublications.values()) {
        if (publication.source === TrackSource.SOURCE_MICROPHONE) {
          publication.setSubscribed(true);
          if (publication.track) return publication.track;
        }
      }
      return null;
    };

    const existing = pickFromCurrent();
    if (existing) return existing;

    return await new Promise((resolve, reject) => {
      // In browsers, mic permission + track publish can easily exceed 15s.
      // Wait longer so the root flow behaves like the `livekit-agent` example.
      const timeout = setTimeout(() => {
        cleanup();
        const known = [...this.#room.remoteParticipants.values()].map((p) => p.identity);
        reject(
          new Error(
            `Timed out waiting for microphone track subscription. Known participants: ${known.join(", ") || "(none)"}`,
          ),
        );
      }, 120000);

      const onParticipantConnected = (participant) => {
        console.log("[convai] participant connected", participant.identity);
      };

      const onTrackSubscribed = (track, publication, participant) => {
        if (this.#participantIdentity && participant.identity !== this.#participantIdentity) return;
        if (publication.source !== TrackSource.SOURCE_MICROPHONE) return;
        cleanup();
        resolve(track);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.#room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
        this.#room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      };

      this.#room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
      this.#room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    });
  }

  stop() {
    this.#room.off(RoomEvent.DataReceived, this.#onDataReceived);
    this.#micSuppressUplink = false;
    this.#uplinkAbort = true;
    this.#finishAgentStream();
    this.#upResampler?.close();
    this.#upResampler = null;
    this.#downResampler?.close();
    this.#downResampler = null;
    try {
      this.#ws?.close();
    } catch {
      /* ignore */
    }
    this.#ws = null;
  }

  sendUserMessage(text) {
    if (!text?.trim()) return;
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      console.log("[convai] sendUserMessage dropped (socket not open)");
      return;
    }
    this.#ws.send(JSON.stringify({ type: "user_message", text: text.trim() }));
    console.log("[convai] user_message sent");
  }
}

