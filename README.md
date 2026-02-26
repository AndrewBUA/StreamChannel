# StreamChannel

Create your own cross-service "TV channel" from Netflix, Hulu, and HBO Max links, then play through your lineup automatically.


<img width="421" height="601" alt="image" src="https://github.com/user-attachments/assets/184fc6bd-4e88-42da-95b9-53be0904903b" />

<img width="428" height="604" alt="image" src="https://github.com/user-attachments/assets/7e527283-2529-4977-babc-e35545354c3f" />

<img width="427" height="602" alt="image" src="https://github.com/user-attachments/assets/4342dd6c-ff27-4f37-850f-6ad8befbbbb1" />






This Chrome extension lets you:
- Build channels from shows, episodes, and movies
- Auto-advance through items
- Control subtitles (CC) globally and per-item
- Shuffle with multiple strategies
- Reorder items with drag-and-drop
- Resume where you left off
- Import/export channel data
- Enforce safe URL allowlisting

## Supported Services

- `https://www.netflix.com/`
- `https://www.hulu.com/`
- `https://play.hbomax.com/`

All stored and navigated URLs are sanitized and allowlisted to those trusted domains.

## Key Features

- Channel playback controls: `Back`, `Stop`, `Skip`
- Rewinds all shows/movies automatically to start on HBOMax and Hulu. Netflix does not support this functionality.
- Per-channel playback mode:
  - `Sequential`
  - `True Random`
  - `Least Played`
  - `Newest First`
- Per-channel profile presets:
  - Default CC on/off
  - CC language
  - Auto maximize on/off
- Per-item controls:
  - CC toggle
  - Play count (`+`, `-`, `Reset`)
  - Max plays limit
  - Cooldown minutes
  - URL repair
- Channel management:
  - Drag-and-drop reorder
  - Randomize
  - Deduplicate
  - Clone
- Data management:
  - Export/import JSON backups
  - Batch add URLs (one per line)
- Session memory:
  - `Start Here` sets current pointer
  - `Play` resumes from saved pointer

## Installation (Developer Mode)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder (`StreamChannel`)
5. Pin/open the extension popup

## How To Use

### 1) Create a channel
1. Open popup
2. Enter a name under **New Channel**
3. Click **Create**

### 2) Add items from a service page
1. Open a Netflix/Hulu/HBO Max page in the active tab
2. In popup, choose your channel
3. Click **Add To Channel**

### 3) Batch add URLs
1. Paste one URL per line in **Batch Add URLs**
2. Click **Add URLs To Selected Channel**
3. Invalid/untrusted URLs are skipped automatically

### 4) Start playback
1. In a channel, optionally choose an item in **Start Here**
2. Click **Start Here** (sets pointer + starts there), or click **Play** to resume saved pointer
3. Use `Back`, `Stop`, and `Skip` from the popup

### 5) Tune behavior
- Set channel profile defaults (CC, language, maximize)
- Adjust per-item play count / limits / cooldown
- Reorder items by dragging rows

## Data & Safety

- URLs are validated/sanitized on:
  - Add/import/repair
  - Channel normalization
  - Final navigation in background playback
- Unsafe domains are dropped and never opened by playback flow

## Known Issues / Notes

- **Auto Maximize interaction requirement**  
  To reliably use auto maximize, click once on the video at the beginning of the show/movie. After that, maximize behavior works as expected.

- **HBO Max overlay flicker at start**  
  At the beginning of some HBO Max items, the player overlay may flicker briefly before settling (usually a few moments). This is expected with current UI automation behavior.

## Project Structure

- `manifest.json` - extension manifest
- `popup.html` / `popup.css` / `popup.js` - popup UI and channel management
- `background.js` - playback state, routing, sequencing logic
- `content/netflix.js` - Netflix automation
- `content/hulu.js` - Hulu automation
- `content/max.js` - HBO Max automation

## Contributing

If you fork this, test changes per service independently (Netflix/Hulu/HBO Max) because player UIs evolve frequently.
