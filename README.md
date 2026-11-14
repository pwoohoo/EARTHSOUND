# EARTHSOUND

Multimodal Earth-Observation Sonification & Voice Assistant Suite.

Combines a real-time Web Audio spatial synthesizer with a voice-activated AI assistant powered by Google Gemini.

---

## 1. Voice-Activated AI Assistant (`earthsound_assistant.py`)

A customizable voice assistant that detects intent and routes user commands to NASA Earth-observation datasets (`CLIMATE`, `RAINFALL`, `URBANIZATION`, `WILDFIRE`).

### Features
- **Custom Bot Naming:** `setup_account()` configures a custom assistant name saved to `user_settings.json`.
- **Speech Recognition:** Continuously listens for `"Hey [Custom Name]"` via the system microphone, then captures the user's spoken request.
- **Gemini Router (JSON Mode):** Analyzes multilingual intent using `gemini-2.0-flash` with strict JSON output containing `dataset_id` and localized `spoken_response`.
- **Speech Feedback & Trigger:** Speaks the response aloud via `pyttsx3` and triggers the corresponding NASA video/audio mapping.

### Quick Start (Voice Assistant)
```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Set your Gemini API key
export GEMINI_API_KEY="your_api_key_here"  # On Windows: set GEMINI_API_KEY="your_api_key_here"

# 3. Run the assistant
python earthsound_assistant.py
```

---

## 2. Real-Time Spatial Synthesizer (`eicSpatialSynth.ts`)

Connects an HTML5 `<video>` element (e.g., satellite weather feed) to the Web Audio API to generate a multi-voice, spatially-panned musical score in real time.

- **12 Longitude Columns:** Anchored at Greenwich (0° Meridian, center pan) to the Date Line (±180°, hard left/right).
- **Temporal Derivative Engine:** Computes $\Delta I / \Delta t$ frame deltas and motion vectors to isolate active weather fronts from static backgrounds.
- **C Dorian Scale Polyphony:** Voices across 130 Hz – 4,500 Hz mapped to warmth/coolness $(R - B)$ and wave sharpness.
- **Atmosphere Pad:** Filtered noise base (100–400 Hz) driven by global temperature balance.
- **Accessibility Justification Feed:** Plain-English event captions compatible with `aria-live`.

### Quick Start (Frontend Synth)
```html
<video id="earthVideo" src="satellite.mp4" muted></video>
<button id="playBtn">▶ Play Sonification</button>
<div id="caption" aria-live="polite" role="status"></div>

<script type="module">
  import { start, stop, setLayerMute, getJustificationLog } from './eicSpatialSynth.js';

  const video = document.getElementById('earthVideo');
  const btn = document.getElementById('playBtn');

  btn.addEventListener('click', async () => {
    await video.play();
    await start(video, {
      ariaLiveElement: document.getElementById('caption'),
      onJustification: (e) => console.log(e.text),
    });
  });
</script>
```

---

## Project Structure

```
EARTHSOUND/
├── earthsound_assistant.py    # Voice AI assistant & Gemini dataset router
├── test_assistant.py          # Multilingual test runner for voice assistant
├── requirements.txt           # Python dependencies (SpeechRecognition, pyttsx3, etc.)
├── eicSpatialSynth.ts         # TypeScript spatial audio & canvas analysis engine
├── tsconfig.json              # TypeScript configuration
└── README.md
```
