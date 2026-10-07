/**
 * Phone templates (SPEC section 5). Pure: a PhoneModel snapshot in, an HTML
 * string out. Every dynamic value goes through escapeHtml; post HTML never
 * reaches this module (only titles and metadata), no remote images are
 * loaded, and there are no links: external URLs are offered as Copy link.
 * Non-ASCII glyphs are written as HTML entities so the source stays ASCII.
 */
import { isRetryable } from '../app/frames'
import { minutesFor, pctString } from '../app/format'
import { HOME_ITEM_IDS, LATEST_MAX_PUBLICATIONS_RANGE, LIMITS, type AppState, type HomeItemId, type PostRef, type ViewError } from '../app/types'
import type { GlassesPage, GlassesStatus } from '../events'
import { isRead, isSaved, positionOf, refKey } from '../storage'
import type { ParsedInput } from '../substack/urls'
import type { HealthResponse, PostSummary, Profile, PubMeta } from '../substack/types'

export type PhonePanel = 'home' | 'publications' | 'browse' | 'saved' | 'settings' | 'diagnostics' | 'about'
export const PHONE_PANELS: readonly PhonePanel[] = ['home', 'publications', 'browse', 'saved', 'settings', 'diagnostics', 'about']

/** Glasses link as shown on the phone ('nobridge': not opened from the Even app). */
export type GlassesLink = GlassesStatus['state'] | 'nobridge'

export interface PhoneError {
  code: string
  message: string
  /** Upstream status / retry hint, already plain text. */
  detail: string
  retry: boolean
}

export type AddCard =
  | { id: number; kind: 'pending'; label: string }
  | { id: number; kind: 'message'; label: string; text: string; tone: 'ok' | 'info' }
  | { id: number; kind: 'invalid'; label: string; text: string }
  | { id: number; kind: 'error'; label: string; text: string; code: string; parsed: ParsedInput }
  | { id: number; kind: 'post'; label: string; post: PostSummary; publication: PubMeta | null; host: string }
  | { id: number; kind: 'profile'; label: string; profile: Profile; picks: string[] }
  | { id: number; kind: 'search'; label: string; query: string; results: PubMeta[] }

export interface BrowseState {
  host: string
  name: string
  posts: PostSummary[]
  nextOffset: number | null
  loaded: boolean
}

export interface GlassesMirror {
  frame: GlassesPage
  /** Glasses back-stack depth (1 = Home). */
  depth: number
  /** The post open on the glasses, or null. */
  reading: PostRef | null
  error: ViewError | null
  busy: boolean
}

export interface PhoneModel {
  panel: PhonePanel
  appName: string
  version: string
  relayOrigin: string | null
  link: { state: GlassesLink; message: string }
  busy: boolean
  busyLabel: string
  error: PhoneError | null
  notice: string
  copyFallback: string
  saveOk: boolean
  state: AppState
  glasses: GlassesMirror
  addCards: readonly AddCard[]
  browse: BrowseState | null
  health: HealthResponse | null
  events: readonly string[]
  storage: { backend: string; sizes: { prefs: number; progress: number } }
  lastErrorCode: string
  confirm: 'clear-reading' | 'reset-settings' | null
}

export const NO_BRIDGE_MESSAGE = 'Open this from the Even app to use the glasses.'

const HOME_ITEM_LABELS: Record<HomeItemId, string> = {
  latest: 'Latest',
  publications: 'Publications',
  saved: 'Saved',
  history: 'History',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOT = ' &middot; '

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
}
const esc = escapeHtml

