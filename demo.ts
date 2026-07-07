import type {
  RoomOptions,
  ChatMessage,
  TranscriptionSegment,
} from "livekit-client";
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
} from "livekit-client";

setLogLevel(LogLevel.info);

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const CALL_CONNECTED_STORAGE_KEY = "bey.callConnected";
const DEFAULT_CHAT_CHANNEL_NAME = "bey.chat.sync";
const MATCHED_USER_NAME_STORAGE_KEY = "matchedUserName";
const MATCHED_WEBHOOK_VARIABLES_STORAGE_KEY = "matchedWebhookVariables";
const queryParams = new URLSearchParams(window.location.search);

const pageRole =
  (window as any).DEMOPAGEROLE ?? queryParams.get("role") ?? "avatar";

const demoMode =
  (window as any).DEMOTWOTAB ?? queryParams.get("twoTab") === "1";

let sessionKey = queryParams.get("session");

if (!sessionKey) {
  sessionKey =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `session-${Date.now()}`;

  queryParams.set("session", sessionKey);

  if (!queryParams.get("role")) {
    queryParams.set("role", pageRole);
  }

  if (demoMode) {
    queryParams.set("twoTab", "1");
  }

  const newUrl = `${window.location.pathname}?${queryParams.toString()}${window.location.hash}`;
  window.history.replaceState({}, "", newUrl);
}

const CHATCHANNELNAME = `${DEFAULT_CHAT_CHANNEL_NAME}${sessionKey}`;
const JOURNEYTABPATH = `journey-screen.html?session=${encodeURIComponent(
  sessionKey,
)}&role=journey${demoMode ? "&twoTab=1" : ""}`;

interface LocalStartResponse {
  livekit_url: string;
  livekit_token: string;
  room: string;
  identity: string;
}

type ChatEntry = { from: string; message: string; timestamp: number };
type ConversationPhase =
  | "idle"
  | "awaiting_yes"
  | "collecting_details"
  | "details_captured"
  | "awaiting_confirmation"
  | "completed";

type CrossPageMessage =
  | { type: "call-connected" }
  | { type: "call-disconnected" }
  | { type: "chat-outbound"; message: string }
  | { type: "chat-inbound"; from: string; message: string }
  | { type: "stop-call" }
  | { type: "start-call-request" }
  | { type: "chat-history-request" }
  | { type: "chat-history-response"; messages: ChatEntry[] }
  | {
      type: "journey-stage";
      screen: string;
      journey?: string | null;
      reason?: string | null;
    };

let currentRoom: Room | undefined;

const state = {
  chatMessages: [] as ChatEntry[],
};
type TranscriptRuntimeStatus = "idle" | "listening" | "receiving";
let transcriptStatusResetTimer: ReturnType<typeof setTimeout> | undefined;
const processedTranscriptionSegmentIds = new Set<string>();
const processedInboundTexts = new Set<string>();
type ChatView = "card-selection" | "details" | "selected-card";
let currentChatView: ChatView | null = null;
let journeyWindowRef: Window | null = null;
let lastMirroredJourneyScreen: string | null = null;
let lastMirroredJourneyName: string | null = null;
type UiStep =
  | "idle"
  | "card-selection"
  | "details"
  | "awaiting-final-cards"
  | "cards";
let uiStep: UiStep = "idle";
let awaitingBestCardConfirmation = false;
let pendingDetailQuestionIndex: number | null = null;
const answeredDetailQuestionIndexes = new Set<number>();
let hasSentSingleSentenceDetailsGuidance = false;
let hasSentSingleSentenceDetailsCorrection = false;
let conversationPhase: ConversationPhase = "idle";
let flowStopped = false;
let autoFlowTriggered = false;
let hasEvaStartedTalking = false;
let hasEvaSpokenOnCallPage = false;
let hasShownWelcomeForexScreen = false;
let hasAskedWelcomeBestSuitedConsent = false;
let hasConfirmedWelcomeBestSuitedConsent = false;
let hasShownWelcomeDetailsScreen = false;
let hasShownAddressVerifyScreen = false;
let addressJourneyActive = false;
let addressVerifyMethodChosen: string | null = null;
let hasAskedAddressConsent = false;
let hasShownAddressConsentScreen = false;
let hasShownAddressNextScreen = false;
let hasShownAddressVerifiedSuccessScreen = false;
let awaitingEvaAddressVerifiedSuccessAnnouncement = false;
let hasShownAddressSelectScreen = false;
let awaitingEvaAddressSelectAnnouncement = false;
let hasConfirmedAddressSelectView = false;
let hasShownSelfVerifyMethodsScreen = false;
let hasShownFaceScanScreen = false;
let hasShownAddressRequestSubmittedScreen = false;
let pendingEvaRequestSubmittedCopy: string | null = null;
let welcomeFaceScanCaptureListenerBound = false;
let welcomeFaceCaptureHandled = false;
let faceScanStep9Timer: number | null = null;
const WELCOME_FACE_SCAN_TO_STEP9_MS = 1000;
const EVA_ADDRESS_REQUEST_SUBMITTED_DISPLAY =
  "Request Submitted! Your new communication address will be updated within 24 hrs. Need help with anything else?";
let isLoanJourneyInProgress = false;
let isLiveSearchInProgress = false;
/** True while the loan-blank-panel is up and we are waiting for Eva's spoken answer. */
let awaitingEvaLiveSearchPanelAnswer = false;
/** Monotonic id for live-search requests so a topic change supersedes older ones. */
let liveSearchRequestSeq = 0;

function isJourneyPage() {
  return pageRole === "journey";
}

function canRenderJourneyUi() {
  return isJourneyPage();
}

function canRenderAvatarUi() {
  return isAvatarPage();
}

function ensureJourneyTabOpen() {
  if (!demoMode || !isAvatarPage()) return;

  if (journeyWindowRef && !journeyWindowRef.closed) return;

  const url = new URL(JOURNEYTABPATH, window.location.href);
  journeyWindowRef = window.open(
    url.toString(),
    "journey-screen",
    "noopener,noreferrer",
  );

  if (!journeyWindowRef) {
    appendLog("[TwoTab] Journey window popup was blocked.");
    showStatus?.(
      "info",
      "Popup blocked. Please open the journey screen manually.",
    );
  } else {
    appendLog("[TwoTab] Journey window opened.");
  }
}

function updateJourneyPlaceholder(
  screen: string | null,
  journey: string | null,
  reason?: string | null,
) {
  if (!isJourneyPage()) return;

  lastMirroredJourneyScreen = screen;
  lastMirroredJourneyName = journey;

  const stageTitle = document.getElementById("journey-stage-title");
  const stageCopy = document.getElementById("journey-stage-copy");
  const screenChip = document.getElementById("journey-screen-chip");
  const journeyChip = document.getElementById("journey-name-chip");

  if (stageTitle) {
    stageTitle.textContent = screen
      ? screen.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
      : "Waiting for journey";
  }

  if (stageCopy) {
    stageCopy.textContent = screen
      ? `The assistant moved the user into the "${screen}" stage${journey ? ` within the "${journey}" journey` : ""}${reason ? ` (${reason})` : ""}.`
      : "Start the call in the avatar window. When the assistant enters a guided flow, this window will switch to the active journey stage.";
  }

  if (screenChip) {
    screenChip.textContent = `screen: ${screen ?? "none"}`;
  }

  if (journeyChip) {
    journeyChip.textContent = `journey: ${journey ?? "none"}`;
  }
}

// ── Withdraw-money journey state ───────────────────────────────────────────
let cashWithdrawJourneyActive = false;
let hasShownCashWithdrawScreen = false;
let hasShownCashWithdrawConsentScreen = false;
let hasShownCashWithdrawDebitSlotScreen = false;
let hasShownCashWithdrawBankDetailsScreen = false;
let hasShownOtpVerifyScreen = false;
let hasShownCashWithdrawCollectScreen = false;
let cashWithdrawAmount: number | null = null;
let cashWithdrawInsertCardCueArmed = false;
let cashWithdrawDebitSlotToBankDetailsTimer: number | null = null;
const CASH_WITHDRAW_INSERT_CARD_DELAY_MS = 3000;
const CASH_WITHDRAW_BANK_DETAILS_DEFAULT_TITLE = "Details as per Bank Records";
const CASH_WITHDRAW_BANK_DETAILS_DEFAULT_FOOTER = "Please confirm to proceed";
const CASH_WITHDRAW_BANK_DETAILS_DEFAULT_HERO =
  "/media/cash-withdraw-bank-details-hero.png";
const CASH_WITHDRAW_COLLECT_TITLE = "Please Collect Cash";
const CASH_WITHDRAW_COLLECT_FOOTER = "Remove your card from card slot";
const CASH_WITHDRAW_COLLECT_HERO = "/media/cash-withdraw-hero.png";

// ── Home-loan journey state ────────────────────────────────────────────────
let homeLoanJourneyActive = false;
let hasShownHomeLoanActiveListScreen = false;
let hasShownHomeLoanSummaryScreen = false;
let hasShownHomeLoanOtpScreen = false;
let hasShownHomeLoanPaymentReceivedScreen = false;
let hasShownHomeLoanPrepaymentAdjustedScreen = false;
let homeLoanSelection: "home" | "topup" | null = null;
let homeLoanPrepaymentAmount: number | null = null;

type HomeLoanProfile = {
  label: string;
  number: string;
  amount: number;
  emi: number;
  outstandingPrincipal: number;
  principal: number;
  prepayLimit: number;
};

const HOME_LOAN_PROFILES: Record<"home" | "topup", HomeLoanProfile> = {
  home: {
    label: "Home Loan",
    number: "*****6789",
    amount: 20000000,
    emi: 173468,
    outstandingPrincipal: 18420000,
    principal: 18500000,
    prepayLimit: 4625000,
  },
  topup: {
    label: "Top-Up Loan",
    number: "*****9876",
    amount: 3500000,
    emi: 85000,
    outstandingPrincipal: 3200000,
    principal: 3350000,
    prepayLimit: 837500,
  },
};

// ── Send-money journey state ───────────────────────────────────────────────
let sendMoneyJourneyActive = false;
let hasShownSendMoneyPayeeScreen = false;
let hasShownSendMoneyPayeeSuggestScreen = false;
let hasShownSendMoneyPayeeListScreen = false;
let hasShownSendMoneyAmountScreen = false;
let hasShownSendMoneyAccountSelectedScreen = false;
let hasShownSendMoneyWhenScreen = false;
let hasShownSendMoneyPreviewScreen = false;
let hasShownSendMoneyOtpVerifyScreen = false;
let hasShownSendMoneySuccessScreen = false;
let sendMoneyPayeeName: string | null = null;
let sendMoneyAmount: number | null = null;
let sendMoneyRemark: string | null = null;
let sendMoneyAccountType: "savings" | "current" | null = null;
let sendMoneyWhen: "pay-now" | "schedule" | null = null;
const SEND_MONEY_DEFAULT_PAYEE_NAME = "Digvijay Shelar";
const SEND_MONEY_PAYEE_LIST_PLACEHOLDER_NAMES = [
  "payee name 1",
  "payee name 2",
  "payee name 3",
];

declare global {
  interface Window {
    startFaceScanViewport?: (target: string | Element) => boolean;
    stopFaceScanViewport?: (target: string | Element) => boolean;
    initFaceScanCameras?: () => void;
  }
}

const WELCOME_DETAILS_PHRASES = [
  "lets start sum of your detals",
  "let s start sum of your detals",
  "lets start some of your details",
  "let s start some of your details",
  "provide your travel destination",
  "travel destination",
  "traval destination",
  "purpose of your trip",
  "date of travel",
  "required currency",
  "currency you ll need",
  "transaction currency",
  "country of visit",
  "purpose of travel",
  "date of departure",
];

const WELCOME_DETAILS_KICKOFF_PHRASES = [
  "lets start sum of your detals",
  "let s start sum of your detals",
  "lets start some of your details",
  "let s start some of your details",
  "let us start some of your details",
  "lets start with your details",
  "let s start with your details",
];

function getStoredMatchedVariables() {
  const fallbackName = localStorage
    .getItem(MATCHED_USER_NAME_STORAGE_KEY)
    ?.trim();
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
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      appendLog(
        "[CALL] matchedWebhookVariables is not valid JSON, using fallback values",
      );
    }
  }

  const merged: Record<string, unknown> = {
    ...parsed,
    ...queryVariables,
  };

  const readStringValue = (value: unknown) => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (
      value &&
      typeof value === "object" &&
      "value" in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).value === "string"
    ) {
      const nested = (
        (value as Record<string, unknown>).value as string
      ).trim();
      if (nested) return nested;
    }
    return "";
  };

  const preferredNameKeys = [
    "name",
    "user_name",
    "userName",
    "full_name",
    "customer_name",
  ];
  const nameFromKnownKeys = preferredNameKeys
    .map((key) => readStringValue(merged[key]))
    .find((value) => Boolean(value));

  const lowerCaseNameMatch = Object.entries(merged).find(
    ([key, value]) =>
      key.toLowerCase().includes("name") && Boolean(readStringValue(value)),
  );

  const nameFromPayload =
    nameFromKnownKeys ||
    (lowerCaseNameMatch ? readStringValue(lowerCaseNameMatch[1]) : "") ||
    fallbackName ||
    "";

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

const CONVAI_LANGUAGE_ALIASES: Record<string, string> = {
  en: "en",
  english: "en",
  hi: "hi",
  hindi: "hi",
  mr: "mr",
  marathi: "mr",
  hinglish: "hi",
};

const CONVAI_LANGUAGE_AUTO_SENTINELS = new Set([
  "auto",
  "detect",
  "automatic",
  "any",
  "multi",
  "multilingual",
]);

function normalizeConvaiLanguageCode(raw: unknown): string | null {
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;
  if (CONVAI_LANGUAGE_AUTO_SENTINELS.has(text)) return "auto";
  const token = text.split(/[-_]/)[0];
  if (CONVAI_LANGUAGE_AUTO_SENTINELS.has(token)) return "auto";
  if (CONVAI_LANGUAGE_ALIASES[token]) return CONVAI_LANGUAGE_ALIASES[token];
  if (/^[a-z]{2}$/.test(token)) return token;
  return null;
}

/**
 * Language for ElevenLabs ConvAI on connect.
 * - URL `?lang=hi` / `?lang=auto` wins
 * - Then webhook variables / browser locale
 * - Default is `"auto"` so ElevenLabs `language_detection` switches mid-call when the user
 *   speaks a different supported language.
 */
function resolveWelcomeConvaiLanguage(
  variables: Record<string, unknown>,
): string {
  const queryParams = new URLSearchParams(window.location.search);
  const fromQuery =
    queryParams.get("lang") ||
    queryParams.get("language") ||
    queryParams.get("locale");
  const fromQueryNorm = normalizeConvaiLanguageCode(fromQuery);
  if (fromQueryNorm) return fromQueryNorm;

  const readStringValue = (value: unknown) => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (
      value &&
      typeof value === "object" &&
      "value" in (value as Record<string, unknown>) &&
      typeof (value as Record<string, unknown>).value === "string"
    ) {
      return ((value as Record<string, unknown>).value as string).trim();
    }
    return "";
  };

  for (const key of ["language", "preferred_language", "locale", "lang"]) {
    const norm = normalizeConvaiLanguageCode(readStringValue(variables[key]));
    if (norm) return norm;
  }

  // We deliberately don't fall back to navigator.language — locking to the browser
  // locale would prevent mid-call auto-switching. Default to "auto" instead.
  return "auto";
}

let lastAnnouncedConvaiLanguage: string | null = null;

function handleConvaiLanguageChangePayload(payload: Record<string, unknown>) {
  const rawLanguage =
    typeof payload.language === "string" ? payload.language : "";
  const language = rawLanguage.trim().toLowerCase().split(/[-_]/)[0];
  if (!language) return;
  const rawPrevious =
    typeof payload.previous === "string" ? payload.previous : "";
  const previous = rawPrevious.trim().toLowerCase().split(/[-_]/)[0];
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  const source =
    typeof payload.source === "string" ? payload.source : "unknown";

  // Suppress duplicate broadcasts (the agent often re-emits the same code on every turn).
  if (lastAnnouncedConvaiLanguage === language && source !== "initial") {
    return;
  }
  lastAnnouncedConvaiLanguage = language;

  document.documentElement.lang = language;
  document.documentElement.dataset.convaiLanguage = language;
  document.body.dataset.convaiLanguage = language;
  if (previous) {
    document.body.dataset.convaiLanguagePrev = previous;
  }
  appendLog(
    `[ConvAI] Language ${source}: ${previous || "unknown"} → ${language}${reason ? ` (${reason})` : ""}`,
  );
  window.dispatchEvent(
    new CustomEvent("convai-language-change", {
      detail: { language, previous, reason, source },
    }),
  );
}

/**
 * Maps every canonical UI screen ID (declared in `agent/convai_pipeline.js`
 * `ConvaiPipeline.UI_SCREEN_IDS`) to the existing `showWelcome…` function that
 * actually flips the DOM. Adding a new screen?
 *   1. Add the ID to `UI_SCREEN_IDS` in `agent/convai_pipeline.js`.
 *   2. Add an entry here.
 *   3. Update the ElevenLabs agent's `ui_show_screen` tool description so the
 *      LLM knows when to call it.
 */

const AVATAR_DISPATCH: Record<string, () => void> = {};
const JOURNEY_DISPATCH: Record<string, () => void> = {
  forex: () => showWelcomeForexStage(),
  details: () => showWelcomeDetailsStage(),
  "best-card": () => showWelcomeBestCardStage(),
  "address-verify": () => showWelcomeAddressVerifyStage(),
  "address-consent": () => showWelcomeAddressConsentStage(),
  "address-next": () => showWelcomeAddressNextStage(),
  "address-verified-success": () => showWelcomeAddressVerifiedSuccessStage(),
  "address-select": () => showWelcomeAddressSelectStage(),
  "address-select-review": () => applyWelcomeAddressSelectReviewView(),
  "address-request-submitted": () => showWelcomeAddressRequestSubmittedStage(),
  "self-verify": () => showWelcomeSelfVerifyMethodsStage(),
  "face-scan": () => showWelcomeFaceScanStage({ force: true }),
  "home-loan": () => showWelcomeHomeLoanActiveListStage(),
  "home-loan-summary": () =>
    showWelcomeHomeLoanSummaryStage(homeLoanSelection ?? "home"),
  "home-loan-payment-received": () => showWelcomeHomeLoanPaymentReceivedStage(),
  "home-loan-prepayment-adjusted": () =>
    showWelcomeHomeLoanPrepaymentAdjustedStage(),
  "cash-withdraw": () => showWelcomeCashWithdrawStage(),
  "cash-withdraw-consent": () => showWelcomeCashWithdrawConsentStage(),
  "cash-withdraw-debit-slot": () => showWelcomeCashWithdrawDebitSlotStage(),
  "cash-withdraw-bank-details": () => showWelcomeCashWithdrawBankDetailsStage(),
  "otp-verify": () => {
    if (sendMoneyJourneyActive) showWelcomeSendMoneyOtpVerifyStage();
    else if (homeLoanJourneyActive) showWelcomeHomeLoanOtpVerifyStage();
    else showWelcomeOtpVerifyStage();
  },
  "cash-withdraw-collect": () =>
    showWelcomeCashWithdrawBankDetailsStage({ collectCash: true }),
  "send-money-payee": () => showWelcomeSendMoneyPayeeStage(),
  "send-money-payee-suggest": () => showWelcomeSendMoneyPayeeSuggestStage(),
  "send-money-payee-list": () => showWelcomeSendMoneyPayeeListStage(),
  "send-money-amount": () => showWelcomeSendMoneyAmountStage(),
  "send-money-account-selected": () =>
    showWelcomeSendMoneyAccountSelectedStage(),
  "send-money-when": () => showWelcomeSendMoneyWhenStage(),
  "send-money-preview": () => showWelcomeSendMoneyPreviewStage(),
  "send-money-success": () => showWelcomeSendMoneySuccessStage(),
};

/**
 * Which top-level journey owns each canonical screen. Steps within the same
 * journey can flow freely; jumping between journeys requires an explicit
 * user-driven intent from the agent (see {@link isExplicitJourneySwitchIntent}).
 *
 * Screens like `self-verify` / `face-scan` are part of the address-change flow
 * here because that's the only journey using them today. If a future journey
 * also needs face-scan, model it as a separate journey that explicitly opts
 * in via an `intent: 'user_switched_journey'` call.
 */
type JourneyId =
  | "forex"
  | "address"
  | "home-loan"
  | "cash-withdraw"
  | "send-money";

const SCREEN_TO_JOURNEY: Record<string, JourneyId> = {
  forex: "forex",
  details: "forex",
  "best-card": "forex",
  "address-verify": "address",
  "address-consent": "address",
  "address-next": "address",
  "address-verified-success": "address",
  "address-select": "address",
  "address-select-review": "address",
  "address-request-submitted": "address",
  "self-verify": "address",
  "face-scan": "address",
  "home-loan": "home-loan",
  "home-loan-summary": "home-loan",
  "home-loan-payment-received": "home-loan",
  "home-loan-prepayment-adjusted": "home-loan",
  "cash-withdraw": "cash-withdraw",
  "cash-withdraw-consent": "cash-withdraw",
  "cash-withdraw-debit-slot": "cash-withdraw",
  "cash-withdraw-bank-details": "cash-withdraw",
  "otp-verify": "cash-withdraw",
  "cash-withdraw-collect": "cash-withdraw",
  "send-money-payee": "send-money",
  "send-money-payee-suggest": "send-money",
  "send-money-payee-list": "send-money",
  "send-money-amount": "send-money",
  "send-money-account-selected": "send-money",
  "send-money-when": "send-money",
  "send-money-preview": "send-money",
  "send-money-success": "send-money",
};

/**
 * A journey is treated as "complete" once any of these terminal screens has
 * been reached. After completion the user is free to start a different
 * journey without an explicit switch intent.
 */
const JOURNEY_TERMINAL_SCREENS: Record<JourneyId, ReadonlySet<string>> = {
  forex: new Set(["best-card"]),
  address: new Set(["address-request-submitted", "face-scan"]),
  "home-loan": new Set(["home-loan-prepayment-adjusted"]),
  "cash-withdraw": new Set(["cash-withdraw-collect"]),
  "send-money": new Set(["send-money-success"]),
};

/**
 * Phrases the agent can put in the `intent` parameter to declare that the user
 * explicitly switched journeys (e.g. "actually, I want a loan instead").
 * Anything else is treated as an unsolicited drift and is blocked so the
 * current journey can finish.
 */
const EXPLICIT_JOURNEY_SWITCH_INTENTS = new Set([
  "user_switched_journey",
  "user_requested_new_journey",
  "switch_journey",
  "new_journey",
  "topic_change",
]);

function isExplicitJourneySwitchIntent(
  intent: unknown,
  force: unknown,
): boolean {
  if (force === true || force === "true") return true;
  if (typeof intent !== "string") return false;
  return EXPLICIT_JOURNEY_SWITCH_INTENTS.has(intent.trim().toLowerCase());
}

let activeJourney: JourneyId | null = null;
let activeJourneyComplete = false;
let lastUiShowScreenAt = 0;
let lastUiShowScreenId: string | null = null;

function setActiveJourney(next: JourneyId | null, reason: string) {
  if (activeJourney === next) return;
  appendLog(
    `[ConvAI] Journey ${activeJourney ?? "none"} → ${next ?? "none"} (${reason})`,
  );
  activeJourney = next;
  activeJourneyComplete = false;
}

function markActiveJourneyComplete(reason: string) {
  if (!activeJourney || activeJourneyComplete) return;
  activeJourneyComplete = true;
  appendLog(`[ConvAI] Journey ${activeJourney} marked complete (${reason})`);
}

