# Device acceptance checklist

Run this on real G2 glasses with the packaged build. Tick an item only after you have observed it, and write down what you saw (values, codes, firmware and Even app versions). CI cannot cover any of this: it uses a stub of the Even bridge.

Build under test: `artifacts/substack-reader-0.1.0.ehpk` (version ______, relay origin ______, SHA-256 ______).

Upload it at hub.evenrealities.com (your project → Builds → upload the build, with a change log). Then **promote it from Private to Beta**; forgetting this step caused the "expired" message in the LIHKG reader. Install or update it as a tester in the Even app (Me → Beta tester).

Even app version ______ · glasses firmware ______ · phone and OS ______ · date ______

## Diagnostics

- [ ] Diagnostics → Check relay shows `protocol 1`. Record the echoed **WebView Origin**: ______
- [ ] Record the probes: `subdomain` ______ · `customDomain` ______ · `substackCom` ______ (200 each, or the failure status and content type).

## First run and setup

- [ ] The first launch from the glasses menu shows the setup frame ("No publications yet."), not a black screen.
- [ ] Add a `*.substack.com` publication.
- [ ] Add a custom-domain publication (for example `www.slowboring.com`, and the bare `slowboring.com`, which must fall back to `www.`).
- [ ] Import publications from an `@handle`.
- [ ] Find and follow a publication by name search.
- [ ] Force-quit the Even app, relaunch it, and confirm the publications, saved posts and settings are still there (bridge storage).

## Navigation and gestures

- [ ] Home → Publications → list → reader works. Every page fits with **no internal scrolling** (the first swipe turns the page).
- [ ] The swipe toward the ear (and ring down) goes to the **next** page. If not, turn on "Invert swipe" and record the result: ______
- [ ] Tap turns to the next page. Double-tap goes back to the list with the same post selected.
- [ ] Double-tap on Home opens the system exit dialog. Cancelling it leaves the app working; confirming exits cleanly, and another app (for example Conversate) then opens normally.
- [ ] Long press: record whether it reaches the app: ______
- [ ] Tap-then-hold opens the system menu with Home, Save for later, Next post, Restart post and Refresh, and each one works.
- [ ] R1 ring: swipe and tap work the same as the temple touchpads. Record the event sources shown in Diagnostics: ______
- [ ] The raw event log shows which envelope (sys, text or list) carries taps, double-taps and scrolls. Record it: ______
- [ ] "Load older posts…" loads more posts and the list keeps going past short pages.
- [ ] The phone remote (Prev, Select, Next, Back) drives the glasses.

## Display

- [ ] Glyphs: curly quotes, dashes, `•`, `·`, `×`, `…`, superscript digits and the indentation of nested lists render correctly.
- [ ] `[Image: …]` placeholders and `> ` quotes look right.
- [ ] Supported emoji are legible, or "Remove emoji" removes them cleanly.
- [ ] Changing lines per page to 6 and 5 keeps the reading position, and every page still fits.
- [ ] Page turns feel instant (target under 250 ms). Rapid swipes neither skip pages nor turn twice.

## Lifecycle and errors

- [ ] Lock the phone for 5 minutes while reading, then unlock: the page is still shown and the app responds.
- [ ] Android: after the Even app is killed in the background, a cold start resumes at the same page.
- [ ] Launch from the glasses menu with a post in progress: the app goes straight to that post at the saved page.
- [ ] Paid post: the preview, then the paid end card ("The free preview ends here.").
- [ ] Podcast post: the podcast note appears in the header.
- [ ] Airplane mode: the glasses show "Can't reach the reader service." within about 15 s, with no endless Loading; Tap retry works once the connection is back.
- [ ] Idle for 2 minutes, then the app still responds.
- [ ] Battery drain over a 30-minute reading session: ______ %
