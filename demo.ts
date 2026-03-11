import type { RoomOptions, ChatMessage, TranscriptionSegment } from 'livekit-client';
import {
  DisconnectReason,
  Participant,
  ParticipantEvent,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  TrackPublication,
  VideoPresets,
  isLocalParticipant,
  setLogLevel,
  LogLevel,
} from 'livekit-client';

setLogLevel(LogLevel.info);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const BEY_API_URL = 'https://api.bey.dev/v1/calls';
const BEY_AGENTS_URL = 'https://api.bey.dev/v1/agents';
const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
const BEY_API_KEY = (env.VITE_BEY_API_KEY ?? '').trim();
const BEY_AGENT_ID = (env.VITE_BEY_AGENT_ID ?? '').trim();
const CALL_CONNECTED_STORAGE_KEY = 'bey.callConnected';
const CHAT_CHANNEL_NAME = 'bey.chat.sync';
const MATCHED_USER_NAME_STORAGE_KEY = 'matchedUserName';
const MATCHED_WEBHOOK_VARIABLES_STORAGE_KEY = 'matchedWebhookVariables';

interface BeyCallResponse {
  id: string;
  agent_id: string;
  tags: Record<string, unknown>;
  started_at: string;
  ended_at: string | null;
  livekit_url: string;
  livekit_token: string;
}

type ChatEntry = { from: string; message: string; timestamp: number };
type CallStartPayload = {
  agent_id: string;
  livekit_username?: string;
  tags?: Record<string, unknown>;
  conversation_initiation_data?: {
    variables: Record<string, unknown>;
  };
};
type ConversationPhase =
  | 'idle'
  | 'awaiting_yes'
  | 'collecting_details'
  | 'details_captured'
  | 'awaiting_confirmation'
  | 'completed';

type CrossPageMessage =
  | { type: 'call-connected' }
  | { type: 'call-disconnected' }
  | { type: 'chat-outbound'; message: string }
  | { type: 'chat-inbound'; from: string; message: string }
  | { type: 'stop-call' }
  | { type: 'chat-history-request' }
  | { type: 'chat-history-response'; messages: ChatEntry[] };

let currentRoom: Room | undefined;

const state = {
  chatMessages: [] as ChatEntry[],
};
const processedTranscriptionSegmentIds = new Set<string>();
const processedInboundTexts = new Set<string>();
type ChatView = 'card-selection' | 'details' | 'selected-card';
let currentChatView: ChatView | null = null;
type UiStep = 'idle' | 'card-selection' | 'details' | 'awaiting-final-cards' | 'cards';
let uiStep: UiStep = 'idle';
let awaitingBestCardConfirmation = false;
let pendingDetailQuestionIndex: number | null = null;
const answeredDetailQuestionIndexes = new Set<number>();
let hasSentSingleSentenceDetailsGuidance = false;
let hasSentSingleSentenceDetailsCorrection = false;
let conversationPhase: ConversationPhase = 'idle';
let flowStopped = false;
let autoFlowTriggered = false;
let hasEvaStartedTalking = false;
let hasEvaSpokenOnCallPage = false;

function getStoredMatchedVariables() {
  const fallbackName = localStorage.getItem(MATCHED_USER_NAME_STORAGE_KEY)?.trim();
  const queryParams = new URLSearchParams(window.location.search);
  const queryVariables: Record<string, unknown> = {};
  queryParams.forEach((value, key) => {
    queryVariables[key] = value;
  });
  const raw = localStorage.getItem(MATCHED_WEBHOOK_VARIABLES_STORAGE_KEY);
  let parsed: Record<string, unknown> = {};

  if (raw) {
    try {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      appendLog('[CALL] matchedWebhookVariables is not valid JSON, using fallback values');
    }
  }

  const merged: Record<string, unknown> = {
    ...parsed,
    ...queryVariables,
  };

  const readStringValue = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (
      value &&
      typeof value === 'object' &&
      'value' in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).value === 'string'
    ) {
      const nested = ((value as Record<string, unknown>).value as string).trim();
      if (nested) return nested;
    }
    return '';
  };

  const preferredNameKeys = ['name', 'user_name', 'userName', 'full_name', 'customer_name'];
  const nameFromKnownKeys = preferredNameKeys
    .map((key) => readStringValue(merged[key]))
    .find((value) => Boolean(value));

  const lowerCaseNameMatch = Object.entries(merged).find(([key, value]) =>
    key.toLowerCase().includes('name') && Boolean(readStringValue(value))
  );

  const nameFromPayload =
    nameFromKnownKeys ||
    (lowerCaseNameMatch ? readStringValue(lowerCaseNameMatch[1]) : '') ||
    fallbackName ||
    '';

  if (nameFromPayload) {
    merged.name = nameFromPayload;
    merged.user_name = nameFromPayload;
    merged.userName = nameFromPayload;
  }

  if (nameFromPayload) {
    localStorage.setItem(MATCHED_USER_NAME_STORAGE_KEY, nameFromPayload);
  }

  return { variables: merged, userName: nameFromPayload };
}

async function updateAgentGreetingForName(userName: string) {
  if (!userName) return;
  try {
    const response = await fetch(`${BEY_AGENTS_URL}/${BEY_AGENT_ID}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': BEY_API_KEY,
      },
      body: JSON.stringify({
        greeting: `Hi ${userName}! I'm Eva! Your all New AI Assistant. How may I help you today?`,
      }),
    });
    if (!response.ok) {
      const errorData = await response.text();
      appendLog(`[CALL] Failed to update greeting: ${response.status} - ${errorData}`);
    } else {
      appendLog(`[CALL] Updated greeting with name: ${userName}`);
    }
  } catch (error: any) {
    appendLog(`[CALL] Greeting update failed: ${error?.message ?? 'unknown error'}`);
  }
}