function handleConvaiUiShowScreenPayload(payload: Record<string, unknown>) {
  const screenRaw = typeof payload.screen === "string" ? payload.screen : "";
  const screen = screenRaw.trim().toLowerCase();
  if (!screen) return;
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  const details = (
    payload.details && typeof payload.details === "object"
      ? (payload.details as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;
  const intent = details.intent ?? payload.intent;
  const force = details.force ?? payload.force;
  const explicitSwitch = isExplicitJourneySwitchIntent(intent, force);

  // Drop duplicate bursts within 1.5s — the agent occasionally re-emits the
  // same tool call when it re-anchors a step.
  const now = Date.now();
  if (lastUiShowScreenId === screen && now - lastUiShowScreenAt < 1500) {
    return;
  }

  const handler = JOURNEY_DISPATCH[screen];
  if (!handler) {
    appendLog(`[ConvAI] ui_show_screen: unknown screen "${screen}"`);
    return;
  }

  const targetJourney = SCREEN_TO_JOURNEY[screen];
  const journeyChange =
    Boolean(activeJourney) && targetJourney && targetJourney !== activeJourney;

  // Block cross-journey jumps unless the agent declares an explicit user-driven
  // switch OR the current journey is already complete. This is what enforces
  // "finish the journey you're on before jumping to another topic".
  if (journeyChange && !activeJourneyComplete && !explicitSwitch) {
    appendLog(
      `[ConvAI] ui_show_screen "${screen}" blocked — finishing "${activeJourney}" first` +
        (reason ? ` (reason: ${reason})` : ""),
    );
    window.dispatchEvent(
      new CustomEvent("convai-ui-show-screen-blocked", {
        detail: {
          screen,
          reason,
          currentJourney: activeJourney,
          targetJourney,
        },
      }),
    );
    return;
  }

  lastUiShowScreenAt = now;
  lastUiShowScreenId = screen;

  if (journeyChange) {
    // Switching journeys mid-flow — wipe the old journey's UI / state so the
    // new journey starts from a clean slate (hides the old screen).
    if (targetJourney) {
      resetOtherJourneysExcept(targetJourney);
    }
    setActiveJourney(
      targetJourney,
      explicitSwitch
        ? `user requested ${targetJourney}`
        : "previous journey complete",
    );
  } else if (!activeJourney && targetJourney) {
    setActiveJourney(targetJourney, "first screen of journey");
  }

  appendLog(
    `[ConvAI] ui_show_screen → ${screen}${reason ? ` (${reason})` : ""}`,
  );
  try {
    if (!isJourneyPage()) {
      return;
    }
    if (isJourneyPage()) {
      const fn = JOURNEY_DISPATCH[screen];

      fn?.();
    }
  } catch (err: any) {
    appendLog(
      `[ConvAI] ui_show_screen "${screen}" handler failed: ${err?.message ?? err}`,
    );
  }
  postCrossPageMessage({
    type: "journey-stage",
    screen,
    journey: targetJourney ?? null,
    reason: reason || null,
  });

  if (targetJourney && JOURNEY_TERMINAL_SCREENS[targetJourney].has(screen)) {
    markActiveJourneyComplete(`reached terminal screen ${screen}`);
  }

  window.dispatchEvent(
    new CustomEvent("convai-ui-show-screen", {
      detail: {
        screen,
        reason,
        intent,
        force,
        details: payload.details ?? null,
      },
    }),
  );
}

const appActions = {
  startCall: async () => {
    if (isInteractionPage() || isJourneyPage()) {
      postCrossPageMessage({ type: "start-call-request" });
      showStatus?.("info", "Requesting the avatar window to connect...");
      return;
    }

    const latestParams = new URLSearchParams(window.location.search);
    let latestSessionKey = latestParams.get("session");

    if (!latestSessionKey) {
      latestSessionKey =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `session-${Date.now()}`;

      latestParams.set("session", latestSessionKey);
      latestParams.set("role", "avatar");

      if (demoMode) {
        latestParams.set("twoTab", "1");
      }

      const newUrl = `${window.location.pathname}?${latestParams.toString()}${window.location.hash}`;
      window.history.replaceState({}, "", newUrl);
    }

    if (demoMode && isAvatarPage()) {
      ensureJourneyTabOpen();
    }

    try {
      setTranscriptRuntimeStatus("listening");
      setButtonDisabled("start-call-button", true);
      setCallPageConnectedClass(true);
      showStatus("info", "Starting call...");
      const { variables, userName } = getStoredMatchedVariables();
      const convaiLanguage = resolveWelcomeConvaiLanguage(variables);
      appendLog(
        "Creating local LiveKit session and starting ElevenLabs + Bey avatar worker...",
      );
      if (convaiLanguage === "auto") {
        appendLog(
          "[ConvAI] Auto language detection — agent will switch when user speaks another language",
        );
      } else {
        appendLog(`[ConvAI] Locking agent language to: ${convaiLanguage}`);
      }

      const response = await fetch("/api/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          identity: (userName || "user").trim() || "user",
          name: (userName || "").trim(),
          language: convaiLanguage,
          variables,
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(
          `Local start failed: ${response.status} - ${errorData}`,
        );
      }

      const callData: LocalStartResponse = await response.json();
      appendLog(`Room created: ${callData.room}`);
      appendLog(`Connecting to room...`);

      await connectToLiveKit(callData.livekit_url, callData.livekit_token);
      setCallConnectedState(true);
      postCrossPageMessage({ type: "call-connected" });

      showStatus("success", `Connected! Room: ${callData.room}`);
      setButtonsForState(true);
    } catch (error: any) {
      appendLog(`Error: ${error.message}`);
      showStatus("error", `Failed to start call: ${error.message}`);
      setCallPageConnectedClass(false);
      setButtonDisabled("start-call-button", false);
    }
  },

  toggleAudio: async () => {
    if (!currentRoom) return;
    const enabled = currentRoom.localParticipant.isMicrophoneEnabled;
    setButtonDisabled("toggle-audio-button", true);

    try {
      await currentRoom.localParticipant.setMicrophoneEnabled(!enabled);
      appendLog(`Microphone ${!enabled ? "enabled" : "disabled"}`);
      updateButtonsForPublishState();
    } catch (error: any) {
      appendLog(`Error toggling audio: ${error.message}`);
    }

    setButtonDisabled("toggle-audio-button", false);
  },

  toggleVideo: async () => {
    if (!currentRoom) return;
    const enabled = currentRoom.localParticipant.isCameraEnabled;
    setButtonDisabled("toggle-video-button", true);

    try {
      await currentRoom.localParticipant.setCameraEnabled(!enabled);
      appendLog(`Camera ${!enabled ? "enabled" : "disabled"}`);
      if (isAvatarPage()) {
renderParticipant(currentRoom.localParticipant);}
      updateButtonsForPublishState();
    } catch (error: any) {
      appendLog(`Error toggling video: ${error.message}`);
    }

    setButtonDisabled("toggle-video-button", false);
  },

  handleDeviceSelected: async (e: Event) => {
    const deviceId = (e.target as HTMLSelectElement).value;
    const elementId = (e.target as HTMLSelectElement).id;

    if (!currentRoom) return;

    let kind: MediaDeviceKind;
    if (elementId === "video-input") {
      kind = "videoinput";
    } else if (elementId === "audio-input") {
      kind = "audioinput";
    } else if (elementId === "audio-output") {
      kind = "audiooutput";
    } else {
      return;
    }

    await currentRoom.switchActiveDevice(kind, deviceId);
    appendLog(`Switched ${kind} to device: ${deviceId}`);
  },

  sendMessage: async () => {
    const textField = document.getElementById(
      "entry",
    ) as HTMLInputElement | null;
    if (!textField) return;
    const message = textField.value.trim();
    if (!message) return;
    const normalized = message.toLowerCase().replace(/\s+/g, " ");
    const loanJourneyIntent = isLoanJourneyIntentMessage(message);
    if (isWelcomePage()) {
      if (!tryApplyWelcomeAddressStepFromUserSpeech(message, "You", true)) {
        updateWelcomeFlowFromUser(message);
      }
    }
    if (
      normalized.includes("i want to apply for a forex card") ||
      (normalized.includes("forex card") &&
        /apply|want|need|get|interested/.test(normalized))
    ) {
      document.querySelector(".main-container")?.classList.add("active");
    }
    updateChatBackgroundForUserMessage(message);

    if (isInteractionPage()) {
      addChatMessage("You", message);
      textField.value = "";
      postCrossPageMessage({ type: "chat-outbound", message });
      appendLog(`Forwarded message to avatar page: ${message}`);
      return;
    }

    if (currentRoom) {
      addChatMessage("You", message);
      textField.value = "";
      if (loanJourneyIntent) {
        // Do not send raw phrase to lk.chat — Convai would answer before n8n.
        await triggerLoanJourneyFromN8n(message);
        appendLog(`Loan journey: user line kept local; n8n → lk.chat only`);
      } else if (await maybeTriggerLiveSearchFromN8n(message)) {
        appendLog(`Live search: user line kept local; n8n → lk.chat only`);
      } else {
        currentRoom.localParticipant.sendText(message, { topic: "lk.chat" });
        appendLog(`Sent message: ${message}`);
      }
      return;
    }

    if (isChatPage() && isCallConnected()) {
      addChatMessage("You", message);
      textField.value = "";
      if (loanJourneyIntent) {
        await triggerLoanJourneyFromN8n(message);
        appendLog(`Loan journey: forwarded n8n reply only (not raw user text)`);
      } else if (await maybeTriggerLiveSearchFromN8n(message)) {
        appendLog(`Live search: forwarded n8n reply only (not raw user text)`);
      } else {
        postCrossPageMessage({ type: "chat-outbound", message });
        appendLog(`Forwarded message to call page: ${message}`);
      }
    }
  },

  showWelcomeSelfVerifyStage: showWelcomeSelfVerifyMethodsStage,
  showWelcomeFaceScanStage: showWelcomeFaceScanStage,

  disconnect: () => {
    if (isInteractionPage()) {
      postCrossPageMessage({ type: "stop-call" });
      showStatus("info", "Stop requested for the avatar window.");
      return;
    }

    if (currentRoom) {
      appendLog("Disconnecting from call...");
      currentRoom.disconnect();
      currentRoom = undefined;
      setCallConnectedState(false);
      setCallPageConnectedClass(false);
      postCrossPageMessage({ type: "call-disconnected" });
      setButtonsForState(false);
      showStatus("info", "Call ended");
      clearParticipants();
      resetWelcomeStage();
    }
    fetch("/api/stop", { method: "POST" }).catch(() => {});
  },
};

async function connectToLiveKit(url: string, token: string): Promise<void> {
  const roomOptions: RoomOptions = {
    // Keep remote avatar tracks flowing even when attached to hidden elements
    // used by the chroma-key pipeline.
    adaptiveStream: false,
    dynacast: true,
    publishDefaults: {
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      videoCodec: "vp8",
    },
    videoCaptureDefaults: {
      resolution: VideoPresets.h720.resolution,
    },
  };
  if (!isAvatarPage()) {
    return;
  }
  const room = new Room(roomOptions);
  // Capture topic-based text streams (`lk.chat`) directly so transcript
  // updates even when RoomEvent.ChatMessage is not emitted for this topic.
  room.registerTextStreamHandler(
    "lk.chat",
    async (reader: any, sender: any) => {
      try {
        const identity = sender?.identity || "Unknown";
        let accumulated = "";

        // Prefer incremental chunks so step 5 can appear as Eva's line streams in.
        if (reader && typeof reader[Symbol.asyncIterator] === "function") {
          for await (const chunk of reader as AsyncIterable<
            string | Uint8Array
          >) {
            accumulated += String(chunk ?? "");
            if (
              isWelcomePage() &&
              awaitingEvaAddressVerifiedSuccessAnnouncement
            ) {
              tryShowAddressVerifiedSuccessFromInbound(accumulated, {
                streaming: true,
              });
            }
            if (isWelcomePage() && !hasShownAddressSelectScreen) {
              tryShowAddressSelectFromInbound(accumulated, { streaming: true });
            }
            if (
              isWelcomePage() &&
              hasShownAddressSelectScreen &&
              document.body.classList.contains("address-select-stage") &&
              !document.body.classList.contains("address-select-review")
            ) {
              tryShowAddressSelectReviewFromInbound(accumulated, {
                streaming: true,
              });
            }
            if (
              isWelcomePage() &&
              !hasShownWelcomeForexScreen &&
              !addressJourneyActive
            ) {
              tryShowForexFromInbound(accumulated, { streaming: true });
            }
            if (isWelcomePage() && !hasShownSelfVerifyMethodsScreen) {
              tryShowSelfVerifyMethodsFromInbound(accumulated, {
                streaming: true,
              });
            }
            if (isWelcomePage() && !hasShownFaceScanScreen) {
              tryShowFaceScanFromInbound(accumulated, { streaming: true });
            }
            if (isWelcomePage()) {
              tryArmCashWithdrawInsertCardCueFromEva(accumulated);
            }
          }
        } else if (reader?.readAll) {
          accumulated = String((await reader.readAll()) ?? "");
          if (
            isWelcomePage() &&
            awaitingEvaAddressVerifiedSuccessAnnouncement
          ) {
            tryShowAddressVerifiedSuccessFromInbound(accumulated, {
              streaming: true,
            });
          }
          if (isWelcomePage() && !hasShownAddressSelectScreen) {
            tryShowAddressSelectFromInbound(accumulated, { streaming: true });
          }
          if (
            isWelcomePage() &&
            hasShownAddressSelectScreen &&
            document.body.classList.contains("address-select-stage") &&
            !document.body.classList.contains("address-select-review")
          ) {
            tryShowAddressSelectReviewFromInbound(accumulated, {
              streaming: true,
            });
          }
          if (
            isWelcomePage() &&
            !hasShownWelcomeForexScreen &&
            !addressJourneyActive
          ) {
            tryShowForexFromInbound(accumulated, { streaming: true });
          }
          if (isWelcomePage() && !hasShownSelfVerifyMethodsScreen) {
            tryShowSelfVerifyMethodsFromInbound(accumulated, {
              streaming: true,
            });
          }
          if (isWelcomePage() && !hasShownFaceScanScreen) {
            tryShowFaceScanFromInbound(accumulated, { streaming: true });
          }
          if (isWelcomePage()) {
            tryArmCashWithdrawInsertCardCueFromEva(accumulated);
          }
        }

        const text = accumulated.trim();
        if (!text) return;
        const inbound = parseInboundChatLine(identity, text);
        handleInboundAssistantText(inbound.from, inbound.text, "text-stream");
      } catch (error: any) {
        appendLog(`Failed to read lk.chat stream: ${error?.message ?? error}`);
      }
    },
  );
  room
    .on(RoomEvent.ChatMessage, handleChatMessage)
    .on(RoomEvent.TranscriptionReceived, handleTranscriptionReceived)
    .on(RoomEvent.DataReceived, handleDataReceived)
    .on(RoomEvent.Disconnected, handleRoomDisconnect);

  if (isAvatarPage()) {
    room
      .on(RoomEvent.ParticipantConnected, participantConnected)
      .on(RoomEvent.ParticipantDisconnected, participantDisconnected)

      .on(RoomEvent.Reconnecting, () => appendLog("Reconnecting..."))
      .on(RoomEvent.Reconnected, () => appendLog("Reconnected successfully"))
      .on(RoomEvent.LocalTrackPublished, () => {
        if (isAvatarPage()) {
renderParticipant(room.localParticipant);}
      })
      .on(RoomEvent.LocalTrackUnpublished, () => {
        if (isAvatarPage()) {
renderParticipant(room.localParticipant);}
      })
      .on(RoomEvent.TrackSubscribed, (_, __, participant) => {
        appendLog(`Subscribed to track from ${participant.identity}`);
        if (isAvatarPage()) {
renderParticipant(participant);}
      })
      .on(RoomEvent.TrackPublished, (publication, participant) => {
        appendLog(
          `Track published from ${participant.identity} (${String((publication as any)?.kind ?? "unknown")})`,
        );
        if (isAvatarPage()) {
renderParticipant(participant);}
      })
      .on(RoomEvent.TrackSubscriptionStatusChanged, (...args: any[]) => {
        const publication = args.find(
          (value) =>
            value && typeof value === "object" && "isSubscribed" in value,
        );
        const participant = args.find(
          (value) => value && typeof value === "object" && "identity" in value,
        ) as Participant | undefined;
        if (participant) {
          appendLog(
            `Track subscription status changed for ${participant.identity}: ${String((publication as any)?.isSubscribed ?? "unknown")}`,
          );
          if (isAvatarPage()) {
renderParticipant(participant);}
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (_, __, participant) => {
        if (isAvatarPage()) {
renderParticipant(participant);}
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (room.canPlaybackAudio) {
          appendLog("Audio playback enabled");
        } else {
          appendLog("Audio playback blocked - user interaction required");
        }
      });
  }
  try {
    await room.connect(url, token);
    setTranscriptRuntimeStatus("listening");

    currentRoom = room;
    (window as any).currentRoom = room;

    appendLog(`Connected to room: ${room.name}`);

    await room.localParticipant.setMicrophoneEnabled(true);
    appendLog("Microphone enabled (Eva can hear you)");

    room.remoteParticipants.forEach((participant) => {
      participantConnected(participant);
    });
    participantConnected(room.localParticipant);
    updateButtonsForPublishState();

    await room.startAudio();
    appendLog("Started audio playback");

    // Single-page mode (`index.html` only): make sure the right panel is visible
    // and the flow kickoff happens locally without relying on BroadcastChannel echo.
    // Single-page mode only. In two-tab mode, the avatar page owns the call while
    // the journey page mirrors stages and chat history through BroadcastChannel.
    if ((isChatPage() || isWelcomePage()) && !demoMode) {
      document.querySelector(".main-container")?.classList.add("active");
      setChatBackgroundImage("card-selection");
      uiStep = "card-selection";
      if (!autoFlowTriggered) {
        const kickoff = "How may I help you today?";
        autoFlowTriggered = true;
        room.localParticipant.sendText(kickoff, { topic: "lk.chat" });
        addChatMessage("You", kickoff);
        appendLog(
          "[BG] Auto-started flow with kickoff message (single-page mode)",
        );
      }
    }
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
      if (isAvatarPage()) {
        renderParticipant(participant);
      }
    })
    .on(ParticipantEvent.TrackUnmuted, (_: TrackPublication) => {
      appendLog(`Track unmuted: ${participant.identity}`);
      if (isAvatarPage()) {
renderParticipant(participant);}
    })
    .on(ParticipantEvent.IsSpeakingChanged, () => {
      if (isAvatarPage()) {
renderParticipant(participant);}
    });

  if (isAvatarPage()) {
renderParticipant(participant);}
}

function participantDisconnected(participant: RemoteParticipant) {
  appendLog(`Participant disconnected: ${participant.identity}`);
  if (isAvatarPage()) {
renderParticipant(participant, true);}
}

function handleRoomDisconnect(reason?: DisconnectReason) {
  appendLog(`Disconnected from room. Reason: ${reason}`);
  setButtonsForState(false);
  clearParticipants();
  currentRoom = undefined;
  setCallConnectedState(false);
  setCallPageConnectedClass(false);
  postCrossPageMessage({ type: "call-disconnected" });
  document.querySelector(".main-container")?.classList.remove("active");
  setTranscriptRuntimeStatus("idle");
  resetWelcomeStage();
}

function handleChatMessage(msg: ChatMessage, participant?: Participant) {
  pulseTranscriptReceiving();
  const inbound = parseInboundChatLine(
    participant?.identity || "Unknown",
    msg.message,
  );
  const from = inbound.from;
  const text = inbound.text;

  addChatMessage(from, text);
  if (isWelcomePage()) {
    applyWelcomeDetailsOptionsFromUserMessage(text);
  }
  if (isWelcomePage() && tryShowAddressVerifiedSuccessFromInbound(text)) {
    updateWelcomeCopyFromEva(from, text);
    postCrossPageMessage({ type: "chat-inbound", from, message: text });
    if (isChatPage()) {
      if (isLikelyUserSpeaker(from)) {
        updateChatBackgroundForUserMessage(text);
      } else {
        updateChatBackgroundForEvaMessage(from, text);
      }
    }
    appendLog(`Chat message from ${from}: ${text}`);
    return;
  }
  if (isWelcomePage() && tryShowAddressSelectFromInbound(text)) {
    updateWelcomeCopyFromEva(from, text);
    postCrossPageMessage({ type: "chat-inbound", from, message: text });
    if (isChatPage()) {
      if (isLikelyUserSpeaker(from)) {
        updateChatBackgroundForUserMessage(text);
      } else {
        updateChatBackgroundForEvaMessage(from, text);
      }
    }
    appendLog(`Chat message from ${from}: ${text}`);
    return;
  }
  if (isWelcomePage() && tryShowAddressSelectReviewFromInbound(text)) {
    updateWelcomeCopyFromEva(from, text);
    postCrossPageMessage({ type: "chat-inbound", from, message: text });
    if (isChatPage()) {
      if (isLikelyUserSpeaker(from)) {
        updateChatBackgroundForUserMessage(text);
      } else {
        updateChatBackgroundForEvaMessage(from, text);
      }
    }
    appendLog(`Chat message from ${from}: ${text}`);
    return;
  }
  if (isWelcomePage() && tryShowForexFromInbound(text)) {
    updateWelcomeCopyFromEva(from, text);
    postCrossPageMessage({ type: "chat-inbound", from, message: text });
    if (isChatPage()) {
      if (isLikelyUserSpeaker(from)) {
        updateChatBackgroundForUserMessage(text);
      } else {
        updateChatBackgroundForEvaMessage(from, text);
      }
    }
    appendLog(`Chat message from ${from}: ${text}`);
    return;
  }
  if (isWelcomePage() && tryShowSelfVerifyMethodsFromInbound(text)) {
    updateWelcomeCopyFromEva(from, text);
    postCrossPageMessage({ type: "chat-inbound", from, message: text });
    if (isChatPage()) {
      if (isLikelyUserSpeaker(from)) {
        updateChatBackgroundForUserMessage(text);
      } else {
        updateChatBackgroundForEvaMessage(from, text);
      }
    }
    appendLog(`Chat message from ${from}: ${text}`);
    return;
  }
  if (isWelcomePage() && tryShowFaceScanFromInbound(text)) {
    updateWelcomeCopyFromEva(from, text);
    postCrossPageMessage({ type: "chat-inbound", from, message: text });
    if (isChatPage()) {
      if (isLikelyUserSpeaker(from)) {
        updateChatBackgroundForUserMessage(text);
      } else {
        updateChatBackgroundForEvaMessage(from, text);
      }
    }
    appendLog(`Chat message from ${from}: ${text}`);
    return;
  }
  if (isWelcomePage()) {
    const userSpeech = isLikelyUserSpeaker(from);
    if (userSpeech) {
      if (!tryApplyWelcomeAddressStepFromUserSpeech(text, from, false)) {
        updateWelcomeFlowFromUser(text);
      }
    } else {
      tryShowAddressNextFromEvaSpeech(from, text);
      tryShowAddressConsentScreenFromEvaSpeech(from, text);
      tryArmCashWithdrawInsertCardCueFromEva(text);
      if (isAddressChangeIntentMessage(text)) {
        startAddressChangeJourney({ force: true });
      }
    }
  }
  updateWelcomeCopyFromEva(from, text);
  postCrossPageMessage({ type: "chat-inbound", from, message: text });
  if (isChatPage()) {
    if (isLikelyUserSpeaker(from)) {
      updateChatBackgroundForUserMessage(text);
    } else {
      updateChatBackgroundForEvaMessage(from, text);
    }
  }
  appendLog(`Chat message from ${from}: ${text}`);
}

function handleTranscriptionReceived(
  segments: TranscriptionSegment[],
  participant?: Participant,
) {
  pulseTranscriptReceiving();
  const localTranscript = participant ? isLocalParticipant(participant) : false;
  const streamingText = segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  // Step 5: react on interim Eva STT, not only after the ~2s final segment.
  if (isWelcomePage() && !localTranscript) {
    if (streamingText) {
      const inbound = parseInboundChatLine(
        participant?.identity || "Unknown",
        streamingText,
      );
      if (
        awaitingEvaAddressVerifiedSuccessAnnouncement &&
        !hasShownAddressVerifiedSuccessScreen
      ) {
        tryShowAddressVerifiedSuccessFromInbound(inbound.text, {
          streaming: true,
        });
      }
      if (!hasShownAddressSelectScreen) {
        tryShowAddressSelectFromInbound(inbound.text, { streaming: true });
      }
      if (
        hasShownAddressSelectScreen &&
        document.body.classList.contains("address-select-stage") &&
        !document.body.classList.contains("address-select-review")
      ) {
        tryShowAddressSelectReviewFromInbound(inbound.text, {
          streaming: true,
        });
      }
      if (!hasShownWelcomeForexScreen && !addressJourneyActive) {
        tryShowForexFromInbound(inbound.text, { streaming: true });
      }
      if (!hasShownSelfVerifyMethodsScreen) {
        tryShowSelfVerifyMethodsFromInbound(inbound.text, { streaming: true });
      }
      if (!hasShownFaceScanScreen) {
        tryShowFaceScanFromInbound(inbound.text, { streaming: true });
      }
      tryArmCashWithdrawInsertCardCueFromEva(inbound.text);
    }
  }
  if (isWelcomePage() && localTranscript && streamingText) {
    tryShowFaceScanFromUserSpeech(streamingText, "You", true);
  }

  const finalizedText = segments
    .filter((segment) => {
      if (!segment.final || !segment.text.trim()) return false;
      if (processedTranscriptionSegmentIds.has(segment.id)) return false;
      processedTranscriptionSegmentIds.add(segment.id);
      return true;
    })
    .map((segment) => segment.text.trim())
    .join(" ")
    .trim();

  if (!finalizedText) return;

  const inbound = parseInboundChatLine(
    localTranscript ? "You" : participant?.identity || "Unknown",
    finalizedText,
  );
  const from = inbound.from;
  const userText = inbound.text;
  if (!userText) return;

  addChatMessage(from, userText);
  if (localTranscript && isHomeLoanJourneyIntentMessage(userText)) {
    startHomeLoanJourney({ force: true });
  } else if (localTranscript && isLoanJourneyIntentMessage(userText)) {
    void triggerLoanJourneyFromN8n(userText);
  }
  if (isWelcomePage()) {
    applyWelcomeDetailsOptionsFromUserMessage(userText);
  }
  if (isWelcomePage() && tryShowAddressVerifiedSuccessFromInbound(userText)) {
    updateWelcomeCopyFromEva(from, userText);
    postCrossPageMessage({ type: "chat-inbound", from, message: userText });
    if (isChatPage()) {
      if (localTranscript) {
        updateChatBackgroundForUserMessage(userText);
      } else {
        updateChatBackgroundForEvaMessage(from, userText);
      }
    }
    return;
  }
  if (isWelcomePage() && tryShowAddressSelectFromInbound(userText)) {
    updateWelcomeCopyFromEva(from, userText);
    postCrossPageMessage({ type: "chat-inbound", from, message: userText });
    if (isChatPage()) {
      if (localTranscript) {
        updateChatBackgroundForUserMessage(userText);
      } else {
        updateChatBackgroundForEvaMessage(from, userText);
      }
    }
    return;
  }
  if (isWelcomePage() && tryShowAddressSelectReviewFromInbound(userText)) {
    updateWelcomeCopyFromEva(from, userText);
    postCrossPageMessage({ type: "chat-inbound", from, message: userText });
    if (isChatPage()) {
      if (localTranscript) {
        updateChatBackgroundForUserMessage(userText);
      } else {
        updateChatBackgroundForEvaMessage(from, userText);
      }
    }
    return;
  }
  if (isWelcomePage() && tryShowForexFromInbound(userText)) {
    updateWelcomeCopyFromEva(from, userText);
    postCrossPageMessage({ type: "chat-inbound", from, message: userText });
    if (isChatPage()) {
      if (localTranscript) {
        updateChatBackgroundForUserMessage(userText);
      } else {
        updateChatBackgroundForEvaMessage(from, userText);
      }
    }
    return;
  }
  if (isWelcomePage() && tryShowSelfVerifyMethodsFromInbound(userText)) {
    updateWelcomeCopyFromEva(from, userText);
    postCrossPageMessage({ type: "chat-inbound", from, message: userText });
    if (isChatPage()) {
      if (localTranscript) {
        updateChatBackgroundForUserMessage(userText);
      } else {
        updateChatBackgroundForEvaMessage(from, userText);
      }
    }
    return;
  }
  if (isWelcomePage() && tryShowFaceScanFromInbound(userText)) {
    updateWelcomeCopyFromEva(from, userText);
    postCrossPageMessage({ type: "chat-inbound", from, message: userText });
    if (isChatPage()) {
      if (localTranscript) {
        updateChatBackgroundForUserMessage(userText);
      } else {
        updateChatBackgroundForEvaMessage(from, userText);
      }
    }
    return;
  }
  if (isWelcomePage()) {
    const userSpeech = localTranscript || isLikelyUserSpeaker(from);
    if (userSpeech) {
      if (
        !tryApplyWelcomeAddressStepFromUserSpeech(
          userText,
          from,
          localTranscript,
        )
      ) {
        updateWelcomeFlowFromUser(userText);
      }
    } else {
      tryShowAddressNextFromEvaSpeech(from, userText);
      tryShowAddressConsentScreenFromEvaSpeech(from, userText);
      tryArmCashWithdrawInsertCardCueFromEva(userText);
      if (isAddressChangeIntentMessage(userText)) {
        startAddressChangeJourney({ force: true });
      }
    }
  }
  updateWelcomeCopyFromEva(from, userText);
  postCrossPageMessage({ type: "chat-inbound", from, message: userText });
  if (isChatPage()) {
    if (localTranscript) {
      updateChatBackgroundForUserMessage(userText);
    } else {
      updateChatBackgroundForEvaMessage(from, userText);
    }
  }
  if (localTranscript && !isLoanJourneyIntentMessage(userText)) {
    void maybeTriggerLiveSearchFromN8n(userText);
  }
  appendLog(`Transcription from ${from}: ${userText}`);
}

function handleDataReceived(
  payload: Uint8Array,
  participant?: Participant,
  _kind?: unknown,
  _topic?: string,
) {
  pulseTranscriptReceiving();
  if (participant && isLocalParticipant(participant)) return;

  const decoded = new TextDecoder().decode(payload).trim();
  if (!decoded) return;

  const from = participant?.identity || "Unknown";

  if (decoded.startsWith("{")) {
    try {
      const parsedPayload = JSON.parse(decoded) as Record<string, unknown>;
      if (parsedPayload?.eva === "language-change") {
        handleConvaiLanguageChangePayload(parsedPayload);
        return;
      }
      if (parsedPayload?.eva === "ui-show-screen") {
        handleConvaiUiShowScreenPayload(parsedPayload);
        return;
      }
    } catch {
      // fall through to generic handling
    }
  }

  handleInboundAssistantText(from, decoded, "data");

  try {
    const parsed = JSON.parse(decoded) as unknown;
    const texts = extractTextCandidates(parsed);
    texts.forEach((text) =>
      handleInboundAssistantText(from, text, "data-json"),
    );
  } catch {
    // ignore non-json payload
  }
}

function extractTextCandidates(value: unknown): string[] {
  const result: string[] = [];

  const walk = (node: unknown) => {
    if (!node) return;

    if (typeof node === "string") {
      const text = node.trim();
      if (text.length >= 6) result.push(text);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      ["text", "message", "content", "transcript", "utterance"].forEach((key) =>
        walk(obj[key]),
      );
      walk(obj.segments);
      walk(obj.messages);
    }
  };

  walk(value);
  return result;
}

function handleInboundAssistantText(
  from: string,
  text: string,
  source: string,
) {
  const inbound = parseInboundChatLine(from, text);
  const cleaned = inbound.text.trim();
  if (!cleaned) return;
  from = inbound.from;

  const dedupeKey = `${normalizeMessage(from)}::${normalizeMessage(cleaned)}`;
  if (processedInboundTexts.has(dedupeKey)) return;
  processedInboundTexts.add(dedupeKey);

  addChatMessage(from, cleaned);
  if (isWelcomePage()) {
    applyWelcomeDetailsOptionsFromUserMessage(cleaned);
    if (tryShowAddressVerifiedSuccessFromInbound(cleaned)) {
      updateWelcomeCopyFromEva(from, cleaned);
      postCrossPageMessage({ type: "chat-inbound", from, message: cleaned });
      if (isChatPage()) {
        if (isLikelyUserSpeaker(from)) {
          updateChatBackgroundForUserMessage(cleaned);
        } else {
          updateChatBackgroundForEvaMessage(from, cleaned);
        }
      }
      appendLog(`Inbound ${source} from ${from}: ${cleaned}`);
      return;
    }
    if (tryShowAddressSelectFromInbound(cleaned)) {
      updateWelcomeCopyFromEva(from, cleaned);
      postCrossPageMessage({ type: "chat-inbound", from, message: cleaned });
      if (isChatPage()) {
        if (isLikelyUserSpeaker(from)) {
          updateChatBackgroundForUserMessage(cleaned);
        } else {
          updateChatBackgroundForEvaMessage(from, cleaned);
        }
      }
      appendLog(`Inbound ${source} from ${from}: ${cleaned}`);
      return;
    }
    if (tryShowAddressSelectReviewFromInbound(cleaned)) {
      updateWelcomeCopyFromEva(from, cleaned);
      postCrossPageMessage({ type: "chat-inbound", from, message: cleaned });
      if (isChatPage()) {
        if (isLikelyUserSpeaker(from)) {
          updateChatBackgroundForUserMessage(cleaned);
        } else {
          updateChatBackgroundForEvaMessage(from, cleaned);
        }
      }
      appendLog(`Inbound ${source} from ${from}: ${cleaned}`);
      return;
    }
    if (tryShowForexFromInbound(cleaned)) {
      updateWelcomeCopyFromEva(from, cleaned);
      postCrossPageMessage({ type: "chat-inbound", from, message: cleaned });
      if (isChatPage()) {
        if (isLikelyUserSpeaker(from)) {
          updateChatBackgroundForUserMessage(cleaned);
        } else {
          updateChatBackgroundForEvaMessage(from, cleaned);
        }
      }
      appendLog(`Inbound ${source} from ${from}: ${cleaned}`);
      return;
    }
    if (tryShowSelfVerifyMethodsFromInbound(cleaned)) {
      updateWelcomeCopyFromEva(from, cleaned);
      postCrossPageMessage({ type: "chat-inbound", from, message: cleaned });
      if (isChatPage()) {
        if (isLikelyUserSpeaker(from)) {
          updateChatBackgroundForUserMessage(cleaned);
        } else {
          updateChatBackgroundForEvaMessage(from, cleaned);
        }
      }
      appendLog(`Inbound ${source} from ${from}: ${cleaned}`);
      return;
    }
    if (tryShowFaceScanFromInbound(cleaned)) {
      updateWelcomeCopyFromEva(from, cleaned);
      postCrossPageMessage({ type: "chat-inbound", from, message: cleaned });
      if (isChatPage()) {
        if (isLikelyUserSpeaker(from)) {
          updateChatBackgroundForUserMessage(cleaned);
        } else {
          updateChatBackgroundForEvaMessage(from, cleaned);
        }
      }
      appendLog(`Inbound ${source} from ${from}: ${cleaned}`);
      return;
    }
    if (isLikelyUserSpeaker(from)) {
      if (!tryApplyWelcomeAddressStepFromUserSpeech(cleaned, from, false)) {
        updateWelcomeFlowFromUser(cleaned);
      }
      // Voice transcripts arrive here (ConvAI publishes "You: …" on lk.chat).
      // Route non-journey questions (e.g. general "cards" queries) to live search
      // so the loan-blank-panel surfaces — mirrors the typed/transcription paths.
      if (
        !isLoanJourneyIntentMessage(cleaned) &&
        !isHomeLoanJourneyIntentMessage(cleaned)
      ) {
        void maybeTriggerLiveSearchFromN8n(cleaned);
      }
    } else if (isAddressChangeIntentMessage(cleaned)) {
      startAddressChangeJourney({ force: true });
    } else {
      if (tryRenderEvaAnswerInLiveSearchPanel(from, cleaned)) {
        postCrossPageMessage({ type: "chat-inbound", from, message: cleaned });
        if (isChatPage()) {
          updateChatBackgroundForEvaMessage(from, cleaned);
        }
        appendLog(`Inbound ${source} from ${from}: ${cleaned}`);
        return;
      }
      tryShowAddressNextFromEvaSpeech(from, cleaned);
      tryShowAddressConsentScreenFromEvaSpeech(from, cleaned);
      tryArmCashWithdrawInsertCardCueFromEva(cleaned);
      updateWelcomeCopyFromEva(from, cleaned);
    }
  } else {
    updateWelcomeCopyFromEva(from, cleaned);
  }
  postCrossPageMessage({ type: "chat-inbound", from, message: cleaned });
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
function showStatus(type: "success" | "error" | "info", message: string) {
  const statusEl = document.getElementById(
    "status-message",
  ) as HTMLElement | null;
  if (!statusEl) return;
  statusEl.style.display = "block";
  statusEl.className = `alert alert-${type === "error" ? "danger" : type === "success" ? "success" : "info"}`;
  statusEl.textContent = message;

  if (type === "success" || type === "info") {
    setTimeout(() => {
      statusEl.style.display = "none";
    }, 5000);
  }
}

function setTranscriptRuntimeStatus(status: TranscriptRuntimeStatus) {
  const header = document.querySelector(
    "#transcription-panel .transcription-header",
  ) as HTMLElement | null;
  if (!header) return;
  const label =
    status === "receiving"
      ? "Receiving..."
      : status === "listening"
        ? "Listening..."
        : "Idle";
  header.textContent = `Live transcript (${label})`;
}

function pulseTranscriptReceiving() {
  setTranscriptRuntimeStatus("receiving");
  if (transcriptStatusResetTimer) clearTimeout(transcriptStatusResetTimer);
  transcriptStatusResetTimer = setTimeout(() => {
    setTranscriptRuntimeStatus(currentRoom ? "listening" : "idle");
  }, 1800);
}

function appendLog(message: string) {
  console.log(`[Bey API] ${message}`);
}

/**
 * Remove ElevenLabs mood / emotion audio tags such as "[happy]", "[sad]",
 * "[whispers]" from spoken transcriptions before they are displayed.
 */
function stripMoodTags(text: string): string {
  return String(text || "")
    .replace(/\[[^\]\n]{0,40}\]/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

/** Extract displayable text from message - filters system JSON, extracts from agent JSON */
function extractDisplayMessage(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().includes("trigger background image")) return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === "stv_metrics") return null;
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return stripMoodTags(parsed.message.trim());
      }
      return stripMoodTags(trimmed);
    } catch {
      return stripMoodTags(trimmed);
    }
  }
  return stripMoodTags(trimmed.replace(/^elevenlabs\s*:\s*/i, "").trim());
}

function convertNumberWordsToDigits(input: string): string {
  const small: Record<string, number> = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };
  const scales: Record<string, number> = {
    hundred: 100,
    thousand: 1000,
    lakh: 100000,
    million: 1000000,
  };
  const joiners = new Set(["and"]);
  const words = new Set([
    ...Object.keys(small),
    ...Object.keys(scales),
    ...joiners,
  ]);

  const tokens = input.split(/\b/);
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (!/^[a-z]+$/.test(lower) || !words.has(lower)) {
      i += 1;
      continue;
    }

    let j = i;
    let group = 0;
    let total = 0;
    let consumed = false;

    while (j < tokens.length) {
      const t = tokens[j];
      const tl = t.toLowerCase();
      if (/^[a-z]+$/.test(tl) && (words.has(tl) || joiners.has(tl))) {
        if (joiners.has(tl)) {
          j += 1;
          consumed = true;
          continue;
        }
        if (tl in small) {
          group += small[tl];
          j += 1;
          consumed = true;
          continue;
        }
        if (tl in scales) {
          const scale = scales[tl];
          if (scale === 100) {
            group = Math.max(1, group) * scale;
          } else {
            total += Math.max(1, group) * scale;
            group = 0;
          }
          j += 1;
          consumed = true;
          continue;
        }
      }
      break;
    }

    if (!consumed) {
      i += 1;
      continue;
    }

    const numberValue = total + group;
    tokens.splice(i, j - i, String(numberValue));
    i += 1;
  }

  return tokens.join("");
}

