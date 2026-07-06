# Bey Call API Example

A simple, interactive example demonstrating how to use the Beyond Presence Call API to connect users with AI agents through LiveKit.

![Bey Call API Example](demo.png)

## Overview

The LiveKit-based implementation of our API provides a streamlined approach to integrating interactive avatars into web applications. This example demonstrates using the LiveKit browser SDK, but you can use **any LiveKit client SDK or UI components** based on your stack.

### Flexible Integration Options

- **Client SDKs**: Use LiveKit SDKs for Browser, iOS/macOS/visionOS, Android, Flutter, React Native, Rust, Node.js, Python, Unity, Unity (WebGL), or ESP32
- **UI Components**: Leverage pre-built UI components for React, Android Compose, SwiftUI, or Flutter

This example shows how to:
- Call the Beyond Presence API to create a new call with a managed agent
- Receive LiveKit connection credentials
- Connect to the call directly through its LiveKit room with audio/video
- Interact with the managed agent in real-time
- Send chat messages during the call
- Switch camera, microphone, and speaker devices

## Requirements

Before running this example, you'll need:

1. **Beyond Presence Account**: Sign up at [app.bey.chat](https://app.bey.chat)
2. **API Key**: Get your API key from the Beyond Presence dashboard
3. **Avatar ID**: Create/select an avatar and note its `BEY_AVATAR_ID` (or use a stock avatar)
4. **LiveKit Cloud Project**: LiveKit URL + API key/secret
5. **ElevenLabs**: API key + Conversational AI Agent ID (Convai)

## Setup

### 1. Install Dependencies

```sh
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the project root:

```sh
LIVEKIT_URL=wss://<your-livekit-host>
LIVEKIT_API_KEY=<livekit-api-key>
LIVEKIT_API_SECRET=<livekit-api-secret>

BEY_API_KEY=sk-...
BEY_AVATAR_ID=<beyond-presence-avatar-id>

ELEVEN_API_KEY=...
ELEVEN_AGENT_ID=...
ELEVEN_INTEGRATION_MODE=convai
```

### 3. Run the Development Server

```sh
npm run dev
```

This will start a local development server (typically at <http://localhost:5173>).

### 4. Open in Browser

Navigate to the URL shown in your terminal (e.g., <http://localhost:5173>).

Note: this project uses a single `index.html` page.

## Usage

1. **Start Call**
   - Click the "Start Call" button
   - The app will:
     - Create a new LiveKit room locally (via `/api/start`)
     - Start a local ElevenLabs + Beyond Presence avatar worker
     - Automatically connect to the LiveKit room

2. **Interact with the Avatar**
   - The avatar will appear in the participants area when connected
   - Click "Enable Mic" to allow your microphone
   - Click "Enable Camera" to share your video (optional)
   - Use the chat box to send text messages

3. **End Call**
   - Click "End Call" to disconnect from the LiveKit room, ending the call

## Local API

This repo runs a small local server that exposes:

- `POST /api/start`: creates a room, starts the local worker, returns `livekit_url` + `livekit_token`
- `POST /api/stop`: stops the local worker


## Multilingual + Auto language detection

The agent now auto-detects the user's language mid-call and switches without restarting the conversation. This needs setup in **two places**.

### 1. ElevenLabs agent settings (one-time)

- **Language → Additional languages**: enable English, Hindi, Marathi (and any others you want).
- **Agent → Tools**: add the **`language_detection` system tool**. This is what triggers switching when the user speaks a different supported language.
- **Hinglish mode**: turn on only if you want Hindi+English mixed replies.
- **Security**: enable **language override** so an initial language can be passed from the client (optional, only used when you explicitly lock a language).

### 2. This app

Auto-detect is the default. On connect we send no language override, so ElevenLabs's `language_detection` tool freely switches the agent. Behaviour:

- **Default (recommended)**: nothing to set. URL `welcome.html` starts with the agent's default language and switches when the user speaks Hindi/Marathi/etc.
- **Lock to a specific language**: URL `welcome.html?lang=hi` (or `?lang=mr`, `?lang=en`). This disables auto-switching for the call.
- **Server-side default**: `ELEVEN_AGENT_LANGUAGE=auto` (default) or a specific ISO code in `.env`.

### Confirm it's working

When you start a call you should see in the terminal:

- `[convai] auto language detection — agent will switch when user speaks another supported language`

When the user changes language mid-call you should see two lines back-to-back:

- `[convai] language_detection client_tool_call → hi (reason: User spoke Hindi, id: call_…)`
- `[convai] language switched en → hi (User spoke Hindi)`

…followed by the next `[convai] agent_response` in the new language.

The browser console / on-page log also prints `[ConvAI] Language auto-detect: en → hi`, and `<html lang>` plus `document.body.dataset.convaiLanguage` are updated so CSS can react with `[data-convai-language="hi"]`.

Restart `npm run dev` after agent or env changes, then start a **new** call.

### Auto-switch isn't happening?

Almost always one of these:

1. **`language_detection` system tool is not added in the ElevenLabs dashboard.** Without it the LLM has no way to switch — there is no log line starting with `[convai] language_detection client_tool_call`.
2. **The target language isn't in the agent's enabled languages.** The tool will refuse to switch to a language that isn't on the agent's `Additional languages` list.
3. **The URL was opened with `?lang=…`.** That locks the call to a single language and bypasses auto-detect. Open `welcome.html` with no query string for auto mode.
4. **Old build is still serving.** Restart `npm run dev` and start a *new* call — language config is captured at call start.

## Journey routing (`ui_show_screen`)

The agent drives screen changes by calling the **client tool** `ui_show_screen({ screen, reason?, intent? })`. The browser is language-agnostic — only the tool moves screens, so this works in English, Hindi, Marathi, etc.

### Tool parameter schema (paste into ElevenLabs)

```json
{
  "type": "object",
  "properties": {
    "screen": {
      "type": "string",
      "description": "One of: forex, details, best-card, address-verify, address-consent, address-next, address-verified-success, address-select, address-select-review, address-request-submitted, self-verify, face-scan, home-loan"
    },
    "reason": {
      "type": "string",
      "description": "Short reason, e.g. 'User confirmed address change'"
    },
    "intent": {
      "type": "string",
      "description": "Set to 'user_switched_journey' ONLY when the user explicitly asks to switch to a different journey mid-flow (e.g. 'I want a loan instead'). Leave empty for normal in-journey steps."
    }
  },
  "required": ["screen"]
}
```

### Journey-locking behaviour

Screens are grouped into top-level journeys:

| Journey | Screens |
|---------|---------|
| `forex` | `forex`, `details`, `best-card` |
| `address` | `address-verify`, `address-consent`, `address-next`, `address-verified-success`, `address-select`, `address-select-review`, `address-request-submitted`, `self-verify`, `face-scan` |
| `home-loan` | `home-loan` |

While the user is mid-journey, the client **blocks** any `ui_show_screen` call that targets a different journey. This is what enforces "complete the current journey before jumping to a different topic".

To explicitly switch journeys when the user asks for something else, the agent must include an explicit intent:

```json
ui_show_screen({
  "screen": "home-loan",
  "reason": "User said: aap loan ke baare mein bataiye",
  "intent": "user_switched_journey"
})
```

Accepted `intent` values: `user_switched_journey`, `user_requested_new_journey`, `switch_journey`, `new_journey`, `topic_change`. (Also accepts `force: true` as a synonym.)

A journey is treated as "complete" once any of its terminal screens fires (`best-card`, `address-request-submitted`, `face-scan`, `home-loan`); after that the next `ui_show_screen` may target any journey freely.

### Agent prompt snippet

Add this to your ElevenLabs agent prompt so the LLM uses the new field correctly:

```
You drive UI changes via the client tool `ui_show_screen({ screen, reason?, intent? })`.

Journey rules:
1. Once you start a journey (forex / address-change / home-loan), you MUST keep the user on that journey's screens until it finishes, even if the user goes off-topic or asks small questions. Answer briefly and steer them back.
2. Only call `ui_show_screen` with an out-of-journey `screen` if the user EXPLICITLY asks to switch topics (e.g. "actually, I want a loan", "show me forex card instead", "cancel this and help me with…").
3. When you switch journeys for an explicit user request, set `intent: "user_switched_journey"` so the UI knows to allow the jump.
4. Steps inside the same journey don't need any intent field.
5. After a terminal step (`best-card`, `address-request-submitted`, `face-scan`, `home-loan`) the user is free; you can move to a new journey without an intent.
```

### Confirming it works

Block path (drift):

```text
[ConvAI] ui_show_screen "forex" blocked — finishing "address" first
```

Allowed switch (explicit):

```text
[ConvAI] Journey address → home-loan (user requested home-loan)
[ConvAI] ui_show_screen → home-loan (User asked for a home loan)
```

## Troubleshooting

### API Connection Issues

If you encounter API errors:
- Verify your API key is correct
- Check that your Agent ID exists in your dashboard


### Media Permission Issues

If camera/microphone don't work:
- Check browser permissions for camera/microphone access
- Ensure you're running on HTTPS or localhost
- Try a different browser (Chrome/Edge recommended)

### Connection Issues

If LiveKit connection fails:
- Check browser console for detailed error messages
- Verify your firewall isn't blocking WebSocket connections
- Ensure you have a stable internet connection

## LiveKit Ecosystem

Beyond Presence integrates seamlessly with the entire LiveKit ecosystem:

<table>
<thead><tr><th colspan="2">LiveKit Ecosystem</th></tr></thead>
<tbody>
<tr><td>Web & Mobile SDKs</td><td><b><a href="https://github.com/livekit/client-sdk-js">Browser</a></b> · <a href="https://github.com/livekit/client-sdk-swift">iOS/macOS/visionOS</a> · <a href="https://github.com/livekit/client-sdk-android">Android</a> · <a href="https://github.com/livekit/client-sdk-flutter">Flutter</a> · <a href="https://github.com/livekit/client-sdk-react-native">React Native</a></td></tr>
<tr><td>Other Platforms SDKs</td><td><a href="https://github.com/livekit/rust-sdks">Rust</a> · <a href="https://github.com/livekit/node-sdks">Node.js</a> · <a href="https://github.com/livekit/python-sdks">Python</a> · <a href="https://github.com/livekit/client-sdk-unity">Unity</a> · <a href="https://github.com/livekit/client-sdk-unity-web">Unity (WebGL)</a> · <a href="https://github.com/livekit/client-sdk-esp32">ESP32</a></td></tr>
<tr><td>UI Components</td><td><a href="https://github.com/livekit/components-js">React</a> · <a href="https://github.com/livekit/components-android">Android Compose</a> · <a href="https://github.com/livekit/components-swift">SwiftUI</a> · <a href="https://github.com/livekit/components-flutter">Flutter</a></td></tr>
<tr><td>Agents Frameworks</td><td><a href="https://github.com/livekit/agents">Python</a> · <a href="https://github.com/livekit/agents-js">Node.js</a> · <a href="https://github.com/livekit/agent-playground">Playground</a></td></tr>
</tbody>
</table>

**Beyond Presence Plugin**: Our official plugins are available for both [Python](https://docs.livekit.io/agents/models/avatar/plugins/bey/) and [Node.js](https://www.npmjs.com/package/@livekit/agents-plugin-bey) agents frameworks, enabling advanced integration scenarios.

## Resources

- [Beyond Presence API Reference](https://docs.bey.dev/api-reference)
- [Beyond Presence Documentation](https://docs.bey.dev)
- [LiveKit Documentation](https://docs.livekit.io)
- [Join our Discord Community](https://bey.dev/community)

## Support

Need help? Reach out:
- Email: <support@beyondpresence.ai>
- Discord: [bey.dev/community](https://bey.dev/community)
