# EARTHSOUND

Real-time spatial audio synthesizer that converts satellite weather video into a multi-voice, spatially-panned musical track using the Web Audio API.

## What it does

`eicSpatialSynth.ts` connects an HTML5 `<video>` element (e.g. a satellite weather map) to the Web Audio API and generates music in real time:

- **12 longitude columns** spanning the Prime Meridian (center) to the International Date Line (edges)
- **Temporal derivative analysis** detects moving weather fronts vs. static background
- **C Dorian scale** voices (130 Hz – 4,500 Hz) with stereo panning matching geographic position
- **Atmosphere pad** (filtered noise) driven by global temperature balance
- **Live justification feed** with plain-English captions and `aria-live` accessibility

## Quick Start

```html
<video id="earthVideo" src="satellite.mp4" muted></video>
<button id="playBtn">▶ Play Sonification</button>
<div id="caption" aria-live="polite" role="status"></div>

<script type="module">
  import { start, stop, setLayerMute, getJustificationLog } from './eicSpatialSynth.js';

  const video = document.getElementById('earthVideo');
  const btn   = document.getElementById('playBtn');

  btn.addEventListener('click', async () => {
    await video.play();
    await start(video, {
      ariaLiveElement: document.getElementById('caption'),
      onJustification: (e) => console.log(e.text),
    });
  });
</script>
```

## API

| Function | Signature | Purpose |
|----------|-----------|---------|
| `start` | `(video, options?) → Promise<void>` | Init audio graph + begin frame loop |
| `stop` | `() → void` | Tear down everything cleanly |
| `setLayerMute` | `(layer, muted) → void` | Mute/unmute `'pad'`, `'meridianVoices'`, or `'all'` |
| `getJustificationLog` | `() → JustificationEntry[]` | Snapshot of all justification events |

## Tech Stack

- **TypeScript** — sole language
- **Web Audio API** — oscillators, filters, stereo panners, dynamics compressor
- **Canvas 2D** — real-time video frame capture and pixel analysis
- Zero external dependencies