function addChatMessage(from: string, message: string) {
  const displayMsg = extractDisplayMessage(message) ?? message.trim();
  if (!displayMsg) return;

  const normalizedDisplayMsg = convertNumberWordsToDigits(displayMsg);

  const last = state.chatMessages[state.chatMessages.length - 1];
  if (last && last.from === from && last.message === normalizedDisplayMsg) {
    return;
  }

  state.chatMessages.push({
    from,
    message: normalizedDisplayMsg,
    timestamp: Date.now(),
  });
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
    .join("\n");
  const chatEl = document.getElementById("chat") as HTMLTextAreaElement | null;
  if (chatEl) {
    chatEl.value = transcriptText;
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  const dateTextEl = document.getElementById("transcription-display");
  if (dateTextEl && isLikelyEvaSpeaker(from)) {
    if (shouldDeferEvaRequestSubmittedCopy(from, normalizedDisplayMsg)) {
      pendingEvaRequestSubmittedCopy = normalizedDisplayMsg;
      return;
    }
    dateTextEl.textContent = normalizedDisplayMsg;
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
  const connectedButtons = [
    "toggle-audio-button",
    "toggle-video-button",
    "disconnect-button",
    "send-button",
    "entry",
  ];
  const disconnectedButtons = ["start-call-button"];
  const deviceSelects = ["video-input", "audio-input", "audio-output"];

  if (connected) {
    connectedButtons.forEach((id) => {
      const el = $(id);
      if (el) el.removeAttribute("disabled");
    });
    disconnectedButtons.forEach((id) => {
      const el = $(id);
      if (el) el.setAttribute("disabled", "true");
    });
    deviceSelects.forEach((id) => {
      const el = $(id);
      if (el) el.removeAttribute("disabled");
    });
    handleDevicesChanged();
  } else {
    connectedButtons.forEach((id) => {
      const el = $(id);
      if (el) el.setAttribute("disabled", "true");
    });
    disconnectedButtons.forEach((id) => {
      const el = $(id);
      if (el) el.removeAttribute("disabled");
    });
    deviceSelects.forEach((id) => {
      const el = $(id);
      if (el) el.setAttribute("disabled", "true");
    });
  }
}

function updateButtonsForPublishState() {
  if (!currentRoom) return;

  const lp = currentRoom.localParticipant;

  updateButtonText(
    "toggle-video-button",
    lp.isCameraEnabled ? "Disable Camera" : "Enable Camera",
  );

  updateButtonText(
    "toggle-audio-button",
    lp.isMicrophoneEnabled ? "Disable Mic" : "Enable Mic",
  );
}

async function handleDevicesChanged() {
  const kinds: MediaDeviceKind[] = ["videoinput", "audioinput", "audiooutput"];
  const ids = ["video-input", "audio-input", "audio-output"];

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

function populateSelect(
  element: HTMLSelectElement,
  devices: MediaDeviceInfo[],
) {
  element.innerHTML = "";

  for (const device of devices) {
    const option = document.createElement("option");
    option.text =
      device.label || `${device.kind} (${device.deviceId.slice(0, 8)})`;
    option.value = device.deviceId;
    element.appendChild(option);
  }
}

function renderParticipant(participant: Participant, remove: boolean = false) {
  if (!isAvatarPage()) {
    return;
  }
  const container = $("participants-area");
  if (!container) return;

  const isLocal = isLocalParticipant(participant);
  // New approach: do not rely on fixed agent identities.
  // Any non-local participant in call mode can be the avatar media source.
  const isAgent = !isLocal;

  // Force subscription for remote tracks to avoid missing avatar media when
  // publications are not auto-subscribed quickly enough.
  if (!isLocal) {
    for (const pub of participant.trackPublications.values()) {
      try {
        (pub as any).setSubscribed?.(true);
      } catch {
        // ignore; some publication states may not allow toggling immediately
      }
    }
  }

  const getFirstSubscribedVideoPub = () => {
    for (const pub of participant.trackPublications.values()) {
      // Prefer an actually subscribed, unmuted video publication.
      if ((pub as any).kind === Track.Kind.Video || (pub as any).videoTrack) {
        const videoTrack = (pub as any).videoTrack;
        if (pub.isSubscribed && !pub.isMuted && videoTrack) return pub;
      }
    }
    // Fallback: any publication that currently has a video track object.
    for (const pub of participant.trackPublications.values()) {
      const videoTrack = (pub as any).videoTrack;
      if (videoTrack) return pub;
    }
    return null;
  };

  const getFirstSubscribedAudioPub = () => {
    for (const pub of participant.trackPublications.values()) {
      if ((pub as any).kind === Track.Kind.Audio || (pub as any).audioTrack) {
        const audioTrack = (pub as any).audioTrack;
        if (pub.isSubscribed && !pub.isMuted && audioTrack) return pub;
      }
    }
    for (const pub of participant.trackPublications.values()) {
      const audioTrack = (pub as any).audioTrack;
      if (audioTrack) return pub;
    }
    return null;
  };

  if (isLocal) {
    if (remove) {
      const div = container.querySelector(
        `#participant-${participant.identity}`,
      );
      if (div) div.remove();
    }
    return;
  }

  // In call mode, render any remote participant media source.

  // Bey avatar video may not be published as Track.Source.Camera.
  const videoPub = getFirstSubscribedVideoPub();
  const videoTrack = videoPub ? (videoPub as any).videoTrack : null;
  // Bey publications can report muted/subscription flags inconsistently.
  // If a track object exists, attach it directly.
  const hasVideo = Boolean(videoTrack);

  if (!hasVideo) {
    const existingDiv = container.querySelector(
      `#participant-${participant.identity}`,
    );
    if (existingDiv) existingDiv.remove();
    return;
  }

  const { identity } = participant;
  const useChromaEva =
    !isJourneyPage() && (isChatPage() || isWelcomePage()) && isAgent;

  if (remove) {
    if (useChromaEva) {
      const chromaSource = document.getElementById(
        "eva-chroma-source",
      ) as HTMLVideoElement;
      if (chromaSource?.srcObject) {
        (chromaSource.srcObject as MediaStream)
          .getTracks()
          .forEach((t) => t.stop());
        chromaSource.srcObject = null;
      }
      (window as any).stopEvaChromaProcess?.();
      if (isAgent) {
        document.body.classList.remove("eva-speaking");
        hasEvaSpokenOnCallPage = false;
      }
    } else {
      const div = container.querySelector(`#participant-${identity}`);
      if (div) div.remove();
      if (isCallPage() && isAgent) {
        document.body.classList.remove("eva-speaking");
        hasEvaSpokenOnCallPage = false;
      }
    }
    return;
  }

  if (useChromaEva) {
    if (!isAvatarPage()) {
      return;
    }
    const chromaSource = document.getElementById(
      "eva-chroma-source",
    ) as HTMLVideoElement;
    const chromaAudio = document.getElementById(
      "eva-chroma-audio",
    ) as HTMLAudioElement;
    if (chromaSource && videoTrack) {
      videoTrack.attach(chromaSource);
      chromaSource.play?.();
      (window as any).startEvaChromaProcess?.();
    }
    // Bey avatar audio may not be published as Track.Source.Microphone.
    const audioPub = getFirstSubscribedAudioPub();
    const audioTrack = audioPub ? (audioPub as any).audioTrack : null;
    const audioEnabled = Boolean(audioTrack);
    if (chromaAudio && audioEnabled && audioTrack) {
      audioTrack.attach(chromaAudio);
      chromaAudio.volume = 1;
      chromaAudio.muted = false;
      chromaAudio.play().catch((e) => {
        appendLog(
          `[AUDIO] Eva agent playback blocked: ${e?.message ?? e}. User interaction may be required.`,
        );
      });
    }
    if (participant.isSpeaking && isAgent) {
      if (isWelcomePage()) {
        setChatInputBoxVisible(true);
      }
      if (!hasEvaSpokenOnCallPage) {
        hasEvaSpokenOnCallPage = true;
        document.body.classList.add("eva-speaking");
        appendLog("[CALL] Eva started speaking - hiding background image");
      }
      updateOrbBlobFromState();
    } else if (isAgent) {
      document.body.classList.remove("eva-speaking");
      hasEvaSpokenOnCallPage = false;
      updateOrbBlobFromState();
    }
    return;
  }

  let div = container.querySelector(
    `#participant-${identity}`,
  ) as HTMLDivElement;

  if (!div) {
    div = document.createElement("div");
    div.id = `participant-${identity}`;
    div.className = "participant";
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

  const videoElm = container.querySelector(
    `#video-${identity}`,
  ) as HTMLVideoElement;
  const audioElm = container.querySelector(
    `#audio-${identity}`,
  ) as HTMLAudioElement;
  const nameElm = container.querySelector(`#name-${identity}`);
  const micElm = container.querySelector(`#mic-${identity}`);

  if (nameElm) {
    nameElm.innerHTML = isLocal ? "You" : "Agent";
  }

  if (hasVideo) {
    if (isLocal) {
      videoElm.style.transform = "scale(-1, 1)";
    }
    videoTrack?.attach(videoElm);
  } else {
    if (videoTrack) {
      videoTrack.detach(videoElm);
    }
    videoElm.src = "";
    videoElm.srcObject = null;
  }

  const audioPub = getFirstSubscribedAudioPub();
  const audioTrack = audioPub ? (audioPub as any).audioTrack : null;
  const audioEnabled = Boolean(audioTrack);

  if (audioEnabled && !isLocal) {
    audioTrack?.attach(audioElm);
  } else {
    if (audioTrack) {
      audioTrack.detach(audioElm);
    }
    audioElm.src = "";
    audioElm.srcObject = null;
  }

  if (micElm) {
    micElm.innerHTML = audioEnabled ? "🎤" : "🔇";
  }

  if (participant.isSpeaking) {
    div.classList.add("speaking");
    if (isCallPage() && isAgent && !hasEvaSpokenOnCallPage) {
      hasEvaSpokenOnCallPage = true;
      document.body.classList.add("eva-speaking");
      appendLog("[CALL] Eva started speaking - hiding background image");
    }
    updateOrbBlobFromState();
  } else {
    div.classList.remove("speaking");
    if (isAgent) {
      document.body.classList.remove("eva-speaking");
      hasEvaSpokenOnCallPage = false;
      updateOrbBlobFromState();
    }
  }
}

function clearParticipants() {
  if (!isAvatarPage()) {
    return;
  }
  const container = $("participants-area");
  if (container) {
    if (isChatPage() || isWelcomePage()) {
      container.querySelectorAll(".participant").forEach((el) => el.remove());
      const chromaSource = document.getElementById(
        "eva-chroma-source",
      ) as HTMLVideoElement;
      if (chromaSource?.srcObject) {
        (chromaSource.srcObject as MediaStream)
          .getTracks()
          .forEach((t) => t.stop());
        chromaSource.srcObject = null;
      }
      (window as any).stopEvaChromaProcess?.();
    } else {
      container.innerHTML = "";
    }
  }
  processedTranscriptionSegmentIds.clear();
  processedInboundTexts.clear();
  currentChatView = null;
  uiStep = "idle";
  awaitingBestCardConfirmation = false;
  pendingDetailQuestionIndex = null;
  answeredDetailQuestionIndexes.clear();
  hasSentSingleSentenceDetailsGuidance = false;
  hasSentSingleSentenceDetailsCorrection = false;
  conversationPhase = "idle";
  flowStopped = false;
  autoFlowTriggered = false;
  hasEvaStartedTalking = false;
  hasEvaSpokenOnCallPage = false;
  resetWelcomeFlowState();
  document.body.classList.remove("eva-speaking");
  const orbUserTimer = (window as any).__orbUserSpeakingTimer;
  if (orbUserTimer) {
    clearTimeout(orbUserTimer);
    (window as any).__orbUserSpeakingTimer = null;
  }
  (window as any).__orbUserSpeaking = false;
  state.chatMessages = [];
  setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
  resetChatContainerViews();
  const chatEl = $("chat") as HTMLTextAreaElement;
  if (chatEl) chatEl.value = "";
  updateOrbBlobFromState();
}

const chatChannel =
  typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel(CHATCHANNELNAME);

function postCrossPageMessage(message: CrossPageMessage) {
  chatChannel?.postMessage(message);
}

function setCallConnectedState(connected: boolean) {
  localStorage.setItem(CALL_CONNECTED_STORAGE_KEY, connected ? "1" : "0");
}

function isCallConnected() {
  return localStorage.getItem(CALL_CONNECTED_STORAGE_KEY) === "1";
}

function isAvatarPage() {
  return pageRole === "avatar";
}

function isInteractionPage() {
  return pageRole === "interaction";
}

function isChatPage() {
  const p = window.location.pathname.replace(/\/$/, "") || "/";
  return (
    isInteractionPage() ||
    isJourneyPage() ||
    p === "/" ||
    p.endsWith("/index.html") ||
    p.endsWith("/interaction-screen.html") ||
    p.endsWith("/journey-screen.html") ||
    p.endsWith("/chat") ||
    p.endsWith("/chat.html")
  );
}

function isWelcomePage() {
  const p = window.location.pathname.replace(/\/$/, "") || "/";
  return (
    isAvatarPage() ||
    p.endsWith("/welcome.html") ||
    p.endsWith("/avatar-screen.html")
  );
}

function isCallPage() {
  return isAvatarPage() || isWelcomePage();
}

type OrbBlobState = "listening" | "answering" | "static";

function setOrbBlobState(state: OrbBlobState) {
  if (!isChatPage()) return;
  const el = document.getElementById("orb-blob") as HTMLImageElement | null;
  if (!el) return;
  const gifs: Record<OrbBlobState, string> = {
    listening: "/ui/blob-listening.gif",
    answering: "/ui/blob-answering.gif",
    static: "/ui/blob-static.gif",
  };
  const target = gifs[state];
  if (el.src && el.src.split("/").pop() === target.split("/").pop()) return;
  el.src = target;
  el.alt = state.charAt(0).toUpperCase() + state.slice(1);
}

function updateOrbBlobFromState() {
  if (!isChatPage()) return;
  if (!isCallConnected()) {
    setOrbBlobState("static");
    return;
  }
  if (document.body.classList.contains("eva-speaking")) {
    setOrbBlobState("static");
    return;
  }
  if ((window as any).__orbUserSpeaking) {
    setOrbBlobState("answering");
    return;
  }
  setOrbBlobState("listening");
  const dateTextEl = document.getElementById("transcription-display");
  if (dateTextEl) dateTextEl.textContent = "Listening...";
}

function normalizeMessage(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseInboundChatLine(from: string, text: string) {
  let speaker = from;
  let line = text.trim();
  if (/^you:\s*/i.test(line)) {
    speaker = "You";
    line = line.replace(/^you:\s*/i, "").trim();
  } else if (/^elevenlabs:\s*/i.test(line)) {
    speaker = "Agent";
    line = line.replace(/^elevenlabs:\s*/i, "").trim();
  }
  return { from: speaker, text: line };
}

function normalizeAddressVerifyUserSpeech(message: string) {
  let normalized = normalizeMessage(message);
  if (normalized.startsWith("you ")) {
    normalized = normalized.slice(4).trim();
  }
  return normalized;
}

function isLikelyEvaSpeaker(from: string) {
  if (isLikelyUserSpeaker(from)) return false;

  const normalizedFrom = normalizeMessage(from);
  if (!normalizedFrom) return true;

  // Treat most non-user inbound speakers as EVA/assistant.
  return true;
}

function isHomeLoanJourneyIntentMessage(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (normalized.includes("home loan") || normalized.includes("housing loan"))
    return true;
  if (
    containsAny(normalized, [
      "know about my home loan",
      "about my home loan",
      "my home loan",
      "home loan summary",
      "home loan details",
      "home loan status",
      "home loan balance",
      "home loan account",
      "home loan information",
    ])
  ) {
    return true;
  }
  return /\bhome\s+loan\b/.test(normalized);
}

function isLoanJourneyIntentMessage(message: string) {
  if (isHomeLoanJourneyIntentMessage(message)) return false;

  const raw = message.toLowerCase().trim();
  const normalized = normalizeMessage(message);
  if (!raw && !normalized) return false;

  if (/\b(loans?|mortgage|lending)\b/.test(raw)) return true;
  if (
    /\b(home|housing|personal|car|auto|education|student|gold|business|lap)\s+loans?\b/.test(
      raw,
    )
  )
    return true;

  if (normalized.includes("home loan") || normalized.includes("housing loan"))
    return true;
  if (normalized.includes("personal loan")) return true;

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.includes("loan") || tokens.includes("loans")) return true;

  return false;
}

async function publishConvaiMicSuppress(suppress: boolean) {
  if (!currentRoom) return;
  try {
    await currentRoom.localParticipant.publishData(
      new TextEncoder().encode(
        JSON.stringify({ eva: "suppress-convai-mic", suppress }),
      ),
      { reliable: true },
    );
  } catch (error: any) {
    appendLog(
      `[convai] mic suppress publish failed: ${error?.message ?? error}`,
    );
  }
}

async function triggerLoanJourneyFromN8n(userMessage: string) {
  if (!isLoanJourneyIntentMessage(userMessage)) return false;
  if (isLoanJourneyInProgress) return true;

  isLoanJourneyInProgress = true;
  await publishConvaiMicSuppress(true);
  try {
    const fallbackName =
      localStorage.getItem(MATCHED_USER_NAME_STORAGE_KEY)?.trim() || "";
    const room = currentRoom?.name || "";
    const resp = await fetch("/api/n8n/loan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: userMessage,
        name: fallbackName,
        room,
      }),
    });
    const payload = (await resp.json().catch(() => ({}))) as {
      response?: string;
      error?: string;
      raw?: unknown;
    };
    if (!resp.ok) {
      appendLog(
        `[n8n] loan journey webhook failed: ${payload?.error || resp.statusText}`,
      );
      showStatus(
        "error",
        String(payload?.error || "Loan service unavailable. Please try again."),
      );
      return true;
    }

    let webhookPrompt = String(payload?.response || "").trim();
    if (!webhookPrompt) {
      webhookPrompt = extractFirstStringFromN8nPayload(
        (payload as { raw?: unknown }).raw ?? payload,
      );
    }
    if (!webhookPrompt) {
      appendLog("[n8n] loan journey webhook returned empty response");
      showStatus(
        "error",
        "Loan service returned no instructions. Please try again.",
      );
      return true;
    }

    if (currentRoom) {
      currentRoom.localParticipant.sendText(webhookPrompt, {
        topic: "lk.chat",
      });
      appendLog("[n8n] loan journey prompt sent to lk.chat");
    } else if (isChatPage() && isCallConnected()) {
      postCrossPageMessage({ type: "chat-outbound", message: webhookPrompt });
      appendLog("[n8n] loan journey prompt forwarded to call page");
    }
    return true;
  } catch (error: any) {
    appendLog(`[n8n] loan journey webhook error: ${error?.message ?? error}`);
    showStatus("error", "Loan service request failed. Please try again.");
    return true;
  } finally {
    await publishConvaiMicSuppress(false);
    isLoanJourneyInProgress = false;
  }
}

function isGeneratedJourneyIntentMessage(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (isSendMoneyIntentMessage(message)) return true;
  if (isHomeLoanJourneyIntentMessage(message)) return true;
  if (isCashWithdrawIntentMessage(message)) return true;
  if (isAddressChangeIntentMessage(message)) return true;
  if (isUserForexCardIntent(normalized)) return true;
  if (normalized.includes("i want to apply for a forex card")) return true;
  if (
    normalized.includes("forex card") &&
    /apply|want|need|get|interested/.test(normalized)
  ) {
    return true;
  }
  return false;
}

function isActiveGeneratedJourneyContext(): boolean {
  if (isLoanJourneyInProgress || isLiveSearchInProgress) return true;
  if (activeJourney && !activeJourneyComplete) return true;

  if (sendMoneyJourneyActive && !hasShownSendMoneySuccessScreen) return true;
  if (homeLoanJourneyActive && !hasShownHomeLoanPrepaymentAdjustedScreen)
    return true;
  if (cashWithdrawJourneyActive && !hasShownCashWithdrawCollectScreen)
    return true;
  if (
    addressJourneyActive &&
    !hasShownAddressRequestSubmittedScreen &&
    !hasShownFaceScanScreen
  ) {
    return true;
  }
  if (
    isForexJourneyInProgress() &&
    !document.body.classList.contains("best-card-stage")
  ) {
    return true;
  }
  return false;
}

function shouldRouteUserMessageToLiveSearch(message: string): boolean {
  if (!message.trim()) return false;
  if (isHomeLoanJourneyIntentMessage(message)) return false;
  if (isLoanJourneyIntentMessage(message)) return false;
  const normalized = normalizeMessage(message);
  // A specific Forex Card request always runs the Forex journey, never live search.
  if (isUserForexCardIntent(normalized)) return false;
  // Other scripted journeys (send money, cash withdraw, address change…) win too.
  if (isGeneratedJourneyIntentMessage(message)) return false;

  // Rule 1: live-chat is ONLY for bank-related products/services. Anything that
  // isn't about a banking product/topic must never open the panel.
  if (!isBankProductQuestion(normalized)) return false;

  // A general "card"/"cards" question goes to live search, even mid-journey —
  // the user explicitly changed topic to a card query.
  if (isGeneralCardQuestion(normalized)) return true;
  // While the live-chat panel is open, a further bank-product question is a topic
  // change that must refresh the panel — even if a previous search is still
  // resolving (the newer topic supersedes it).
  if (isLiveSearchPanelActive()) return true;
  if (isActiveGeneratedJourneyContext()) return false;
  return true;
}

async function maybeTriggerLiveSearchFromN8n(
  userMessage: string,
): Promise<boolean> {
  if (!shouldRouteUserMessageToLiveSearch(userMessage)) return false;
  return triggerLiveSearchFromN8n(userMessage);
}

async function triggerLiveSearchFromN8n(userMessage: string): Promise<boolean> {
  if (!userMessage.trim()) return false;

  // Each call gets a fresh id. If the user changes topic while a request is still
  // in flight, the newer call wins and the stale response is ignored — so the
  // panel always reflects the latest topic.
  const requestId = ++liveSearchRequestSeq;
  isLiveSearchInProgress = true;
  // Step 1 — surface the panel immediately and reset it to the loading state for
  // the new topic; Eva's answer (n8n or spoken) will fill it.
  showWelcomeLoanBlankPanelStage();
  setLoanBlankPanelLoading();
  awaitingEvaLiveSearchPanelAnswer = true;
  try {
    const fallbackName =
      localStorage.getItem(MATCHED_USER_NAME_STORAGE_KEY)?.trim() || "";
    const room = currentRoom?.name || "";
    const resp = await fetch("/api/n8n/live-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: userMessage,
        name: fallbackName,
        room,
      }),
    });

    // A newer topic superseded this request — drop the stale answer entirely.
    if (requestId !== liveSearchRequestSeq) {
      appendLog(
        "[n8n] live search response ignored (superseded by newer topic)",
      );
      return true;
    }

    const payload = (await resp.json().catch(() => ({}))) as {
      response?: string;
      error?: string;
      raw?: unknown;
    };

    if (requestId !== liveSearchRequestSeq) {
      appendLog(
        "[n8n] live search response ignored (superseded by newer topic)",
      );
      return true;
    }

    let webhookPrompt = "";
    if (resp.ok) {
      webhookPrompt = String(payload?.response || "").trim();
      if (!webhookPrompt) {
        webhookPrompt = extractFirstStringFromN8nPayload(
          (payload as { raw?: unknown }).raw ?? payload,
        );
      }
    } else {
      appendLog(
        `[n8n] live search webhook failed: ${payload?.error || resp.statusText}`,
      );
    }

    if (webhookPrompt) {
      // n8n returned a usable answer — render it and have Eva speak it.
      awaitingEvaLiveSearchPanelAnswer = false;
      renderLoanBlankPanelAnswer(
        webhookPrompt,
        (payload as { raw?: unknown }).raw,
      );
      await publishConvaiMicSuppress(true);
      if (currentRoom) {
        currentRoom.localParticipant.sendText(webhookPrompt, {
          topic: "lk.chat",
        });
        appendLog("[n8n] live search prompt sent to lk.chat");
      } else if (isChatPage() && isCallConnected()) {
        postCrossPageMessage({ type: "chat-outbound", message: webhookPrompt });
        appendLog("[n8n] live search prompt forwarded to call page");
      }
      await publishConvaiMicSuppress(false);
      return true;
    }

    // Webhook empty or unavailable — keep the panel open and wait for Eva's
    // natural spoken response (ConvAI) to populate title / paragraph / bullets.
    appendLog(
      "[n8n] live search webhook empty — waiting for Eva response in panel",
    );
    return true;
  } catch (error: any) {
    appendLog(
      `[n8n] live search webhook error: ${error?.message ?? error} — waiting for Eva response`,
    );
    return true;
  } finally {
    // Only the most recent request clears the in-progress flag.
    if (requestId === liveSearchRequestSeq) {
      isLiveSearchInProgress = false;
    }
  }
}

// ── Live-search panel (loan-blank-panel-showcase) ──────────────────────────

const LOAN_BLANK_PANEL_STAGE_SIBLINGS = [
  "forex-stage",
  "details-stage",
  "best-card-stage",
  "address-stage",
  "address-consent-stage",
  "address-next-stage",
  "address-verified-success-stage",
  "address-select-stage",
  "address-select-confirm",
  "address-select-review",
  "self-verify-stage",
  "face-scan-stage",
  "address-request-submitted-stage",
  "cash-withdraw-stage",
  "cash-withdraw-consent-stage",
  "cash-withdraw-debit-slot-stage",
  "cash-withdraw-bank-details-stage",
  "otp-verify-stage",
  "send-money-payee-stage",
  "send-money-payee-suggest-stage",
  "send-money-payee-list-stage",
  "send-money-amount-stage",
  "send-money-account-selected-stage",
  "send-money-when-stage",
  "send-money-preview-stage",
  "send-money-success-stage",
];

/**
 * Fully tear down the live-chat panel: hide it and invalidate any in-flight n8n
 * request so a late answer can't repopulate it after the user switched away.
 */
function deactivateLiveSearchPanel() {
  document.body.classList.remove("loan-blank-panel-stage");
  awaitingEvaLiveSearchPanelAnswer = false;
  liveSearchRequestSeq++;
  isLiveSearchInProgress = false;
}

function showWelcomeLoanBlankPanelStage() {
  if (!isJourneyPage()) return;
  // Req: when hdfc live-chat is active, ONLY the panel should be visible — reset
  // every scripted journey's state so nothing lingers behind the panel.
  resetOtherJourneysExcept(null);
  document.body.classList.add("eva-started", "loan-blank-panel-stage");
  document.body.classList.remove(...LOAN_BLANK_PANEL_STAGE_SIBLINGS);
  setChatInputBoxVisible(true);
  appendLog("[Welcome] Live search — loan-blank-panel shown");
}

interface LoanBlankPanelSections {
  title: string;
  paragraph: string;
  bullets: string[];
}

function setLoanBlankPanelLoading() {
  renderLoanBlankPanelSections({
    title: "One moment\u2026",
    paragraph: "",
    bullets: [],
  });
}

/**
 * Filler / acknowledgement lines Eva speaks *before* the real answer (often while
 * a tool like `hdfc_live_search` is running). We skip these so the panel waits
 * for the substantive reply that follows.
 */
function isLiveSearchFillerLine(normalized: string): boolean {
  if (!normalized) return true;
  return containsAny(normalized, [
    "fetching",
    "fetch information",
    "let me get",
    "let me check",
    "let me find",
    "let me look",
    "looking up",
    "looking into",
    "checking that",
    "searching",
    "one moment",
    "give me a moment",
    "just a moment",
    "hold on",
    "please wait",
    "i will find",
    "i will get",
    "i am getting",
    "i am fetching",
    "getting that information",
    "pulling up",
  ]);
}

function tryRenderEvaAnswerInLiveSearchPanel(
  from: string,
  message: string,
): boolean {
  if (!isWelcomePage()) return false;
  if (isLikelyUserSpeaker(from)) return false;
  // Only capture an Eva utterance after a live search starts, and stop after the
  // first real answer so trailing follow-ups ("Anything else?") don't overwrite it.
  if (!awaitingEvaLiveSearchPanelAnswer) return false;

  const text = stripMoodTags(message);
  if (!text || text.length < 8) return false;

  // Skip the "I am fetching information…" acknowledgement; wait for the real reply.
  if (isLiveSearchFillerLine(normalizeMessage(text))) {
    appendLog(
      `[Welcome] Live search — skipping Eva filler line: "${text.slice(0, 80)}"`,
    );
    return false;
  }

  awaitingEvaLiveSearchPanelAnswer = false;
  renderLoanBlankPanelAnswer(text, undefined);
  appendLog(
    `[Welcome] Live search panel filled from Eva transcription: "${text.slice(0, 120)}"`,
  );
  return true;
}

function renderLoanBlankPanelAnswer(answer: string, raw: unknown) {
  const sections = parseLiveSearchAnswerSections(answer, raw);
  renderLoanBlankPanelSections(sections);
}

function renderLoanBlankPanelSections(sections: LoanBlankPanelSections) {
  const root = document.getElementById("welcome-loan-blank-panel");
  if (!root) return;

  const titleEl = root.querySelector<HTMLElement>(".loan-blank-panel-title");
  const textEl = root.querySelector<HTMLElement>(".loan-blank-panel-text");
  const listEl = root.querySelector<HTMLElement>(".loan-blank-panel-list");

  const title = sections.title.trim();
  const paragraph = sections.paragraph.trim();
  const bullets = sections.bullets.map((b) => b.trim()).filter(Boolean);

  if (titleEl) {
    titleEl.textContent = title;
    titleEl.style.display = title ? "" : "none";
  }
  if (textEl) {
    textEl.textContent = paragraph;
    textEl.style.display = paragraph ? "" : "none";
  }
  if (listEl) {
    listEl.replaceChildren();
    if (bullets.length) {
      for (const item of bullets) {
        const li = document.createElement("li");
        li.textContent = item;
        listEl.appendChild(li);
      }
      listEl.style.display = "";
    } else {
      listEl.style.display = "none";
    }
  }
}

/**
 * Turns an arbitrary answer (Eva's webhook reply) into the panel's
 * title / paragraph / bullet structure. Prefers structured fields from the
 * raw n8n payload, then falls back to parsing the plain-text answer.
 */
function parseLiveSearchAnswerSections(
  answer: string,
  raw: unknown,
): LoanBlankPanelSections {
  const structured = extractStructuredLiveSearchSections(raw);
  if (structured) return structured;
  return parseLiveSearchPlainText(answer);
}

