# Glasses UI

The G2 display is 576 x 288 pixels, 4-bit greyscale shown in green, with one firmware font (not monospaced) and a fixed 27 px line height. The app draws text only.

## Layout

One page is created once with `createStartUpPageContainer` and is never rebuilt. Every later change is a `textContainerUpgrade` of the containers whose text changed (body first, then title, then footer).

| Container | ID / name | Position and size | Lines | Captures input | Brightness |
| --- | --- | --- | --- | --- | --- |
| Title | 1 `title` | x 12, y 4, 552 x 35, padding 4 | 1 | no | 3 |
| Body | 2 `body` | x 12, y 43, 552 x 197, padding 4 (inner 544 x 189) | 7 | **yes** | 4 |
| Footer | 3 `footer` | x 12, y 249, 552 x 35, padding 4 | 1 | no | 3 |

- No borders, no images, no native list container. Menus are text rows with a `> ` cursor; unselected rows are indented with three no-break spaces.
- Reader pages are paginated to 7, 6 or 5 lines (a phone setting). Every other frame is fitted to 7 lines, and every list line is truncated to the pixel width, so a frame can never overflow and make the firmware scroll the body.
- Pages are measured with Even's font metrics (`@evenrealities/pretext`) and capped at 1800 UTF-8 bytes. Text never has an ASCII space right after a line break; indentation uses no-break spaces.

## Gestures

| View | Swipe down (next) | Swipe up (previous) | Tap | Double-tap | Long press |
| --- | --- | --- | --- | --- | --- |
| Home | Cursor down (stops at the end) | Cursor up | Open the item | **Exit**: `shutDownPageContainer(1)` shows the system exit dialog | Ignored |
| First run / no relay | — | — | — | Exit (system dialog) | Ignored |
| Publications | Cursor down | Cursor up | Open that publication's posts | Back | Back |
| Posts list | Cursor down; past the last post it selects "Load older posts…" when present | Cursor up | Read the post, or load older posts on that row | Back (Home or Publications keeps its selection) | Back |
| Reader | Next page; after the last page, the end card | Previous page; from the end card, the last page | Next page (setting "Tap in reader: next page"); on the end card, the next post in the list | Back to the list with this post selected; the position is saved at once | Back |
| Loading | — | — | — | Cancel the request and go back | Same as double-tap |
| Error | — | — | Retry (when retrying can help) | Back | Back |

- Swipe direction can be inverted in the phone settings. The device checklist records which physical swipe is "down".
- Taps and double-taps may arrive in the system, text or list event envelope; all three are read. A click with no event type inside an envelope is a tap.
- Long press may never reach the app on some firmware, because the system uses tap-then-hold for its own menu. Nothing depends on it.
- The phone's Home panel has a remote (‹ Prev, Select, Next ›, Back) that sends the same actions.

### Gesture filter

One physical gesture can arrive as several events, and the firmware can send a phantom scroll right after the display changes. `src/input.ts` drops:

| Rule | Window |
| --- | --- |
| A second scroll in the same direction | 300 ms |
| A scroll in the other direction | 50 ms |
| Any scroll right after a successful display write | 80 ms |
| A second tap | 220 ms |
| A second double-tap or long press (shared window) | 600 ms |
| The same contextual-menu item again | 600 ms |

The scroll debounce is reset on every view change, so the first swipe in a new view always counts.

### Contextual menu

Tap then hold opens the system menu, which lists these items above the system's own:

| ID | Item | Effect |
| --- | --- | --- |
| 1 | Home | Back to Home from anywhere (saves the reading position) |
| 2 | Save for later | Saves the open post, or the selected post in a list. The footer shows "Saved for later", "Already saved" or "Saved list is full" for one frame. |
| 3 | Next post | In the reader: open the next post of the list |
| 4 | Restart post | In the reader: go to page 1 |
| 5 | Refresh | In a list: reload it (Latest skips its 5-minute cache). In a failed reader: retry. Elsewhere: redraw the whole frame. |

An item that does not apply shows "Not available here" in the footer for one frame.

## Frames

`·` is U+00B7, `×` is U+00D7, `…` is U+2026. All are in the G2 font.

