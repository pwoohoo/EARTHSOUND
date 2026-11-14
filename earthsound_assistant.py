"""
earthsound_assistant.py
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EarthSound — Voice-Activated AI Assistant & Dataset Router

Features:
  1. Account Setup (Naming the Bot):
     - setup_account() asks "What would you like to name your assistant?"
     - Persists the bot name to user_settings.json.
  2. Speech Recognition (The Custom Ear):
     - Reads custom bot name from user_settings.json.
     - Continuously listens for wake word: "Hey [Custom Name]".
     - Once triggered, asks "What would you like to hear today?" via pyttsx3.
     - Captures the user's next spoken request sentence.
  3. Gemini Router (JSON Mode):
     - Uses google-generativeai SDK with os.getenv("GEMINI_API_KEY").
     - Multi-lingual intent analysis in strict JSON mode.
     - Returns exactly:
         • dataset_id: CLIMATE | RAINFALL | URBANIZATION | WILDFIRE
         • spoken_response: natural confirmation in the user's language.
  4. Execution & Audio/UI Trigger:
     - Speaks the confirmation phrase via pyttsx3.
     - Returns/prints dataset_id to trigger the EarthSound video & audio engine.

Installation:
  pip install -r requirements.txt
  (SpeechRecognition, pyttsx3, google-generativeai, pyaudio)

Usage:
  set GEMINI_API_KEY=your_key_here
  python earthsound_assistant.py
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import json
import os
import re
import sys
import time

import speech_recognition as sr
import pyttsx3
import google.generativeai as genai

# ─── Configuration & Paths ───────────────────────────────────────────────────

SETTINGS_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "user_settings.json"
)

VALID_DATASETS = {"CLIMATE", "RAINFALL", "URBANIZATION", "WILDFIRE"}

# ─── Text-to-Speech Engine ───────────────────────────────────────────────────

_tts_engine: pyttsx3.Engine | None = None


def _get_tts() -> pyttsx3.Engine:
    """Initialize and configure the pyttsx3 TTS engine."""
    global _tts_engine
    if _tts_engine is None:
        try:
            _tts_engine = pyttsx3.init()
            _tts_engine.setProperty("rate", 165)
            _tts_engine.setProperty("volume", 1.0)
        except Exception as err:
            print(f"⚠️  TTS Initialization warning: {err}")
    return _tts_engine


def speak(text: str) -> None:
    """Speak text aloud using pyttsx3, with safe error fallback."""
    print(f"🔊  [Assistant]: {text}")
    try:
        engine = _get_tts()
        if engine:
            engine.say(text)
            engine.runAndWait()
    except Exception as err:
        print(f"⚠️  [TTS Audio Output Error]: {err}")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. ACCOUNT SETUP (Naming the Bot)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def setup_account() -> str:
    """
    Runs when a user first opens the app.
    Asks: 'What would you like to name your assistant?'
    Saves the chosen name into user_settings.json.
    """
    print("\n" + "=" * 50)
    print("🌍  Welcome to EarthSound AI Setup")
    print("=" * 50)

    prompt = "What would you like to name your assistant?"
    print(f"\n{prompt}")
    bot_name = input("Enter assistant name: ").strip()

    while not bot_name:
        bot_name = input("Please provide a valid name: ").strip()

    settings = {"bot_name": bot_name}
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)

    print(f"\n✅ Assistant registered as: '{bot_name}'")
    print(f"Saved configuration to: {SETTINGS_FILE}")
    speak(f"Hello! I am {bot_name}, your EarthSound assistant.")
    return bot_name


def load_bot_name() -> str:
    """
    Load the custom bot name from user_settings.json.
    Triggers setup_account() if the file does not exist or name is empty.
    """
    if not os.path.exists(SETTINGS_FILE):
        return setup_account()

    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        name = data.get("bot_name", "").strip()
        if not name:
            return setup_account()
        return name
    except Exception:
        return setup_account()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. SPEECH RECOGNITION (The Custom Ear)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def _listen_mic(recognizer: sr.Recognizer, mic: sr.Microphone, timeout: int | None = None) -> str | None:
    """Capture audio from microphone and transcribe via speech_recognition."""
    try:
        audio = recognizer.listen(mic, timeout=timeout, phrase_time_limit=12)
        text = recognizer.recognize_google(audio)
        return text.strip()
    except (sr.WaitTimeoutError, sr.UnknownValueError):
        return None
    except sr.RequestError as err:
        print(f"⚠️  Speech API connection error: {err}")
        return None


def listen_for_wake_word(bot_name: str) -> str:
    """
    Continuously listens for the wake word: 'Hey [Custom Name]'.
    Once triggered, asks 'What would you like to hear today?' via pyttsx3,
    and captures the user's next spoken sentence.
    """
    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 300
    recognizer.dynamic_energy_threshold = True

    wake_phrase = f"hey {bot_name}".lower()

    print(f"\n🎧  [Ear Active] Listening for wake word: 'Hey {bot_name}'...")
    print("    (Say 'Hey " + bot_name + "' or type 'text' to switch to manual test mode)")

    try:
        with sr.Microphone() as mic:
            print("    Calibrating for background noise (1s)...")
            recognizer.adjust_for_ambient_noise(mic, duration=1.0)
            print("    Ready! Speak into your microphone.")

            # ── Loop until wake word is heard ──
            while True:
                heard = _listen_mic(recognizer, mic, timeout=None)
                if not heard:
                    continue

                print(f"    Heard: \"{heard}\"")
                if wake_phrase in heard.lower():
                    print(f"\n✨ Wake word 'Hey {bot_name}' detected!")
                    break

            # ── Prompt user for their request ──
            follow_up = "What would you like to hear today?"
            speak(follow_up)

            user_request = None
            while not user_request:
                print("🎤  Listening for your request...")
                user_request = _listen_mic(recognizer, mic, timeout=10)
                if not user_request:
                    speak("Sorry, I didn't catch that. What would you like to hear today?")

            print(f"📝  User Spoke: \"{user_request}\"")
            return user_request

    except (OSError, AttributeError) as err:
        # Fallback if no working microphone or PyAudio is absent
        print(f"\n⚠️  Microphone / PyAudio unavailable ({err}). Falling back to keyboard input:")
        prompt_text = f"Hey {bot_name}"
        input(f"Press Enter to simulate wake word ('{prompt_text}')... ")
        follow_up = "What would you like to hear today?"
        speak(follow_up)
        return input("What would you like to hear today? > ").strip()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. THE GEMINI ROUTER (JSON Mode)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SYSTEM_PROMPT = """You are the intelligent voice router for the EarthSound application.