function extractStructuredLiveSearchSections(
  raw: unknown,
  depth = 0,
): LoanBlankPanelSections | null {
  if (depth > 6 || raw == null || typeof raw !== "object") return null;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = extractStructuredLiveSearchSections(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const readString = (...keys: string[]): string => {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const readBullets = (...keys: string[]): string[] => {
    for (const key of keys) {
      const value = obj[key];
      if (Array.isArray(value)) {
        const items = value
          .map((v) => (typeof v === "string" ? v.trim() : ""))
          .filter(Boolean);
        if (items.length) return items;
      }
    }
    return [];
  };

  const title = readString("title", "heading", "header");
  const paragraph = readString(
    "paragraph",
    "description",
    "summary",
    "body",
    "detail",
    "details",
  );
  const bullets = readBullets(
    "important_details",
    "bullets",
    "points",
    "key_points",
    "list",
    "items",
    "highlights",
    "details",
  );

  if (title || paragraph || bullets.length) {
    return { title, paragraph, bullets };
  }

  // Dig into nested objects (e.g. { data: {...} } / { output: {...} }).
  for (const value of Object.values(obj)) {
    const found = extractStructuredLiveSearchSections(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Max words allowed for an (optional) short heading title. */
const LIVE_SEARCH_TITLE_MAX_WORDS = 5;

function parseLiveSearchPlainText(answer: string): LoanBlankPanelSections {
  const text = stripMoodTags(String(answer || ""))
    .replace(/\r\n/g, "\n")
    .trim();
  if (!text) return { title: "", paragraph: "", bullets: [] };

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const bulletRe = /^(?:[-*•·–]\s+|\d+[.)]\s+)/;
  const stripMarkdown = (s: string) =>
    s
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/^#+\s*/, "")
      .trim();
  const stripTitlePunct = (s: string) =>
    s.replace(/[\s:.\u2013-]+$/, "").trim();
  const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

  const explicitBullets: string[] = [];
  const nonBullet: string[] = [];
  for (const line of lines) {
    if (bulletRe.test(line)) {
      explicitBullets.push(stripMarkdown(line.replace(bulletRe, "")));
    } else {
      nonBullet.push(stripMarkdown(line));
    }
  }

  let title = "";
  let paragraph = "";
  let bullets: string[] = [];

  // (1) Optional short title: only when the first non-bullet line is a brief
  // heading (≤ 5 words) AND there's more content after it. Never compulsory.
  let intro = nonBullet;
  if (
    nonBullet.length &&
    wordCount(nonBullet[0]) <= LIVE_SEARCH_TITLE_MAX_WORDS &&
    (explicitBullets.length > 0 || nonBullet.length > 1)
  ) {
    title = stripTitlePunct(nonBullet[0]);
    intro = nonBullet.slice(1);
  }

  // (3) Explicit list present → those lines are the bullets (steps/benefits/details).
  if (explicitBullets.length) {
    bullets = explicitBullets;
    paragraph = intro.join(" ").trim();
    return { title, paragraph, bullets };
  }

  // No explicit list — decide between paragraph (lengthy prose) and bullets
  // (multiple short points) from the sentence count.
  const joined = intro.join(" ").trim();
  const sentences = joined
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length <= 2) {
    // (2) Lengthy / descriptive content stays together in the paragraph.
    paragraph = joined;
  } else {
    // (3) Three or more points → lead sentence is the paragraph, the rest are
    // bullets (steps / benefits / details).
    paragraph = sentences[0];
    bullets = sentences.slice(1);
  }

  return { title, paragraph, bullets };
}

function extractFirstStringFromN8nPayload(node: unknown, depth = 0): string {
  if (depth > 8 || node == null) return "";
  if (typeof node === "string") {
    const t = node.trim();
    return t.length > 0 ? t : "";
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = extractFirstStringFromN8nPayload(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof node === "object") {
    const preferred = [
      "response",
      "message",
      "text",
      "output",
      "reply",
      "content",
      "answer",
      "result",
      "prompt",
      "body",
    ];
    const obj = node as Record<string, unknown>;
    for (const key of preferred) {
      if (key in obj) {
        const found = extractFirstStringFromN8nPayload(obj[key], depth + 1);
        if (found) return found;
      }
    }
    for (const val of Object.values(obj)) {
      const found = extractFirstStringFromN8nPayload(val, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function updateWelcomeCopyFromEva(from: string, message: string) {
  if (!isWelcomePage() || isLikelyUserSpeaker(from)) return;
  if (tryRenderEvaAnswerInLiveSearchPanel(from, message)) return;
  const normalized = normalizeMessage(message);
  if (!normalized) return;

  const body = document.body;
  const welcomeLine = document.getElementById("welcome-line");
  const fallbackName = localStorage
    .getItem(MATCHED_USER_NAME_STORAGE_KEY)
    ?.trim();

  const hasIntro =
    normalized.includes("welcome") ||
    normalized.includes("i am eva") ||
    normalized.includes("i m eva") ||
    normalized.includes("im eva") ||
    normalized.includes("all new smart ai assistant");

  if (hasIntro) {
    setChatInputBoxVisible(true);
    const nameMatch = message.match(/welcome\s+([^!.\n]+)[!.\n]?/i);
    if (welcomeLine) {
      const speechName = nameMatch?.[1]?.trim();
      const name = speechName || fallbackName || "";
      welcomeLine.textContent = name ? `Welcome ${name}! 👋` : "Welcome! 👋";
    }
  }

  if (normalized.includes("how may i help you today")) {
    body.classList.add("eva-help-visible");
  }

  if (shouldAskWelcomeBestSuitedConsent(normalized)) {
    body.classList.add("eva-started");
    hasAskedWelcomeBestSuitedConsent = true;
  }

  // Send-money journey — react to Eva cues first so the dedicated steps win
  // over generic forex/address detectors that share keywords like "amount".
  if (tryShowSendMoneyFromEvaSpeech(message)) {
    return;
  }

  if (tryShowHomeLoanFromEvaSpeech(message)) {
    return;
  }

  // Forex journey (screens 1–3) — handle before address-change steps so address STT never blocks cards.
  if (shouldShowWelcomeForexStage(normalized)) {
    showWelcomeForexStage();
    setChatInputBoxVisible(true);
    return;
  }

  if (isWelcomeDetailsKickoffText(normalized)) {
    hasConfirmedWelcomeBestSuitedConsent = true;
  }

  if (
    !addressJourneyActive &&
    hasShownWelcomeForexScreen &&
    !hasShownWelcomeDetailsScreen &&
    shouldShowWelcomeDetailsStage(normalized)
  ) {
    hasConfirmedWelcomeBestSuitedConsent = true;
    showWelcomeDetailsStage();
    setChatInputBoxVisible(true);
    return;
  }

  if (
    !addressJourneyActive &&
    isWelcomeBestCardAnnouncement(normalized) &&
    hasShownWelcomeDetailsScreen
  ) {
    showWelcomeBestCardStage();
    setChatInputBoxVisible(true);
    return;
  }

  if (isForexJourneyInProgress()) return;

  // Address-change journey — only after forex flow is finished or user chose address.
  if (shouldShowAddressVerifiedSuccessFromEva(normalized)) {
    showWelcomeAddressVerifiedSuccessStage();
    return;
  }

  if (shouldShowAddressSelectFromEva(normalized)) {
    showWelcomeAddressSelectStage();
    return;
  }

  if (shouldShowSelfVerifyMethodsFromEva(normalized)) {
    showWelcomeSelfVerifyMethodsStage();
    return;
  }

  if (shouldShowFaceScanFromEva(normalized)) {
    showWelcomeFaceScanStage({ force: true });
    return;
  }

  if (shouldShowAddressVerifyStageFromEva(normalized)) {
    startAddressChangeJourney();
    return;
  }

  if (
    addressVerifyMethodChosen &&
    shouldMarkAddressConsentAskedFromEva(normalized)
  ) {
    showWelcomeAddressConsentStageFromEva();
  }
}

function resetWelcomeDetailOptionCards() {
  document
    .querySelectorAll(
      "#welcome-travel-details-needed-grid .travel-details-needed-card",
    )
    .forEach((el) => {
      const card = el as HTMLElement;
      card.classList.remove("travel-details-needed-card--active");
      card.setAttribute("aria-pressed", "false");
    });
}

function resetWelcomeStage() {
  if (!isJourneyPage()) return;
  document.body.classList.remove(
    "eva-started",
    "eva-help-visible",
    "eva-speaking",
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
    "cash-withdraw-stage",
    "cash-withdraw-consent-stage",
    "cash-withdraw-debit-slot-stage",
    "cash-withdraw-bank-details-stage",
    "otp-verify-stage",
    "send-money-payee-stage",
    "send-money-payee-suggest-stage",
    "send-money-payee-list-stage",
    "send-money-amount-stage",
    "send-money-account-selected-stage",
    "send-money-when-stage",
    "send-money-preview-stage",
    "send-money-success-stage",
    "loan-blank-panel-stage",
    "loan-active-list-stage",
    "home-loan-summary-stage",
    "loan-payment-received-stage",
    "loan-prepayment-adjusted-stage",
  );
  resetWelcomeFlowState();
  clearWelcomeFaceScanStep9Timer();
  welcomeFaceScanCaptureObserver?.disconnect();
  welcomeFaceScanCaptureObserver = null;
  stopWelcomeFaceScanCamera();
  setChatInputBoxVisible(false);
  const welcomeLine = document.getElementById("welcome-line");
  if (welcomeLine) welcomeLine.textContent = "Welcome! 👋";
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  setWelcomeForexVisibility(false);
  resetWelcomeDetailOptionCards();
  clearWelcomeVerifyMethodSelection();
  resetWelcomeAddressSelectCards();
  resetWelcomeSelfVerifyMethodCards();
  hasShownFaceScanScreen = false;
  hasShownAddressRequestSubmittedScreen = false;
  pendingEvaRequestSubmittedCopy = null;
  welcomeFaceCaptureHandled = false;
  activeJourney = null;
  activeJourneyComplete = false;
  lastUiShowScreenId = null;
  lastUiShowScreenAt = 0;
}

function isForexJourneyInProgress() {
  if (addressJourneyActive) return false;
  return (
    hasShownWelcomeForexScreen ||
    document.body.classList.contains("forex-stage") ||
    document.body.classList.contains("details-stage") ||
    document.body.classList.contains("best-card-stage")
  );
}

function isUserForexCardIntent(normalized: string) {
  if (!normalized) return false;
  if (
    normalized.includes("forex card") ||
    normalized.includes("travel card") ||
    normalized.includes("forexplus")
  ) {
    return containsAny(normalized, [
      "apply",
      "want",
      "need",
      "get",
      "interested",
      "like",
      "forex",
    ]);
  }
  if (
    normalized.includes("forex") &&
    containsAny(normalized, ["card", "apply", "want", "need", "get"])
  ) {
    return true;
  }
  return false;
}

// A general "card"/"cards" question (e.g. "tell me about your credit cards") that
// is NOT specifically about a Forex card. These route to live search instead of
// starting the Forex journey.
function isForexSpecificCardMention(normalized: string) {
  return containsAny(normalized, [
    "forex",
    "forexplus",
    "forex plus",
    "travel card",
    "multicurrency",
    "multi currency",
    "multi-currency",
  ]);
}

function isGeneralCardQuestion(normalized: string) {
  if (!normalized) return false;
  if (!/\bcards?\b/.test(normalized)) return false;
  if (isForexSpecificCardMention(normalized)) return false;
  return true;
}

/**
 * Rule 1: live-chat (loan-blank-panel) is only for BANK-related products/services.
 * Returns true when the user's message is about an HDFC banking product, service,
 * or general banking topic — so unrelated chit-chat never opens the panel.
 */
const BANK_PRODUCT_KEYWORDS = [
  // accounts & banking basics
  "account",
  "savings",
  "current account",
  "salary account",
  "bank",
  "banking",
  "branch",
  "ifsc",
  "passbook",
  "cheque",
  "cheque book",
  "statement",
  "balance",
  "kyc",
  "nominee",
  "minimum balance",
  // cards
  "card",
  "cards",
  "credit card",
  "debit card",
  "forex card",
  "travel card",
  "rupay",
  "visa",
  "mastercard",
  // loans
  "loan",
  "loans",
  "home loan",
  "personal loan",
  "car loan",
  "auto loan",
  "gold loan",
  "education loan",
  "business loan",
  "top up loan",
  "top-up loan",
  "emi",
  "overdraft",
  "mortgage",
  "interest rate",
  "eligibility",
  "tenure",
  // payments & transfers
  "payment",
  "transfer",
  "fund transfer",
  "neft",
  "rtgs",
  "imps",
  "upi",
  "send money",
  "remittance",
  "bill pay",
  "autopay",
  "standing instruction",
  // investments & insurance
  "fixed deposit",
  "fd",
  "recurring deposit",
  "rd",
  "deposit",
  "mutual fund",
  "sip",
  "investment",
  "insurance",
  "demat",
  "trading",
  "locker",
  "ppf",
  // digital / service
  "netbanking",
  "net banking",
  "mobile banking",
  "rewards",
  "cashback",
  "lounge",
  "offer",
  "charges",
  "fees",
  "reward points",
];

function isBankProductQuestion(normalized: string): boolean {
  if (!normalized) return false;
  return containsAny(normalized, BANK_PRODUCT_KEYWORDS);
}

function showWelcomeForexStage() {
  if (!isJourneyPage()) {
    return;
  }
  resetOtherJourneysExcept("forex");
  document.body.classList.add("eva-started", "forex-stage");
  hasShownWelcomeForexScreen = true;
  document.body.classList.remove(
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
  );
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  setWelcomeForexVisibility(true);
  resetWelcomeDetailOptionCards();
}

function showWelcomeAddressVerifyStage() {
  if (!isJourneyPage()) return;
  document.body.classList.add(
    "eva-started",
    "eva-help-visible",
    "address-stage",
  );
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
  );
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(true);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  resetWelcomeDetailOptionCards();
}

function showWelcomeSelfVerifyMethodsStage() {
  if (!isJourneyPage()) return;
  if (
    hasShownSelfVerifyMethodsScreen &&
    document.body.classList.contains("self-verify-stage")
  )
    return;
  document.body.classList.add(
    "eva-started",
    "eva-help-visible",
    "self-verify-stage",
  );
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "face-scan-stage",
    "address-request-submitted-stage",
  );
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(true);
  setWelcomeAddressRequestSubmittedVisibility(false);
  hasShownSelfVerifyMethodsScreen = true;
  resetWelcomeDetailOptionCards();
  resetWelcomeSelfVerifyMethodCards();
  setChatInputBoxVisible(true);
  setWelcomeFaceScanVisibility(false);
  stopWelcomeFaceScanCamera();
  appendLog("[Welcome] Self-verify methods stage shown (step 7)");
}

function setWelcomeSelfVerifyFaceAuthActive() {
  if (!isJourneyPage()) return;
  const grid = document.getElementById("welcome-self-verify-methods-grid");
  if (!grid) return;
  grid.querySelectorAll<HTMLElement>(".verify-method-card").forEach((card) => {
    const active = card.dataset.method === "face-auth";
    card.classList.toggle("active", active);
    card.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function startWelcomeFaceScanCamera() {
  if (!isJourneyPage()) return;
  const viewportId = "#welcome-face-scan-viewport";
  window.initFaceScanCameras?.();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.startFaceScanViewport?.(viewportId);
    });
  });
}

function stopWelcomeFaceScanCamera() {
  if (!isJourneyPage()) return;
  window.stopFaceScanViewport?.("#welcome-face-scan-viewport");
}

function showWelcomeFaceScanStage(options?: { force?: boolean }) {
  if (!isJourneyPage()) return;
  if (document.body.classList.contains("face-scan-stage")) return;
  if (!options?.force && !isReadyForFaceScanScreen()) {
    appendLog("[Welcome] Step 8 blocked — self-verify stage not ready yet");
    return;
  }

  document.body.classList.add(
    "eva-started",
    "eva-help-visible",
    "face-scan-stage",
  );
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "address-request-submitted-stage",
  );
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  setWelcomeFaceScanVisibility(true);
  setWelcomeSelfVerifyFaceAuthActive();
  hasShownFaceScanScreen = true;
  pendingEvaRequestSubmittedCopy = null;
  setChatInputBoxVisible(true);
  bindWelcomeFaceScanCaptureHandlers();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      startWelcomeFaceScanCamera();
    });
  });
  appendLog("[Welcome] Face scan stage shown (step 8)");
}

function activateWelcomeFaceAuthChoice() {
  if (!isJourneyPage()) return;
  if (!hasShownSelfVerifyMethodsScreen) {
    hasShownSelfVerifyMethodsScreen = true;
    document.body.classList.add(
      "eva-started",
      "eva-help-visible",
      "self-verify-stage",
    );
    setWelcomeSelfVerifyMethodsVisibility(true);
  }
  setWelcomeSelfVerifyFaceAuthActive();
  showWelcomeFaceScanStage({ force: true });
}

function clearWelcomeFaceScanStep9Timer() {
  if (!isJourneyPage()) return;
  if (faceScanStep9Timer) {
    clearTimeout(faceScanStep9Timer);
    faceScanStep9Timer = null;
  }
}

function syncWelcomeAddressRequestSubmittedCopy() {
  if (!isJourneyPage()) return;
  const addrEl = document.getElementById("welcome-address-request-new-address");
  if (!addrEl) return;
  addrEl.textContent = WELCOME_ADDRESS_REVIEW_DISPLAY;
}

function showWelcomeAddressRequestSubmittedStage() {
  if (!isJourneyPage()) return;
  if (
    hasShownAddressRequestSubmittedScreen &&
    document.body.classList.contains("address-request-submitted-stage")
  ) {
    return;
  }
  clearWelcomeFaceScanStep9Timer();
  welcomeFaceScanCaptureObserver?.disconnect();
  welcomeFaceScanCaptureObserver = null;
  stopWelcomeFaceScanCamera();
  syncWelcomeAddressRequestSubmittedCopy();
  document.body.classList.add(
    "eva-started",
    "eva-help-visible",
    "address-request-submitted-stage",
  );
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
  );
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(true);
  hasShownAddressRequestSubmittedScreen = true;
  applyWelcomeAddressRequestSubmittedEvaCopy();
  setChatInputBoxVisible(true);
  appendLog("[Welcome] Request submitted stage shown (step 9)");
}

function scheduleWelcomeAddressRequestSubmittedAfterFaceCapture() {
  if (!isJourneyPage() || hasShownAddressRequestSubmittedScreen) return;
  clearWelcomeFaceScanStep9Timer();
  appendLog(
    `[Welcome] Face captured — step 9 in ${WELCOME_FACE_SCAN_TO_STEP9_MS}ms`,
  );
  faceScanStep9Timer = window.setTimeout(() => {
    faceScanStep9Timer = null;
    showWelcomeAddressRequestSubmittedStage();
  }, WELCOME_FACE_SCAN_TO_STEP9_MS);
}

let welcomeFaceScanCaptureObserver: MutationObserver | null = null;

function onWelcomeFaceScanCaptured() {
  if (welcomeFaceCaptureHandled || hasShownAddressRequestSubmittedScreen)
    return;
  welcomeFaceCaptureHandled = true;
  scheduleWelcomeAddressRequestSubmittedAfterFaceCapture();
}

function bindWelcomeFaceScanCaptureHandlers() {
  const viewport = document.getElementById("welcome-face-scan-viewport");
  if (!viewport) return;

  if (!welcomeFaceScanCaptureListenerBound) {
    welcomeFaceScanCaptureListenerBound = true;
    document.addEventListener("face-scan-captured", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest("#welcome-face-scan-viewport")) return;
      onWelcomeFaceScanCaptured();
    });
  }

  welcomeFaceScanCaptureObserver?.disconnect();
  welcomeFaceScanCaptureObserver = new MutationObserver(() => {
    if (!viewport.classList.contains("is-captured")) return;
    welcomeFaceScanCaptureObserver?.disconnect();
    welcomeFaceScanCaptureObserver = null;
    onWelcomeFaceScanCaptured();
  });
  welcomeFaceScanCaptureObserver.observe(viewport, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

function initWelcomeFaceScanCaptureListener() {
  if (!isJourneyPage()) return;
  bindWelcomeFaceScanCaptureHandlers();
}

function initWelcomeAddressRequestCopyButtons() {
  document
    .querySelectorAll(
      "#address-request-submitted-showcase .address-request-copy[data-copy-target]",
    )
    .forEach((btn) => {
      if ((btn as HTMLElement).dataset.copyBound === "true") return;
      (btn as HTMLElement).dataset.copyBound = "true";
      btn.addEventListener("click", async () => {
        const target = document.getElementById(
          btn.getAttribute("data-copy-target") || "",
        );
        const text = target?.textContent?.trim();
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          btn.classList.add("is-copied");
          window.setTimeout(() => btn.classList.remove("is-copied"), 1200);
        } catch {
          /* clipboard unavailable */
        }
      });
    });
}

function startAddressChangeJourney(options?: { force?: boolean }) {
  if (!isJourneyPage()) return;
  if (!options?.force && isForexJourneyInProgress()) return;
  if (
    hasShownAddressVerifyScreen &&
    document.body.classList.contains("address-stage")
  )
    return;
  // Do not rewind consent / verify / success if Eva repeats an address-change prompt mid-flow.
  if (
    hasShownAddressConsentScreen ||
    hasShownAddressNextScreen ||
    hasShownAddressVerifiedSuccessScreen ||
    hasShownAddressSelectScreen ||
    document.body.classList.contains("address-consent-stage") ||
    document.body.classList.contains("address-next-stage") ||
    document.body.classList.contains("address-verified-success-stage") ||
    document.body.classList.contains("address-select-stage") ||
    document.body.classList.contains("self-verify-stage") ||
    document.body.classList.contains("face-scan-stage") ||
    hasShownSelfVerifyMethodsScreen ||
    hasShownFaceScanScreen ||
    hasShownAddressRequestSubmittedScreen ||
    document.body.classList.contains("address-request-submitted-stage")
  ) {
    return;
  }
  resetOtherJourneysExcept("address");
  showWelcomeAddressVerifyStage();
  hasShownAddressVerifyScreen = true;
  addressJourneyActive = true;
  resetAddressConsentFlowState();
  clearWelcomeVerifyMethodSelection();
  setChatInputBoxVisible(true);
  appendLog(
    "[Welcome] Address change journey — showing verify-methods (step 1)",
  );
}

// ── Withdraw-money journey ────────────────────────────────────────────────
// Six-step flow that mirrors the forex / address-change pattern:
//   1) user says "I want to withdraw cash"    → cash-withdraw-showcase
//   2) user says a numeric amount             → cash-withdraw-consent-showcase
//   3) user confirms ("yes proceed")          → cash-withdraw-debit-slot-showcase
//   4) Eva says "insert your debit card …"    → cash-withdraw-bank-details (after 3s)
//   5) user confirms ("yes proceed")          → otp-verify-showcase
//   6) user enters any 6-digit OTP            → cash-withdraw-bank-details (collect-cash variant)

function isCashWithdrawIntentMessage(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "i want to withdraw cash",
      "want to withdraw cash",
      "i want to withdraw money",
      "want to withdraw money",
      "i need to withdraw cash",
      "i need to withdraw money",
      "i would like to withdraw cash",
      "i would like to withdraw money",
      "withdraw cash",
      "withdraw money",
      "cash withdrawal",
      "cash withdraw",
      "withdraw some cash",
      "withdraw some money",
      "i want cash",
      "i need cash",
      "cash nikalna",
      "paise nikalna",
      "paisa nikalna",
    ])
  ) {
    return true;
  }
  if (!containsAny(normalized, ["withdraw", "withdrawal", "nikal"]))
    return false;
  return containsAny(normalized, [
    "cash",
    "money",
    "rupees",
    "rupee",
    "paise",
    "paisa",
    "rs",
    "inr",
    "i want",
    "i need",
    "i would",
    "want to",
    "need to",
    "like to",
    "help me",
    "please",
  ]);
}

function extractCashWithdrawAmount(message: string): number | null {
  if (!message) return null;
  // Remove commas inside numbers (e.g. "5,000" → "5000") then find the
  // first multi-digit run. We also accept short-hand like "5k" or "10K".
  const cleaned = message.replace(/(\d),(?=\d)/g, "$1");
  const shortHand = cleaned.match(/(\d+(?:\.\d+)?)\s*k\b/i);
  if (shortHand) {
    const v = Math.round(parseFloat(shortHand[1]) * 1000);
    if (Number.isFinite(v) && v >= 100) return v;
  }
  const direct = cleaned.match(/\d{2,7}/);
  if (!direct) return null;
  const value = Number(direct[0]);
  if (!Number.isFinite(value) || value <= 0) return null;
  // Treat very small amounts (e.g. "I want to withdraw 5") as not enough
  // information — wait for the user to give a real INR amount.
  if (value < 100) return null;
  return value;
}

function extractOtpCode(message: string): string | null {
  if (!message) return null;
  // Allow OTPs spoken with spaces between digits e.g. "1 2 3 4 5 6".
  const compact = message.replace(/[^0-9]/g, "");
  const match = compact.match(/\d{6}/);
  return match ? match[0] : null;
}

function isCashWithdrawProceedMessage(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "yes proceed",
      "proceed",
      "yes please proceed",
      "lets proceed",
      "please proceed",
      "go ahead",
      "continue",
      "confirm",
      "yes confirm",
      "okay proceed",
    ])
  ) {
    return true;
  }
  return isPositiveIntent(normalized);
}

function isEvaInsertDebitCardCue(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (!containsAny(normalized, ["insert", "put", "place"])) return false;
  if (!containsAny(normalized, ["debit card", "card"])) return false;
  return containsAny(normalized, [
    "card slot",
    "slot",
    "in the slot",
    "into the slot",
  ]);
}

function formatCashWithdrawAmount(value: number): string {
  // Indian numbering: ₹6,45,000. Use en-IN locale formatter when available.
  let body: string;
  try {
    body = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
      value,
    );
  } catch {
    body = String(value);
  }
  return `\u20B9${body}`;
}

function clearCashWithdrawDebitSlotTimer() {
  if (cashWithdrawDebitSlotToBankDetailsTimer !== null) {
    clearTimeout(cashWithdrawDebitSlotToBankDetailsTimer);
    cashWithdrawDebitSlotToBankDetailsTimer = null;
  }
}

function resetCashWithdrawFlowState() {
  cashWithdrawJourneyActive = false;
  hasShownCashWithdrawScreen = false;
  hasShownCashWithdrawConsentScreen = false;
  hasShownCashWithdrawDebitSlotScreen = false;
  hasShownCashWithdrawBankDetailsScreen = false;
  hasShownOtpVerifyScreen = false;
  hasShownCashWithdrawCollectScreen = false;
  cashWithdrawAmount = null;
  cashWithdrawInsertCardCueArmed = false;
  clearCashWithdrawDebitSlotTimer();
  applyCashWithdrawBankDetailsVariant(false);
}

function setCashWithdrawConsentAmount(amount: number) {
  cashWithdrawAmount = amount;
  const el = document.getElementById("welcome-cash-withdraw-consent-amount");
  if (el) el.textContent = formatCashWithdrawAmount(amount);
}

function applyCashWithdrawBankDetailsVariant(collectCash: boolean) {
  const title = document.getElementById(
    "welcome-cash-withdraw-bank-details-title",
  );
  const footer = document.getElementById(
    "welcome-cash-withdraw-bank-details-footer",
  );
  const heroImg = document.getElementById(
    "welcome-cash-withdraw-bank-details-hero-img",
  ) as HTMLImageElement | null;
  const rows = document.getElementById(
    "welcome-cash-withdraw-bank-details-rows",
  );
  if (title)
    title.textContent = collectCash
      ? CASH_WITHDRAW_COLLECT_TITLE
      : CASH_WITHDRAW_BANK_DETAILS_DEFAULT_TITLE;
  if (footer)
    footer.textContent = collectCash
      ? CASH_WITHDRAW_COLLECT_FOOTER
      : CASH_WITHDRAW_BANK_DETAILS_DEFAULT_FOOTER;
  if (heroImg)
    heroImg.src = collectCash
      ? CASH_WITHDRAW_COLLECT_HERO
      : CASH_WITHDRAW_BANK_DETAILS_DEFAULT_HERO;
  if (rows) rows.setAttribute("aria-hidden", collectCash ? "true" : "false");
  const section = document.getElementById("welcome-cash-withdraw-bank-details");
  if (section) {
    section.classList.toggle(
      "cash-withdraw-bank-details--collect",
      collectCash,
    );
    section.setAttribute(
      "aria-label",
      collectCash ? "Please collect your cash" : "Details as per bank records",
    );
  }
}

const CASH_WITHDRAW_STAGE_CLASSES = [
  "cash-withdraw-stage",
  "cash-withdraw-consent-stage",
  "cash-withdraw-debit-slot-stage",
  "cash-withdraw-bank-details-stage",
  "otp-verify-stage",
];

function clearOtherJourneyStages() {
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
    "send-money-payee-stage",
    "send-money-payee-suggest-stage",
    "send-money-payee-list-stage",
    "send-money-amount-stage",
    "send-money-account-selected-stage",
    "send-money-when-stage",
    "send-money-preview-stage",
    "send-money-success-stage",
    "loan-blank-panel-stage",
    "loan-active-list-stage",
    "home-loan-summary-stage",
    "loan-payment-received-stage",
    "loan-prepayment-adjusted-stage",
  );
}

function activateCashWithdrawStage(stageClass: string) {
  document.body.classList.add("eva-started", stageClass);
  clearOtherJourneyStages();
  for (const c of CASH_WITHDRAW_STAGE_CLASSES) {
    if (c !== stageClass) document.body.classList.remove(c);
  }
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  setWelcomeForexVisibility(false);
  setChatInputBoxVisible(true);
}

function showWelcomeCashWithdrawStage() {
  if (!isJourneyPage()) return;
  activateCashWithdrawStage("cash-withdraw-stage");
  cashWithdrawJourneyActive = true;
  hasShownCashWithdrawScreen = true;
  applyCashWithdrawBankDetailsVariant(false);
  appendLog("[Welcome] Withdraw-money stage 1 — cash-withdraw screen shown");
}

function showWelcomeCashWithdrawConsentStage(amount?: number) {
  if (!isJourneyPage()) return;
  if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
    setCashWithdrawConsentAmount(amount);
  } else if (cashWithdrawAmount !== null) {
    setCashWithdrawConsentAmount(cashWithdrawAmount);
  }
  activateCashWithdrawStage("cash-withdraw-consent-stage");
  cashWithdrawJourneyActive = true;
  hasShownCashWithdrawConsentScreen = true;
  appendLog(
    `[Welcome] Withdraw-money stage 2 — consent screen shown (amount=${cashWithdrawAmount ?? "—"})`,
  );
}

function showWelcomeCashWithdrawDebitSlotStage() {
  if (!isJourneyPage()) return;
  activateCashWithdrawStage("cash-withdraw-debit-slot-stage");
  cashWithdrawJourneyActive = true;
  hasShownCashWithdrawDebitSlotScreen = true;
  cashWithdrawInsertCardCueArmed = false;
  clearCashWithdrawDebitSlotTimer();
  appendLog("[Welcome] Withdraw-money stage 3 — debit-slot screen shown");
}

function showWelcomeCashWithdrawBankDetailsStage(options?: {
  collectCash?: boolean;
}) {
  if (!isJourneyPage()) return;
  const collectCash = Boolean(options?.collectCash);
  applyCashWithdrawBankDetailsVariant(collectCash);
  activateCashWithdrawStage("cash-withdraw-bank-details-stage");
  cashWithdrawJourneyActive = true;
  hasShownCashWithdrawBankDetailsScreen = true;
  if (collectCash) hasShownCashWithdrawCollectScreen = true;
  clearCashWithdrawDebitSlotTimer();
  appendLog(
    collectCash
      ? "[Welcome] Withdraw-money stage 6 — bank-details (collect cash) shown"
      : "[Welcome] Withdraw-money stage 4 — bank-details shown",
  );
}

function showWelcomeOtpVerifyStage() {
  if (!isJourneyPage()) return;
  activateCashWithdrawStage("otp-verify-stage");
  cashWithdrawJourneyActive = true;
  hasShownOtpVerifyScreen = true;
  clearCashWithdrawDebitSlotTimer();
  appendLog("[Welcome] Withdraw-money stage 5 — otp-verify screen shown");
}

function startCashWithdrawJourney(options?: { force?: boolean }) {
  if (!isJourneyPage()) return;
  if (
    !options?.force &&
    cashWithdrawJourneyActive &&
    hasShownCashWithdrawScreen
  )
    return;
  resetOtherJourneysExcept("cash-withdraw");
  showWelcomeCashWithdrawStage();
}

/**
 * Central "switch journeys" helper. Wipes the body classes, UI visibility and
 * in-memory flags of every journey except `target` so the new journey starts
 * from a clean slate. Called at the entry point of every `start*Journey` /
 * `show*Stage` function that begins a new journey from the welcome page.
 *
 * Without this, switching mid-flow (e.g. user is at `address-select-stage`
 * and says "I want to withdraw cash") would leave the old `address-stage`
 * body class, ARIA attributes and `addressJourneyActive=true` in place,
 * causing the new journey to render on top of stale UI.
 */
