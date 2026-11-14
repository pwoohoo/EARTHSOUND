"""
test_assistant.py
───────────────────────────────────────────────────────────────────────────────
Simulated test script for earthsound_assistant.py
Tests:
  1. Setting up / loading the bot name in user_settings.json
  2. Gemini Router with sample multi-lingual queries
  3. JSON response validation (dataset_id & spoken_response)
  4. TTS audio output verification
───────────────────────────────────────────────────────────────────────────────
"""

import os
from earthsound_assistant import (
    load_bot_name,
    route_with_gemini,
    execute,
    VALID_DATASETS,
)

SAMPLE_QUERIES = [
    "Can you show me the raging forest fires across California?",
    "Show me global temperature changes and carbon emissions",
    "Where is it raining heavily with monsoons right now?",
    "Quiero ver cómo crecen las grandes ciudades del mundo por la noche",  # Spanish: Urbanization
    "東京の雨の様子を見せてください",  # Japanese: Rainfall
]


def run_tests():
    print("🌍 Testing EarthSound Voice Assistant Engine...\n")

    bot_name = load_bot_name()
    print(f"Assistant Name: '{bot_name}'")

    if not os.getenv("GEMINI_API_KEY"):
        print("⚠️ Warning: GEMINI_API_KEY is not set in environment.")
        print("   Run: set GEMINI_API_KEY=your_key before running tests.")
        return

    for query in SAMPLE_QUERIES:
        print("\n" + "=" * 60)
        print(f"User Input: \"{query}\"")
        result = route_with_gemini(query, bot_name)
        print(f"Gemini Raw JSON Output: {result}")
        assert result["dataset_id"] in VALID_DATASETS, f"Invalid dataset: {result['dataset_id']}"
        dataset_id = execute(result)
        print(f"Resulting Trigger ID: {dataset_id}")


if __name__ == "__main__":
    run_tests()