const appActions = {
  startCall: async () => {
    if (!BEY_API_KEY || !BEY_AGENT_ID) {
      showStatus(
        'error',
        'Missing environment variables. Set VITE_BEY_API_KEY and VITE_BEY_AGENT_ID in .env and restart the dev server.'
      );
      return;
    }

    try {
      setButtonDisabled('start-call-button', true);
      setCallPageConnectedClass(true);
      showStatus('info', 'Starting call...');
      appendLog('Creating new call session...');
      const { variables, userName } = getStoredMatchedVariables();
      const hasVariables = Object.keys(variables).length > 0;
      const payload: CallStartPayload = {
        agent_id: BEY_AGENT_ID,
      };

      if (userName) {
        await updateAgentGreetingForName(userName);
        payload.livekit_username = userName;
      }

      if (hasVariables) {
        payload.tags = {
          ...variables,
          ...(userName ? { name: userName, user_name: userName, userName } : {}),
        };
        payload.conversation_initiation_data = { variables };
        (payload as Record<string, unknown>).variables = variables;
        (payload as Record<string, unknown>).metadata = variables;
      }

      appendLog(
        `[CALL] Starting call with ${hasVariables ? `${Object.keys(variables).length} webhook variable(s)` : 'no webhook variables'}`
      );

      const response = await fetch(BEY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': BEY_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`API request failed: ${response.status} - ${errorData}`);
      }

      const callData: BeyCallResponse = await response.json();

      appendLog(`Call created: ${callData.id}`);
      appendLog(`Connecting to room...`);

      await connectToLiveKit(callData.livekit_url, callData.livekit_token);
      setCallConnectedState(true);
      postCrossPageMessage({ type: 'call-connected' });

      showStatus('success', `Connected! Call ID: ${callData.id}`);
      setButtonsForState(true);
    } catch (error: any) {
      appendLog(`Error: ${error.message}`);
      showStatus('error', `Failed to start call: ${error.message}`);
      setCallPageConnectedClass(false);
      setButtonDisabled('start-call-button', false);
    }
  },

  toggleAudio: async () => {
    if (!currentRoom) return;
    const enabled = currentRoom.localParticipant.isMicrophoneEnabled;
    setButtonDisabled('toggle-audio-button', true);

    try {
      await currentRoom.localParticipant.setMicrophoneEnabled(!enabled);
      appendLog(`Microphone ${!enabled ? 'enabled' : 'disabled'}`);
      updateButtonsForPublishState();
    } catch (error: any) {
      appendLog(`Error toggling audio: ${error.message}`);
    }

    setButtonDisabled('toggle-audio-button', false);
  },

  toggleVideo: async () => {
    if (!currentRoom) return;
    const enabled = currentRoom.localParticipant.isCameraEnabled;
    setButtonDisabled('toggle-video-button', true);

    try {
      await currentRoom.localParticipant.setCameraEnabled(!enabled);
      appendLog(`Camera ${!enabled ? 'enabled' : 'disabled'}`);
      renderParticipant(currentRoom.localParticipant);
      updateButtonsForPublishState();
    } catch (error: any) {
      appendLog(`Error toggling video: ${error.message}`);
    }

    setButtonDisabled('toggle-video-button', false);
  },

  handleDeviceSelected: async (e: Event) => {
    const deviceId = (e.target as HTMLSelectElement).value;
    const elementId = (e.target as HTMLSelectElement).id;

    if (!currentRoom) return;

    let kind: MediaDeviceKind;
    if (elementId === 'video-input') {
      kind = 'videoinput';
    } else if (elementId === 'audio-input') {
      kind = 'audioinput';
    } else if (elementId === 'audio-output') {
      kind = 'audiooutput';
    } else {
      return;
    }

    await currentRoom.switchActiveDevice(kind, deviceId);
    appendLog(`Switched ${kind} to device: ${deviceId}`);
  },

  sendMessage: () => {
    const textField = document.getElementById('entry') as HTMLInputElement | null;
    if (!textField) return;
    const message = textField.value.trim();
    if (!message) return;
    const normalized = message.toLowerCase().replace(/\s+/g, ' ');
    if (normalized.includes('i want to apply for a forex card') || (normalized.includes('forex card') && /apply|want|need|get|interested/.test(normalized))) {
      document.querySelector('.main-container')?.classList.add('active');
    }
    updateChatBackgroundForUserMessage(message);

    if (currentRoom) {
      currentRoom.localParticipant.sendText(message, { topic: 'lk.chat' });
      addChatMessage('You', message);
      textField.value = '';
      appendLog(`Sent message: ${message}`);
      return;
    }

    if (isChatPage() && isCallConnected()) {
      postCrossPageMessage({ type: 'chat-outbound', message });
      addChatMessage('You', message);
      textField.value = '';
      appendLog(`Forwarded message to call page: ${message}`);
    }
  },

  disconnect: () => {
    if (currentRoom) {
      appendLog('Disconnecting from call...');
      currentRoom.disconnect();
      currentRoom = undefined;
      setCallConnectedState(false);
      setCallPageConnectedClass(false);
      postCrossPageMessage({ type: 'call-disconnected' });
      setButtonsForState(false);
      showStatus('info', 'Call ended');
      clearParticipants();
    }
  },
};

async function connectToLiveKit(url: string, token: string): Promise<void> {
  const roomOptions: RoomOptions = {
    adaptiveStream: true,
    dynacast: true,
    publishDefaults: {
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      videoCodec: 'vp8',
    },
    videoCaptureDefaults: {
      resolution: VideoPresets.h720.resolution,
    },
  };

  const room = new Room(roomOptions);

  room
    .on(RoomEvent.ParticipantConnected, participantConnected)
    .on(RoomEvent.ParticipantDisconnected, participantDisconnected)
    .on(RoomEvent.ChatMessage, handleChatMessage)
    .on(RoomEvent.TranscriptionReceived, handleTranscriptionReceived)
    .on(RoomEvent.DataReceived, handleDataReceived)
    .on(RoomEvent.Disconnected, handleRoomDisconnect)
    .on(RoomEvent.Reconnecting, () => appendLog('Reconnecting...'))
    .on(RoomEvent.Reconnected, () => appendLog('Reconnected successfully'))
    .on(RoomEvent.LocalTrackPublished, () => {
      renderParticipant(room.localParticipant);
    })
    .on(RoomEvent.LocalTrackUnpublished, () => {
      renderParticipant(room.localParticipant);
    })
    .on(RoomEvent.TrackSubscribed, (_, __, participant) => {
      appendLog(`Subscribed to track from ${participant.identity}`);
      renderParticipant(participant);
    })
    .on(RoomEvent.TrackUnsubscribed, (_, __, participant) => {
      renderParticipant(participant);
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (room.canPlaybackAudio) {
        appendLog('Audio playback enabled');
      } else {
        appendLog('Audio playback blocked - user interaction required');
      }
    });

  try {
    await room.connect(url, token);

    currentRoom = room;
    (window as any).currentRoom = room;

    appendLog(`Connected to room: ${room.name}`);

    await room.localParticipant.setMicrophoneEnabled(true);
    appendLog('Microphone enabled (Eva can hear you)');

    room.remoteParticipants.forEach((participant) => {
      participantConnected(participant);
    });
    participantConnected(room.localParticipant);
    updateButtonsForPublishState();

    await room.startAudio();
    appendLog('Started audio playback');
  } catch (error: any) {
    appendLog(`Failed to connect: ${error.message}`);
    throw error;
  }
}
function participantConnected(participant: Participant) {
  appendLog(`Participant connected: ${participant.identity}`);
  participant
    .on(ParticipantEvent.TrackMuted, (_: TrackPublication) => {
      appendLog(`Track muted: ${participant.identity}`);
      renderParticipant(participant);
    })
    .on(ParticipantEvent.TrackUnmuted, (_: TrackPublication) => {
      appendLog(`Track unmuted: ${participant.identity}`);
      renderParticipant(participant);
    })
    .on(ParticipantEvent.IsSpeakingChanged, () => {
      renderParticipant(participant);
    });

  renderParticipant(participant);
}