function resetOtherJourneysExcept(target: JourneyId | null) {
  if (!isJourneyPage()) return;

  // Switching into a real scripted journey also closes the live-chat panel.
  // (target === null means "reset every journey" and is used by the live-chat
  // panel itself, so we must NOT tear it down in that case.)
  if (target !== null) {
    deactivateLiveSearchPanel();
  }

  if (target !== "address") {
    document.body.classList.remove(
      "address-stage",
      "address-consent-stage",
      "address-next-stage",
      "address-verified-success-stage",
      "address-select-stage",
      "address-select-confirm",
      "address-select-review",
      "self-verify-stage",
      "face-scan-stage",
      "address-request-submitted-stage",
    );
    addressJourneyActive = false;
    hasShownAddressVerifyScreen = false;
    hasShownFaceScanScreen = false;
    hasShownAddressRequestSubmittedScreen = false;
    pendingEvaRequestSubmittedCopy = null;
    welcomeFaceCaptureHandled = false;
    resetAddressConsentFlowState();
    clearWelcomeVerifyMethodSelection();
    resetWelcomeAddressSelectCards();
    resetWelcomeSelfVerifyMethodCards();
    setWelcomeAddressVerifyVisibility(false);
    setWelcomeAddressConsentVisibility(false);
    setWelcomeAddressNextVisibility(false);
    setWelcomeAddressVerifiedSuccessVisibility(false);
    setWelcomeAddressSelectVisibility(false);
    setWelcomeSelfVerifyMethodsVisibility(false);
    setWelcomeFaceScanVisibility(false);
    setWelcomeAddressRequestSubmittedVisibility(false);
    clearWelcomeFaceScanStep9Timer();
    welcomeFaceScanCaptureObserver?.disconnect();
    welcomeFaceScanCaptureObserver = null;
    stopWelcomeFaceScanCamera();
  }

  if (target !== "forex") {
    document.body.classList.remove(
      "forex-stage",
      "details-stage",
      "best-card-stage",
    );
    hasShownWelcomeForexScreen = false;
    hasAskedWelcomeBestSuitedConsent = false;
    hasConfirmedWelcomeBestSuitedConsent = false;
    hasShownWelcomeDetailsScreen = false;
    setWelcomeForexVisibility(false);
    setWelcomeDetailsScreenVisibility(false);
    setWelcomeBestCardScreenVisibility(false);
    resetWelcomeDetailOptionCards();
  }

  if (target !== "cash-withdraw") {
    document.body.classList.remove(...CASH_WITHDRAW_STAGE_CLASSES);
    resetCashWithdrawFlowState();
  }

  if (target !== "send-money") {
    // Don't strip otp-verify-stage here — it's also owned by cash-withdraw.
    // The cash-withdraw branch above already handles otp-verify-stage when
    // switching away from cash-withdraw.
    const sendMoneyOnlyClasses = SEND_MONEY_STAGE_CLASSES.filter(
      (c) => c !== "otp-verify-stage",
    );
    document.body.classList.remove(...sendMoneyOnlyClasses);
    resetSendMoneyFlowState();
  }

  if (target !== "home-loan") {
    const homeLoanOnlyClasses = HOME_LOAN_STAGE_CLASSES.filter(
      (c) => c !== "otp-verify-stage",
    );
    document.body.classList.remove(...homeLoanOnlyClasses);
    if (!cashWithdrawJourneyActive && !sendMoneyJourneyActive) {
      document.body.classList.remove("otp-verify-stage");
    }
    resetHomeLoanFlowState();
  }

  if (activeJourney && activeJourney !== target) {
    setActiveJourney(target, `user_switched_journey → ${target ?? "none"}`);
  }
}

function tryApplyWelcomeCashWithdrawStepFromUserSpeech(
  message: string,
): boolean {
  if (!isWelcomePage()) return false;
  if (!cashWithdrawJourneyActive) return false;

  // Step 6 — OTP entry → final collect-cash screen.
  if (
    document.body.classList.contains("otp-verify-stage") &&
    !hasShownCashWithdrawCollectScreen
  ) {
    const otp = extractOtpCode(message);
    if (otp) {
      appendLog(
        `[Welcome] Withdraw-money: OTP captured (${otp.replace(/.(?=.{2})/g, "*")})`,
      );
      showWelcomeCashWithdrawBankDetailsStage({ collectCash: true });
      return true;
    }
    return false;
  }

  // Step 5 — confirm at bank-details → OTP screen.
  if (
    document.body.classList.contains("cash-withdraw-bank-details-stage") &&
    !hasShownCashWithdrawCollectScreen &&
    !hasShownOtpVerifyScreen &&
    isCashWithdrawProceedMessage(message)
  ) {
    showWelcomeOtpVerifyStage();
    return true;
  }

  // Step 3 — confirm at consent → debit-slot.
  if (
    document.body.classList.contains("cash-withdraw-consent-stage") &&
    !hasShownCashWithdrawDebitSlotScreen &&
    isCashWithdrawProceedMessage(message)
  ) {
    showWelcomeCashWithdrawDebitSlotStage();
    return true;
  }

  // Step 2 — amount at cash-withdraw → consent.
  if (
    document.body.classList.contains("cash-withdraw-stage") &&
    !hasShownCashWithdrawConsentScreen
  ) {
    const amount = extractCashWithdrawAmount(message);
    if (amount !== null) {
      showWelcomeCashWithdrawConsentStage(amount);
      return true;
    }
  }

  return false;
}

function tryArmCashWithdrawInsertCardCueFromEva(text: string) {
  if (!isJourneyPage()) return;
  if (cashWithdrawInsertCardCueArmed) return;
  if (hasShownCashWithdrawBankDetailsScreen) return;
  if (!document.body.classList.contains("cash-withdraw-debit-slot-stage"))
    return;
  if (!isEvaInsertDebitCardCue(text)) return;
  cashWithdrawInsertCardCueArmed = true;
  appendLog(
    `[Welcome] Withdraw-money: Eva insert-card cue heard — bank-details in ${CASH_WITHDRAW_INSERT_CARD_DELAY_MS}ms`,
  );
  clearCashWithdrawDebitSlotTimer();
  cashWithdrawDebitSlotToBankDetailsTimer = window.setTimeout(() => {
    cashWithdrawDebitSlotToBankDetailsTimer = null;
    if (
      cashWithdrawJourneyActive &&
      document.body.classList.contains("cash-withdraw-debit-slot-stage") &&
      !hasShownCashWithdrawBankDetailsScreen
    ) {
      showWelcomeCashWithdrawBankDetailsStage();
    }
  }, CASH_WITHDRAW_INSERT_CARD_DELAY_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Send-money journey
// Step flow:
//   1) Eva: "Whom would you like to send money to?"  → send-money-payee
//   2) user names a payee                            → send-money-payee-suggest
//   3a) user denies suggested payee                  → send-money-payee-list
//   3b) Eva: "Enter the amount you would like to send" → send-money-amount
//   4) Eva: "Choose an account you want to pay from" → send-money-account-selected
//   5) Eva: "Pay now or schedule it for later?"      → send-money-when
//   6) Eva: "Here is your payment preview"           → send-money-preview
//   7) Eva: "I will proceed the payment process"     → otp-verify (send-money variant)
//   8) user enters any 6-digit OTP                   → send-money-success

const SEND_MONEY_STAGE_CLASSES = [
  "send-money-payee-stage",
  "send-money-payee-suggest-stage",
  "send-money-payee-list-stage",
  "send-money-amount-stage",
  "send-money-account-selected-stage",
  "send-money-when-stage",
  "send-money-preview-stage",
  "otp-verify-stage",
  "send-money-success-stage",
];

function clearOtherJourneyStagesForSendMoney() {
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
    "cash-withdraw-stage",
    "cash-withdraw-consent-stage",
    "cash-withdraw-debit-slot-stage",
    "cash-withdraw-bank-details-stage",
    "send-money-success-stage",
    "loan-blank-panel-stage",
    "loan-active-list-stage",
    "home-loan-summary-stage",
    "loan-payment-received-stage",
    "loan-prepayment-adjusted-stage",
  );
}

function activateSendMoneyStage(stageClass: string) {
  document.body.classList.add("eva-started", stageClass);
  clearOtherJourneyStagesForSendMoney();
  for (const c of SEND_MONEY_STAGE_CLASSES) {
    if (c !== stageClass) document.body.classList.remove(c);
  }
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  setWelcomeForexVisibility(false);
  setChatInputBoxVisible(true);
}

function resetSendMoneyFlowState() {
  sendMoneyJourneyActive = false;
  hasShownSendMoneyPayeeScreen = false;
  hasShownSendMoneyPayeeSuggestScreen = false;
  hasShownSendMoneyPayeeListScreen = false;
  hasShownSendMoneyAmountScreen = false;
  hasShownSendMoneyAccountSelectedScreen = false;
  hasShownSendMoneyWhenScreen = false;
  hasShownSendMoneyPreviewScreen = false;
  hasShownSendMoneyOtpVerifyScreen = false;
  hasShownSendMoneySuccessScreen = false;
  sendMoneyPayeeName = null;
  sendMoneyAmount = null;
  sendMoneyRemark = null;
  sendMoneyAccountType = null;
  sendMoneyWhen = null;
  resetSendMoneyPayeeListNames();
  resetSendMoneyAccountActiveCards();
  resetSendMoneyWhenActiveCards();
  setSendMoneyPayeeSuggestName(SEND_MONEY_DEFAULT_PAYEE_NAME);
}

function formatSendMoneyAmount(value: number): string {
  let body: string;
  try {
    body = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
      value,
    );
  } catch {
    body = String(value);
  }
  return `\u20B9${body}`;
}

function setSendMoneyPayeeSuggestName(name: string) {
  const el = document.querySelector<HTMLElement>(
    "#welcome-send-money-payee-suggest .send-money-payee-suggest-name-primary",
  );
  if (el) el.textContent = name;
}

function setSendMoneyPayeeListPlaceholderNames() {
  const cards = document.querySelectorAll<HTMLElement>(
    "#welcome-send-money-payee-list-accounts .send-money-payee-list-card",
  );
  cards.forEach((card, index) => {
    const primary = card.querySelector<HTMLElement>(
      ".send-money-payee-list-name-primary",
    );
    if (!primary) return;
    primary.textContent =
      SEND_MONEY_PAYEE_LIST_PLACEHOLDER_NAMES[index] ??
      `payee name ${index + 1}`;
  });
}

const SEND_MONEY_PAYEE_LIST_DEFAULT_NAMES = [
  "Digvijay Shelar",
  "Digvijay Kumar",
  "Digvijay Enterprises",
];

function resetSendMoneyPayeeListNames() {
  const cards = document.querySelectorAll<HTMLElement>(
    "#welcome-send-money-payee-list-accounts .send-money-payee-list-card",
  );
  cards.forEach((card, index) => {
    const primary = card.querySelector<HTMLElement>(
      ".send-money-payee-list-name-primary",
    );
    if (!primary) return;
    primary.textContent =
      SEND_MONEY_PAYEE_LIST_DEFAULT_NAMES[index] ?? primary.textContent ?? "";
    card.classList.remove("active", "send-money-payee-list-card--active");
    card.setAttribute("aria-pressed", "false");
  });
}

function resetSendMoneyAccountActiveCards() {
  document
    .querySelectorAll<HTMLElement>(
      "#welcome-send-money-account-selected-options .send-money-account-selected-card",
    )
    .forEach((card) => {
      card.classList.remove("send-money-account-selected-card--active");
      card.setAttribute("aria-pressed", "false");
    });
}

function setSendMoneyAccountActive(account: "savings" | "current") {
  const cards = document.querySelectorAll<HTMLElement>(
    "#welcome-send-money-account-selected-options .send-money-account-selected-card",
  );
  let matched = false;
  cards.forEach((card) => {
    const isTarget = card.dataset.account === account;
    card.classList.toggle("send-money-account-selected-card--active", isTarget);
    card.setAttribute("aria-pressed", isTarget ? "true" : "false");
    if (isTarget) matched = true;
  });
  if (matched) {
    sendMoneyAccountType = account;
    appendLog(`[Welcome] Send-money: account active → ${account}`);
  }
}

function resetSendMoneyWhenActiveCards() {
  document
    .querySelectorAll<HTMLElement>(
      "#welcome-send-money-when-options .send-money-when-card",
    )
    .forEach((card) => {
      card.classList.remove("send-money-when-card--active");
      card.setAttribute("aria-pressed", "false");
    });
}

function setSendMoneyWhenActive(option: "pay-now" | "schedule") {
  const cards = document.querySelectorAll<HTMLElement>(
    "#welcome-send-money-when-options .send-money-when-card",
  );
  let matched = false;
  cards.forEach((card) => {
    const isTarget = card.dataset.option === option;
    card.classList.toggle("send-money-when-card--active", isTarget);
    card.setAttribute("aria-pressed", isTarget ? "true" : "false");
    if (isTarget) matched = true;
  });
  if (matched) {
    sendMoneyWhen = option;
    appendLog(`[Welcome] Send-money: when active → ${option}`);
  }
}

function getSendMoneyAccountValueText(): string {
  return sendMoneyAccountType === "current"
    ? "Current Account"
    : "Savings Account";
}

function getSendMoneyAccountMaskText(): string {
  return sendMoneyAccountType === "current" ? "**** 6789" : "**** 7673";
}

function applySendMoneyPreviewContent() {
  const payee = sendMoneyPayeeName?.trim() || SEND_MONEY_DEFAULT_PAYEE_NAME;
  const amountText =
    sendMoneyAmount !== null
      ? formatSendMoneyAmount(sendMoneyAmount)
      : "\u20B95,000";
  const remark = sendMoneyRemark?.trim() || "";
  const fromValue = getSendMoneyAccountValueText();
  const fromMeta = getSendMoneyAccountMaskText();

  const setText = (selector: string, value: string) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) el.textContent = value;
  };
  const setVisibility = (selector: string, visible: boolean) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) el.style.display = visible ? "" : "none";
  };

  setText("#welcome-send-money-preview .send-money-preview-to-name", payee);
  setText(
    "#welcome-send-money-preview .send-money-preview-amount-value",
    amountText,
  );
  if (remark) {
    setText("#welcome-send-money-preview .send-money-preview-remark", remark);
    setVisibility(
      "#welcome-send-money-preview .send-money-preview-remark",
      true,
    );
  } else {
    setVisibility(
      "#welcome-send-money-preview .send-money-preview-remark",
      false,
    );
  }
  setText(
    "#welcome-send-money-preview .send-money-preview-from-col .send-money-preview-from-value",
    fromValue,
  );
  const fromMetaEl = document.querySelector<HTMLElement>(
    "#welcome-send-money-preview .send-money-preview-from-col .send-money-preview-from-meta",
  );
  if (fromMetaEl) fromMetaEl.textContent = fromMeta;
}

function formatSendMoneySuccessDate(now: Date): { date: string; time: string } {
  const day = now.getDate();
  const suffix = (() => {
    const v = day % 100;
    if (v >= 11 && v <= 13) return "th";
    switch (day % 10) {
      case 1:
        return "st";
      case 2:
        return "nd";
      case 3:
        return "rd";
      default:
        return "th";
    }
  })();
  const month = now.toLocaleString("en-US", { month: "long" });
  const year = now.getFullYear();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const period = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return {
    date: `${day}${suffix} ${month} ${year}`,
    time: `${hours}:${minutes} ${period}`,
  };
}

function applySendMoneySuccessContent() {
  const payee = sendMoneyPayeeName?.trim() || SEND_MONEY_DEFAULT_PAYEE_NAME;
  const amountText =
    sendMoneyAmount !== null
      ? formatSendMoneyAmount(sendMoneyAmount)
      : "\u20B95,000";
  const remark = sendMoneyRemark?.trim() || "";
  const fromValue = getSendMoneyAccountValueText();
  const fromMeta = `A/C: ${getSendMoneyAccountMaskText()}`;
  const { date, time } = formatSendMoneySuccessDate(new Date());

  const root = document.getElementById("welcome-send-money-success");
  if (!root) return;

  const sections = root.querySelectorAll<HTMLElement>(
    ".send-money-success-section",
  );
  // section 1 → To / Amount; section 2 → Sent on / From
  const section1Cols = sections[0]?.querySelectorAll<HTMLElement>(
    ".send-money-success-col",
  );
  const section2Cols = sections[1]?.querySelectorAll<HTMLElement>(
    ".send-money-success-col",
  );

  if (section1Cols && section1Cols.length >= 2) {
    const toValue = section1Cols[0].querySelector<HTMLElement>(
      ".send-money-success-value",
    );
    if (toValue) toValue.textContent = payee;
    const amtValue = section1Cols[1].querySelector<HTMLElement>(
      ".send-money-success-value",
    );
    if (amtValue) amtValue.textContent = amountText;
    const amtMeta = section1Cols[1].querySelector<HTMLElement>(
      ".send-money-success-meta",
    );
    if (amtMeta) {
      if (remark) {
        amtMeta.textContent = remark;
        amtMeta.style.display = "";
      } else {
        amtMeta.style.display = "none";
      }
    }
  }

  if (section2Cols && section2Cols.length >= 2) {
    const sentValue = section2Cols[0].querySelector<HTMLElement>(
      ".send-money-success-value",
    );
    if (sentValue) sentValue.textContent = date;
    const sentMeta = section2Cols[0].querySelector<HTMLElement>(
      ".send-money-success-meta",
    );
    if (sentMeta) sentMeta.textContent = time;
    const fromValueEl = section2Cols[1].querySelector<HTMLElement>(
      ".send-money-success-value",
    );
    if (fromValueEl) fromValueEl.textContent = fromValue;
    const fromMetaEl = section2Cols[1].querySelector<HTMLElement>(
      ".send-money-success-meta",
    );
    if (fromMetaEl) fromMetaEl.textContent = fromMeta;
  }
}

function showWelcomeSendMoneyPayeeStage() {
  if (!isJourneyPage()) return;
  resetOtherJourneysExcept("send-money");
  activateSendMoneyStage("send-money-payee-stage");
  sendMoneyJourneyActive = true;
  hasShownSendMoneyPayeeScreen = true;
  appendLog("[Welcome] Send-money stage 1 — payee screen shown");
}

function showWelcomeSendMoneyPayeeSuggestStage(payeeName?: string) {
  if (!isJourneyPage()) return;
  if (payeeName && payeeName.trim()) {
    sendMoneyPayeeName = payeeName.trim();
  }
  setSendMoneyPayeeSuggestName(
    sendMoneyPayeeName?.trim() || SEND_MONEY_DEFAULT_PAYEE_NAME,
  );
  activateSendMoneyStage("send-money-payee-suggest-stage");
  sendMoneyJourneyActive = true;
  hasShownSendMoneyPayeeSuggestScreen = true;
  appendLog(
    `[Welcome] Send-money stage 2 — payee-suggest shown (payee=${sendMoneyPayeeName ?? "—"})`,
  );
}

function showWelcomeSendMoneyPayeeListStage() {
  if (!isJourneyPage()) return;
  setSendMoneyPayeeListPlaceholderNames();
  activateSendMoneyStage("send-money-payee-list-stage");
  sendMoneyJourneyActive = true;
  hasShownSendMoneyPayeeListScreen = true;
  appendLog("[Welcome] Send-money stage 3 — payee-list shown");
}

function showWelcomeSendMoneyAmountStage() {
  if (!isJourneyPage()) return;
  activateSendMoneyStage("send-money-amount-stage");
  sendMoneyJourneyActive = true;
  hasShownSendMoneyAmountScreen = true;
  appendLog("[Welcome] Send-money stage 3b — amount screen shown");
}

function showWelcomeSendMoneyAccountSelectedStage() {
  if (!isJourneyPage()) return;
  resetSendMoneyAccountActiveCards();
  sendMoneyAccountType = null;
  activateSendMoneyStage("send-money-account-selected-stage");
  sendMoneyJourneyActive = true;
  hasShownSendMoneyAccountSelectedScreen = true;
  appendLog(
    "[Welcome] Send-money stage 4 — account-selected shown (default state)",
  );
}

function showWelcomeSendMoneyWhenStage() {
  if (!isJourneyPage()) return;
  resetSendMoneyWhenActiveCards();
  sendMoneyWhen = null;
  activateSendMoneyStage("send-money-when-stage");
  sendMoneyJourneyActive = true;
  hasShownSendMoneyWhenScreen = true;
  appendLog("[Welcome] Send-money stage 5 — when shown (default state)");
}

function showWelcomeSendMoneyPreviewStage() {
  if (!isJourneyPage()) return;
  applySendMoneyPreviewContent();
  applySendMoneySuccessContent();
  activateSendMoneyStage("send-money-preview-stage");
  sendMoneyJourneyActive = true;
  hasShownSendMoneyPreviewScreen = true;
  appendLog(
    `[Welcome] Send-money stage 6 — preview shown (when=${sendMoneyWhen ?? "—"})`,
  );
}

function showWelcomeSendMoneyOtpVerifyStage() {
  if (!isJourneyPage()) return;
  activateSendMoneyStage("otp-verify-stage");
  sendMoneyJourneyActive = true;
  hasShownSendMoneyOtpVerifyScreen = true;
  appendLog("[Welcome] Send-money stage 7 — otp-verify shown");
}

function showWelcomeSendMoneySuccessStage() {
  if (!isJourneyPage()) return;
  applySendMoneySuccessContent();
  activateSendMoneyStage("send-money-success-stage");
  sendMoneyJourneyActive = true;
  hasShownSendMoneySuccessScreen = true;
  appendLog("[Welcome] Send-money stage 8 — success shown");
}

function startSendMoneyJourney(options?: { force?: boolean }) {
  if (!isJourneyPage()) return;
  if (!options?.force && sendMoneyJourneyActive && hasShownSendMoneyPayeeScreen)
    return;
  resetOtherJourneysExcept("send-money");
  showWelcomeSendMoneyPayeeStage();
}

// ── Send-money matchers ────────────────────────────────────────────────────

function isSendMoneyIntentMessage(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "i want to send money",
      "want to send money",
      "i need to send money",
      "i would like to send money",
      "send money",
      "send some money",
      "transfer money",
      "transfer some money",
      "i want to transfer money",
      "want to transfer money",
      "make a payment",
      "make payment",
      "pay someone",
      "pay my friend",
      "paise bhejna",
      "paisa bhejna",
    ])
  ) {
    return true;
  }
  if (!containsAny(normalized, ["send", "transfer", "pay"])) return false;
  return containsAny(normalized, [
    "money",
    "rupees",
    "rupee",
    "inr",
    "rs",
    "i want",
    "i need",
    "i would",
    "want to",
    "need to",
    "like to",
    "help me",
    "please",
  ]);
}

function isEvaSendMoneyPayeeCue(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "whom would you like to send money to",
      "who would you like to send money to",
    ])
  ) {
    return true;
  }
  if (
    normalized.includes("send money to") &&
    containsAny(normalized, ["whom", "who", "which", "whose"])
  ) {
    return true;
  }
  return (
    containsAny(normalized, ["whom", "who"]) &&
    normalized.includes("send") &&
    normalized.includes("money")
  );
}

function isEvaSendMoneyAmountCue(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "enter the amount you would like to send",
      "enter the amount you want to send",
      "how much would you like to send",
      "how much do you want to send",
      "amount you would like to send",
      "amount you want to send",
    ])
  ) {
    return true;
  }
  if (normalized.includes("amount") && normalized.includes("send")) return true;
  if (normalized.includes("amount") && normalized.includes("add a note"))
    return true;
  return normalized.includes("add a remark") && normalized.includes("amount");
}

function isEvaSendMoneyAccountCue(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "choose an account you want to pay from",
      "choose the account you want to pay from",
      "select an account you want to pay from",
      "select the account you want to pay from",
      "which account would you like to pay from",
      "which account do you want to pay from",
      "pick an account to pay from",
    ])
  ) {
    return true;
  }
  return normalized.includes("account") && normalized.includes("pay from");
}

function isEvaSendMoneyWhenCue(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "pay now or schedule it for later",
      "pay now or schedule for later",
      "pay it now or schedule it for later",
      "do you want to pay now or schedule",
      "pay now or pay later",
      "send now or schedule",
    ])
  ) {
    return true;
  }
  return (
    normalized.includes("pay now") &&
    containsAny(normalized, ["schedule", "later"])
  );
}

function isEvaSendMoneyPreviewCue(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  return containsAny(normalized, [
    "here is your payment preview",
    "here s your payment preview",
    "this is your payment preview",
    "your payment preview",
    "payment preview",
  ]);
}

function isEvaSendMoneyOtpProceedCue(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "i will proceed the payment process",
      "i will proceed with the payment",
      "i ll proceed the payment process",
      "i ll proceed with the payment",
      "proceed the payment process",
      "proceeding with the payment",
      "proceeding the payment",
    ])
  ) {
    return true;
  }
  return normalized.includes("proceed") && normalized.includes("payment");
}

function isSendMoneyChangePayeeMessage(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "change payee",
      "change the payee",
      "this is not the payee",
      "this is not payee",
      "thats not the payee",
      "that is not the payee",
      "wrong payee",
      "different payee",
      "different person",
      "someone else",
      "not this person",
      "not this one",
      "not the right payee",
      "show other payees",
      "show me other payees",
      "show others",
      "list of payees",
      "list payees",
      "change name",
      "wrong name",
    ])
  )
    return true;
  // Plain "no" / "nope" / "nah" while at the suggest stage.
  return /^(no|nope|nah|not really|no thanks|no this is not|no thats not|no its not|no that is not)\b/.test(
    normalized,
  );
}

function extractSendMoneyPayeeName(message: string): string | null {
  if (!message) return null;
  let cleaned = message.trim();
  cleaned = cleaned.replace(
    /^(i\s+want\s+to\s+|i\s+would\s+like\s+to\s+|i\s+need\s+to\s+|please\s+|kindly\s+|can\s+you\s+|could\s+you\s+|let\s+s\s+|lets\s+)/i,
    "",
  );
  cleaned = cleaned.replace(
    /^(send\s+(money\s+)?(to\s+)?|pay\s+(to\s+)?|transfer\s+(money\s+)?(to\s+)?|make\s+(a\s+)?payment\s+(to\s+)?)/i,
    "",
  );
  cleaned = cleaned.replace(
    /^(its|it\s+is|name\s+is|the\s+name\s+is|to\s+|the\s+payee\s+is\s+|payee\s+is\s+|the\s+payee\s+name\s+is\s+|payee\s+name\s+is\s+)/i,
    "",
  );
  cleaned = cleaned.replace(/[\.,!?]+$/g, "").trim();
  if (!cleaned) return null;
  if (/^\d+$/.test(cleaned)) return null;
  const lower = cleaned.toLowerCase();
  const reject = new Set([
    "yes",
    "no",
    "okay",
    "ok",
    "sure",
    "yeah",
    "yep",
    "nope",
    "not",
    "change payee",
    "this is not the payee",
    "this is not payee",
    "pay now",
    "schedule later",
    "now",
    "later",
    "savings",
    "savings account",
    "current",
    "current account",
    "confirm",
    "proceed",
    "cancel",
  ]);
  if (reject.has(lower)) return null;
  if (cleaned.length > 60) return null;
  // Heuristic: at least one alphabetic character; words limited to a name shape.
  if (!/[a-zA-Z]/.test(cleaned)) return null;
  // Title-case the result.
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function extractSendMoneyAmount(message: string): number | null {
  if (!message) return null;
  const cleaned = message.replace(/(\d),(?=\d)/g, "$1");
  const shortHand = cleaned.match(/(\d+(?:\.\d+)?)\s*k\b/i);
  if (shortHand) {
    const v = Math.round(parseFloat(shortHand[1]) * 1000);
    if (Number.isFinite(v) && v >= 1) return v;
  }
  const direct = cleaned.match(/\d{1,7}/);
  if (!direct) return null;
  const value = Number(direct[0]);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 1) return null;
  return value;
}