Analyze the user's spoken sentence (which may be in any language or dialect) and map it to the corresponding NASA Earth-observation dataset.

Strict requirements:
1. Return ONLY a single raw JSON object. Do not wrap in markdown code blocks or add any additional commentary.
2. The JSON object must contain exactly these two fields:
   - "dataset_id": MUST be exactly one of: "CLIMATE", "RAINFALL", "URBANIZATION", "WILDFIRE".
   - "spoken_response": A concise, natural, friendly confirmation phrase in the EXACT SAME LANGUAGE the user used. Occasionally mention the assistant's name to sound warm and engaging.

Intent Mapping:
- CLIMATE: Temperature shifts, global warming, carbon emissions, greenhouse gases, arctic ice, polar vortex.
- RAINFALL: Rain, precipitation, monsoon, storms, hurricanes, floods, atmospheric rivers, typhoons.
- URBANIZATION: Cities growing, night lights, deforestation for human development, population sprawl, concrete infrastructure.
- WILDFIRE: Forest fires, brush fires, smoke plumes, burning acreage, fire fronts, heat thermal anomalies.

If the request is ambiguous, pick the closest matching category or default to "CLIMATE".
"""


def route_with_gemini(user_text: str, bot_name: str) -> dict:
    """
    Passes transcribed text to Google Gemini in JSON Mode.
    Returns:
      {
        "dataset_id": "CLIMATE" | "RAINFALL" | "URBANIZATION" | "WILDFIRE",
        "spoken_response": "<Natural phrase in user's language>"
      }
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("❌ Error: GEMINI_API_KEY environment variable is not set.")
        print("   Set it using: set GEMINI_API_KEY=your_key (Windows) or export GEMINI_API_KEY=your_key")
        sys.exit(1)

    genai.configure(api_key=api_key)

    # Use the latest fast model gemini-2.0-flash with JSON mode
    model = genai.GenerativeModel(
        model_name="gemini-2.0-flash",
        system_instruction=SYSTEM_PROMPT + f"\nThe assistant's name is: {bot_name}",
        generation_config=genai.GenerationConfig(
            response_mime_type="application/json",
            temperature=0.3,
        ),
    )

    print("🧠  [Gemini Router] Analyzing intent and language...")
    response = model.generate_content(user_text)
    raw_content = response.text.strip()

    # Clean markdown fences if any are returned
    clean_json = re.sub(r"^```(?:json)?\s*", "", raw_content)
    clean_json = re.sub(r"\s*```$", "", clean_json).strip()

    try:
        parsed = json.loads(clean_json)
    except json.JSONDecodeError as err:
        print(f"⚠️  JSON parsing error: {err}. Raw was: {raw_content}")
        parsed = {
            "dataset_id": "CLIMATE",
            "spoken_response": f"I will load the Earth climate data for you now, with {bot_name}.",
        }

    # Validate dataset_id against strict allowlist
    dataset_id = str(parsed.get("dataset_id", "")).upper().strip()
    if dataset_id not in VALID_DATASETS:
        print(f"⚠️  Unrecognized dataset '{dataset_id}'. Defaulting to 'CLIMATE'.")
        dataset_id = "CLIMATE"

    parsed["dataset_id"] = dataset_id
    return parsed


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. EXECUTION & INPUT INSTRUCTION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def execute(gemini_result: dict) -> str:
    """
    1. Reads the spoken_response out loud via pyttsx3.
    2. Prints and returns dataset_id as the trigger for the NASA video/audio engine.
    """
    spoken_response = gemini_result.get("spoken_response", "Loading EarthSound dataset.")
    dataset_id = gemini_result.get("dataset_id", "CLIMATE")

    # Speak confirmation
    speak(spoken_response)

    # Trigger output for main application
    print("\n" + "─" * 40)
    print(f"🚀  TRIGGER: dataset_id = {dataset_id}")
    print(f"    (Ready to load NASA {dataset_id} video & audio mapping)")
    print("─" * 40 + "\n")

    return dataset_id


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# MAIN LOOP
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def run_assistant_cycle() -> str:
    """Runs a single wake-word -> recognition -> Gemini -> execute cycle."""
    bot_name = load_bot_name()
    user_speech = listen_for_wake_word(bot_name)
    decision = route_with_gemini(user_speech, bot_name)
    dataset_id = execute(decision)
    return dataset_id


def main():
    """Main continuous assistant runner."""
    print("🌍  Starting EarthSound Voice Assistant...")
    bot_name = load_bot_name()
    print(f"🤖  Assistant Name: '{bot_name}'")

    while True:
        try:
            dataset_id = run_assistant_cycle()
            print(f"✅  Cycle completed with dataset: {dataset_id}\n")
            time.sleep(1)
        except KeyboardInterrupt:
            print("\n👋  EarthSound Voice Assistant exiting.")
            break


if __name__ == "__main__":
    main()