function participantDisconnected(participant: RemoteParticipant) {
  appendLog(`Participant disconnected: ${participant.identity}`);
  renderParticipant(participant, true);
}

function handleRoomDisconnect(reason?: DisconnectReason) {
  appendLog(`Disconnected from room. Reason: ${reason}`);
  setButtonsForState(false);
  clearParticipants();
  currentRoom = undefined;
  setCallConnectedState(false);
  setCallPageConnectedClass(false);
  postCrossPageMessage({ type: 'call-disconnected' });
}

function handleChatMessage(msg: ChatMessage, participant?: Participant) {
  const from = participant?.identity || 'Unknown';
  addChatMessage(from, msg.message);
  postCrossPageMessage({ type: 'chat-inbound', from, message: msg.message });
  if (isChatPage()) {
    if (isLikelyUserSpeaker(from)) {
      updateChatBackgroundForUserMessage(msg.message);
    } else {
      updateChatBackgroundForEvaMessage(from, msg.message);
    }
  }
  appendLog(`Chat message from ${from}: ${msg.message}`);
}

function handleTranscriptionReceived(
  segments: TranscriptionSegment[],
  participant?: Participant,
) {
  const localTranscript = participant ? isLocalParticipant(participant) : false;

  const finalizedText = segments
    .filter((segment) => {
      if (!segment.final || !segment.text.trim()) return false;
      if (processedTranscriptionSegmentIds.has(segment.id)) return false;
      processedTranscriptionSegmentIds.add(segment.id);
      return true;
    })
    .map((segment) => segment.text.trim())
    .join(' ')
    .trim();

  if (!finalizedText) return;

  const from = localTranscript ? 'You' : participant?.identity || 'Unknown';
  addChatMessage(from, finalizedText);
  postCrossPageMessage({ type: 'chat-inbound', from, message: finalizedText });
  if (isChatPage()) {
    if (localTranscript) {
      updateChatBackgroundForUserMessage(finalizedText);
    } else {
      updateChatBackgroundForEvaMessage(from, finalizedText);
    }
  }
  appendLog(`Transcription from ${from}: ${finalizedText}`);
}

function handleDataReceived(
  payload: Uint8Array,
  participant?: Participant,
  _kind?: unknown,
  _topic?: string,
) {
  if (participant && isLocalParticipant(participant)) return;

  const decoded = new TextDecoder().decode(payload).trim();
  if (!decoded) return;

  const from = participant?.identity || 'Unknown';
  handleInboundAssistantText(from, decoded, 'data');

  try {
    const parsed = JSON.parse(decoded) as unknown;
    const texts = extractTextCandidates(parsed);
    texts.forEach((text) => handleInboundAssistantText(from, text, 'data-json'));
  } catch {
    // ignore non-json payload
  }
}

function extractTextCandidates(value: unknown): string[] {
  const result: string[] = [];

  const walk = (node: unknown) => {
    if (!node) return;

    if (typeof node === 'string') {
      const text = node.trim();
      if (text.length >= 6) result.push(text);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      ['text', 'message', 'content', 'transcript', 'utterance'].forEach((key) => walk(obj[key]));
      walk(obj.segments);
      walk(obj.messages);
    }
  };

  walk(value);
  return result;
}

function handleInboundAssistantText(from: string, text: string, source: string) {
  const cleaned = text.trim();
  if (!cleaned) return;

  const dedupeKey = `${normalizeMessage(from)}::${normalizeMessage(cleaned)}`;
  if (processedInboundTexts.has(dedupeKey)) return;
  processedInboundTexts.add(dedupeKey);

  addChatMessage(from, cleaned);
  postCrossPageMessage({ type: 'chat-inbound', from, message: cleaned });
  if (isChatPage()) {
    if (isLikelyUserSpeaker(from)) {
      updateChatBackgroundForUserMessage(cleaned);
    } else {
      updateChatBackgroundForEvaMessage(from, cleaned);
    }
  }
  appendLog(`Inbound ${source} from ${from}: ${cleaned}`);
}

// UI Helper Functions
function showStatus(type: 'success' | 'error' | 'info', message: string) {
  const statusEl = document.getElementById('status-message') as HTMLElement | null;
  if (!statusEl) return;
  statusEl.style.display = 'block';
  statusEl.className = `alert alert-${type === 'error' ? 'danger' : type === 'success' ? 'success' : 'info'}`;
  statusEl.textContent = message;

  if (type === 'success' || type === 'info') {
    setTimeout(() => {
      statusEl.style.display = 'none';
    }, 5000);
  }
}

function appendLog(message: string) {
  console.log(`[Bey API] ${message}`);
}

/** Extract displayable text from message - filters system JSON, extracts from agent JSON */
function extractDisplayMessage(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().includes('trigger background image')) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === 'stv_metrics') return null;
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      }
      return null;
    } catch {
      return null;
    }
  }
  return trimmed;
}