function extractSendMoneyRemark(message: string): string | null {
  if (!message) return null;
  const forMatch = message.match(
    /\b(?:for|note(?:\s+is)?|remark(?:\s+is)?)\s+([a-zA-Z][\w\s\-&]{0,40})\b/i,
  );
  if (forMatch) {
    const candidate = forMatch[1].trim().replace(/[\.,!?]+$/g, "");
    if (candidate && !/^\d+$/.test(candidate)) {
      // Title-case first letter of each word.
      return candidate
        .split(/\s+/)
        .map(
          (part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
        )
        .join(" ");
    }
  }
  return null;
}

function extractSendMoneyAccountType(
  message: string,
): "savings" | "current" | null {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;
  if (
    containsAny(normalized, [
      "savings account",
      "saving account",
      "savings",
      "saving",
    ])
  )
    return "savings";
  if (containsAny(normalized, ["current account", "current"])) return "current";
  return null;
}

function extractSendMoneyWhen(message: string): "pay-now" | "schedule" | null {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;
  if (
    containsAny(normalized, [
      "pay now",
      "pay it now",
      "pay right now",
      "pay immediately",
      "send now",
      "send it now",
      "right now",
      "immediately",
      "instant",
      "do it now",
    ])
  )
    return "pay-now";
  if (/^now$/.test(normalized)) return "pay-now";
  if (
    containsAny(normalized, [
      "schedule later",
      "schedule it later",
      "schedule it for later",
      "schedule for later",
      "schedule",
      "pay later",
      "send later",
      "do it later",
      "later",
    ])
  )
    return "schedule";
  return null;
}

function extractSendMoneyPayeeListIndex(message: string): 1 | 2 | 3 | null {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;
  if (
    /(payee\s+name\s+|name\s+|payee\s+|number\s+|option\s+)?(1|one|first)\b/.test(
      normalized,
    )
  )
    return 1;
  if (
    /(payee\s+name\s+|name\s+|payee\s+|number\s+|option\s+)?(2|two|second)\b/.test(
      normalized,
    )
  )
    return 2;
  if (
    /(payee\s+name\s+|name\s+|payee\s+|number\s+|option\s+)?(3|three|third)\b/.test(
      normalized,
    )
  )
    return 3;
  return null;
}

function captureSendMoneyAmountAndRemark(message: string) {
  const amount = extractSendMoneyAmount(message);
  if (amount !== null) sendMoneyAmount = amount;
  const remark = extractSendMoneyRemark(message);
  if (remark) sendMoneyRemark = remark;
}

function tryApplyWelcomeSendMoneyStepFromUserSpeech(message: string): boolean {
  if (!isWelcomePage()) return false;
  if (!sendMoneyJourneyActive) return false;
  const normalized = normalizeMessage(message);
  if (!normalized) return false;

  // Step 8 — OTP entry → send-money-success.
  if (
    document.body.classList.contains("otp-verify-stage") &&
    !hasShownSendMoneySuccessScreen
  ) {
    const otp = extractOtpCode(message);
    if (otp) {
      appendLog(
        `[Welcome] Send-money: OTP captured (${otp.replace(/.(?=.{2})/g, "*")})`,
      );
      showWelcomeSendMoneySuccessStage();
      return true;
    }
    return false;
  }

  // Step 5 user response — pay-now / schedule selection.
  if (document.body.classList.contains("send-money-when-stage")) {
    const when = extractSendMoneyWhen(message);
    if (when) {
      setSendMoneyWhenActive(when);
      return true;
    }
  }

  // Step 4 user response — savings / current selection.
  if (document.body.classList.contains("send-money-account-selected-stage")) {
    const account = extractSendMoneyAccountType(message);
    if (account) {
      setSendMoneyAccountActive(account);
      return true;
    }
  }

  // Amount stage — capture amount + remark from the user response.
  if (document.body.classList.contains("send-money-amount-stage")) {
    captureSendMoneyAmountAndRemark(message);
  }

  // Step 3a — at payee-suggest, user denies → list screen.
  if (
    document.body.classList.contains("send-money-payee-suggest-stage") &&
    !hasShownSendMoneyPayeeListScreen &&
    isSendMoneyChangePayeeMessage(message)
  ) {
    showWelcomeSendMoneyPayeeListStage();
    return true;
  }

  // Step 3 list selection — user picks payee name 1/2/3.
  if (document.body.classList.contains("send-money-payee-list-stage")) {
    const idx = extractSendMoneyPayeeListIndex(message);
    if (idx) {
      const cards = document.querySelectorAll<HTMLElement>(
        "#welcome-send-money-payee-list-accounts .send-money-payee-list-card",
      );
      cards.forEach((card, i) => {
        const isTarget = i === idx - 1;
        card.classList.toggle("active", isTarget);
        card.setAttribute("aria-pressed", isTarget ? "true" : "false");
      });
      const chosen = SEND_MONEY_PAYEE_LIST_PLACEHOLDER_NAMES[idx - 1];
      if (chosen) {
        sendMoneyPayeeName = chosen
          .split(/\s+/)
          .map(
            (part) =>
              part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
          )
          .join(" ");
      }
      appendLog(
        `[Welcome] Send-money: payee-list picked → ${sendMoneyPayeeName ?? `#${idx}`}`,
      );
      return true;
    }
  }

  // Step 2 — at payee stage, user names a payee → suggest screen.
  if (
    document.body.classList.contains("send-money-payee-stage") &&
    !hasShownSendMoneyPayeeSuggestScreen
  ) {
    const name = extractSendMoneyPayeeName(message);
    if (name) {
      sendMoneyPayeeName = name;
      showWelcomeSendMoneyPayeeSuggestStage(name);
      return true;
    }
  }

  return false;
}

function tryShowSendMoneyFromEvaSpeech(message: string): boolean {
  if (!isWelcomePage()) return false;
  const normalized = normalizeMessage(message);
  if (!normalized) return false;

  // Step 1 — Eva asks "whom would you like to send money to".
  if (isEvaSendMoneyPayeeCue(message)) {
    if (!sendMoneyJourneyActive || !hasShownSendMoneyPayeeScreen) {
      startSendMoneyJourney({ force: true });
    }
    return true;
  }

  // From here on, only act when the send-money journey is active.
  if (!sendMoneyJourneyActive) return false;

  // Step 7 — Eva says she'll proceed the payment → otp-verify (send-money variant).
  if (
    !hasShownSendMoneyOtpVerifyScreen &&
    isEvaSendMoneyOtpProceedCue(message)
  ) {
    showWelcomeSendMoneyOtpVerifyStage();
    return true;
  }

  // Step 6 — Eva: payment preview.
  if (!hasShownSendMoneyPreviewScreen && isEvaSendMoneyPreviewCue(message)) {
    showWelcomeSendMoneyPreviewStage();
    return true;
  }

  // Step 5 — Eva: pay now or schedule.
  if (!hasShownSendMoneyWhenScreen && isEvaSendMoneyWhenCue(message)) {
    showWelcomeSendMoneyWhenStage();
    return true;
  }

  // Step 4 — Eva: choose an account to pay from.
  if (
    !hasShownSendMoneyAccountSelectedScreen &&
    isEvaSendMoneyAccountCue(message)
  ) {
    showWelcomeSendMoneyAccountSelectedStage();
    return true;
  }

  // Step 3b — Eva: enter the amount you would like to send.
  if (!hasShownSendMoneyAmountScreen && isEvaSendMoneyAmountCue(message)) {
    showWelcomeSendMoneyAmountStage();
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Home-loan journey
// Step flow:
//   1) user asks about home loan                     → loan-active-list
//   2) user picks Home Loan / Top-Up Loan            → home-loan-summary
//   3) user says yes + prepayment amount             → otp-verify (home-loan)
//   4) Eva: payment successful from savings account  → loan-payment-received
//   5) user: Reduce EMI or Reduce Tenure             → loan-prepayment-adjusted

const HOME_LOAN_STAGE_CLASSES = [
  "loan-active-list-stage",
  "home-loan-summary-stage",
  "otp-verify-stage",
  "loan-payment-received-stage",
  "loan-prepayment-adjusted-stage",
];

function clearOtherJourneyStagesForHomeLoan() {
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
    "cash-withdraw-stage",
    "cash-withdraw-consent-stage",
    "cash-withdraw-debit-slot-stage",
    "cash-withdraw-bank-details-stage",
    "send-money-payee-stage",
    "send-money-payee-suggest-stage",
    "send-money-payee-list-stage",
    "send-money-amount-stage",
    "send-money-account-selected-stage",
    "send-money-when-stage",
    "send-money-preview-stage",
    "send-money-success-stage",
    "loan-blank-panel-stage",
  );
}

function activateHomeLoanStage(stageClass: string) {
  document.body.classList.add("eva-started", stageClass);
  clearOtherJourneyStagesForHomeLoan();
  for (const c of HOME_LOAN_STAGE_CLASSES) {
    if (c !== stageClass) document.body.classList.remove(c);
  }
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  setWelcomeForexVisibility(false);
  setChatInputBoxVisible(true);
}

function resetHomeLoanFlowState() {
  homeLoanJourneyActive = false;
  hasShownHomeLoanActiveListScreen = false;
  hasShownHomeLoanSummaryScreen = false;
  hasShownHomeLoanOtpScreen = false;
  hasShownHomeLoanPaymentReceivedScreen = false;
  hasShownHomeLoanPrepaymentAdjustedScreen = false;
  homeLoanSelection = null;
  homeLoanPrepaymentAmount = null;
  resetWelcomeHomeLoanActiveListCards();
}

function resetWelcomeHomeLoanActiveListCards() {
  document
    .querySelectorAll("#welcome-loan-active-list-cards .loan-active-list-card")
    .forEach((card) => {
      card.classList.remove("loan-active-list-card--active", "active");
      card.setAttribute("aria-pressed", "false");
    });
}

function setWelcomeHomeLoanActiveListSelection(selection: "home" | "topup") {
  const cards = document.querySelectorAll<HTMLElement>(
    "#welcome-loan-active-list-cards .loan-active-list-card",
  );
  cards.forEach((card) => {
    const active = card.dataset.loan === selection;
    card.classList.toggle("loan-active-list-card--active", active);
    card.classList.toggle("active", active);
    card.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function applyWelcomeHomeLoanSummaryContent(selection: "home" | "topup") {
  const profile = HOME_LOAN_PROFILES[selection];
  const root = document.getElementById("welcome-home-loan-summary");
  if (!root) return;

  const title = root.querySelector<HTMLElement>(".home-loan-summary-title");
  if (title) {
    title.textContent =
      selection === "topup"
        ? "Here is your Top-Up Loan summary"
        : "Here is your home loan summary";
  }

  const nameEl = root.querySelector<HTMLElement>(
    ".home-loan-summary-card-name",
  );
  if (nameEl) nameEl.textContent = profile.label;

  const numberEl = root.querySelector<HTMLElement>(
    ".home-loan-summary-card-number",
  );
  if (numberEl) numberEl.textContent = profile.number;

  const rows = root.querySelectorAll<HTMLElement>(".home-loan-summary-row");
  rows.forEach((row) => {
    const label = row
      .querySelector(".home-loan-summary-row-label")
      ?.textContent?.trim()
      .toLowerCase();
    const valueEl = row.querySelector<HTMLElement>(
      ".home-loan-summary-row-value",
    );
    if (!label || !valueEl) return;
    if (label === "amount")
      valueEl.textContent = formatCashWithdrawAmount(profile.amount);
    else if (label === "emi")
      valueEl.textContent = formatCashWithdrawAmount(profile.emi);
    else if (label === "outstanding principal") {
      valueEl.textContent = formatCashWithdrawAmount(
        profile.outstandingPrincipal,
      );
    } else if (label === "principal")
      valueEl.textContent = formatCashWithdrawAmount(profile.principal);
  });

  const prepayValue = root.querySelector<HTMLElement>(
    ".home-loan-summary-prepay-value",
  );
  if (prepayValue)
    prepayValue.textContent = `Up to ${formatCashWithdrawAmount(profile.prepayLimit)}`;
}

function applyWelcomeHomeLoanPaymentReceivedContent() {
  const selection = homeLoanSelection ?? "home";
  const profile = HOME_LOAN_PROFILES[selection];
  const root = document.getElementById("welcome-loan-payment-received");
  if (!root) return;

  const subtitle = root.querySelector<HTMLElement>(
    ".loan-payment-received-subtitle",
  );
  if (subtitle) {
    subtitle.textContent = `We have received the part-prepayment for ${profile.label}`;
  }

  const nameEl = root.querySelector<HTMLElement>(
    ".loan-payment-received-card-name",
  );
  if (nameEl) nameEl.textContent = profile.label;

  const numberEl = root.querySelector<HTMLElement>(
    ".loan-payment-received-card-number",
  );
  if (numberEl) numberEl.textContent = profile.number;

  const rows = root.querySelectorAll<HTMLElement>(".loan-payment-received-row");
  rows.forEach((row) => {
    const label = row
      .querySelector(".loan-payment-received-row-label")
      ?.textContent?.trim()
      .toLowerCase();
    const valueEl = row.querySelector<HTMLElement>(
      ".loan-payment-received-row-value",
    );
    if (!label || !valueEl) return;
    if (label === "amount paid" && homeLoanPrepaymentAmount !== null) {
      valueEl.textContent = formatCashWithdrawAmount(homeLoanPrepaymentAmount);
    }
  });
}

function showWelcomeHomeLoanActiveListStage() {
  if (!isJourneyPage()) return;
  resetOtherJourneysExcept("home-loan");
  activateHomeLoanStage("loan-active-list-stage");
  homeLoanJourneyActive = true;
  hasShownHomeLoanActiveListScreen = true;
  resetWelcomeHomeLoanActiveListCards();
  appendLog("[Welcome] Home-loan stage 1 — loan-active-list shown");
}

function showWelcomeHomeLoanSummaryStage(selection: "home" | "topup") {
  if (!isJourneyPage()) return;
  homeLoanSelection = selection;
  setWelcomeHomeLoanActiveListSelection(selection);
  applyWelcomeHomeLoanSummaryContent(selection);
  activateHomeLoanStage("home-loan-summary-stage");
  homeLoanJourneyActive = true;
  hasShownHomeLoanSummaryScreen = true;
  appendLog(
    `[Welcome] Home-loan stage 2 — home-loan-summary shown (${selection})`,
  );
}

function showWelcomeHomeLoanOtpVerifyStage() {
  if (!isJourneyPage()) return;
  activateHomeLoanStage("otp-verify-stage");
  homeLoanJourneyActive = true;
  hasShownHomeLoanOtpScreen = true;
  appendLog("[Welcome] Home-loan stage 3 — otp-verify shown");
}

function showWelcomeHomeLoanPaymentReceivedStage() {
  if (!isJourneyPage()) return;
  applyWelcomeHomeLoanPaymentReceivedContent();
  activateHomeLoanStage("loan-payment-received-stage");
  homeLoanJourneyActive = true;
  hasShownHomeLoanPaymentReceivedScreen = true;
  appendLog("[Welcome] Home-loan stage 4 — loan-payment-received shown");
}

function showWelcomeHomeLoanPrepaymentAdjustedStage() {
  if (!isJourneyPage()) return;
  activateHomeLoanStage("loan-prepayment-adjusted-stage");
  homeLoanJourneyActive = true;
  hasShownHomeLoanPrepaymentAdjustedScreen = true;
  markActiveJourneyComplete("home-loan prepayment adjusted");
  appendLog("[Welcome] Home-loan stage 5 — loan-prepayment-adjusted shown");
}

function startHomeLoanJourney(options?: { force?: boolean }) {
  if (!isJourneyPage()) return;
  if (
    !options?.force &&
    homeLoanJourneyActive &&
    hasShownHomeLoanActiveListScreen
  )
    return;
  resetOtherJourneysExcept("home-loan");
  setActiveJourney(
    "home-loan",
    options?.force ? "user requested home-loan" : "first screen of journey",
  );
  showWelcomeHomeLoanActiveListStage();
}

function extractHomeLoanSelection(message: string): "home" | "topup" | null {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;
  if (
    containsAny(normalized, [
      "top up loan",
      "topup loan",
      "top-up loan",
      "top up",
      "topup",
      "top-up",
    ])
  ) {
    return "topup";
  }
  if (
    containsAny(normalized, ["home loan", "housing loan"]) ||
    (normalized.includes("home") && normalized.includes("loan"))
  ) {
    return "home";
  }
  return null;
}

function isHomeLoanPrepayConfirmMessage(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "yes",
      "yeah",
      "yep",
      "sure",
      "okay",
      "ok",
      "prepay",
      "part prepay",
      "part-prepay",
    ])
  ) {
    return true;
  }
  return isPositiveIntent(normalized);
}

function isHomeLoanReduceChoiceMessage(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "reduce emi",
      "reduce the emi",
      "lower emi",
      "decrease emi",
    ])
  ) {
    return true;
  }
  if (
    containsAny(normalized, [
      "reduce tenure",
      "reduce the tenure",
      "lower tenure",
      "decrease tenure",
    ])
  ) {
    return true;
  }
  if (normalized === "emi" || normalized.endsWith(" emi")) return true;
  if (normalized === "tenure" || normalized.endsWith(" tenure")) return true;
  return false;
}

function isEvaHomeLoanPaymentSuccessCue(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "payment made successful from your savings account",
      "payment made successfully from your savings account",
      "great payment made successful from your savings account",
      "great payment made successfully from your savings account",
    ])
  ) {
    return true;
  }
  return (
    normalized.includes("payment") &&
    normalized.includes("successful") &&
    normalized.includes("savings")
  );
}

function tryApplyWelcomeHomeLoanStepFromUserSpeech(message: string): boolean {
  if (!isWelcomePage()) return false;
  if (!homeLoanJourneyActive) return false;
  const normalized = normalizeMessage(message);
  if (!normalized) return false;

  // Step 5 — Reduce EMI or Reduce Tenure → prepayment-adjusted.
  if (
    document.body.classList.contains("loan-payment-received-stage") &&
    !hasShownHomeLoanPrepaymentAdjustedScreen &&
    isHomeLoanReduceChoiceMessage(message)
  ) {
    showWelcomeHomeLoanPrepaymentAdjustedStage();
    return true;
  }

  // Step 3 — yes + amount on summary → otp-verify.
  if (
    document.body.classList.contains("home-loan-summary-stage") &&
    !hasShownHomeLoanOtpScreen
  ) {
    const amount = extractCashWithdrawAmount(message);
    if (isHomeLoanPrepayConfirmMessage(message) && amount !== null) {
      homeLoanPrepaymentAmount = amount;
      showWelcomeHomeLoanOtpVerifyStage();
      return true;
    }
  }

  // Step 2 — loan pick on active list → summary.
  if (
    document.body.classList.contains("loan-active-list-stage") &&
    !hasShownHomeLoanSummaryScreen
  ) {
    const selection = extractHomeLoanSelection(message);
    if (selection) {
      showWelcomeHomeLoanSummaryStage(selection);
      return true;
    }
  }

  return false;
}

function tryShowHomeLoanFromEvaSpeech(message: string): boolean {
  if (!isWelcomePage()) return false;
  const normalized = normalizeMessage(message);
  if (!normalized) return false;

  // Step 4 — Eva confirms payment success → payment-received.
  if (
    homeLoanJourneyActive &&
    hasShownHomeLoanOtpScreen &&
    !hasShownHomeLoanPaymentReceivedScreen &&
    isEvaHomeLoanPaymentSuccessCue(message)
  ) {
    showWelcomeHomeLoanPaymentReceivedStage();
    return true;
  }

  return false;
}

function initWelcomeTravelDetailsCards() {
  const grid = document.getElementById("welcome-travel-details-needed-grid");
  if (!grid || grid.dataset.bound === "true") return;
  grid.dataset.bound = "true";
  const cards = Array.from(
    grid.querySelectorAll<HTMLElement>(".travel-details-needed-card"),
  );
  const setActive = (card: HTMLElement) => {
    cards.forEach((c) => {
      const active = c === card;
      c.classList.toggle("travel-details-needed-card--active", active);
      c.setAttribute("aria-pressed", active ? "true" : "false");
    });
  };
  cards.forEach((card) => {
    card.addEventListener("click", () => setActive(card));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setActive(card);
      }
    });
  });
}

function initWelcomeHomeLoanActiveListCards() {
  const grid = document.getElementById("welcome-loan-active-list-cards");
  if (!grid || grid.dataset.bound === "true") return;
  grid.dataset.bound = "true";
  const cards = Array.from(
    grid.querySelectorAll<HTMLElement>(".loan-active-list-card"),
  );
  const setActive = (card: HTMLElement) => {
    if (!homeLoanJourneyActive) return;
    if (!document.body.classList.contains("loan-active-list-stage")) return;
    if (hasShownHomeLoanSummaryScreen) return;
    const loan = card.dataset.loan;
    if (loan === "home" || loan === "topup") {
      showWelcomeHomeLoanSummaryStage(loan);
      appendLog(`[Welcome] Home-loan: user selected ${loan} via card`);
    }
  };
  cards.forEach((card) => {
    card.addEventListener("click", () => setActive(card));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setActive(card);
      }
    });
  });
}

function clearWelcomeVerifyMethodSelection() {
  document
    .querySelectorAll("#welcome-verify-methods-grid .verify-method-card")
    .forEach((card) => {
      card.classList.remove("active");
    });
}

function setWelcomeVerifyMethodActive(method: string) {
  const grid = document.getElementById("welcome-verify-methods-grid");
  if (!grid) {
    appendLog(`[Welcome] verify-methods grid not found (method=${method})`);
    return;
  }

  let matched = false;
  grid.querySelectorAll<HTMLElement>(".verify-method-card").forEach((card) => {
    const isTarget = card.dataset.method === method;
    card.classList.remove("active");
    if (isTarget) {
      card.classList.add("active");
      matched = true;
    }
  });

  if (matched) {
    addressVerifyMethodChosen = method;
    hasAskedAddressConsent = false;
    appendLog(`[Welcome] verify-method-card.active applied for "${method}"`);
  } else {
    appendLog(`[Welcome] no verify-method-card with data-method="${method}"`);
  }
}

function resetAddressConsentFlowState() {
  addressVerifyMethodChosen = null;
  hasAskedAddressConsent = false;
  hasShownAddressConsentScreen = false;
  hasShownAddressNextScreen = false;
  hasShownAddressVerifiedSuccessScreen = false;
  awaitingEvaAddressVerifiedSuccessAnnouncement = false;
  hasShownAddressSelectScreen = false;
  awaitingEvaAddressSelectAnnouncement = false;
  hasShownSelfVerifyMethodsScreen = false;
  clearWelcomeAddressSelectConfirmState();
}

function isAddressVerifyMethodExplicitChoice(normalized: string) {
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "digilocker",
      "digi locker",
      "digi-locker",
      "ckyc",
    ])
  )
    return true;
  if (
    containsAny(normalized, [
      "official valid",
      "valid documents",
      "valid document",
    ])
  )
    return true;
  return containsAny(normalized, [
    "ekyc",
    "e kyc",
    "aadhaar",
    "aadhar",
    "use aadhaar",
    "choose ekyc",
    "go with ekyc",
  ]);
}

function isAddressVerifyMethodSelected() {
  if (addressVerifyMethodChosen) return true;
  return Boolean(
    document.querySelector(
      "#welcome-verify-methods-grid .verify-method-card.active",
    ),
  );
}

function isAddressChangeJourneyContextActive() {
  return (
    addressJourneyActive ||
    hasShownAddressVerifyScreen ||
    document.body.classList.contains("address-stage") ||
    document.body.classList.contains("address-consent-stage") ||
    document.body.classList.contains("address-next-stage") ||
    document.body.classList.contains("address-verified-success-stage") ||
    document.body.classList.contains("address-select-stage") ||
    document.body.classList.contains("address-select-confirm") ||
    document.body.classList.contains("address-select-review") ||
    hasShownAddressSelectScreen ||
    hasShownSelfVerifyMethodsScreen ||
    document.body.classList.contains("self-verify-stage")
  );
}

function shouldMarkAddressConsentAskedFromEva(normalizedText: string) {
  if (!normalizedText || !isAddressChangeJourneyContextActive()) return false;
  if (!isAddressVerifyMethodSelected()) return false;
  if (shouldShowAddressVerifyStageFromEva(normalizedText)) return false;
  if (
    containsAny(normalizedText, [
      "consent",
      "permission",
      "authorize",
      "authorise",
    ])
  )
    return true;
  return containsAny(normalizedText, [
    "need your consent",
    "your consent",
    "consent to proceed",
    "do you consent",
    "give your consent",
    "give us your consent",
    "may i have your consent",
    "we will need your consent",
    "need consent",
    "ask for your consent",
    "provide your consent",
    "do you agree",
    "would you agree",
    "are you agree",
    "can we proceed",
    "shall we proceed",
    "may we proceed",
    "ready to proceed",
    "please confirm",
    "kindly confirm",
    "is that okay",
    "is that ok",
    "go ahead with",
    "proceed with aadhaar",
    "proceed with ekyc",
    "fetch your latest address",
    "aadhaar will be used",
    "used to fetch your address",
    "grant permission",
    "give permission",
  ]);
}

function tryShowAddressConsentScreenFromEvaSpeech(
  from: string,
  message: string,
): boolean {
  if (!isWelcomePage() || isLikelyUserSpeaker(from)) return false;
  const normalized = normalizeMessage(message);
  if (!normalized || !shouldMarkAddressConsentAskedFromEva(normalized))
    return false;
  showWelcomeAddressConsentStageFromEva();
  return true;
}

function isAddressConsentConfirmationMessage(message: string) {
  const normalized = normalizeAddressVerifyUserSpeech(message);
  if (!normalized) return false;
  return isAddressVerifyConfirmationForEkyc(normalized);
}

function showWelcomeAddressConsentStageFromEva() {
  if (!isAddressVerifyMethodSelected() || hasShownAddressConsentScreen) return;
  hasAskedAddressConsent = true;
  showWelcomeAddressConsentStage();
  appendLog(
    "[Welcome] Eva asked for consent — showing consent screen (step 3)",
  );
}

function showWelcomeAddressConsentStage() {
  if (hasShownAddressConsentScreen) return;
  document.body.classList.add(
    "eva-started",
    "eva-help-visible",
    "address-consent-stage",
  );
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
  );
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(true);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  hasShownAddressConsentScreen = true;
  awaitingEvaAddressVerifiedSuccessAnnouncement = true;
  setChatInputBoxVisible(true);
  appendLog("[Welcome] Address consent screen visible (step 3)");
}

function showWelcomeAddressNextStage() {
  if (hasShownAddressNextScreen) return;
  document.body.classList.add(
    "eva-started",
    "eva-help-visible",
    "address-next-stage",
  );
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
  );
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(true);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  hasShownAddressNextScreen = true;
  awaitingEvaAddressVerifiedSuccessAnnouncement = true;
  setChatInputBoxVisible(true);
  appendLog(
    "[Welcome] Address Aadhaar verify screen shown (step 4) — awaiting Eva success announcement",
  );
}

function isEvaAddressVerifiedSuccessHeadline(normalizedText: string) {
  if (!normalizedText) return false;
  if (
    normalizedText.includes("aadhaar verified successfully") ||
    normalizedText.includes("aadhar verified successfully")
  ) {
    return true;
  }
  if (
    (normalizedText.includes("aadhaar") || normalizedText.includes("aadhar")) &&
    (normalizedText.includes("successfully verified") ||
      normalizedText.includes("verification successful") ||
      normalizedText.includes("verified with success"))
  ) {
    return true;
  }
  const padded = ` ${normalizedText} `;
  return /(?:^|\s)(?:aadhaar|aadhar)(?:\s+(?:has been|is|was))?\s+verified\s+successfully(?:\s|$)/.test(
    padded,
  );
}

/** Looser match for streaming / interim text while Eva is still speaking. */
function isEvaAddressVerifiedSuccessHeadlineStreaming(normalizedText: string) {
  if (isEvaAddressVerifiedSuccessHeadline(normalizedText)) return true;
  const padded = ` ${normalizedText} `;
  return /(?:^|\s)(?:aadhaar|aadhar)(?:\s+(?:has been|is|was))?\s+verified\s+success(?:ful)?(?:ly)?/.test(
    padded,
  );
}

function isReadyForAddressVerifiedSuccessScreen() {
  return (
    hasShownAddressNextScreen ||
    hasShownAddressConsentScreen ||
    document.body.classList.contains("address-next-stage") ||
    document.body.classList.contains("address-consent-stage")
  );
}

function shouldShowAddressNextFromEva(normalizedText: string) {
  if (!normalizedText || hasShownAddressNextScreen) return false;
  if (
    !hasShownAddressConsentScreen &&
    !document.body.classList.contains("address-consent-stage")
  ) {
    return false;
  }
  return containsAny(normalizedText, [
    "let s verify your aadhaar",
    "lets verify your aadhaar",
    "let us verify your aadhaar",
    "verify your aadhaar",
    "verifying your aadhaar",
    "proceed to verify your aadhaar",
    "thank you let s verify",
    "thank you lets verify",
  ]);
}

function tryShowAddressNextFromEvaSpeech(
  from: string,
  message: string,
): boolean {
  if (!isWelcomePage() || isLikelyUserSpeaker(from)) return false;
  const normalized = normalizeMessage(message);
  if (!normalized || !shouldShowAddressNextFromEva(normalized)) return false;
  if (isEvaAddressVerifiedSuccessHeadlineStreaming(normalized)) return false;
  showWelcomeAddressNextStage();
  appendLog(`[Welcome] Eva prompted Aadhaar verify — step 4 from speech`);
  return true;
}

function shouldShowAddressVerifiedSuccessFromEva(
  normalizedText: string,
  options?: { streaming?: boolean },
) {
  if (!normalizedText) return false;
  if (hasShownAddressVerifiedSuccessScreen) return false;
  if (!isAddressChangeJourneyContextActive()) return false;
  if (!isReadyForAddressVerifiedSuccessScreen()) return false;
  if (
    !awaitingEvaAddressVerifiedSuccessAnnouncement &&
    !hasShownAddressNextScreen
  )
    return false;
  if (document.body.classList.contains("address-verified-success-stage"))
    return false;
  const headlineMatches = options?.streaming
    ? isEvaAddressVerifiedSuccessHeadlineStreaming(normalizedText)
    : isEvaAddressVerifiedSuccessHeadline(normalizedText);
  if (!headlineMatches) return false;

  // Step 5 headline wins over consent / verify-method phrasing in the same utterance.
  if (shouldShowAddressVerifyStageFromEva(normalizedText)) return false;

  return true;
}

/** Step 5 — runs for any inbound line (Eva or mis-tagged transcript) while awaiting success. */
function tryShowAddressVerifiedSuccessFromInbound(
  message: string,
  options?: { streaming?: boolean },
): boolean {
  if (!isWelcomePage()) return false;
  const normalized = normalizeMessage(message);
  if (!shouldShowAddressVerifiedSuccessFromEva(normalized, options))
    return false;
  showWelcomeAddressVerifiedSuccessStage();
  appendLog(`[Welcome] Step 5 from inbound: "${message.trim().slice(0, 120)}"`);
  return true;
}

function showWelcomeAddressVerifiedSuccessStage() {
  if (hasShownAddressVerifiedSuccessScreen) return;
  if (
    !isAddressChangeJourneyContextActive() ||
    !isReadyForAddressVerifiedSuccessScreen()
  )
    return;
  document.body.classList.add(
    "eva-started",
    "eva-help-visible",
    "address-verified-success-stage",
  );
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
  );
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(true);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  hasShownAddressVerifiedSuccessScreen = true;
  awaitingEvaAddressVerifiedSuccessAnnouncement = false;
  awaitingEvaAddressSelectAnnouncement = true;
  setChatInputBoxVisible(true);
  appendLog(
    "[Welcome] Eva announced Aadhaar verified successfully — step 5 shown",
  );
}

function isReadyForAddressSelectScreen() {
  return (
    hasShownAddressVerifiedSuccessScreen ||
    document.body.classList.contains("address-verified-success-stage") ||
    awaitingEvaAddressSelectAnnouncement ||
    (addressJourneyActive &&
      (hasShownAddressNextScreen ||
        hasShownAddressConsentScreen ||
        document.body.classList.contains("address-next-stage")))
  );
}

function isEvaAddressSelectPrompt(normalizedText: string) {
  if (!normalizedText) return false;
  if (
    normalizedText.includes("select the address you want to change") ||
    normalizedText.includes("select the address") ||
    normalizedText.includes("address you want to change") ||
    normalizedText.includes("which address you want to change") ||
    normalizedText.includes("which address would you like") ||
    normalizedText.includes("address you would like to change") ||
    normalizedText.includes("choose the address") ||
    normalizedText.includes("pick the address")
  ) {
    return true;
  }
  return (
    (normalizedText.includes("permanent address") ||
      normalizedText.includes("communication address")) &&
    (normalizedText.includes("select") ||
      normalizedText.includes("choose") ||
      normalizedText.includes("which") ||
      normalizedText.includes("like to change"))
  );
}

function isEvaAddressSelectPromptStreaming(normalizedText: string) {
  if (isEvaAddressSelectPrompt(normalizedText)) return true;
  if (normalizedText.includes("select the address")) return true;
  if (normalizedText.includes("select the add")) return true;
  if (
    normalizedText.includes("address you want") &&
    normalizedText.includes("chang")
  )
    return true;
  if (
    normalizedText.includes("want to change") &&
    normalizedText.includes("address")
  )
    return true;
  return false;
}

function shouldShowAddressSelectFromEva(
  normalizedText: string,
  options?: { streaming?: boolean },
) {
  if (!normalizedText) return false;
  if (hasShownAddressSelectScreen) return false;
  if (!isAddressChangeJourneyContextActive()) return false;
  if (!isReadyForAddressSelectScreen()) return false;
  if (document.body.classList.contains("address-select-stage")) return false;
  const matches = options?.streaming
    ? isEvaAddressSelectPromptStreaming(normalizedText)
    : isEvaAddressSelectPrompt(normalizedText);
  if (!matches) return false;
  // If Eva says the select line (even after success in the same utterance), step 6 wins.
  if (
    !isEvaAddressSelectPromptStreaming(normalizedText) &&
    isEvaAddressVerifiedSuccessHeadlineStreaming(normalizedText)
  ) {
    return false;
  }
  return true;
}

function tryShowAddressSelectFromInbound(
  message: string,
  options?: { streaming?: boolean },
): boolean {
  if (!isWelcomePage()) return false;
  const normalized = normalizeMessage(message);
  if (!shouldShowAddressSelectFromEva(normalized, options)) return false;
  showWelcomeAddressSelectStage();
  appendLog(`[Welcome] Step 6 from inbound: "${message.trim().slice(0, 120)}"`);
  return true;
}

function isEvaAddressUpdatedReviewPrompt(normalizedText: string) {
  if (!normalizedText) return false;
  if (!normalizedText.includes("updated address")) return false;
  if (
    !normalizedText.includes("confirm") ||
    !normalizedText.includes("proceed")
  )
    return false;
  // Match “check / verify / review / see” + optional “your” wording from live STT.
  return (
    /\b(check|verify|review|see|look)\b/.test(normalizedText) ||
    normalizedText.includes("just check") ||
    normalizedText.includes("please check") ||
    normalizedText.includes("kindly check")
  );
}

/** Same gates as {@link isEvaAddressUpdatedReviewPrompt}; used for streamed STT / lk.chat chunks. */
function isEvaAddressUpdatedReviewStreaming(normalizedText: string) {
  return isEvaAddressUpdatedReviewPrompt(normalizedText);
}