| Frame | Title | Body | Footer |
| --- | --- | --- | --- |
| Home | `Reader for Substack` | 4 items per screen with a blank line between them: `Continue: <title>` (only while a post is unfinished), then the Home items set on the phone: `Latest`, `Publications (N)`, `Saved (N)`, `History` | `Tap open · 2×tap exit` |
| First run (no publications and nothing saved) | `Reader for Substack` | `No publications yet.` / blank / `On your phone, open Reader for Substack` / `in the Even app and add a publication.` | `2×tap exit` |
| No relay in this build | `Reader for Substack` | `This build has no reader service.` / `See the phone for details.` | `2×tap exit` |
| Publications | `Publications` | 4 names per screen, as on Home | `3/12 · Tap open · 2×tap back` |
| Posts list | Publication name, `Latest`, `Saved` or `History` | 3 posts per screen, 2 lines each: `> Title…` and an indented meta line such as `Pub · 2d · 12 min · Paid · 34%` (the publication is left out inside its own list; `Paid` only for paywalled posts; the last field is the progress or `Read`). The last row may be `> Load older posts…`. | `4/37 · Tap read · 2×tap back` (`Tap load` on the Load row; `· 2 failed` when some Latest publications failed) |
| Reader | `<Publication> · <Title>` | The page text | `12/41 · 29% · ~9 min left` |
| End card, free post | same | `End of post.` / blank / `Tap: next post` / `Swipe up: previous page` / `2×tap: back to list` | `End · 41/41` |
| End card, paid post | same | `The free preview ends here.` / `The rest is for paid subscribers.` / `Read it in the Substack app.` / blank / `Tap: next post · 2×tap: back` | `End · 41/41` |
| Loading | Context title | `Loading…` | `2×tap cancel` |
| Error | Context title | See below | `Tap retry · 2×tap back` (or `2×tap back` when retrying cannot help) |

Empty lists show `No posts yet.`, `Nothing saved yet.` / `Save posts on your phone.`, `Nothing read yet.`, `No publications yet.` / `Add one on your phone.`, or `No publications in Latest.` / `Turn one on in the phone app.` A tap on the end card when the list has no next post shows `No more posts.` for one frame.

Error bodies (details go to the phone):

| Error code | Glasses body |
| --- | --- |
| `NOT_CONFIGURED` | `This build has no reader service.` |
| `NETWORK_ERROR`, `TIMEOUT` | `Can't reach the reader service.` / `Check the phone's connection.` |
| `UPSTREAM_BLOCKED` | `Substack refused the reader service.` / `Try again later.` |
| `RATE_LIMITED`, `UPSTREAM_RATE_LIMITED` | `Busy. Try again in <N> s.` (60 when unknown) |
| `POST_NOT_FOUND`, `PUBLICATION_NOT_FOUND`, `PROFILE_NOT_FOUND` | `Not found on Substack.` |
| `HOST_NOT_SUBSTACK` | `That site is not a Substack publication.` |
| Post with no readable text | `No readable text in this post.` (footer `2×tap back`) |
| Anything else | `Substack had a problem.` / `Try again.` |

## Reader text

Each post starts with a header block: the title, the subtitle, `By <authors> · <date> · <N> min read`, then `[Paid post · free preview only]` for paywalled posts and `[Podcast episode · audio is not available on glasses]` for podcasts, then a blank line and the converted text. Reading time is the word count divided by 230, at least 1 minute.

The converter keeps paragraphs, headings (upper-cased when short, a setting), quotes (`> `), lists (`• `, `– `, `· ` by depth, or numbers), code, footnotes (at the end, inline or hidden) and placeholders such as `[Image: caption]`, `[Video: YouTube]`, `[Tweet by Name (@user)]`, `[Chart: …]` and `[Poll]`. Subscribe buttons, share widgets and similar page furniture are dropped. Characters the font cannot draw are mapped to close equivalents, removed (invisible characters, unsupported emoji) or shown as `[?]`.

## Position, launch and lifecycle

- The reading position (character offset, fraction, page) is recorded after every page that the glasses actually displayed, saved after 800 ms, and saved immediately on back, Home, opening another post, background, `pagehide` and exit. Showing the end card marks the post as read.
- Launching the app from the glasses menu with an unfinished post goes straight to that post (Loading first), with Home underneath it.
- When the app returns to the foreground after more than 30 seconds, or the glasses reconnect, the current frame is sent again in full.
- Connection status on the phone: `Connecting to G2…`, `G2 connected.`, `G2 disconnected. Reconnect in the Even app.`, `Reader closed.`