function addChatMessage(from: string, message: string) {
  const displayMsg = extractDisplayMessage(message);
  if (displayMsg === null) {
    appendLog(`[CHAT] Filtered from UI: "${message.slice(0, 60)}..."`);
    return;
  }

  const last = state.chatMessages[state.chatMessages.length - 1];
  if (last && last.from === from && last.message === displayMsg) {
    return;
  }

  state.chatMessages.push({ from, message: displayMsg, timestamp: Date.now() });
  if (isLikelyUserSpeaker(from)) {
    (window as any).__orbUserSpeaking = true;
    const prevTimer = (window as any).__orbUserSpeakingTimer;
    if (prevTimer) clearTimeout(prevTimer);
    (window as any).__orbUserSpeakingTimer = setTimeout(() => {
      (window as any).__orbUserSpeaking = false;
      updateOrbBlobFromState();
    }, 4000);
    updateOrbBlobFromState();
  }
  const transcriptText = state.chatMessages
    .map((msg) => `${msg.from}: ${msg.message}`)
    .join('\n');
  const chatEl = document.getElementById('chat') as HTMLTextAreaElement | null;
  if (chatEl) {
    chatEl.value = transcriptText;
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  const dateTextEl = document.getElementById('transcription-display');
  if (dateTextEl && isLikelyUserSpeaker(from)) {
    dateTextEl.textContent = displayMsg;
  }
}

function setButtonDisabled(buttonId: string, disabled: boolean) {
  const el = $(buttonId) as HTMLButtonElement;
  if (el) el.disabled = disabled;
}

function updateButtonText(buttonId: string, text: string) {
  const el = $(buttonId) as HTMLButtonElement;
  if (el) el.textContent = text;
}

function setButtonsForState(connected: boolean) {
  const connectedButtons = ['toggle-audio-button', 'toggle-video-button', 'disconnect-button', 'send-button', 'entry'];
  const disconnectedButtons = ['start-call-button'];
  const deviceSelects = ['video-input', 'audio-input', 'audio-output'];

  if (connected) {
    connectedButtons.forEach((id) => {
      const el = $(id);
      if (el) el.removeAttribute('disabled');
    });
    disconnectedButtons.forEach((id) => {
      const el = $(id);
      if (el) el.setAttribute('disabled', 'true');
    });
    deviceSelects.forEach((id) => {
      const el = $(id);
      if (el) el.removeAttribute('disabled');
    });
    handleDevicesChanged();
  } else {
    connectedButtons.forEach((id) => {
      const el = $(id);
      if (el) el.setAttribute('disabled', 'true');
    });
    disconnectedButtons.forEach((id) => {
      const el = $(id);
      if (el) el.removeAttribute('disabled');
    });
    deviceSelects.forEach((id) => {
      const el = $(id);
      if (el) el.setAttribute('disabled', 'true');
    });
  }
}

function updateButtonsForPublishState() {
  if (!currentRoom) return;

  const lp = currentRoom.localParticipant;

  updateButtonText(
    'toggle-video-button',
    lp.isCameraEnabled ? 'Disable Camera' : 'Enable Camera'
  );

  updateButtonText(
    'toggle-audio-button',
    lp.isMicrophoneEnabled ? 'Disable Mic' : 'Enable Mic'
  );
}

async function handleDevicesChanged() {
  const kinds: MediaDeviceKind[] = ['videoinput', 'audioinput', 'audiooutput'];
  const ids = ['video-input', 'audio-input', 'audio-output'];

  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const elementId = ids[i];
    const devices = await Room.getLocalDevices(kind);
    const element = $(elementId) as HTMLSelectElement;
    if (element) {
      populateSelect(element, devices);
    }
  }
}

function populateSelect(element: HTMLSelectElement, devices: MediaDeviceInfo[]) {
  element.innerHTML = '';

  for (const device of devices) {
    const option = document.createElement('option');
    option.text = device.label || `${device.kind} (${device.deviceId.slice(0, 8)})`;
    option.value = device.deviceId;
    element.appendChild(option);
  }
}