function shouldShowAddressSelectReviewFromEva(
  normalizedText: string,
  options?: { streaming?: boolean },
) {
  if (!normalizedText) return false;
  if (
    !hasShownAddressSelectScreen ||
    !document.body.classList.contains("address-select-stage")
  ) {
    return false;
  }
  if (document.body.classList.contains("address-select-review")) return false;
  return options?.streaming
    ? isEvaAddressUpdatedReviewStreaming(normalizedText)
    : isEvaAddressUpdatedReviewPrompt(normalizedText);
}

function tryShowAddressSelectReviewFromInbound(
  message: string,
  options?: { streaming?: boolean },
): boolean {
  if (!isWelcomePage()) return false;
  const normalized = normalizeMessage(message);
  if (!shouldShowAddressSelectReviewFromEva(normalized, options)) return false;
  applyWelcomeAddressSelectReviewView();
  appendLog(
    `[Welcome] Address updated review UI from Eva: "${message.trim().slice(0, 120)}"`,
  );
  return true;
}

function showWelcomeAddressSelectStage() {
  if (hasShownAddressSelectScreen) return;
  if (!isReadyForAddressSelectScreen()) return;
  clearWelcomeAddressSelectConfirmState();
  document.body.classList.add(
    "eva-started",
    "eva-help-visible",
    "address-select-stage",
  );
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
  );
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(true);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  hasShownAddressSelectScreen = true;
  awaitingEvaAddressSelectAnnouncement = false;
  setChatInputBoxVisible(true);
  appendLog("[Welcome] Address select screen shown (step 6)");
}

function isEvaSelfVerifyIntroPrompt(normalizedText: string) {
  if (!normalizedText) return false;
  if (
    normalizedText.includes("one final step") &&
    normalizedText.includes("it s done")
  ) {
    return true;
  }
  if (
    normalizedText.includes("okay") &&
    normalizedText.includes("one final step") &&
    normalizedText.includes("done")
  ) {
    return true;
  }
  return false;
}

function isEvaSelfVerifyIntroStreaming(normalizedText: string) {
  if (isEvaSelfVerifyIntroPrompt(normalizedText)) return true;
  if (
    normalizedText.includes("one final step") &&
    normalizedText.includes("done")
  )
    return true;
  if (normalizedText.includes("okay") && normalizedText.includes("final step"))
    return true;
  return false;
}

function isReadyForSelfVerifyMethodsScreen() {
  return (
    hasShownAddressSelectScreen ||
    document.body.classList.contains("address-select-stage") ||
    document.body.classList.contains("address-select-confirm") ||
    document.body.classList.contains("address-select-review")
  );
}

function shouldShowSelfVerifyMethodsFromEva(
  normalizedText: string,
  options?: { streaming?: boolean },
) {
  if (!normalizedText) return false;
  if (hasShownSelfVerifyMethodsScreen) return false;
  if (!isReadyForSelfVerifyMethodsScreen()) return false;
  if (document.body.classList.contains("self-verify-stage")) return false;
  const matches = options?.streaming
    ? isEvaSelfVerifyIntroStreaming(normalizedText)
    : isEvaSelfVerifyIntroPrompt(normalizedText);
  if (!matches) return false;
  // Step 7 intro wins over step 6 select phrasing if both appear in one utterance.
  if (
    !options?.streaming &&
    shouldShowAddressSelectFromEva(normalizedText) &&
    isEvaAddressSelectPrompt(normalizedText)
  ) {
    return false;
  }
  return true;
}

function tryShowSelfVerifyMethodsFromInbound(
  message: string,
  options?: { streaming?: boolean },
): boolean {
  if (!isWelcomePage()) return false;
  const normalized = normalizeMessage(message);
  if (!shouldShowSelfVerifyMethodsFromEva(normalized, options)) return false;
  showWelcomeSelfVerifyMethodsStage();
  appendLog(`[Welcome] Step 7 from inbound: "${message.trim().slice(0, 120)}"`);
  return true;
}

function isEvaFaceScanPrompt(normalizedText: string) {
  if (!normalizedText) return false;
  const hasLookStraight =
    normalizedText.includes("look straight") ||
    normalizedText.includes("look stra") ||
    (normalizedText.includes("look") && normalizedText.includes("straight"));
  const hasQuick =
    normalizedText.includes("quick process") ||
    normalizedText.includes("quick");
  return hasLookStraight && (hasQuick || normalizedText.includes("great"));
}

function isEvaFaceScanPromptStreaming(normalizedText: string) {
  if (isEvaFaceScanPrompt(normalizedText)) return true;
  if (
    normalizedText.includes("look straight") ||
    normalizedText.includes("look stra")
  )
    return true;
  if (normalizedText.includes("look") && normalizedText.includes("straight"))
    return true;
  return false;
}

function shouldShowFaceScanFromEva(
  normalizedText: string,
  options?: { streaming?: boolean },
) {
  if (!normalizedText) return false;
  if (hasShownFaceScanScreen) return false;
  if (document.body.classList.contains("face-scan-stage")) return false;
  const matches = options?.streaming
    ? isEvaFaceScanPromptStreaming(normalizedText)
    : isEvaFaceScanPrompt(normalizedText);
  if (!matches) return false;
  return (
    isReadyForFaceScanScreen() ||
    hasShownSelfVerifyMethodsScreen ||
    document.body.classList.contains("self-verify-stage")
  );
}

function tryShowFaceScanFromInbound(
  message: string,
  options?: { streaming?: boolean },
): boolean {
  if (!isWelcomePage()) return false;
  const normalized = normalizeMessage(message);
  if (!shouldShowFaceScanFromEva(normalized, options)) return false;
  showWelcomeFaceScanStage({ force: true });
  appendLog(`[Welcome] Step 8 from Eva: "${message.trim().slice(0, 120)}"`);
  return true;
}

function isEvaAddressRequestSubmittedAnnouncement(normalizedText: string) {
  if (!normalizedText) return false;
  if (!normalizedText.includes("request submitted")) return false;
  const hasUpdateLine =
    normalizedText.includes("24 hr") ||
    normalizedText.includes("24 hours") ||
    normalizedText.includes("communication address") ||
    normalizedText.includes("updated within");
  const hasHelpLine =
    normalizedText.includes("need help") ||
    normalizedText.includes("anything else");
  return hasUpdateLine || hasHelpLine;
}

function shouldDeferEvaRequestSubmittedCopy(from: string, message: string) {
  if (!isWelcomePage() || !isLikelyEvaSpeaker(from)) return false;
  if (hasShownAddressRequestSubmittedScreen) return false;
  const normalized = normalizeMessage(message);
  if (!isEvaAddressRequestSubmittedAnnouncement(normalized)) return false;
  return (
    document.body.classList.contains("face-scan-stage") ||
    (welcomeFaceCaptureHandled && !hasShownAddressRequestSubmittedScreen)
  );
}

function applyWelcomeAddressRequestSubmittedEvaCopy() {
  const dateTextEl = document.getElementById("transcription-display");
  if (!dateTextEl) return;
  const copy =
    pendingEvaRequestSubmittedCopy?.trim() ||
    EVA_ADDRESS_REQUEST_SUBMITTED_DISPLAY;
  dateTextEl.textContent = copy;
  pendingEvaRequestSubmittedCopy = null;
}