/** 'Mar 5, 2026' in the phone's time zone; '' when unparsable. */
export function dateLabel(iso: string | null | undefined): string {
  const time = typeof iso === 'string' && iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

/** The public web address of a post pointer (https only), or null. */
export function postUrl(ref: Pick<PostRef, 'host' | 'slug'>): string | null {
  return ref.host && ref.slug ? `https://${ref.host}/p/${encodeURIComponent(ref.slug)}` : null
}

function disabledIf(condition: boolean): string {
  return condition ? ' disabled' : ''
}

function pressed(value: boolean): string {
  return ` aria-pressed="${value ? 'true' : 'false'}"`
}

function isFollowing(state: AppState, host: string): boolean {
  return state.publications.some(item => item.host === host)
}

// ---------------------------------------------------------------------------
// Chrome

const BRAND_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">'
  + '<rect x="5" y="3" width="14" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/>'
  + '<path d="M8 8h8M8 11.5h8M8 15h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'

export function renderStatusInner(model: Pick<PhoneModel, 'link'>): string {
  return `<span class="dot" aria-hidden="true"></span><span class="status-text">${esc(model.link.message)}</span>`
}

function renderTabs(panel: PhonePanel): string {
  const current = panel === 'browse' ? 'publications' : panel
  const tab = (id: PhonePanel, label: string) =>
    `<button type="button" class="tab" data-panel="${id}"${current === id ? ' aria-current="page"' : ''}>${label}</button>`
  return `<nav class="tabs" aria-label="Sections">${tab('home', 'Home')}${tab('publications', 'Publications')}${tab('saved', 'Saved')}${tab('settings', 'Settings')}</nav>`
}

/** Glasses error alert and the "reading on glasses" note (updated in place on glasses changes). */
export function renderGlassesLive(model: Pick<PhoneModel, 'glasses'>): string {
  const { error, reading } = model.glasses
  let html = ''
  if (error) {
    html += `<div class="alert" role="alert" data-testid="glasses-alert"><p><strong>Glasses:</strong> ${esc(error.message)} <span class="code">${esc(error.code)}</span></p>`
      + (isRetryable(error) ? '<div class="alert-actions"><button type="button" data-action="glasses-retry" data-testid="glasses-retry">Retry on glasses</button></div>' : '')
      + '</div>'
  }
  if (reading) {
    html += `<aside class="now-reading" data-testid="now-reading"><span class="eyebrow">Reading on glasses</span><strong>${esc(reading.title)}</strong><span class="small">${esc(reading.pubName)}</span></aside>`
  }
  return html
}

/** The three glasses containers as text (inside #mirror). */
export function renderMirrorFrame(model: Pick<PhoneModel, 'glasses'>): string {
  const frame = model.glasses.frame
  return `<div class="lens-title" data-testid="mirror-title">${esc(frame.title)}</div>`
    + `<div class="lens-body" data-testid="mirror-body">${esc(frame.body)}</div>`
    + `<div class="lens-footer" data-testid="mirror-footer">${esc(frame.footer)}</div>`
}

export function renderEventLog(events: readonly string[]): string {
  return events.length ? events.map(line => `<li>${esc(line)}</li>`).join('') : '<li class="empty">No glasses events yet.</li>'
}

function renderMessages(model: PhoneModel): string {
  let html = ''
  if (!model.relayOrigin) {
    html += '<div class="alert" role="alert" data-testid="relay-missing"><p><strong>No reader service in this build.</strong> Publications cannot be checked or read. '
      + 'The app must be built with VITE_RELAY_ORIGIN set to the deployed relay origin.</p></div>'
  }
  if (!model.saveOk) {
    html += '<div class="alert" role="alert" data-testid="save-failed"><p><strong>Could not save.</strong> Your latest changes are kept until the app closes. '
      + 'Remove some saved posts or publications, then try again.</p></div>'
  }
  if (model.error) {
    const e = model.error
    html += `<div class="alert" role="alert" data-testid="phone-alert"><p>${esc(e.message)} <span class="code">${esc(e.code)}</span></p>`
      + (e.detail ? `<p class="small">${esc(e.detail)}</p>` : '')
      + '<div class="alert-actions">'
      + (e.retry ? `<button type="button" data-action="retry" data-testid="phone-retry"${disabledIf(model.busy)}>Retry</button>` : '')
      + '<button type="button" class="quiet" data-action="dismiss-error">Dismiss</button></div></div>'
  }
  if (model.notice) html += `<div class="notice" role="status" data-testid="notice">${esc(model.notice)}</div>`
  if (model.copyFallback) {
    html += '<section class="card copy-panel"><label for="copy-fallback">Press and hold the link, select all, then copy</label>'
      + `<textarea id="copy-fallback" class="code-text" readonly rows="3">${esc(model.copyFallback)}</textarea></section>`
  }
  if (model.busy) html += `<div class="loading" role="status" data-testid="busy">${esc(model.busyLabel || 'Working')}&hellip;</div>`
  return html
}

// ---------------------------------------------------------------------------
// Panels

function renderHome(model: PhoneModel): string {
  const { state } = model
  const backDisabled = model.glasses.depth <= 1
  const firstRun = !state.publications.length && !state.saved.length
  return `<section class="card mirror-card"><h2>Now on glasses</h2>`
    + `<div class="lens" id="mirror" data-testid="mirror">${renderMirrorFrame(model)}</div>`
    + '<details id="remote" class="remote"><summary data-testid="remote-toggle">Remote control</summary>'
    + '<div class="remote-grid">'
    + '<button type="button" class="secondary" data-action="remote" data-remote="previous" data-testid="remote-previous">&lsaquo; Prev</button>'
    + '<button type="button" data-action="remote" data-remote="select" data-testid="remote-select">Select</button>'
    + '<button type="button" class="secondary" data-action="remote" data-remote="next" data-testid="remote-next">Next &rsaquo;</button>'
    + `<button type="button" class="secondary" data-action="remote" data-remote="back" data-testid="remote-back"${disabledIf(backDisabled)}>Back</button>`
    + '</div><button type="button" class="quiet full" data-action="glasses-home">Glasses Home</button>'
    + '<p class="small">The remote works like the glasses: Select opens or turns the page, Back returns to the list.</p></details></section>'
    + (firstRun
      ? '<section class="card"><h2>Get started</h2><p>Add a Substack publication by link, custom domain, @handle or name. It then appears on the glasses.</p>'
        + '<button type="button" class="full" data-panel="publications">Add a publication</button></section>'
      : '')
    + '<div class="source-grid">'
    + `<button type="button" class="source-card" data-panel="publications" data-testid="count-publications"><strong>Publications</strong><span>${state.publications.length} followed</span></button>`
    + `<button type="button" class="source-card" data-panel="saved" data-testid="count-saved"><strong>Saved</strong><span>${state.saved.length} for later</span></button>`
    + '</div>'
    + '<section class="card"><h2>On the glasses</h2><ul class="gestures">'
    + '<li><strong>Swipe down</strong> next item or page</li>'
    + '<li><strong>Swipe up</strong> previous item or page</li>'
    + '<li><strong>Tap</strong> open, or next page while reading</li>'
    + '<li><strong>Double-tap</strong> back; on Home it opens the exit dialog</li>'
    + '<li><strong>Hold</strong> the menu: Home, Save for later, Next post, Restart post, Refresh</li>'
    + '</ul><p class="small">Free posts show in full. Paid posts show the public preview only.</p></section>'
}

function renderCard(card: AddCard, model: PhoneModel): string {
  const { state } = model
  const label = `<span class="result-label">${esc(card.label)}</span>`
  switch (card.kind) {
    case 'pending':
      return `<div class="result pending" data-testid="add-result" data-kind="pending">${label}<span>Checking&hellip;</span></div>`
    case 'message':
      return `<div class="result ${card.tone}" data-testid="add-result" data-kind="message">${label}<span>${esc(card.text)}</span></div>`
    case 'invalid':
      return `<div class="result warn" data-testid="add-result" data-kind="invalid">${label}<span>${esc(card.text)}</span></div>`
    case 'error':
      return `<div class="result error" data-testid="add-result" data-kind="error">${label}<span>${esc(card.text)} <span class="code">${esc(card.code)}</span></span>`
        + `<div class="row-actions"><button type="button" class="secondary" data-action="retry-card" data-card="${card.id}"${disabledIf(model.busy)}>Retry</button></div></div>`
    case 'post': {
      const post = card.post
      const pub = card.publication
      const pubHost = pub?.host ?? card.host
      const pubName = pub?.name || card.host
      const saved = isSaved(state, { postId: post.id, host: card.host, slug: post.slug })
      const meta = [esc(pubName), esc(dateLabel(post.postDate)), post.isPaywalled ? 'Paid' : ''].filter(Boolean).join(DOT)
      const follow = isFollowing(state, pubHost)
        ? `<button type="button" class="secondary" disabled>Following ${esc(pubName)}</button>`
        : `<button type="button" class="secondary" data-action="follow" data-card="${card.id}" data-host="${esc(pubHost)}">Follow ${esc(pubName)}</button>`
      return `<div class="result post" data-testid="add-result" data-kind="post" data-post-id="${post.id}">${label}`
        + `<strong>${esc(post.title)}</strong><span class="small">${meta}</span><div class="row-actions">${follow}`
        + `<button type="button" class="toggle" data-action="save-post" data-card="${card.id}"${pressed(saved)}>${saved ? 'Saved for glasses' : 'Save post for glasses'}</button></div></div>`
    }
    case 'profile': {
      const profile = card.profile
      const entries: { pub: PubMeta; primary: boolean }[] = []
      if (profile.primaryPublication) entries.push({ pub: profile.primaryPublication, primary: true })
      for (const pub of profile.subscriptions) {
        if (!entries.some(entry => entry.pub.host === pub.host)) entries.push({ pub, primary: false })
      }
      const choosable = entries.filter(entry => !isFollowing(state, entry.pub.host))
      const picked = card.picks.filter(host => choosable.some(entry => entry.pub.host === host)).length
      const rows = entries.map(({ pub, primary }) => {
        const following = isFollowing(state, pub.host)
        const checked = following || card.picks.includes(pub.host)
        return `<label class="check"><input type="checkbox" data-pick="${card.id}" value="${esc(pub.host)}"${checked ? ' checked' : ''}${disabledIf(following)}>`
          + `<span><strong>${esc(pub.name)}</strong><span class="small">${esc(pub.host)}${primary ? DOT + 'their publication' : ''}${following ? DOT + 'following' : ''}</span></span></label>`
      }).join('')
      return `<div class="result profile" data-testid="add-result" data-kind="profile">${label}`
        + `<strong>${esc(profile.name)} (@${esc(profile.handle)})</strong>`
        + (entries.length
          ? `<p class="small">Their publication and public subscriptions. Choose what to follow.</p><div class="checks">${rows}</div>`
            + '<div class="row-actions">'
            + `<button type="button" class="secondary" data-action="pick-all" data-card="${card.id}"${disabledIf(!choosable.length)}>Select all</button>`
            + `<button type="button" data-action="follow-selected" data-card="${card.id}"${disabledIf(!picked)}>Follow selected (${picked})</button></div>`
          : '<p class="small">No public publications or subscriptions.</p>')
        + '</div>'
    }
    case 'search': {
      const rows = card.results.map(pub => {
        const following = isFollowing(state, pub.host)
        return `<div class="search-row" data-search-host="${esc(pub.host)}"><span><strong>${esc(pub.name)}</strong><span class="small">${esc(pub.host)}</span></span>`
          + (following
            ? '<button type="button" class="secondary" disabled>Following</button>'
            : `<button type="button" class="secondary" data-action="follow" data-card="${card.id}" data-host="${esc(pub.host)}">Follow</button>`)
          + '</div>'
      }).join('')
      return `<div class="result search" data-testid="add-result" data-kind="search">${label}`
        + (rows || '<p class="small">No publications found. Try another name, or paste a link.</p>') + '</div>'
    }
  }
}

function renderPublications(model: PhoneModel): string {
  const { state } = model
  const list = state.publications
  const rows = list.map((pub, index) => `<div class="row" data-pub-row="${esc(pub.host)}">`
    + `<div class="row-main"><strong>${esc(pub.name)}</strong><span class="small">${esc(pub.host)}</span></div>`
    + '<div class="row-actions">'
    + `<button type="button" class="secondary" data-action="browse" data-host="${esc(pub.host)}">Browse</button>`
    + `<button type="button" class="toggle" data-action="pub-latest" data-host="${esc(pub.host)}"${pressed(pub.inLatest)}>In Latest</button>`
    + `<button type="button" class="icon secondary" data-action="pub-up" data-host="${esc(pub.host)}" aria-label="Move ${esc(pub.name)} up"${disabledIf(index === 0)}>&uarr;</button>`
    + `<button type="button" class="icon secondary" data-action="pub-down" data-host="${esc(pub.host)}" aria-label="Move ${esc(pub.name)} down"${disabledIf(index === list.length - 1)}>&darr;</button>`
    + `<button type="button" class="quiet remove" data-action="pub-remove" data-host="${esc(pub.host)}">Remove</button>`
    + '</div></div>').join('')
  return '<section class="intro compact"><h1>Publications</h1><p>Follow publications to read them on the glasses. Order here is the order on the glasses.</p></section>'
    + '<section class="card"><form id="add-form" novalidate>'
    + '<label for="add-input">Paste a Substack link, a custom domain, an @handle, or search by name</label>'
    + '<textarea id="add-input" name="add" data-draft rows="3" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="65536" '
    + 'placeholder="https://name.substack.com&#10;@handle&#10;economics newsletter"></textarea>'
    + '<p class="small">One per line. Post links work too: you can follow the publication or save the post.</p>'
    + `<button type="submit" data-testid="add-submit"${disabledIf(model.busy)}>Add</button></form>`
    + (model.addCards.length
      ? `<div class="results" data-testid="add-results">${model.addCards.map(card => renderCard(card, model)).join('')}`
        + '<button type="button" class="quiet" data-action="clear-results">Clear results</button></div>'
      : '')
    + '</section>'
    + `<section class="card" data-testid="pub-list"><h2>Following (${list.length}/${LIMITS.publications})</h2>`
    + (rows || '<p>No publications yet. Add one above.</p>')
    + '<p class="small">In Latest: the glasses Latest list merges the newest posts of these publications.</p></section>'
}

function postMetaHtml(post: PostSummary): string {
  return [
    esc(dateLabel(post.postDate)),
    post.wordcount ? `${minutesFor(post.wordcount)} min` : '',
    post.type === 'podcast' ? 'Podcast' : '',
    post.isPaywalled ? '<span class="paid">Paid</span>' : '',
  ].filter(Boolean).join(DOT)
}

function renderBrowse(model: PhoneModel): string {
  const browse = model.browse
  const back = '<nav class="toolbar"><button type="button" class="quiet" data-panel="publications">&larr; Publications</button></nav>'
  if (!browse) return `${back}<section class="card"><p>Choose a publication to browse.</p></section>`
  const rows = browse.posts.map(post => {
    const saved = isSaved(model.state, { postId: post.id, host: browse.host, slug: post.slug })
    return `<div class="row post-row" data-post-row="${post.id}"><div class="row-main"><strong>${esc(post.title)}</strong>`
      + `<span class="small">${postMetaHtml(post)}</span></div><div class="row-actions">`
      + `<button type="button" class="toggle" data-action="toggle-save" data-post-id="${post.id}"${pressed(saved)}>${saved ? 'Saved for glasses' : 'Save for glasses'}</button>`
      + `<button type="button" class="secondary" data-action="copy-link" data-url="${esc(post.canonicalUrl)}">Copy link</button>`
      + '</div></div>'
  }).join('')
  return back
    + `<section class="intro compact"><h1>${esc(browse.name)}</h1><p>${esc(browse.host)}</p></section>`
    + `<section class="card" data-testid="browse-list">`
    + (rows || (browse.loaded ? '<p>No posts yet.</p>' : '<p class="small">Loading posts&hellip;</p>'))
    + (browse.nextOffset !== null && browse.loaded
      ? `<button type="button" class="secondary full" data-action="browse-more" data-testid="browse-more"${disabledIf(model.busy)}>Load older</button>`
      : '')
    + '</section>'
}

function savedMeta(model: PhoneModel, ref: PostRef): string {
  const parts = [esc(ref.pubName), esc(dateLabel(ref.postDate))]
  if (ref.isPaywalled) parts.push('<span class="paid">Paid</span>')
  const position = positionOf(model.state, ref.postId)
  if (position && position.page < position.pages) parts.push(esc(pctString((position.page + 1) / position.pages)))
  else if (isRead(model.state, ref.postId)) parts.push('Read')
  return parts.filter(Boolean).join(DOT)
}

function renderSaved(model: PhoneModel): string {
  const list = model.state.saved
  const rows = list.map((ref, index) => {
    const key = refKey(ref)
    const url = postUrl(ref)
    return `<div class="row" data-saved-row="${esc(key)}"><div class="row-main"><strong>${esc(ref.title)}</strong><span class="small">${savedMeta(model, ref)}</span></div>`
      + '<div class="row-actions">'
      + `<button type="button" class="icon secondary" data-action="saved-up" data-key="${esc(key)}" aria-label="Move up"${disabledIf(index === 0)}>&uarr;</button>`
      + `<button type="button" class="icon secondary" data-action="saved-down" data-key="${esc(key)}" aria-label="Move down"${disabledIf(index === list.length - 1)}>&darr;</button>`
      + (url ? `<button type="button" class="secondary" data-action="copy-link" data-url="${esc(url)}">Copy link</button>` : '')
      + `<button type="button" class="quiet remove" data-action="saved-remove" data-key="${esc(key)}">Remove</button>`
      + '</div></div>'
  }).join('')
  return '<section class="intro compact"><h1>Saved</h1><p>Posts saved here appear under Saved on the glasses, in this order.</p></section>'
    + `<section class="card" data-testid="saved-list"><h2>Saved posts (${list.length}/${LIMITS.saved})</h2>`
    + (rows || '<p>Nothing saved yet. Browse a publication and choose Save for glasses, or use Save for later in the glasses menu.</p>')
    + '</section>'
}

function segmented(key: string, label: string, current: string, options: readonly (readonly [string, string])[]): string {
  return `<div class="setting"><span class="setting-label" id="label-${key}">${label}</span><div class="seg" role="group" aria-labelledby="label-${key}">`
    + options.map(([value, text]) => `<button type="button" data-action="set" data-key="${key}" data-value="${value}"${pressed(current === value)}>${text}</button>`).join('')
    + '</div></div>'
}

function toggle(key: string, label: string, value: boolean, hint = ''): string {
  return `<div class="setting setting-inline"><span class="setting-label">${label}${hint ? `<span class="small">${hint}</span>` : ''}</span>`
    + `<button type="button" class="toggle switch" data-action="set" data-key="${key}" data-value="${value ? 'false' : 'true'}"${pressed(value)}>${value ? 'On' : 'Off'}</button></div>`
}

function renderSettings(model: PhoneModel): string {
  const s = model.state.settings
  const enabled = s.homeItems
  const disabled = HOME_ITEM_IDS.filter(id => !enabled.includes(id))
  const homeRows = enabled.map((id, index) => `<div class="row compact" data-home-row="${id}"><div class="row-main"><strong>${index + 1}. ${HOME_ITEM_LABELS[id]}</strong></div><div class="row-actions">`
    + `<button type="button" class="icon secondary" data-action="home-up" data-item="${id}" aria-label="Move ${HOME_ITEM_LABELS[id]} up"${disabledIf(index === 0)}>&uarr;</button>`
    + `<button type="button" class="icon secondary" data-action="home-down" data-item="${id}" aria-label="Move ${HOME_ITEM_LABELS[id]} down"${disabledIf(index === enabled.length - 1)}>&darr;</button>`
    + `<button type="button" class="quiet remove" data-action="home-item" data-item="${id}"${disabledIf(enabled.length <= 1)}>Hide</button></div></div>`).join('')
    + disabled.map(id => `<div class="row compact" data-home-row="${id}" data-hidden="true"><div class="row-main"><span>${HOME_ITEM_LABELS[id]} (hidden)</span></div><div class="row-actions">`
      + `<button type="button" class="secondary" data-action="home-item" data-item="${id}">Show</button></div></div>`).join('')
  const confirm = (kind: 'clear-reading' | 'reset-settings', label: string, question: string, yes: string) => model.confirm === kind
    ? `<div class="confirm" role="group" aria-label="${question}"><p>${question}</p><div class="row-actions">`
      + `<button type="button" class="danger" data-action="${kind}-confirm">${yes}</button>`
      + '<button type="button" class="secondary" data-action="confirm-cancel">Cancel</button></div></div>'
    : `<button type="button" class="secondary full" data-action="${kind}">${label}</button>`
  return '<section class="intro compact"><h1>Settings</h1><p>Changes apply right away and are saved on this phone.</p></section>'
    + '<section class="card"><h2>Reading on the glasses</h2>'
    + segmented('linesPerPage', 'Lines per page', String(s.linesPerPage), [['7', '7'], ['6', '6'], ['5', '5']])
    + '<p class="small">Changing this keeps your place in the open post.</p>'
    + segmented('tapInReader', 'Tap while reading', s.tapInReader, [['next', 'Next page'], ['none', 'Nothing']])
    + toggle('invertSwipe', 'Invert swipe direction', s.invertSwipe, 'Swipe up for the next page.')
    + '</section>'
    + '<section class="card"><h2>Article text</h2>'
    + segmented('bareImages', 'Images without captions', s.bareImages, [['drop', 'Hide'], ['placeholder', 'Show [Image]']])
    + segmented('footnotes', 'Footnotes', s.footnotes, [['end', 'At end'], ['inline', 'Inline'], ['omit', 'Hidden']])
    + toggle('uppercaseHeadings', 'Uppercase short headings', s.uppercaseHeadings)
    + toggle('stripEmoji', 'Remove emoji', s.stripEmoji)
    + '<p class="small">Text settings apply the next time a post opens.</p></section>'
    + `<section class="card"><h2>Glasses Home</h2><div data-testid="home-items">${homeRows}</div>`
    + '<div class="setting setting-inline"><span class="setting-label" id="label-latest-max">Latest: publications included<span class="small">The first ones marked In Latest, in list order.</span></span>'
    + '<div class="stepper" role="group" aria-labelledby="label-latest-max">'
    + `<button type="button" class="icon secondary" data-action="latest-max" data-delta="-1" aria-label="Fewer"${disabledIf(s.latestMaxPublications <= LATEST_MAX_PUBLICATIONS_RANGE.min)}>&minus;</button>`
    + `<output data-testid="latest-max">${s.latestMaxPublications}</output>`
    + `<button type="button" class="icon secondary" data-action="latest-max" data-delta="1" aria-label="More"${disabledIf(s.latestMaxPublications >= LATEST_MAX_PUBLICATIONS_RANGE.max)}>+</button>`
    + '</div></div></section>'
    + '<section class="card"><h2>Reset</h2>'
    + confirm('clear-reading', 'Clear reading history and positions', 'Clear history, read marks and reading positions?', 'Yes, clear')
    + confirm('reset-settings', 'Reset settings to defaults', 'Reset every setting on this page?', 'Yes, reset')
    + '<p class="small">Publications and saved posts are kept.</p></section>'
}

function renderHealth(health: HealthResponse | null): string {
  if (!health) return '<p class="small">Not checked yet.</p>'
  const probes = health.probes?.length
    ? '<table class="probes"><thead><tr><th>Probe</th><th>Status</th><th>Type</th><th>ms</th></tr></thead><tbody>'
      + health.probes.map(probe => `<tr><td>${esc(probe.target)}</td><td>${esc(probe.status)}${probe.challenge ? ' (challenge)' : ''}</td><td>${esc(probe.contentType)}</td><td>${esc(probe.ms)}</td></tr>`).join('')
      + '</tbody></table>'
    : '<p class="small">No probes reported.</p>'
  return `<dl class="facts" data-testid="health"><dt>Service</dt><dd>${esc(health.service)}</dd><dt>Protocol</dt><dd>${esc(health.protocol)}</dd>`
    + `<dt>Revision</dt><dd>${esc(health.revision ?? 'unknown')}</dd><dt>WebView origin</dt><dd>${esc(health.origin ?? 'none sent')}</dd></dl>${probes}`
}

function renderDiagnostics(model: PhoneModel): string {
  const sizes = model.storage.sizes
  return '<section class="intro compact"><h1>Diagnostics</h1><p>Technical details for checking a device. Nothing here is sent anywhere.</p></section>'
    + '<section class="card"><h2>App</h2><dl class="facts" data-testid="diag-app">'
    + `<dt>Version</dt><dd>${esc(model.version)}</dd>`
    + `<dt>Reader service</dt><dd>${esc(model.relayOrigin ?? 'Not configured')}</dd>`
    + `<dt>Glasses</dt><dd>${esc(model.link.message)}</dd>`
    + `<dt>Storage</dt><dd data-testid="storage-info">${esc(model.storage.backend)}${DOT}prefs ${sizes.prefs} chars${DOT}progress ${sizes.progress} chars</dd>`
    + `<dt>Last save</dt><dd>${model.saveOk ? 'OK' : 'Failed'}</dd>`
    + `<dt>Last error</dt><dd data-testid="last-error">${esc(model.lastErrorCode || 'none')}</dd></dl></section>`
    + '<section class="card"><h2>Reader service</h2>'
    + `<button type="button" class="full" data-action="check-relay" data-testid="check-relay"${disabledIf(model.busy || !model.relayOrigin)}>Check relay</button>`
    + renderHealth(model.health) + '</section>'
    + '<section class="card"><h2>Glasses events (last 30)</h2><p class="small">Envelope, event type and input source only.</p>'
    + `<ol class="events" id="event-log" data-testid="event-log">${renderEventLog(model.events)}</ol>`
    + '<div class="row-actions"><button type="button" class="secondary" data-action="redraw-glasses">Resend frame</button>'
    + '<button type="button" class="quiet" data-action="clear-events">Clear</button></div></section>'
}

function renderAbout(model: PhoneModel): string {
  let relayHost = ''
  try { relayHost = model.relayOrigin ? new URL(model.relayOrigin).host : '' } catch { relayHost = '' }
  return `<section class="intro compact"><h1>About &amp; privacy</h1><p>${esc(model.appName)} ${esc(model.version)} shows public Substack posts on Even Realities G2 glasses.</p></section>`
    + '<section class="card"><h2>Not affiliated with Substack</h2><p>This is an independent reader. Substack is a trademark of its owner. Posts belong to their authors; use Copy link to read or share the original.</p></section>'
    + '<section class="card"><h2>What you can read</h2><p>Free posts are shown in full. Paid posts show only the public preview that Substack offers to everyone. '
    + 'There is no sign-in, no cookies and no paid content.</p></section>'
    + '<section class="card"><h2>What is stored</h2><p>On this phone only (Even app storage, with a copy in this app&#39;s web storage): your publications, saved posts, settings, '
    + 'reading positions, read marks and history. Article text is never stored; it is kept in memory while the app is open.</p></section>'
    + '<section class="card"><h2>Network</h2><p>'
    + (relayHost
      ? `Posts are fetched through the reader service at <strong>${esc(relayHost)}</strong>. It forwards public requests to Substack and keeps no logs of what you read.`
      : 'This build has no reader service configured, so it makes no network requests.')
    + '</p>'
    + (model.relayOrigin ? `<button type="button" class="secondary full" data-action="copy-link" data-url="${esc(`${model.relayOrigin}/privacy`)}">Copy privacy policy link</button>` : '')
    + '</section>'
}

function renderPanel(model: PhoneModel): string {
  switch (model.panel) {
    case 'home': return renderHome(model)
    case 'publications': return renderPublications(model)
    case 'browse': return renderBrowse(model)
    case 'saved': return renderSaved(model)
    case 'settings': return renderSettings(model)
    case 'diagnostics': return renderDiagnostics(model)
    case 'about': return renderAbout(model)
  }
}

export function renderPhone(model: PhoneModel): string {
  return '<main>'
    + '<header class="topbar">'
    + `<button type="button" class="brand" data-panel="home"><span class="brand-icon">${BRAND_ICON}</span><span>${esc(model.appName)}<small>for Even G2</small></span></button>`
    + `<span class="pill">v${esc(model.version)}</span></header>`
    + `<div class="device-status" data-testid="glasses-status" data-state="${esc(model.link.state)}">${renderStatusInner(model)}</div>`
    + renderTabs(model.panel)
    + `<div id="glasses-live">${renderGlassesLive(model)}</div>`
    + renderMessages(model)
    + `<div class="panel" data-testid="panel-${model.panel}">${renderPanel(model)}</div>`
    + '<footer class="app-footer"><p>Unofficial reader. Not affiliated with Substack.</p><div class="footer-actions">'
    + '<button type="button" class="quiet" data-panel="about">About &amp; privacy</button>'
    + '<button type="button" class="quiet" data-panel="diagnostics">Diagnostics</button></div></footer>'
    + '</main>'
}
