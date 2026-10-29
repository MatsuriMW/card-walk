# Card Walk

**English** · [简体中文](./README.zh-CN.md)

Review the `#card` flashcards and `==cloze==` blocks in your notes from a side panel: read the question, reveal, answer Again / Hard / Good / Easy, and let Anki do the scheduling. It works on your phone too: answers made there reach Anki on your computer within seconds, and every step of the sync is visible.

![Card Walk on a phone: the sync status at the top shows the computer is online with Anki running; each recent answer shows Saved → Uploaded → Anki; below are the cards to review.](https://raw.githubusercontent.com/MatsuriMW/card-walk/main/docs/screenshot.png)

The interface follows Obsidian's language (English or Chinese).

## Reviewing

- Open it from the ribbon or the command **Open Card Walk**. Optionally, a tab is added to the right sidebar the first time you open Obsidian each day.
- **Cards**: the list item containing `#card`, with its children; the first line is the question, the children are the answer. **Clozes**: `==…==`, `{{c1::…}}` and `{1:…}` are hidden as ［⋯］, numbered the same way as the Flashcards plugin. Content is rendered as Markdown, with the parent blocks shown above as breadcrumbs.
- **Drawing**: cards due today in Anki come first; the rest alternate between cards and clozes. The draw is stable for the day (↻ draws again). Filter by when cards were added (7 days / 1 month / all), by subject, and, if configured, by a separate Language tab. Recent cards and cards linking to chosen pages can be weighted up.
- **Daily goal**: a progress bar and the last 14 days (from Anki's review log, so phone reviews count too). Cards marked Again come back three cards later.
- **Keyboard**: click to select, Space to reveal, 1–4 to answer, ↑↓ to move; ⌥⌘→ focuses on one card, ⌥⌘← or Esc goes back. ⌘-click opens the source note with the line selected.
- **Right-click → Stop using as a card** removes the `#card` tag or cloze marks and keeps the text (undoable).
- Optional sounds and sparks when you answer, and an optional line in today's journal logging the session.

## Phone ⇄ computer sync

When you review on your phone you need to trust what you see: is this card's progress current, or was it already answered on the computer? Did the answers you just made actually reach Anki?

Card Walk uses an [Upstash](https://upstash.com) Redis database as a relay (the free plan is enough):

- Answer on the phone → uploaded immediately → your computer picks it up and records it in Anki → the new progress goes back to the phone. While a phone is active the computer checks every 5 seconds; otherwise every 30–60 seconds, so the very first answer after you open the panel can take up to a minute.
- A status line on both sides, expandable to devices and recent answers:
  - 🟢 *Computer online · Anki running · progress synced 3s ago*
  - 🟡 *Computer offline since 2 h ago · using its last progress* (nobody changes Anki while it's off, so the progress is still current; answers wait in the queue)
  - 🟡 *Computer online, Anki not running · answers are queued*
  - 🔴 *Can't reach the sync server · 3 answers saved here, they'll upload when online*
- Every answer shows three steps — **Saved → Uploaded → In Anki (next in 3 days)** — updating live. Answers made offline are kept on the device and uploaded later, never twice. If Anki refuses an answer (for example, the card was deleted), you see that too.
- Stale cards are caught: when new progress arrives, cards already answered elsewhere turn grey on the spot. On the computer, cards answered on the phone but not yet in Anki can't be answered again.
- Only card IDs, ratings, times, device names and an Anki progress snapshot (card IDs) are uploaded. Card content never leaves your vault.

### Setup

1. Create a Redis database at [console.upstash.com](https://console.upstash.com) (or Upstash for Redis in the Vercel Marketplace) and copy the REST URL and token from the database page (not the read-only token).
2. Settings → Phone sync: paste both and press **Test connection**. Use the same database on every device; if your plugin settings sync with your vault, entering them once is enough.

Without sync, the computer works directly with Anki and the phone can read cards but not answer them.

## Requirements

- Anki with [AnkiConnect](https://ankiweb.net/shared/info/2055492159), running on the computer.
- The [Flashcards](https://github.com/reuseman/flashcards-obsidian) plugin, which syncs cards to Anki and records each block's Anki note ID in the note's `flashcards` property. Card Walk uses that mapping to find each card in Anki.
- Optional: an Upstash Redis database for phone sync.

## Network use

Card Walk talks to AnkiConnect on your computer (`http://127.0.0.1:8765` by default) and, if you set it up, to your own Upstash database. Nothing else, and no telemetry.

## Install

Search for **Card Walk** in Settings → Community plugins, or download `main.js`, `manifest.json` and `styles.css` from [Releases](https://github.com/MatsuriMW/card-walk/releases) into `<vault>/.obsidian/plugins/card-walk/`. BRAT also works: `MatsuriMW/card-walk`.

## License

MIT