function renderParticipant(participant: Participant, remove: boolean = false) {
  const container = $('participants-area');
  if (!container) return;

  const isAgent = participant.identity === 'avatar_worker';
  const isLocal = isLocalParticipant(participant);

  if (isLocal) {
    if (remove) {
      const div = container.querySelector(`#participant-${participant.identity}`);
      if (div) div.remove();
    }
    return;
  }

  if (!isAgent && isCallPage()) {
    return;
  }

  const cameraPub = participant.getTrackPublication(Track.Source.Camera);
  const hasVideo = cameraPub && cameraPub.isSubscribed && !cameraPub.isMuted;

  if (!hasVideo) {
    const existingDiv = container.querySelector(`#participant-${participant.identity}`);
    if (existingDiv) existingDiv.remove();
    return;
  }

  const { identity } = participant;
  const useChromaEva = isChatPage() && isAgent;

  if (remove) {
    if (useChromaEva) {
      const chromaSource = document.getElementById('eva-chroma-source') as HTMLVideoElement;
      if (chromaSource?.srcObject) {
        (chromaSource.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
        chromaSource.srcObject = null;
      }
      (window as any).stopEvaChromaProcess?.();
      if (isAgent) {
        document.body.classList.remove('eva-speaking');
        hasEvaSpokenOnCallPage = false;
      }
    } else {
      const div = container.querySelector(`#participant-${identity}`);
      if (div) div.remove();
      if (isCallPage() && isAgent && participant.identity === 'avatar_worker') {
        document.body.classList.remove('eva-speaking');
        hasEvaSpokenOnCallPage = false;
      }
    }
    return;
  }

  if (useChromaEva) {
    const chromaSource = document.getElementById('eva-chroma-source') as HTMLVideoElement;
    const chromaAudio = document.getElementById('eva-chroma-audio') as HTMLAudioElement;
    if (chromaSource && cameraPub?.videoTrack) {
      cameraPub.videoTrack.attach(chromaSource);
      chromaSource.play?.();
      (window as any).startEvaChromaProcess?.();
    }
    const micPub = participant.getTrackPublication(Track.Source.Microphone);
    const micEnabled = micPub && micPub.isSubscribed && !micPub.isMuted;
    if (chromaAudio && micEnabled && micPub?.audioTrack) {
      micPub.audioTrack.attach(chromaAudio);
      chromaAudio.volume = 1;
      chromaAudio.muted = false;
      chromaAudio.play().catch((e) => {
        appendLog(`[AUDIO] Eva agent playback blocked: ${e?.message ?? e}. User interaction may be required.`);
      });
    }
    if (participant.isSpeaking && isAgent) {
      if (!hasEvaSpokenOnCallPage) {
        hasEvaSpokenOnCallPage = true;
        document.body.classList.add('eva-speaking');
        appendLog('[CALL] Eva started speaking - hiding background image');
      }
      updateOrbBlobFromState();
    } else if (isAgent) {
      document.body.classList.remove('eva-speaking');
      hasEvaSpokenOnCallPage = false;
      updateOrbBlobFromState();
    }
    return;
  }

  let div = container.querySelector(`#participant-${identity}`) as HTMLDivElement;

  if (!div) {
    div = document.createElement('div');
    div.id = `participant-${identity}`;
    div.className = 'participant';
    div.innerHTML = `
      <video id="video-${identity}" autoplay playsinline></video>
      <audio id="audio-${identity}" autoplay></audio>
      <div class="info-bar">
        <div id="name-${identity}" class="name"></div>
        <div class="right">
          <span id="mic-${identity}"></span>
        </div>
      </div>
    `;
    container.appendChild(div);
  }

  const videoElm = container.querySelector(`#video-${identity}`) as HTMLVideoElement;
  const audioElm = container.querySelector(`#audio-${identity}`) as HTMLAudioElement;
  const nameElm = container.querySelector(`#name-${identity}`);
  const micElm = container.querySelector(`#mic-${identity}`);

  if (nameElm) {
    nameElm.innerHTML = isLocal ? 'You' : 'Agent';
  }

  if (hasVideo) {
    if (isLocal) {
      videoElm.style.transform = 'scale(-1, 1)';
    }
    cameraPub?.videoTrack?.attach(videoElm);
  } else {
    if (cameraPub?.videoTrack) {
      cameraPub.videoTrack.detach(videoElm);
    }
    videoElm.src = '';
    videoElm.srcObject = null;
  }

  const micPub = participant.getTrackPublication(Track.Source.Microphone);
  const micEnabled = micPub && micPub.isSubscribed && !micPub.isMuted;

  if (micEnabled && !isLocal) {
    micPub?.audioTrack?.attach(audioElm);
  }

  if (micElm) {
    micElm.innerHTML = micEnabled ? '🎤' : '🔇';
  }

  if (participant.isSpeaking) {
    div.classList.add('speaking');
    if (isCallPage() && isAgent && !hasEvaSpokenOnCallPage) {
      hasEvaSpokenOnCallPage = true;
      document.body.classList.add('eva-speaking');
      appendLog('[CALL] Eva started speaking - hiding background image');
    }
    updateOrbBlobFromState();
  } else {
    div.classList.remove('speaking');
    if (isAgent) {
      document.body.classList.remove('eva-speaking');
      hasEvaSpokenOnCallPage = false;
      updateOrbBlobFromState();
    }
  }
}

function clearParticipants() {
  const container = $('participants-area');
  if (container) {
    if (isChatPage()) {
      container.querySelectorAll('.participant').forEach((el) => el.remove());
      const chromaSource = document.getElementById('eva-chroma-source') as HTMLVideoElement;
      if (chromaSource?.srcObject) {
        (chromaSource.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
        chromaSource.srcObject = null;
      }
      (window as any).stopEvaChromaProcess?.();
    } else {
      container.innerHTML = '';
    }
  }
  processedTranscriptionSegmentIds.clear();
  processedInboundTexts.clear();
  currentChatView = null;
  uiStep = 'idle';
  awaitingBestCardConfirmation = false;
  pendingDetailQuestionIndex = null;
  answeredDetailQuestionIndexes.clear();
  hasSentSingleSentenceDetailsGuidance = false;
  hasSentSingleSentenceDetailsCorrection = false;
  conversationPhase = 'idle';
  flowStopped = false;
  autoFlowTriggered = false;
  hasEvaStartedTalking = false;
  hasEvaSpokenOnCallPage = false;
  document.body.classList.remove('eva-speaking');
  const orbUserTimer = (window as any).__orbUserSpeakingTimer;
  if (orbUserTimer) {
    clearTimeout(orbUserTimer);
    (window as any).__orbUserSpeakingTimer = null;
  }
  (window as any).__orbUserSpeaking = false;
  state.chatMessages = [];
  setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
  resetChatContainerViews();
  const chatEl = $('chat') as HTMLTextAreaElement;
  if (chatEl) chatEl.value = '';
  updateOrbBlobFromState();
}

const chatChannel = typeof BroadcastChannel === 'undefined'
  ? null
  : new BroadcastChannel(CHAT_CHANNEL_NAME);

function postCrossPageMessage(message: CrossPageMessage) {
  chatChannel?.postMessage(message);
}

function setCallConnectedState(connected: boolean) {
  localStorage.setItem(CALL_CONNECTED_STORAGE_KEY, connected ? '1' : '0');
}

function isCallConnected() {
  return localStorage.getItem(CALL_CONNECTED_STORAGE_KEY) === '1';
}

function isChatPage() {
  const p = window.location.pathname.replace(/\/$/, '') || '/';
  return p.endsWith('/chat') || p.endsWith('/chat.html');
}

function isCallPage() {
  return !isChatPage();
}

type OrbBlobState = 'listening' | 'answering' | 'static';

function setOrbBlobState(state: OrbBlobState) {
  if (!isChatPage()) return;
  const el = document.getElementById('orb-blob') as HTMLImageElement | null;
  if (!el) return;
  const gifs: Record<OrbBlobState, string> = {
    'listening': '/ui/blob-listening.gif',
    'answering': '/ui/blob-answering.gif',
    'static': '/ui/blob-static.gif',
  };
  const target = gifs[state];
  if (el.src && el.src.split('/').pop() === target.split('/').pop()) return;
  el.src = target;
  el.alt = state.charAt(0).toUpperCase() + state.slice(1);
}

function updateOrbBlobFromState() {
  if (!isChatPage()) return;
  if (!isCallConnected()) {
    setOrbBlobState('static');
    return;
  }
  if (document.body.classList.contains('eva-speaking')) {
    setOrbBlobState('static');
    return;
  }
  if ((window as any).__orbUserSpeaking) {
    setOrbBlobState('answering');
    return;
  }
  setOrbBlobState('listening');
  const dateTextEl = document.getElementById('transcription-display');
  if (dateTextEl) dateTextEl.textContent = 'Listening...';
}

function normalizeMessage(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyEvaSpeaker(from: string) {
  if (isLikelyUserSpeaker(from)) return false;

  const normalizedFrom = normalizeMessage(from);
  if (!normalizedFrom) return true;

  // Treat most non-user inbound speakers as EVA/assistant.
  return true;
}

function isLikelyUserSpeaker(from: string) {
  const normalizedFrom = normalizeMessage(from);
  return (
    normalizedFrom === 'you' ||
    normalizedFrom === 'user' ||
    normalizedFrom.includes('local') ||
    normalizedFrom.includes('myself')
  );
}

function setDetailsAnsweredQuestions(answeredIndexes: Set<number>) {
  const cards = document.querySelectorAll('.details .card');
  cards.forEach((card, index) => {
    card.classList.toggle('active', answeredIndexes.has(index));
  });
}

function resetChatContainerViews() {
  if (!isChatPage()) return;
  const bg = document.querySelector('.bg-change') as HTMLElement | null;
  if (!bg) return;
  bg.classList.remove('view-card-selection', 'view-details', 'view-selected-card', 'bg-slide-up');
}

function setChatView(view: ChatView, forceRefresh: boolean = false) {
  if (!isChatPage()) return;
  const bg = document.querySelector('.bg-change') as HTMLElement | null;
  if (!bg) {
    appendLog('[VIEW] .bg-change element not found');
    return;
  }
  if (currentChatView === view && !forceRefresh) {
    appendLog(`[VIEW] Screen unchanged: ${view}`);
    return;
  }

  bg.classList.remove('view-card-selection', 'view-details', 'view-selected-card', 'bg-slide-up');
  void bg.offsetWidth;
  bg.classList.add(`view-${view}`);
  bg.classList.add('bg-slide-up');

  currentChatView = view;
  setChatInputBoxVisible(true);
  appendLog(`[VIEW] Showing container: ${view}`);
}

function isPositiveIntent(text: string) {
  return (
    /^(yes|yeah|yep|sure|ok|okay|confirm|please|yes tell me|go ahead)\b/.test(text) ||
    containsAny(text, [
      'yes tell me',
      'tell me',
      'sounds good',
      'please continue',
      'please go ahead',
      'i want to know',
      'show me',
      'interested',
    ])
  );
}

function isStepOneAgentPrompt(text: string) {
  return containsAny(text, [
    'sure can i help you with that',
    'sure i can help you with that',
    'certainly i can help you with that',
    'of course i can help you with that',
    'absolutely i can help you with that',
    'yes i can help you with that',
    'i can help you with that',
    'i can help with that',
    'definitely i can help you with that',
  ]);
}

/** Matches: "Sure, I can help you with that. Do you want to know the best suited card for you?" etc */
function isStepOneWithCardConsentPrompt(text: string) {
  return isStepOneAgentPrompt(text) && isBestCardConsentQuestion(text);
}

function isBestCardConsentQuestion(text: string) {
  return containsAny(text, ['best suited card for you']) &&
    containsAny(text, ['do you want', 'would you like', 'want to know']);
}

function isFinalCardAnnouncement(text: string) {
  return containsAny(text, [
    'here s the best suited card for you',
    'here is the best suited card for you',
    'best suited card for you',
  ]);
}

function getDetailQuestionIndex(text: string): number | null {
  if (containsAny(text, ['purpose of travel', 'purpose'])) return 0;
  if (containsAny(text, ['country of visit', 'country'])) return 1;
  if (containsAny(text, ['date of departure', 'travel date', 'date'])) return 2;
  if (containsAny(text, ['required currency', 'currency to transact', 'currency'])) return 3;
  return null;
}

function getNextUnansweredDetailQuestionIndex(): number | null {
  for (let i = 0; i < 4; i++) {
    if (!answeredDetailQuestionIndexes.has(i)) return i;
  }
  return null;
}

function markDetailQuestionAnswered(index: number) {
  if (index < 0 || index > 3) return;
  if (answeredDetailQuestionIndexes.has(index)) return;
  answeredDetailQuestionIndexes.add(index);
  setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
}

function requestSingleSentenceDetailsPrompt() {
  if (!isChatPage()) return;
  if (hasSentSingleSentenceDetailsGuidance) return;
  hasSentSingleSentenceDetailsGuidance = true;
  const guidanceMessage =
    'Please ask all required travel details in one sentence only: purpose of travel, country of visit, travel date, and required currency.';
  postCrossPageMessage({ type: 'chat-outbound', message: guidanceMessage });
  appendLog('[VIEW] Sent Eva guidance for single-sentence details question');
}

function requestSingleSentenceDetailsCorrection() {
  if (!isChatPage()) return;
  if (hasSentSingleSentenceDetailsCorrection) return;
  hasSentSingleSentenceDetailsCorrection = true;
  const correctionMessage =
    'Please ask these travel details in one single sentence, not as separate questions: purpose of travel, country of visit, travel date, and required currency.';
  postCrossPageMessage({ type: 'chat-outbound', message: correctionMessage });
  appendLog('[VIEW] Sent Eva correction for separate detail questions');
}

function extractDetailAnswerIndexes(text: string): number[] {
  const matched = new Set<number>();

  const hasPurpose = containsAny(text, [
    'vacation',
    'holiday',
    'family trip',
    'family vacation',
    'business',
    'work trip',
    'office trip',
    'study',
    'education',
    'college',
    'university',
    'medical',
    'treatment',
    'tourism',
    'leisure',
    'honeymoon',
    'conference',
    'visit family',
    'visiting family',
  ]);
  if (hasPurpose) matched.add(0);

  const hasCountry =
    /\b(to|for)\s+(usa|us|united states|uk|united kingdom|uae|singapore|canada|australia|japan|france|germany|italy|spain|dubai|thailand|malaysia|europe)\b/.test(text) ||
    containsAny(text, [
      'country is',
      'country will be',
      'country of visit',
      'travelling to',
      'traveling to',
      'going to',
    ]);
  if (hasCountry) matched.add(1);

  const hasDate =
    /\b\d{1,2}[\/-]\d{1,2}([\/-]\d{2,4})?\b/.test(text) ||
    /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/.test(text) ||
    containsAny(text, ['travel date', 'departure date', 'date is', 'tomorrow', 'next week', 'next month']);
  if (hasDate) matched.add(2);

  const hasCurrency =
    /\b(inr|usd|eur|gbp|aed|cad|aud|jpy|sgd|chf|cny|hkd)\b/.test(text) ||
    containsAny(text, [
      'currency is',
      'required currency',
      'currency to transact',
      'dollar',
      'euro',
      'pound',
      'dirham',
      'yen',
      'usd should be fine',
    ]);
  if (hasCurrency) matched.add(3);

  return Array.from(matched);
}

function setChatBackgroundImage(token: string) {
  if (!isChatPage()) {
    appendLog(`[VIEW] Skip container switch on non-chat page: ${token}`);
    return;
  }

  // Add active so .bg-change is visible (sidebar 30%, bg-change 70%)
  document.querySelector('.main-container')?.classList.add('active');

  if (token === 'card-selection') {
    setChatView('card-selection');
    return;
  }
  if (token === 'details' || token === 'details-progress') {
    setChatView('details', token === 'details-progress');
    return;
  }
  if (token === 'selected-card') {
    setChatView('selected-card');
    answeredDetailQuestionIndexes.clear();
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    return;
  }

  appendLog(`[VIEW] Unsupported mapping token: ${token}`);
}

function setChatInputBoxVisible(visible: boolean) {
  if (!isChatPage()) return;
  const inputBox = document.getElementById('chat-input-area') as HTMLElement | null;
  if (!inputBox) return;
  inputBox.classList.toggle('show', visible);
  appendLog(`[BG] Input box ${visible ? 'shown' : 'hidden'}`);
}

function containsAny(text: string, phrases: string[]) {
  return phrases.some((phrase) => text.includes(phrase));
}

function resolveUserBackgroundImage(message: string) {
  if (flowStopped) return null;
  const text = normalizeMessage(message);

  if (
    isPositiveIntent(text) &&
    (uiStep === 'card-selection' || currentChatView === 'card-selection' || awaitingBestCardConfirmation)
  ) {
    uiStep = 'details';
    awaitingBestCardConfirmation = false;
    pendingDetailQuestionIndex = null;
    answeredDetailQuestionIndexes.clear();
    hasSentSingleSentenceDetailsGuidance = false;
    hasSentSingleSentenceDetailsCorrection = false;
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    conversationPhase = 'collecting_details';
    requestSingleSentenceDetailsPrompt();
    appendLog('[VIEW] Step 2 -> details');
    return 'details';
  }

  if (uiStep === 'details') {
    const extractedIndexes = extractDetailAnswerIndexes(text);
    const indexesToMark = new Set<number>(extractedIndexes);
    if (indexesToMark.size === 0) {
      const inferredIndex = getDetailQuestionIndex(text);
      const targetIndex =
        inferredIndex ?? pendingDetailQuestionIndex ?? getNextUnansweredDetailQuestionIndex();
      if (targetIndex === null) return null;
      indexesToMark.add(targetIndex);
    }

    const beforeCount = answeredDetailQuestionIndexes.size;
    indexesToMark.forEach((index) => markDetailQuestionAnswered(index));
    pendingDetailQuestionIndex = null;
    const answerCount = answeredDetailQuestionIndexes.size;
    const matchedCardLabels = Array.from(indexesToMark)
      .map((index) => index + 1)
      .join(', ');
    appendLog(`[VIEW] Details answer captured (${answerCount}/4) at card(s) ${matchedCardLabels}`);

    if (answerCount === beforeCount) return null;
    if (answerCount < 4) {
      return 'details-progress';
    }

    uiStep = 'awaiting-final-cards';
    pendingDetailQuestionIndex = null;
    appendLog('[VIEW] Step 3 complete -> retaining details with all answers until final card announcement');
    return 'details-progress';
  }

  if (conversationPhase === 'awaiting_confirmation' && isPositiveIntent(text)) {
    conversationPhase = 'completed';
    stopConversationFlow('user confirmation received');
  }

  if (uiStep === 'idle' && containsAny(text, ['forex card', 'travel card']) && containsAny(text, ['apply', 'want', 'need', 'get', 'interested'])) {
    return 'card-selection';
  }

  return null;
}

function updateChatBackgroundForUserMessage(message: string) {
  if (!isChatPage()) return;
  if (!hasEvaStartedTalking) {
    appendLog('[BG] User-triggered background change ignored until EVA starts talking');
    return;
  }
  const image = resolveUserBackgroundImage(message);
  if (!image) return;
  appendLog(`[BG] User message -> ${image}: "${message}"`);
  setChatBackgroundImage(image);
}

function resolveEvaBackgroundImage(message: string) {
  if (flowStopped) return null;
  const text = normalizeMessage(message);

  if ((uiStep === 'idle' || uiStep === 'card-selection') && isStepOneAgentPrompt(text)) {
    uiStep = 'card-selection';
    awaitingBestCardConfirmation = false;
    pendingDetailQuestionIndex = null;
    answeredDetailQuestionIndexes.clear();
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    conversationPhase = 'awaiting_yes';
    appendLog('[VIEW] Step 1 -> card selection');
    return 'card-selection';
  }

  if (isBestCardConsentQuestion(text)) {
    awaitingBestCardConfirmation = false;
    uiStep = 'details';
    pendingDetailQuestionIndex = null;
    answeredDetailQuestionIndexes.clear();
    hasSentSingleSentenceDetailsGuidance = false;
    hasSentSingleSentenceDetailsCorrection = false;
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    conversationPhase = 'collecting_details';
    requestSingleSentenceDetailsPrompt();
    appendLog('[VIEW] Consent question received -> details');
    return 'details';
  }

  if (uiStep === 'details') {
    const questionIndex = getDetailQuestionIndex(text);
    if (questionIndex !== null && !answeredDetailQuestionIndexes.has(questionIndex)) {
      pendingDetailQuestionIndex = questionIndex;
      appendLog(`[VIEW] Pending details question set to card ${questionIndex + 1}`);
      requestSingleSentenceDetailsCorrection();
    }
  }

  if (isFinalCardAnnouncement(text)) {
    uiStep = 'cards';
    awaitingBestCardConfirmation = false;
    pendingDetailQuestionIndex = null;
    conversationPhase = 'details_captured';
    appendLog('[VIEW] Final card announcement -> selected-card');
    return 'selected-card';
  }

  return null;
}

function stopConversationFlow(reason: string) {
  if (flowStopped) return;
  flowStopped = true;
  setChatControlsEnabled(false);
  appendLog(`[BG] Flow stopped: ${reason}`);
  postCrossPageMessage({ type: 'stop-call' });
}

function updateChatBackgroundForEvaMessage(from: string, message: string) {
  if (!isLikelyEvaSpeaker(from)) {
    appendLog(`[BG] Ignored speaker: ${from}`);
    return;
  }
  hasEvaStartedTalking = true;
  const text = normalizeMessage(message);
  if (isStepOneWithCardConsentPrompt(text)) {
    document.body.classList.add('eva-speaking');
    document.querySelector('.main-container')?.classList.add('active');
  }
  updateOrbBlobFromState();
  const image = resolveEvaBackgroundImage(message);
  if (!image) {
    appendLog(`[BG] No image match for message: "${message}"`);
    return;
  }
  appendLog(`[BG] Matched message -> ${image}: "${message}"`);
  setChatBackgroundImage(image);
}

function updateChatBackgroundFromHistory(messages: ChatEntry[]) {
  if (!isChatPage()) return;

  uiStep = 'idle';
  awaitingBestCardConfirmation = false;
  pendingDetailQuestionIndex = null;
  answeredDetailQuestionIndexes.clear();
  hasSentSingleSentenceDetailsGuidance = false;
  hasSentSingleSentenceDetailsCorrection = false;
  conversationPhase = 'idle';
  flowStopped = false;
  hasEvaStartedTalking = false;
  currentChatView = null;
  setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
  resetChatContainerViews();

  for (const entry of messages) {
    let image: string | null = null;
    if (isLikelyUserSpeaker(entry.from)) {
      if (!hasEvaStartedTalking) continue;
      image = resolveUserBackgroundImage(entry.message);
    } else {
      hasEvaStartedTalking = true;
      image = resolveEvaBackgroundImage(entry.message);
    }

    if (image) {
      appendLog(`[BG] History match -> ${image}: "${entry.message}"`);
      setChatBackgroundImage(image);
    }
  }

  appendLog('[BG] History replay complete for container state');
}

function setCallPageConnectedClass(connected: boolean) {
  if (!isCallPage()) return;
  document.body.classList.toggle('call-connected', connected);
  if (!connected) {
    hasEvaSpokenOnCallPage = false;
    document.body.classList.remove('eva-speaking');
  }
}

function renderChatFromState() {
  const transcriptText = state.chatMessages
    .map((msg) => `${msg.from}: ${msg.message}`)
    .join('\n');
  const chatEl = document.getElementById('chat') as HTMLTextAreaElement | null;
  if (chatEl) {
    chatEl.value = transcriptText;
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  const dateTextEl = document.getElementById('transcription-display');
  if (dateTextEl) {
    if (isCallConnected() && !document.body.classList.contains('eva-speaking') && !(window as any).__orbUserSpeaking) {
      dateTextEl.textContent = 'Listening...';
    } else {
      const lastUser = [...state.chatMessages].reverse().find((m) => isLikelyUserSpeaker(m.from));
      dateTextEl.textContent = lastUser ? lastUser.message : '2nd July 2025';
    }
  }
}

function setChatControlsEnabled(enabled: boolean) {
  setButtonDisabled('send-button', !enabled);
  setButtonDisabled('entry', !enabled);
}

function onCrossPageMessage(message: CrossPageMessage) {
  if (message.type === 'call-connected' && isChatPage()) {
    setChatControlsEnabled(true);
    updateOrbBlobFromState();
    if (!autoFlowTriggered) {
      const kickoff = 'I want to apply for a forex card.';
      autoFlowTriggered = true;
      postCrossPageMessage({ type: 'chat-outbound', message: kickoff });
      addChatMessage('You', kickoff);
      document.querySelector('.main-container')?.classList.add('active');
      appendLog('[BG] Auto-started flow with kickoff message');
    }
    return;
  }

  if (message.type === 'call-disconnected' && isChatPage()) {
    setChatControlsEnabled(false);
    document.querySelector('.main-container')?.classList.remove('active');
    clearParticipants();
    updateOrbBlobFromState();
    return;
  }

  if (message.type === 'chat-history-request' && isCallPage()) {
    postCrossPageMessage({ type: 'chat-history-response', messages: state.chatMessages });
    return;
  }

  if (message.type === 'chat-history-response' && isChatPage()) {
    state.chatMessages = message.messages;
    renderChatFromState();
    updateChatBackgroundFromHistory(message.messages);
    return;
  }

  if (message.type === 'chat-outbound' && isCallPage() && currentRoom) {
    currentRoom.localParticipant.sendText(message.message, { topic: 'lk.chat' });
    appendLog(`Forwarded chat message: ${message.message}`);
    return;
  }

  if (message.type === 'stop-call' && isCallPage()) {
    appActions.disconnect();
    return;
  }

  if (message.type === 'chat-inbound' && isChatPage()) {
    if (isLikelyUserSpeaker(message.from)) {
      updateChatBackgroundForUserMessage(message.message);
    } else {
      updateChatBackgroundForEvaMessage(message.from, message.message);
    }
    addChatMessage(message.from, message.message);
  }
}

function tryUnlockEvaAudio() {
  const chromaAudio = document.getElementById('eva-chroma-audio') as HTMLAudioElement;
  if (chromaAudio?.srcObject && chromaAudio.paused) {
    chromaAudio.play().catch(() => {});
  }
}

function initializePageBehavior() {
  chatChannel?.addEventListener('message', (event: MessageEvent<CrossPageMessage>) => {
    onCrossPageMessage(event.data);
  });

  if (isChatPage()) {
    document.addEventListener('click', tryUnlockEvaAudio);
    document.addEventListener('touchstart', tryUnlockEvaAudio);
    document.addEventListener('keydown', tryUnlockEvaAudio);
    updateOrbBlobFromState();
    uiStep = 'idle';
    awaitingBestCardConfirmation = false;
    pendingDetailQuestionIndex = null;
    answeredDetailQuestionIndexes.clear();
    hasSentSingleSentenceDetailsGuidance = false;
    hasSentSingleSentenceDetailsCorrection = false;
    currentChatView = null;
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    resetChatContainerViews();
    setChatInputBoxVisible(false);
    setChatControlsEnabled(isCallConnected());
    postCrossPageMessage({ type: 'chat-history-request' });
  } else {
    setCallConnectedState(false);
    setCallPageConnectedClass(false);
  }
}

(window as any).appActions = appActions;
initializePageBehavior();