function setWelcomeAddressSelectActive(
  type: "permanent" | "communication" | null,
) {
  const grid = document.getElementById("welcome-address-select-cards");
  if (!grid) return;
  grid.querySelectorAll<HTMLElement>(".address-select-card").forEach((card) => {
    const active = type !== null && card.dataset.addressType === type;
    card.classList.toggle("active", active);
    card.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

const WELCOME_ADDRESS_CONFIRM_COMM_HTML =
  '101 Aecs Layout, Whitefield,<br /><span class="address-select-card-address-line2">Bengaluru</span>';
const WELCOME_ADDRESS_CONFIRM_PERM_TEXT =
  "101 Aecs Layout, Whitefield, Bengaluru";
/** Unified copy shown on both rows in the Eva “updated address review” dual-card UI. */
const WELCOME_ADDRESS_REVIEW_DISPLAY = "101 Aecs Layout, Whitefield, Bengaluru";

function applyWelcomeAddressSelectReviewView() {
  const root = document.getElementById("welcome-address-select");
  if (!root || !document.body.classList.contains("address-select-stage"))
    return;

  document.body.classList.remove("address-select-confirm");
  document.body.classList.add("address-select-review");
  hasConfirmedAddressSelectView = false;

  root.setAttribute("aria-label", "Review your updated addresses");

  const pickingHead = root.querySelector(".address-select-head--picking");
  const confirmHead = root.querySelector(".address-select-head--confirm");
  const reviewHead = root.querySelector(".address-select-head--review");
  if (pickingHead) pickingHead.setAttribute("aria-hidden", "true");
  if (confirmHead) confirmHead.setAttribute("aria-hidden", "true");
  if (reviewHead) reviewHead.removeAttribute("aria-hidden");

  root.querySelectorAll<HTMLElement>(".address-select-card").forEach((card) => {
    card.classList.remove("address-select-card--suppressed");
    card.classList.remove("active");
    card.removeAttribute("aria-hidden");
    card.removeAttribute("tabindex");
    card.removeAttribute("aria-pressed");
    card.setAttribute("role", "group");
    const badge = card.querySelector<HTMLElement>(".address-select-badge");
    const type = card.dataset.addressType;
    if (badge) {
      badge.textContent =
        type === "communication" ? "As per Aadhaar" : "As per Bank Records";
    }
    const addr = card.querySelector<HTMLElement>(
      ".address-select-card-address",
    );
    if (addr) addr.textContent = WELCOME_ADDRESS_REVIEW_DISPLAY;
  });
}

function clearWelcomeAddressSelectConfirmState() {
  hasConfirmedAddressSelectView = false;
  document.body.classList.remove(
    "address-select-confirm",
    "address-select-review",
  );
  const root = document.getElementById("welcome-address-select");
  if (!root) return;
  root.setAttribute("aria-label", "Select the address you want to change");
  const pickingHead = root.querySelector(".address-select-head--picking");
  const confirmHead = root.querySelector(".address-select-head--confirm");
  const reviewHead = root.querySelector(".address-select-head--review");
  if (pickingHead) pickingHead.removeAttribute("aria-hidden");
  if (confirmHead) confirmHead.setAttribute("aria-hidden", "true");
  if (reviewHead) reviewHead.setAttribute("aria-hidden", "true");
  root.querySelectorAll<HTMLElement>(".address-select-card").forEach((card) => {
    card.classList.remove("address-select-card--suppressed");
    card.removeAttribute("aria-hidden");
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute(
      "aria-pressed",
      card.classList.contains("active") ? "true" : "false",
    );
  });
  root.querySelectorAll<HTMLElement>(".address-select-badge").forEach((el) => {
    el.textContent = "As per Bank Records";
  });
  root
    .querySelectorAll<HTMLElement>(".address-select-card-address")
    .forEach((el) => {
      const d = el.getAttribute("data-default-address");
      if (d) el.textContent = d;
    });
}

function isAddressSelectConfirmationMessage(message: string) {
  const normalized = normalizeAddressVerifyUserSpeech(message);
  if (!normalized) return false;
  if (normalized.split(/\s+/).filter(Boolean).length > 16) return false;
  if (isAddressVerifyConfirmationForEkyc(normalized)) return true;
  if (
    containsAny(normalized, [
      "this is correct",
      "looks good",
      "looks correct",
      "that s fine",
      "thats fine",
      "sounds good",
      "go ahead with this",
      "proceed with this",
      "confirm this address",
      "use this address",
      "with this address",
    ])
  ) {
    return true;
  }
  return false;
}

function applyWelcomeAddressSelectConfirmView() {
  if (hasConfirmedAddressSelectView) return;
  if (document.body.classList.contains("address-select-review")) return;
  const root = document.getElementById("welcome-address-select");
  if (!root) return;
  const active = root.querySelector<HTMLElement>(".address-select-card.active");
  if (!active) return;
  hasConfirmedAddressSelectView = true;
  document.body.classList.remove("address-select-review");
  document.body.classList.add("address-select-confirm");
  root.setAttribute("aria-label", "Confirm selected address");
  const pickingHead = root.querySelector(".address-select-head--picking");
  const confirmHead = root.querySelector(".address-select-head--confirm");
  const reviewHead = root.querySelector(".address-select-head--review");
  if (pickingHead) pickingHead.setAttribute("aria-hidden", "true");
  if (confirmHead) confirmHead.removeAttribute("aria-hidden");
  if (reviewHead) reviewHead.setAttribute("aria-hidden", "true");
  root.querySelectorAll<HTMLElement>(".address-select-card").forEach((card) => {
    if (!card.classList.contains("active")) {
      card.classList.add("address-select-card--suppressed");
      card.setAttribute("aria-hidden", "true");
      card.removeAttribute("tabindex");
      card.removeAttribute("role");
    } else {
      card.setAttribute("role", "region");
      card.removeAttribute("tabindex");
      card.removeAttribute("aria-pressed");
    }
  });
  const badge = active.querySelector<HTMLElement>(".address-select-badge");
  if (badge) badge.textContent = "As per Aadhaar";
  const type = active.dataset.addressType;
  const addrEl = active.querySelector<HTMLElement>(
    ".address-select-card-address",
  );
  if (addrEl) {
    if (type === "communication") {
      addrEl.innerHTML = WELCOME_ADDRESS_CONFIRM_COMM_HTML;
    } else if (type === "permanent") {
      addrEl.textContent = WELCOME_ADDRESS_CONFIRM_PERM_TEXT;
    }
  }
  appendLog("[Welcome] Address select: user confirmed — single-card view");
}

function resetWelcomeAddressSelectCards() {
  clearWelcomeAddressSelectConfirmState();
  // Show both cards unselected — the user must explicitly pick one.
  setWelcomeAddressSelectActive(null);
}

function initWelcomeAddressSelectCards() {
  const grid = document.getElementById("welcome-address-select-cards");
  if (!grid || grid.dataset.bound === "true") return;
  grid.dataset.bound = "true";
  const cards = Array.from(
    grid.querySelectorAll<HTMLElement>(".address-select-card"),
  );
  const setActive = (card: HTMLElement) => {
    if (hasConfirmedAddressSelectView) return;
    if (document.body.classList.contains("address-select-review")) return;
    const type = card.dataset.addressType;
    if (type === "permanent" || type === "communication") {
      setWelcomeAddressSelectActive(type);
      appendLog(`[Welcome] Address select: user chose ${type}`);
    }
  };
  cards.forEach((card) => {
    card.addEventListener("click", () => setActive(card));
    card.addEventListener("keydown", (event) => {
      if (
        hasConfirmedAddressSelectView ||
        document.body.classList.contains("address-select-review")
      )
        return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setActive(card);
      }
    });
  });
}

function resolveAddressSelectFromUserSpeech(
  message: string,
): "permanent" | "communication" | null {
  const normalized = normalizeAddressVerifyUserSpeech(message);
  if (!normalized) return null;
  if (
    containsAny(normalized, [
      "permanent address",
      "permenant address",
      "parmanent address",
    ])
  ) {
    return "permanent";
  }
  if (
    containsAny(normalized, [
      "communication address",
      "correspondence address",
      "mailing address",
    ])
  ) {
    return "communication";
  }
  if (normalized.includes("permanent") && !normalized.includes("communication"))
    return "permanent";
  if (normalized.includes("communication")) return "communication";
  return null;
}

function tryApplyWelcomeAddressSelectFromUserSpeech(
  message: string,
  from: string,
  localTranscript = false,
): boolean {
  if (!isWelcomePage()) return false;
  if (
    !hasShownAddressSelectScreen ||
    !document.body.classList.contains("address-select-stage")
  ) {
    return false;
  }
  if (!isWelcomeUserUtterance(from, localTranscript)) return false;
  if (hasConfirmedAddressSelectView) return false;
  if (document.body.classList.contains("address-select-review")) return false;

  const type = resolveAddressSelectFromUserSpeech(message);
  if (type) {
    setWelcomeAddressSelectActive(type);
    appendLog(
      `[Welcome] Address select: speech chose ${type} ("${message.trim()}")`,
    );
  }

  if (isAddressSelectConfirmationMessage(message)) {
    applyWelcomeAddressSelectConfirmView();
    return true;
  }

  return Boolean(type);
}

function canProceedToAddressNextConfirmation(message: string) {
  if (!hasAskedAddressConsent || !hasShownAddressConsentScreen) return false;
  const normalized = normalizeAddressVerifyUserSpeech(message);
  if (!normalized || !isAddressConsentConfirmationMessage(message))
    return false;
  return !isAddressVerifyMethodExplicitChoice(normalized);
}

function tryApplyWelcomeAddressNextFromUserSpeech(
  message: string,
  from: string,
  localTranscript = false,
): boolean {
  if (!isWelcomePage()) return false;
  if (!addressJourneyActive || hasShownAddressNextScreen) return false;
  if (!document.body.classList.contains("address-consent-stage")) return false;
  if (!canTreatInboundAsAddressVerifyUserReply(message, from, localTranscript))
    return false;
  if (!canProceedToAddressNextConfirmation(message)) return false;

  showWelcomeAddressNextStage();
  appendLog(
    `[Welcome] User confirmed after consent ("${message.trim()}") — step 4`,
  );
  return true;
}

function isWelcomeUserUtterance(from: string, localTranscript = false) {
  return localTranscript || isLikelyUserSpeaker(from);
}

function isLikelyEvaAddressVerifyPrompt(message: string) {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  return containsAny(normalized, [
    "please choose a verification",
    "choose a verification",
    "verification method",
    "faster via ekyc",
    "lets change your address",
    "let s change your address",
    "change your address",
    "how may i help",
    "i am eva",
    "all new smart",
  ]);
}

function isAddressVerifyConfirmationForEkyc(normalized: string) {
  if (
    /^(yes|yeah|yep|yup|sure|ok|okay|confirm|proceed|continue)\b/.test(
      normalized,
    ) ||
    /^(go ahead|go ahed|go on|let s go|lets go)\b/.test(normalized)
  ) {
    return true;
  }

  if (
    containsAny(normalized, [
      "go ahead",
      "go ahed",
      "go on",
      "sounds good",
      "yes please",
      "please proceed",
      "lets proceed",
      "let s proceed",
      "carry on",
    ])
  ) {
    return normalized.split(" ").filter(Boolean).length <= 10;
  }

  return false;
}

function resolveWelcomeVerifyMethodFromUserSpeech(
  message: string,
): string | null {
  const normalized = normalizeAddressVerifyUserSpeech(message);
  if (!normalized) return null;

  if (containsAny(normalized, ["digilocker", "digi locker", "digi-locker"]))
    return "digilocker";
  if (/\bckyc\b/.test(normalized)) return "ckyc";
  if (
    containsAny(normalized, [
      "official valid",
      "valid documents",
      "valid document",
    ])
  )
    return "documents";

  if (
    containsAny(normalized, [
      "ekyc",
      "e kyc",
      "aadhaar ekyc",
      "aadhar ekyc",
      "aadhaar e kyc",
      "aadhar e kyc",
      "use ekyc",
      "via ekyc",
      "with ekyc",
      "choose ekyc",
      "go with ekyc",
      "use aadhaar",
      "aadhaar please",
    ])
  ) {
    return "ekyc";
  }

  if (
    (normalized.includes("aadhaar") || normalized.includes("aadhar")) &&
    normalized.includes("ekyc")
  ) {
    return "ekyc";
  }

  if (
    (normalized.includes("aadhaar") || normalized.includes("aadhar")) &&
    !containsAny(normalized, [
      "digilocker",
      "ckyc",
      "official valid",
      "valid document",
    ])
  ) {
    return "ekyc";
  }

  if (isAddressVerifyConfirmationForEkyc(normalized)) {
    // After a method is already chosen, "ok/yes" is consent — not re-selection.
    if (addressVerifyMethodChosen) return null;
    return "ekyc";
  }

  return null;
}

function canTreatInboundAsAddressVerifyUserReply(
  message: string,
  from: string,
  localTranscript: boolean,
) {
  if (!isWelcomeUserUtterance(from, localTranscript)) return false;
  if (isLikelyEvaAddressVerifyPrompt(message)) return false;
  if (resolveWelcomeVerifyMethodFromUserSpeech(message)) return true;
  const normalized = normalizeAddressVerifyUserSpeech(message);
  if (!normalized) return false;
  return normalized.split(" ").filter(Boolean).length <= 8;
}

function isUserFaceAuthChoice(normalized: string) {
  if (!normalized) return false;
  if (
    /\bface\b/.test(normalized) &&
    !containsAny(normalized, ["interface", "surface", "preface"])
  ) {
    return true;
  }
  if (
    containsAny(normalized, [
      "face auth",
      "face authentication",
      "face verification",
      "face identify",
      "face id",
      "face scan",
      "facial auth",
      "facial recognition",
      "secured bank face",
      "bank face",
    ])
  ) {
    return true;
  }
  if (
    normalized.includes("face") &&
    containsAny(normalized, [
      "go with",
      "i will go",
      "ill go",
      "i ll go",
      "choose",
      "select",
      "pick",
      "use",
      "want",
      "prefer",
      "take",
      "with",
    ])
  ) {
    return true;
  }
  if (
    containsAny(normalized, [
      "first option",
      "1st option",
      "option one",
      "option 1",
      "option number one",
      "option no 1",
      "option no one",
      "number one",
      "number 1",
      "the first one",
      "first one",
    ])
  ) {
    return true;
  }
  return false;
}

function isReadyForFaceScanScreen() {
  return (
    hasShownSelfVerifyMethodsScreen ||
    document.body.classList.contains("self-verify-stage") ||
    document.body.classList.contains("address-select-stage") ||
    document.body.classList.contains("address-select-confirm") ||
    document.body.classList.contains("address-select-review") ||
    hasShownAddressSelectScreen
  );
}

function shouldShowFaceScanFromUserSpeech(normalized: string) {
  if (!normalized) return false;
  if (hasShownFaceScanScreen) return false;
  if (!isReadyForFaceScanScreen()) return false;
  if (document.body.classList.contains("face-scan-stage")) return false;
  return isUserFaceAuthChoice(normalized);
}

function tryShowFaceScanFromUserSpeech(
  message: string,
  from: string,
  localTranscript = false,
): boolean {
  if (!isWelcomePage()) return false;
  if (!isWelcomeUserUtterance(from, localTranscript)) return false;
  const normalized = normalizeMessage(message);
  if (!shouldShowFaceScanFromUserSpeech(normalized)) return false;
  showWelcomeFaceScanStage();
  appendLog(
    `[Welcome] Step 8 from user speech: "${message.trim().slice(0, 120)}"`,
  );
  return true;
}

function tryApplyWelcomeSelfVerifyStepFromUserSpeech(
  message: string,
  from: string,
  localTranscript = false,
): boolean {
  return tryShowFaceScanFromUserSpeech(message, from, localTranscript);
}

function tryApplyWelcomeAddressStepFromUserSpeech(
  message: string,
  from: string,
  localTranscript = false,
): boolean {
  if (
    tryApplyWelcomeSelfVerifyStepFromUserSpeech(message, from, localTranscript)
  )
    return true;
  if (
    tryApplyWelcomeAddressSelectFromUserSpeech(message, from, localTranscript)
  )
    return true;
  if (tryApplyWelcomeAddressNextFromUserSpeech(message, from, localTranscript))
    return true;
  return tryApplyWelcomeAddressVerifyMethodFromUserSpeech(
    message,
    from,
    localTranscript,
  );
}

function tryApplyWelcomeAddressVerifyMethodFromUserSpeech(
  message: string,
  from: string,
  localTranscript = false,
): boolean {
  if (!isWelcomePage()) return false;
  if (!isWelcomeUserUtterance(from, localTranscript)) return false;
  if (
    hasShownAddressConsentScreen ||
    document.body.classList.contains("address-consent-stage")
  )
    return false;
  if (
    hasShownAddressVerifiedSuccessScreen ||
    document.body.classList.contains("address-verified-success-stage")
  ) {
    return false;
  }
  if (
    !addressJourneyActive ||
    !document.body.classList.contains("address-stage")
  )
    return false;
  if (!canTreatInboundAsAddressVerifyUserReply(message, from, localTranscript))
    return false;

  const method = resolveWelcomeVerifyMethodFromUserSpeech(message);
  if (!method) return false;

  if (
    addressVerifyMethodChosen === method &&
    canProceedToAddressNextConfirmation(message)
  ) {
    return false;
  }

  setWelcomeVerifyMethodActive(method);
  appendLog(
    `[Welcome] Address verify: user speech selected ${method} ("${message.trim()}")`,
  );
  return true;
}

function shouldShowAddressVerifyStageFromEva(normalizedText: string) {
  if (!normalizedText) return false;
  return containsAny(normalizedText, [
    "please choose a verification method",
    "choose a verification method",
    "choose verification method",
    "it will be faster via ekyc",
    "faster via ekyc",
    "lets change your address",
    "let s change your address",
    "change your address",
    "update your address",
  ]);
}

function showWelcomeDetailsStage() {
  const wasAlreadyDetails = document.body.classList.contains("details-stage");
  document.body.classList.add("eva-started", "details-stage");
  document.body.classList.remove(
    "forex-stage",
    "best-card-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
  );
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  hasShownWelcomeDetailsScreen = true;
  if (!wasAlreadyDetails) {
    resetWelcomeDetailOptionCards();
  }
  setWelcomeDetailsScreenVisibility(true);
  setWelcomeBestCardScreenVisibility(false);
  setWelcomeForexVisibility(false);
}

function showWelcomeBestCardStage() {
  document.body.classList.add("eva-started", "best-card-stage");
  document.body.classList.remove(
    "forex-stage",
    "details-stage",
    "address-stage",
    "address-consent-stage",
    "address-next-stage",
    "address-verified-success-stage",
    "address-select-stage",
    "address-select-confirm",
    "address-select-review",
    "self-verify-stage",
    "face-scan-stage",
    "address-request-submitted-stage",
  );
  setWelcomeDetailsScreenVisibility(false);
  setWelcomeBestCardScreenVisibility(true);
  setWelcomeAddressVerifyVisibility(false);
  setWelcomeAddressConsentVisibility(false);
  setWelcomeAddressNextVisibility(false);
  setWelcomeAddressVerifiedSuccessVisibility(false);
  setWelcomeAddressSelectVisibility(false);
  setWelcomeSelfVerifyMethodsVisibility(false);
  setWelcomeFaceScanVisibility(false);
  setWelcomeAddressRequestSubmittedVisibility(false);
  setWelcomeForexVisibility(false);
  resetWelcomeDetailOptionCards();
}

function setWelcomeAddressVerifyVisibility(visible: boolean) {
  const addressVerify = document.getElementById("address-verify-showcase");
  if (addressVerify) {
    addressVerify.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function setWelcomeAddressConsentVisibility(visible: boolean) {
  const consentShowcase = document.getElementById("address-consent-showcase");
  if (consentShowcase) {
    consentShowcase.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function setWelcomeAddressNextVisibility(visible: boolean) {
  const nextShowcase = document.getElementById("address-next-showcase");
  if (nextShowcase) {
    nextShowcase.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function setWelcomeAddressVerifiedSuccessVisibility(visible: boolean) {
  const successShowcase = document.getElementById(
    "address-verified-success-showcase",
  );
  if (successShowcase) {
    successShowcase.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function setWelcomeAddressSelectVisibility(visible: boolean) {
  const selectShowcase = document.getElementById("address-select-showcase");
  if (selectShowcase) {
    selectShowcase.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function setWelcomeSelfVerifyMethodsVisibility(visible: boolean) {
  const showcase = document.getElementById("self-verify-methods-showcase");
  if (showcase) {
    showcase.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function setWelcomeFaceScanVisibility(visible: boolean) {
  const showcase = document.getElementById("face-scan-showcase");
  if (showcase) {
    showcase.setAttribute("aria-hidden", visible ? "false" : "true");
  }
  if (!visible) {
    stopWelcomeFaceScanCamera();
  }
}

function setWelcomeAddressRequestSubmittedVisibility(visible: boolean) {
  const showcase = document.getElementById(
    "address-request-submitted-showcase",
  );
  if (showcase) {
    showcase.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function resetWelcomeSelfVerifyMethodCards() {
  document
    .querySelectorAll("#welcome-self-verify-methods-grid .verify-method-card")
    .forEach((card) => {
      card.classList.remove("active");
      card.setAttribute("aria-pressed", "false");
    });
}

function initWelcomeSelfVerifyMethodsCards() {
  const grid = document.getElementById("welcome-self-verify-methods-grid");
  if (!grid) return;
  const methodCards = Array.from(grid.querySelectorAll(".verify-method-card"));
  const setActiveSelfVerifyCard = (card: Element) => {
    methodCards.forEach((c) => {
      const active = c === card;
      c.classList.toggle("active", active);
      c.setAttribute("aria-pressed", active ? "true" : "false");
    });
  };
  methodCards.forEach((card) => {
    const onActivate = () => {
      setActiveSelfVerifyCard(card);
      if ((card as HTMLElement).dataset.method === "face-auth") {
        activateWelcomeFaceAuthChoice();
      }
    };
    card.addEventListener("click", onActivate);
    card.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" || ke.key === " ") {
        ke.preventDefault();
        onActivate();
      }
    });
  });
}

function setWelcomeForexVisibility(visible: boolean) {
  const showcase = document.getElementById("forex-showcase");
  if (showcase) {
    showcase.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function setWelcomeDetailsScreenVisibility(visible: boolean) {
  const detailsScreen = document.getElementById(
    "travel-details-needed-showcase",
  );
  if (detailsScreen) {
    detailsScreen.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function setWelcomeBestCardScreenVisibility(visible: boolean) {
  const bestCardScreen = document.getElementById("welcome-best-card-screen");
  if (bestCardScreen) {
    bestCardScreen.setAttribute("aria-hidden", visible ? "false" : "true");
  }
}

function resetWelcomeFlowState() {
  hasShownWelcomeForexScreen = false;
  hasAskedWelcomeBestSuitedConsent = false;
  hasConfirmedWelcomeBestSuitedConsent = false;
  hasShownWelcomeDetailsScreen = false;
  hasShownAddressVerifyScreen = false;
  addressJourneyActive = false;
  awaitingEvaLiveSearchPanelAnswer = false;
  // Invalidate any in-flight live search so its (now stale) answer is ignored.
  liveSearchRequestSeq++;
  resetAddressConsentFlowState();
  resetCashWithdrawFlowState();
  resetSendMoneyFlowState();
  resetHomeLoanFlowState();
}

function userMessageHintsDepartureDate(
  rawLower: string,
  normalized: string,
): boolean {
  if (!normalized && !rawLower) return false;
  if (
    containsAny(normalized, [
      "departure date",
      "date of departure",
      "travel date",
      "date of travel",
      "leaving on",
      "flying on",
      "depart on",
      "departing",
      "travel on",
    ])
  ) {
    return true;
  }
  if (/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/.test(rawLower)) return true;
  if (
    /\b(next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b/.test(
      normalized,
    )
  )
    return true;
  if (containsAny(normalized, ["today", "tomorrow"])) return true;
  if (/\b(20\d{2}|19\d{2})\b/.test(normalized)) return true;
  if (/\b\d{1,2}(st|nd|rd|th)\b/.test(normalized)) return true;
  const monthWords = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
  ];
  for (const m of monthWords) {
    if (!normalized.includes(m)) continue;
    if (/\d/.test(normalized)) return true;
  }
  return false;
}

function userMessageHintsCurrencyTransact(
  rawLower: string,
  normalized: string,
): boolean {
  if (!normalized && !rawLower) return false;
  if (/\b(inr|usd|eur|gbp|aed|jpy|chf|cad|aud|sar)\b/i.test(rawLower))
    return true;
  return containsAny(normalized, [
    "usd",
    "inr",
    "eur",
    "gbp",
    "aed",
    "jpy",
    "chf",
    "cad",
    "aud",
    "sar",
    "dollar",
    "dollars",
    "euro",
    "euros",
    "rupee",
    "rupees",
    "pound",
    "pounds",
    "yen",
    "transaction currency",
    "required currency",
    "currency to transact",
    "currency of transact",
    "forex currency",
    "spend in",
    "pay in",
    "load in",
    "us dollar",
    "indian rupee",
  ]);
}

function userMessageHintsPlacesToVisit(
  rawLower: string,
  normalized: string,
): boolean {
  if (!normalized && !rawLower) return false;
  if (
    containsAny(normalized, [
      "places to visit",
      "place to visit",
      "country of visit",
      "countries to visit",
      "country to visit",
      "travel destination",
      "traval destination",
      "destination is",
      "visiting",
      "going to ",
      "travel to ",
      "flying to ",
      "trip to ",
    ])
  ) {
    return true;
  }
  if (
    containsAny(normalized, [
      "usa",
      "u s a",
      "uk ",
      " uae",
      "india",
      "thailand",
      "singapore",
      "france",
      "germany",
      "japan",
      "canada",
      "australia",
      "dubai",
      "london",
      "paris",
      "bali",
      "europe",
      "america",
      "new york",
      "los angeles",
    ])
  ) {
    return true;
  }
  const likelyPlainLocationAnswer =
    /^[a-z\s]{3,40}$/.test(normalized) &&
    normalized.split(" ").length <= 4 &&
    !containsAny(normalized, [
      "purpose",
      "currency",
      "date",
      "departure",
      "travel card",
      "forex",
    ]) &&
    !userMessageHintsCurrencyTransact(rawLower, normalized) &&
    !userMessageHintsDepartureDate(rawLower, normalized) &&
    !userMessageHintsPurposeOfVisit(rawLower, normalized);
  if (likelyPlainLocationAnswer) return true;
  if (/\bvisit(ing)? (?!purpose\b)[a-z]{3,}\b/.test(normalized)) return true;
  return false;
}

function userMessageHintsPurposeOfVisit(
  rawLower: string,
  normalized: string,
): boolean {
  if (!normalized && !rawLower) return false;
  if (/(purpose).*(travel|traval|trip|visit)/.test(normalized)) return true;
  if (
    /\bfor (holiday|vacation|tourism|business|work|official|education|study|medical|treatment|family|pilgrimage|honeymoon)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  return containsAny(normalized, [
    "purpose of visit",
    "purpose of travel",
    "purpose of traval",
    "travel purpose",
    "traval purpose",
    "trip purpose",
    "purpose",
    "holiday",
    "vacation",
    "tourism",
    "tourist",
    "leisure",
    "business",
    "work",
    "official",
    "business trip",
    "for business",
    "on business",
    "official trip",
    "conference",
    "education",
    "study",
    "study trip",
    "student",
    "medical",
    "treatment",
    "family trip",
    "pilgrimage",
    "honeymoon",
    "work trip",
  ]);
}

function applyWelcomeDetailsOptionsFromUserMessage(message: string) {
  if (!isJourneyPage()) return;
  const detailsVisible =
    document.body.classList.contains("details-stage") ||
    document
      .getElementById("travel-details-needed-showcase")
      ?.getAttribute("aria-hidden") === "false";
  if (!detailsVisible) return;
  const rawLower = message.toLowerCase().trim();
  const normalized = normalizeMessage(message);
  if (!normalized && !rawLower) return;

  const screen = document.getElementById("travel-details-needed-showcase");
  if (!screen) return;

  const checks: Array<[string, (raw: string, n: string) => boolean]> = [
    ["departure", userMessageHintsDepartureDate],
    ["currency", userMessageHintsCurrencyTransact],
    ["places", userMessageHintsPlacesToVisit],
    ["purpose", userMessageHintsPurposeOfVisit],
  ];

  const matchedKeys: string[] = [];
  for (const [key, test] of checks) {
    if (!test(rawLower, normalized)) continue;
    matchedKeys.push(key);
  }

  if (matchedKeys.length === 0) return;

  // One sentence can include multiple details; activate all matched cards.
  for (const key of matchedKeys) {
    const card = screen.querySelector<HTMLElement>(
      `.travel-details-needed-card[data-detail-key="${key}"]`,
    );
    if (!card) continue;
    card.classList.add("travel-details-needed-card--active");
    card.setAttribute("aria-pressed", "true");
  }
}

function isAddressChangeIntentMessage(message: string): boolean {
  const normalized = normalizeMessage(message);
  if (!normalized) return false;
  if (
    containsAny(normalized, [
      "change my address",
      "change address",
      "update my address",
      "update address",
      "address change",
      "modify my address",
      "correct my address",
      "change of address",
      "want to change my address",
      "need to change my address",
      "i want to change my address",
      "i want to change address",
      "i need to change my address",
      "i would like to change my address",
      "like to change my address",
      "help me change my address",
      "change the address",
      "update the address",
      "new address",
    ])
  ) {
    return true;
  }
  if (!normalized.includes("address")) return false;
  if (!containsAny(normalized, ["change", "update", "modify", "correct"]))
    return false;
  return containsAny(normalized, [
    "i want",
    "i need",
    "i would",
    "want to",
    "need to",
    "like to",
    "help me",
    "please",
  ]);
}

function updateWelcomeFlowFromUser(message: string) {
  if (!isJourneyPage()) return;
  const normalized = normalizeMessage(message);
  if (!normalized) return;

  // ── Cross-journey switching ──────────────────────────────────────────────
  // An explicit intent for a DIFFERENT journey wins at any time — even mid-journey
  // or while the live-chat panel is open — so the user can jump straight from one
  // journey into another. These run BEFORE the active-journey step handlers so a
  // switch phrase ("withdraw cash") isn't mistaken for a step input (e.g. a payee).
  if (!sendMoneyJourneyActive && isSendMoneyIntentMessage(message)) {
    startSendMoneyJourney({ force: true });
    return;
  }
  if (!cashWithdrawJourneyActive && isCashWithdrawIntentMessage(message)) {
    startCashWithdrawJourney({ force: true });
    return;
  }
  if (!addressJourneyActive && isAddressChangeIntentMessage(message)) {
    startAddressChangeJourney({ force: true });
    return;
  }
  if (!homeLoanJourneyActive && isHomeLoanJourneyIntentMessage(message)) {
    startHomeLoanJourney({ force: true });
    return;
  }
  // Forex switch is handled inside `showWelcomeForexStage` via
  // `resetOtherJourneysExcept('forex')`.
  if (!hasShownWelcomeForexScreen && isUserForexCardIntent(normalized)) {
    showWelcomeForexStage();
    setChatInputBoxVisible(true);
    return;
  }

  // ── Active-journey step progression ──────────────────────────────────────
  // Send-money / withdraw step handlers run after switch checks so that
  // OTP/account/payee-list selections still progress the active journey.
  if (
    sendMoneyJourneyActive &&
    tryApplyWelcomeSendMoneyStepFromUserSpeech(message)
  ) {
    return;
  }
  if (
    cashWithdrawJourneyActive &&
    tryApplyWelcomeCashWithdrawStepFromUserSpeech(message)
  ) {
    return;
  }
  if (
    homeLoanJourneyActive &&
    tryApplyWelcomeHomeLoanStepFromUserSpeech(message)
  ) {
    return;
  }

  if (addressJourneyActive) return;

  const isPositive = isPositiveIntent(normalized);
  if (
    hasShownWelcomeForexScreen &&
    !hasConfirmedWelcomeBestSuitedConsent &&
    isPositive &&
    (hasAskedWelcomeBestSuitedConsent ||
      document.body.classList.contains("forex-stage"))
  ) {
    hasConfirmedWelcomeBestSuitedConsent = true;
    // User confirmed after "best suited card" question:
    // move directly to details screen.
    showWelcomeDetailsStage();
    setChatInputBoxVisible(true);
  }
  applyWelcomeDetailsOptionsFromUserMessage(message);
}

function shouldShowWelcomeForexStage(normalizedText: string) {
  if (!normalizedText) return false;
  if (addressJourneyActive) return false;
  if (isLiveSearchPanelActive()) return false;
  if (
    hasShownWelcomeForexScreen &&
    document.body.classList.contains("details-stage")
  )
    return false;
  if (
    hasShownWelcomeForexScreen &&
    document.body.classList.contains("best-card-stage")
  )
    return false;
  if (
    hasShownWelcomeForexScreen &&
    document.body.classList.contains("forex-stage")
  )
    return false;
  return (
    containsAny(normalizedText, [
      "forex card",
      "travel card",
      "multicurrency platinum",
      "forexplus",
      "forex plus",
      "forex cards",
    ]) ||
    (normalizedText.includes("cards we offer") &&
      normalizedText.includes("benefits")) ||
    normalizedText.includes("22 currencies") ||
    (normalizedText.includes("we offer") &&
      normalizedText.includes("forex") &&
      containsAny(normalizedText, [
        "card",
        "cards",
        "benefits",
        "currencies",
      ])) ||
    (normalizedText.includes("multicurrency") &&
      normalizedText.includes("card"))
  );
}

function isEvaForexIntroStreaming(normalizedText: string) {
  if (shouldShowWelcomeForexStage(normalizedText)) return true;
  if (normalizedText.includes("forex") && normalizedText.includes("card"))
    return true;
  if (normalizedText.includes("22 currenc")) return true;
  if (normalizedText.includes("cards we offer")) return true;
  return false;
}

function isLiveSearchPanelActive(): boolean {
  return (
    isLiveSearchInProgress ||
    document.body.classList.contains("loan-blank-panel-stage")
  );
}

function tryShowForexFromInbound(
  message: string,
  options?: { streaming?: boolean },
): boolean {
  if (!isWelcomePage()) return false;
  // While the live-search panel is up, Eva is reading back the n8n answer (which
  // can mention "card"/"forex"); don't let that hijack into the Forex journey.
  if (isLiveSearchPanelActive()) return false;
  const normalized = normalizeMessage(message);
  const matches = options?.streaming
    ? isEvaForexIntroStreaming(normalized)
    : shouldShowWelcomeForexStage(normalized);
  if (!matches) return false;
  showWelcomeForexStage();
  appendLog(
    `[Welcome] Forex stage from inbound: "${message.trim().slice(0, 120)}"`,
  );
  return true;
}

function shouldShowWelcomeDetailsStage(normalizedText: string) {
  if (!normalizedText) return false;
  return (
    containsAny(normalizedText, WELCOME_DETAILS_PHRASES) ||
    /(travel|traval)\s+destination/.test(normalizedText)
  );
}

function isWelcomeDetailsKickoffText(normalizedText: string) {
  if (!normalizedText) return false;
  return (
    containsAny(normalizedText, WELCOME_DETAILS_KICKOFF_PHRASES) ||
    (/let.?s start/.test(normalizedText) && /detail/.test(normalizedText))
  );
}

function shouldAskWelcomeBestSuitedConsent(normalizedText: string) {
  if (!normalizedText) return false;
  return (
    normalizedText.includes("best suited card for you") &&
    containsAny(normalizedText, [
      "do you want",
      "would you like",
      "want to know",
    ])
  );
}

function isWelcomeBestCardAnnouncement(normalizedText: string) {
  if (!normalizedText) return false;
  return containsAny(normalizedText, [
    "here s the best suited card for you",
    "here is the best suited card for you",
    "best suited card for you",
  ]);
}

function isLikelyUserSpeaker(from: string) {
  const normalizedFrom = normalizeMessage(from);
  const queryName = normalizeMessage(
    new URLSearchParams(window.location.search).get("name") || "",
  );
  const storedName = normalizeMessage(
    localStorage.getItem(MATCHED_USER_NAME_STORAGE_KEY) || "",
  );
  const localIdentity = normalizeMessage(
    currentRoom?.localParticipant?.identity || "",
  );
  const localDisplayName = normalizeMessage(
    (currentRoom?.localParticipant as any)?.name || "",
  );
  const candidates = [
    "you",
    "user",
    queryName,
    storedName,
    localIdentity,
    localDisplayName,
  ].filter(Boolean);

  if (candidates.some((token) => normalizedFrom === token)) return true;
  if (normalizedFrom.includes("local") || normalizedFrom.includes("myself"))
    return true;
  if (
    candidates.some(
      (token) => token.length > 2 && normalizedFrom.includes(token),
    )
  )
    return true;

  return false;
}

function setDetailsAnsweredQuestions(answeredIndexes: Set<number>) {
  const cards = document.querySelectorAll(".details .card");
  cards.forEach((card, index) => {
    card.classList.toggle("active", answeredIndexes.has(index));
  });
}

function resetChatContainerViews() {
  if (!isChatPage()) return;
  const bg = document.querySelector(".bg-change") as HTMLElement | null;
  if (!bg) return;
  bg.classList.remove(
    "view-card-selection",
    "view-details",
    "view-selected-card",
    "bg-slide-up",
  );
}

function setChatView(view: ChatView, forceRefresh: boolean = false) {
  if (!isChatPage()) return;
  const bg = document.querySelector(".bg-change") as HTMLElement | null;
  if (!bg) {
    appendLog("[VIEW] .bg-change element not found");
    return;
  }
  if (currentChatView === view && !forceRefresh) {
    appendLog(`[VIEW] Screen unchanged: ${view}`);
    return;
  }

  bg.classList.remove(
    "view-card-selection",
    "view-details",
    "view-selected-card",
    "bg-slide-up",
  );
  void bg.offsetWidth;
  bg.classList.add(`view-${view}`);
  bg.classList.add("bg-slide-up");

  currentChatView = view;
  setChatInputBoxVisible(true);
  appendLog(`[VIEW] Showing container: ${view}`);
}

function isPositiveIntent(text: string) {
  return (
    /^(yes|yeah|yep|sure|ok|okay|confirm|please|yes tell me|go ahead|lets do it|let us do it)\b/.test(
      text,
    ) ||
    containsAny(text, [
      "yes tell me",
      "tell me",
      "sounds good",
      "please continue",
      "please go ahead",
      "go ahead please",
      "continue please",
      "lets do it",
      "let us do it",
      "lets proceed",
      "please proceed",
      "proceed",
      "carry on",
      "you can continue",
      "i want to know",
      "show me",
      "interested",
    ])
  );
}

function isStepOneAgentPrompt(text: string) {
  return containsAny(text, [
    "sure can i help you with that",
    "sure i can help you with that",
    "certainly i can help you with that",
    "of course i can help you with that",
    "absolutely i can help you with that",
    "yes i can help you with that",
    "i can help you with that",
    "i can help with that",
    "definitely i can help you with that",
  ]);
}

/** Matches: "Sure, I can help you with that. Do you want to know the best suited card for you?" etc */
function isStepOneWithCardConsentPrompt(text: string) {
  return isStepOneAgentPrompt(text) && isBestCardConsentQuestion(text);
}

function isBestCardConsentQuestion(text: string) {
  return (
    containsAny(text, ["best suited card for you"]) &&
    containsAny(text, ["do you want", "would you like", "want to know"])
  );
}

function isFinalCardAnnouncement(text: string) {
  return containsAny(text, [
    "here s the best suited card for you",
    "here is the best suited card for you",
    "best suited card for you",
  ]);
}

function getDetailQuestionIndex(text: string): number | null {
  if (containsAny(text, ["purpose of travel", "purpose"])) return 0;
  if (containsAny(text, ["country of visit", "country"])) return 1;
  if (containsAny(text, ["date of departure", "travel date", "date"])) return 2;
  if (
    containsAny(text, ["required currency", "currency to transact", "currency"])
  )
    return 3;
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
    "Please ask all required travel details in one sentence only: purpose of travel, country of visit, travel date, and required currency.";
  postCrossPageMessage({ type: "chat-outbound", message: guidanceMessage });
  appendLog("[VIEW] Sent Eva guidance for single-sentence details question");
}

function requestSingleSentenceDetailsCorrection() {
  if (!isChatPage()) return;
  if (hasSentSingleSentenceDetailsCorrection) return;
  hasSentSingleSentenceDetailsCorrection = true;
  const correctionMessage =
    "Please ask these travel details in one single sentence, not as separate questions: purpose of travel, country of visit, travel date, and required currency.";
  postCrossPageMessage({ type: "chat-outbound", message: correctionMessage });
  appendLog("[VIEW] Sent Eva correction for separate detail questions");
}

function extractDetailAnswerIndexes(text: string): number[] {
  const matched = new Set<number>();

  const hasPurpose = containsAny(text, [
    "vacation",
    "holiday",
    "family trip",
    "family vacation",
    "business",
    "work trip",
    "office trip",
    "study",
    "education",
    "college",
    "university",
    "medical",
    "treatment",
    "tourism",
    "leisure",
    "honeymoon",
    "conference",
    "visit family",
    "visiting family",
  ]);
  if (hasPurpose) matched.add(0);

  const hasCountry =
    /\b(to|for)\s+(usa|us|united states|uk|united kingdom|uae|singapore|canada|australia|japan|france|germany|italy|spain|dubai|thailand|malaysia|europe)\b/.test(
      text,
    ) ||
    containsAny(text, [
      "country is",
      "country will be",
      "country of visit",
      "travelling to",
      "traveling to",
      "going to",
    ]);
  if (hasCountry) matched.add(1);

  const hasDate =
    /\b\d{1,2}[\/-]\d{1,2}([\/-]\d{2,4})?\b/.test(text) ||
    /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/.test(
      text,
    ) ||
    containsAny(text, [
      "travel date",
      "departure date",
      "date is",
      "tomorrow",
      "next week",
      "next month",
    ]);
  if (hasDate) matched.add(2);

  const hasCurrency =
    /\b(inr|usd|eur|gbp|aed|cad|aud|jpy|sgd|chf|cny|hkd)\b/.test(text) ||
    containsAny(text, [
      "currency is",
      "required currency",
      "currency to transact",
      "dollar",
      "euro",
      "pound",
      "dirham",
      "yen",
      "usd should be fine",
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
  document.querySelector(".main-container")?.classList.add("active");

  if (token === "card-selection") {
    setChatView("card-selection");
    return;
  }
  if (token === "details" || token === "details-progress") {
    setChatView("details", token === "details-progress");
    return;
  }
  if (token === "selected-card") {
    setChatView("selected-card");
    answeredDetailQuestionIndexes.clear();
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    return;
  }

  appendLog(`[VIEW] Unsupported mapping token: ${token}`);
}

function setChatInputBoxVisible(visible: boolean) {
  if (!isChatPage() && !isWelcomePage()) return;
  const inputBox = document.getElementById(
    "chat-input-area",
  ) as HTMLElement | null;
  if (!inputBox) return;
  inputBox.classList.toggle("show", visible);
  appendLog(`[BG] Input box ${visible ? "shown" : "hidden"}`);
}

function containsAny(text: string, phrases: string[]) {
  return phrases.some((phrase) => text.includes(phrase));
}

function resolveUserBackgroundImage(message: string) {
  if (flowStopped) return null;
  const text = normalizeMessage(message);

  if (
    isPositiveIntent(text) &&
    (uiStep === "card-selection" ||
      currentChatView === "card-selection" ||
      awaitingBestCardConfirmation)
  ) {
    uiStep = "details";
    awaitingBestCardConfirmation = false;
    pendingDetailQuestionIndex = null;
    answeredDetailQuestionIndexes.clear();
    hasSentSingleSentenceDetailsGuidance = false;
    hasSentSingleSentenceDetailsCorrection = false;
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    conversationPhase = "collecting_details";
    requestSingleSentenceDetailsPrompt();
    appendLog("[VIEW] Step 2 -> details");
    return "details";
  }

  if (uiStep === "details") {
    const extractedIndexes = extractDetailAnswerIndexes(text);
    const indexesToMark = new Set<number>(extractedIndexes);
    if (indexesToMark.size === 0) {
      const inferredIndex = getDetailQuestionIndex(text);
      const targetIndex =
        inferredIndex ??
        pendingDetailQuestionIndex ??
        getNextUnansweredDetailQuestionIndex();
      if (targetIndex === null) return null;
      indexesToMark.add(targetIndex);
    }

    const beforeCount = answeredDetailQuestionIndexes.size;
    indexesToMark.forEach((index) => markDetailQuestionAnswered(index));
    pendingDetailQuestionIndex = null;
    const answerCount = answeredDetailQuestionIndexes.size;
    const matchedCardLabels = Array.from(indexesToMark)
      .map((index) => index + 1)
      .join(", ");
    appendLog(
      `[VIEW] Details answer captured (${answerCount}/4) at card(s) ${matchedCardLabels}`,
    );

    if (answerCount === beforeCount) return null;
    if (answerCount < 4) {
      return "details-progress";
    }

    uiStep = "awaiting-final-cards";
    pendingDetailQuestionIndex = null;
    appendLog(
      "[VIEW] Step 3 complete -> retaining details with all answers until final card announcement",
    );
    return "details-progress";
  }

  if (conversationPhase === "awaiting_confirmation" && isPositiveIntent(text)) {
    conversationPhase = "completed";
    stopConversationFlow("user confirmation received");
  }

  if (
    uiStep === "idle" &&
    containsAny(text, ["forex card", "travel card"]) &&
    containsAny(text, ["apply", "want", "need", "get", "interested"])
  ) {
    return "card-selection";
  }

  return null;
}

function updateChatBackgroundForUserMessage(message: string) {
  if (!isChatPage()) return;
  if (!hasEvaStartedTalking) {
    appendLog(
      "[BG] User-triggered background change ignored until EVA starts talking",
    );
    return;
  }
  let image = resolveUserBackgroundImage(message);
  // Fallback for non-scripted LLM phrasing: once user replies at card-selection,
  // continue flow to details.
  if (!image && uiStep === "card-selection" && message.trim()) {
    uiStep = "details";
    pendingDetailQuestionIndex = null;
    answeredDetailQuestionIndexes.clear();
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    image = "details";
    appendLog("[BG] Fallback transition: card-selection -> details");
  }
  if (!image) return;
  appendLog(`[BG] User message -> ${image}: "${message}"`);
  setChatBackgroundImage(image);
}

function resolveEvaBackgroundImage(message: string) {
  if (flowStopped) return null;
  const text = normalizeMessage(message);

  if (
    (uiStep === "idle" || uiStep === "card-selection") &&
    isStepOneAgentPrompt(text)
  ) {
    uiStep = "card-selection";
    awaitingBestCardConfirmation = false;
    pendingDetailQuestionIndex = null;
    answeredDetailQuestionIndexes.clear();
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    conversationPhase = "awaiting_yes";
    appendLog("[VIEW] Step 1 -> card selection");
    return "card-selection";
  }

  if (isBestCardConsentQuestion(text)) {
    awaitingBestCardConfirmation = false;
    uiStep = "details";
    pendingDetailQuestionIndex = null;
    answeredDetailQuestionIndexes.clear();
    hasSentSingleSentenceDetailsGuidance = false;
    hasSentSingleSentenceDetailsCorrection = false;
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    conversationPhase = "collecting_details";
    requestSingleSentenceDetailsPrompt();
    appendLog("[VIEW] Consent question received -> details");
    return "details";
  }

  if (uiStep === "details") {
    const questionIndex = getDetailQuestionIndex(text);
    if (
      questionIndex !== null &&
      !answeredDetailQuestionIndexes.has(questionIndex)
    ) {
      pendingDetailQuestionIndex = questionIndex;
      appendLog(
        `[VIEW] Pending details question set to card ${questionIndex + 1}`,
      );
      requestSingleSentenceDetailsCorrection();
    }
  }

  if (isFinalCardAnnouncement(text)) {
    uiStep = "cards";
    awaitingBestCardConfirmation = false;
    pendingDetailQuestionIndex = null;
    conversationPhase = "details_captured";
    appendLog("[VIEW] Final card announcement -> selected-card");
    return "selected-card";
  }

  return null;
}

function stopConversationFlow(reason: string) {
  if (flowStopped) return;
  flowStopped = true;
  setChatControlsEnabled(false);
  appendLog(`[BG] Flow stopped: ${reason}`);
  postCrossPageMessage({ type: "stop-call" });
}

function updateChatBackgroundForEvaMessage(from: string, message: string) {
  if (!isLikelyEvaSpeaker(from)) {
    appendLog(`[BG] Ignored speaker: ${from}`);
    return;
  }
  hasEvaStartedTalking = true;
  const text = normalizeMessage(message);
  if (isStepOneWithCardConsentPrompt(text)) {
    document.body.classList.add("eva-speaking");
    document.querySelector(".main-container")?.classList.add("active");
  }
  updateOrbBlobFromState();
  let image = resolveEvaBackgroundImage(message);
  // Fallback for non-scripted assistant wording: first assistant response
  // should still reveal card-selection.
  if (!image && uiStep === "idle") {
    uiStep = "card-selection";
    image = "card-selection";
    appendLog("[BG] Fallback transition: idle -> card-selection");
  }
  if (!image) {
    appendLog(`[BG] No image match for message: "${message}"`);
    return;
  }
  appendLog(`[BG] Matched message -> ${image}: "${message}"`);
  setChatBackgroundImage(image);
}

function updateChatBackgroundFromHistory(messages: ChatEntry[]) {
  if (!isChatPage()) return;

  uiStep = "idle";
  awaitingBestCardConfirmation = false;
  pendingDetailQuestionIndex = null;
  answeredDetailQuestionIndexes.clear();
  hasSentSingleSentenceDetailsGuidance = false;
  hasSentSingleSentenceDetailsCorrection = false;
  conversationPhase = "idle";
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

  appendLog("[BG] History replay complete for container state");
}

function setCallPageConnectedClass(connected: boolean) {
  if (!isCallPage()) return;
  document.body.classList.toggle("call-connected", connected);
  if (!connected) {
    hasEvaSpokenOnCallPage = false;
    resetWelcomeFlowState();
    document.body.classList.remove("eva-speaking");
  }
}

function renderChatFromState() {
  const transcriptText = state.chatMessages
    .map((msg) => `${msg.from}: ${msg.message}`)
    .join("\n");
  const chatEl = document.getElementById("chat") as HTMLTextAreaElement | null;
  if (chatEl) {
    chatEl.value = transcriptText;
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  const dateTextEl = document.getElementById("transcription-display");
  if (dateTextEl) {
    const lastEva = [...state.chatMessages]
      .reverse()
      .find((m) => isLikelyEvaSpeaker(m.from));
    if (lastEva?.message?.trim()) {
      dateTextEl.textContent = lastEva.message;
    } else if (
      isCallConnected() &&
      !document.body.classList.contains("eva-speaking") &&
      !(window as any).__orbUserSpeaking
    ) {
      dateTextEl.textContent = "Listening...";
    } else {
      dateTextEl.textContent = "Listening...";
    }
  }
}

function setChatControlsEnabled(enabled: boolean) {
  setButtonDisabled("send-button", !enabled);
  setButtonDisabled("entry", !enabled);
}

function onCrossPageMessage(message: CrossPageMessage) {
  if (message.type === "start-call-request" && isAvatarPage()) {
    void appActions.startCall();
    return;
  }

  if (message.type === "call-connected" && isChatPage()) {
    setChatControlsEnabled(true);
    updateOrbBlobFromState();
    if (!autoFlowTriggered) {
      const kickoff = "How may I help you today?";
      autoFlowTriggered = true;
      postCrossPageMessage({ type: "chat-outbound", message: kickoff });
      addChatMessage("You", kickoff);
      document.querySelector(".main-container")?.classList.add("active");
      appendLog("[BG] Auto-started flow with kickoff message");
    }
    return;
  }
  if (message.type === "call-connected") {
    if (isJourneyPage()) {
      setChatControlsEnabled(true);
    }
  }

  if (message.type === "call-disconnected" && isChatPage()) {
    setChatControlsEnabled(false);
    document.querySelector(".main-container")?.classList.remove("active");
    clearParticipants();
    updateOrbBlobFromState();
    return;
  }
  if (message.type === "call-disconnected") {
    if (isJourneyPage()) {
      setChatControlsEnabled(false);
      updateJourneyPlaceholder(null, null, null);
    }
  }
  if (message.type === "journey-stage") {
    if (!isJourneyPage()) return;

    updateJourneyPlaceholder(
      message.screen || null,
      message.journey ?? null,
      message.reason ?? null,
    );

    const handler = JOURNEY_DISPATCH[message.screen];
    if (handler) {
      try {
        handler();
      } catch (err: any) {
        appendLog(
          `[TwoTab] Failed to mirror journey stage "${message.screen}": ${err?.message ?? err}`,
        );
      }
    }

    return;
  }

  if (message.type === "chat-history-request" && isCallPage()) {
    postCrossPageMessage({
      type: "chat-history-response",
      messages: state.chatMessages,
    });
    return;
  }

  if (message.type === "chat-history-response" && isChatPage()) {
    state.chatMessages = message.messages;
    renderChatFromState();
    if (!isJourneyPage()) {
      updateChatBackgroundFromHistory(message.messages);
    }
    return;
  }

  if (message.type === "chat-outbound" && isCallPage() && currentRoom) {
    currentRoom.localParticipant.sendText(message.message, {
      topic: "lk.chat",
    });
    appendLog(`Forwarded chat message: ${message.message}`);
    return;
  }

  if (message.type === "stop-call" && isCallPage()) {
    appActions.disconnect();
    return;
  }

  if (message.type === "chat-inbound" && isChatPage()) {
    if (!isJourneyPage()) {
      if (isLikelyUserSpeaker(message.from)) {
        updateChatBackgroundForUserMessage(message.message);
      } else {
        updateChatBackgroundForEvaMessage(message.from, message.message);
      }
    }
    addChatMessage(message.from, message.message);
    return;
  }
}

function tryUnlockEvaAudio() {
  const chromaAudio = document.getElementById(
    "eva-chroma-audio",
  ) as HTMLAudioElement;
  if (chromaAudio?.srcObject && chromaAudio.paused) {
    chromaAudio.play().catch(() => {});
  }
}

function initializePageBehavior() {
  chatChannel?.addEventListener(
    "message",
    (event: MessageEvent<CrossPageMessage>) => {
      onCrossPageMessage(event.data);
    },
  );

  if (isAvatarPage()) {
    document.addEventListener("click", tryUnlockEvaAudio);
    document.addEventListener("touchstart", tryUnlockEvaAudio);
    document.addEventListener("keydown", tryUnlockEvaAudio);
    setButtonsForState(false);
    setChatInputBoxVisible(false);
    initWelcomeAddressSelectCards();
    initWelcomeSelfVerifyMethodsCards();
    initWelcomeTravelDetailsCards();
    initWelcomeHomeLoanActiveListCards();
    initWelcomeFaceScanCaptureListener();
    initWelcomeAddressRequestCopyButtons();
    if (demoMode) {
      ensureJourneyTabOpen();
    }
    return;
  }

  if (isJourneyPage()) {
    uiStep = "idle";
    awaitingBestCardConfirmation = false;
    pendingDetailQuestionIndex = null;
    answeredDetailQuestionIndexes.clear();
    hasSentSingleSentenceDetailsGuidance = false;
    hasSentSingleSentenceDetailsCorrection = false;
    currentChatView = null;
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    resetChatContainerViews();
    setButtonsForState(false);
    setChatInputBoxVisible(true);
    setChatControlsEnabled(isCallConnected());
    updateJourneyPlaceholder(null, null, null);
    postCrossPageMessage({ type: "chat-history-request" });
    return;
  }

  if (isInteractionPage()) {
    document.addEventListener("click", tryUnlockEvaAudio);
    document.addEventListener("touchstart", tryUnlockEvaAudio);
    document.addEventListener("keydown", tryUnlockEvaAudio);
    updateOrbBlobFromState();
    uiStep = "idle";
    awaitingBestCardConfirmation = false;
    pendingDetailQuestionIndex = null;
    answeredDetailQuestionIndexes.clear();
    hasSentSingleSentenceDetailsGuidance = false;
    hasSentSingleSentenceDetailsCorrection = false;
    currentChatView = null;
    setDetailsAnsweredQuestions(answeredDetailQuestionIndexes);
    resetChatContainerViews();
    setChatInputBoxVisible(true);
    setChatControlsEnabled(isCallConnected() || isInteractionPage());
    postCrossPageMessage({ type: "chat-history-request" });
    return;
  }

  setCallConnectedState(false);
  setCallPageConnectedClass(false);
}

(window as any).appActions = appActions;
initializePageBehavior();
