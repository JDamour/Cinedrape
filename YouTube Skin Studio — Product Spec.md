# Cinedrape — Product Spec

Oct 7, 2026 · @JDamour

## Name and domain

Recommended name: **Cinedrape**, at **cinedrape.com**. It means draping a new look over your videos, and theatre drapes evoke cinema. It avoids "YouTube" and "Tube", which keeps the name clear of Google's trademark.

In the store, the listing reads "Cinedrape — themes for YouTube™", with a line saying it is not affiliated with Google. That is the same nominative use established extensions rely on.

| Name | Domain | Status on 7 Oct 2026 | Notes |
| --- | --- | --- | --- |
| **Cinedrape** | cinedrape.com | Unregistered | Recommended. Cinema + drapes; easy to say and spell |
| Cinedress | cinedress.com | Unregistered | Same idea, "dressing" the player; slightly softer |
| VidVogue | vidvogue.com | Unregistered | Fashion angle; suits a theme marketplace |
| Reskin HQ | reskinhq.com | Unregistered | Plain and descriptive; weaker as a brand |
| Vistlayer | vistlayer.com | Unregistered | Abstract; needs explaining |

These were checked in the .com registry's public lookup (RDAP), which returns "not found" for unregistered names. Domains get taken daily, so register your pick today. Names already taken included skinlet, watchskin, reskinly, cinelayer, cinemask, cinevra, veneerly, skinsmith, moodframe and rethemer.

Before committing, run a trademark search in your target markets (USPTO, EUIPO and WIPO's Global Brand Database). That was not checked here. Also grab the matching handles on X, TikTok and GitHub.

## Overview

Cinedrape is a browser extension that restyles and re-lays-out YouTube on desktop. Users pick a complete look in one click, tweak it, and save it, without touching code.

**Problem.** YouTube's desktop page is busy, ad-shaped and the same for everyone. Existing tools offer colour themes buried inside long settings lists, or raw CSS that most people can't write.

**Vision.** Any viewer can make YouTube feel like the streaming service they want, and share that look with others.

### Target users

| Segment | What they want | Pays for |
| --- | --- | --- |
| Aesthetic customizers | A beautiful, personal YouTube; often students and young adults | Premium themes, the editor |
| Focused learners | Fewer distractions while studying or working | Calm mode, hide Shorts and recommendations |
| Binge watchers | A big-screen, cinematic feel on a laptop or monitor | Layout modes, cinema player |
| Theme creators | To design looks and get credit or income | Marketplace payouts (later) |

### Positioning

Full looks, not colour pickers. Competing all-in-one extensions treat themes as one tab among many. Cinedrape makes the look the whole product, with layout changes, a visual editor and shareable themes.

### Goals for the first 6 months

- 10,000 weekly active users
- 2% of active users buy Pro
- A broken theme is fixed within 48 hours of a YouTube change
- Average store rating of 4.5 or higher

### Non-goals

- No ad blocking or skipping. It invites YouTube enforcement and store policy problems.
- No downloading videos.
- No mobile apps or TV apps. Extensions don't run there.
- No official look-alikes of other services. No other brands' names, logos or exact layouts.

## Feature specs

The MVP is six features: the engine, launch themes, layout modes, quick settings, calm mode and breakage detection. Everything else waits until the validation targets are met.

| # | Feature | Priority | Tier | What it does | Done when |
| --- | --- | --- | --- | --- | --- |
| F1 | Theme engine | P0 · MVP | All | Applies a theme file: colour and type tokens, layout options and scoped CSS | Switching themes takes under 150 ms with no page reload |
| F2 | Launch themes | P0 · MVP | 3 free, 3 Pro | Cinema, Minimal and Classic are free. Prime Time, Studio and Arcade are Pro | Each theme covers home, watch, search, channel and subscriptions pages |
| F3 | Layout modes | P0 · MVP | Pro | Home as a hero banner plus horizontal rows; cinematic watch page; density from compact to roomy | Rows scroll by keyboard and mouse; the player stays YouTube's own |
| F4 | Quick settings popup | P0 · MVP | All | Theme switcher, accent colour, density, animations on or off | Any change is visible in the open tab within 1 second |
| F5 | Calm mode | P0 · MVP | Free basic, Pro full | Toggles to hide Shorts, home recommendations, comments, end screens and view counts | Each toggle works on its own and survives page navigation |
| F6 | Breakage detection | P0 · MVP | All | Checks that every element a theme targets exists; turns off only the broken part and shows a notice | A YouTube change never leaves a blank or unusable page |
| F7 | Theme editor | P1 · v1.1 | Pro | Visual editor with live preview: colours, fonts, corner radius, card style, layout choices | A user builds and saves a theme without writing CSS |
| F8 | Profiles and schedule | P1 · v1.1 | Pro | Several saved looks; switch by time of day or by hand | Schedule switches within 1 minute of the set time |
| F9 | Import, export, share | P1 · v1.1 | All | Export a theme as a file or share code; import one in two clicks | An imported theme looks the same on another machine |
| F10 | Sync | P1 · v1.1 | Pro | Themes and settings follow the user across browsers via their account | A change appears on a second device within 1 minute |
| F11 | AI theme generator | P2 · later | Credits | User describes a look in words; gets a theme file to preview, edit and save | 9 of 10 generated themes pass validation and render cleanly |
| F12 | Theme marketplace | P2 · later | All browse, creators sell | Browse, rate, buy and install community themes; creators earn 70% | Every listed theme passes automated review before going live |

### Pages each theme must cover

Home, watch page (normal, theatre and fullscreen), search results, channel page, subscriptions, history and playlists. Pages a theme does not style fall back to YouTube's default look rather than breaking.

### Launch theme briefs

- **Cinema** (free): near-black, large hero banner, poster-like cards, minimal chrome around the player.
- **Minimal** (free): white or grey, generous spacing, no hover previews on thumbnails, quiet type.
- **Classic** (free): a nostalgic, compact look in the spirit of early 2010s video sites, using original artwork.
- **Prime Time** (Pro): deep blue, bold rows by category, large "continue watching" strip.
- **Studio** (Pro): light, airy, premium serif headings, wide margins.
- **Arcade** (Pro): dark with neon accents, dense grid, gaming-style cards.

## Technical architecture

All logic ships inside a Manifest V3 extension; the server only stores data and runs the AI. The piece that decides survival is the selector map: YouTube's element names live in a data file the server can update within hours, without a new store release.

### Extension components

| Component | Runs in | Job |
| --- | --- | --- |
| Content script | YouTube tab | Loads the active theme, injects CSS, mounts layout renderers, watches page navigation |
| Token layer | YouTube tab | Turns theme tokens into CSS custom properties on the page root |
| Layout renderers | YouTube tab | Build Cinedrape's own rows, hero and cinema views from video tiles already on the page |
| Selector map + health check | YouTube tab | Finds YouTube elements by named roles; reports which roles are missing |
| Service worker | Background | Licence checks, sync, schedule timers, fetching selector map updates |
| Popup | Toolbar | Quick settings and theme switcher |
| Editor page | Extension tab | Visual theme editor with a live preview iframe |

### How layouts get video data

Layout renderers read titles, thumbnails and links from tiles YouTube has already drawn, then place them in Cinedrape's own containers. The extension never calls YouTube's private APIs and never scrapes in the background. Clicks go to YouTube's own links, so watch history and recommendations keep working.

### Selector map

- Every YouTube element a theme touches is named by role, for example `homeGrid`, `videoTile` or `watchPlayer`, with 2 to 3 fallback selectors each.
- The map is a signed JSON file, bundled with each release and refreshed from the server every 6 hours.
- When a role finds nothing, the health check turns off only the features using it and logs an anonymous error count.
- A dashboard alerts the developer when error counts jump, which is the signal YouTube shipped a change.

### Backend

| Part | Choice | Notes |
| --- | --- | --- |
| API | Serverless functions (for example Cloudflare Workers) | Cheap at low volume; no servers to run |
| Database | Managed Postgres or SQLite at the edge | Users, licences, themes, credit ledger |
| File storage | Object storage | Theme files and preview images |
| Sign-in | Email magic link | Needed only for Pro, sync and marketplace; free use needs no account |
| Payments | Merchant-of-record service | Handles global sales tax; sends a webhook that creates the licence |

### AI generation pipeline

1. The user types a description in the editor; the extension sends it with their licence token.
2. The server checks and deducts one credit, then asks the language model for a theme in the JSON schema, using structured output.
3. The server runs the schema check and CSS validator; on failure it retries once, then refunds the credit.
4. The theme comes back as data, opens in the editor as a preview, and is saved only if the user chooses.

### Data model

| Table | Key fields |
| --- | --- |
| users | id, email, created\_at |
| licences | user\_id, plan, status, purchased\_at, source\_order\_id |
| themes | id, owner\_id, name, json, visibility, price, installs, rating |
| credit\_ledger | user\_id, change, reason, created\_at |
| purchases | id, buyer\_id, theme\_id, amount, creator\_share |

### Permissions requested

- `storage` for settings and themes; `alarms` for the schedule.
- Host access to `https://www.youtube.com/*` only. No access to other sites, tabs or browsing history.
- Fewer permissions mean faster store review and more trust at install time.

## Theme format

A theme is a JSON file of data, never code. That one rule makes AI-generated and community themes safe to load, and keeps the extension within Chrome Web Store rules on remote code.

The extension holds all the logic. A theme only picks values: design tokens, choices from a fixed menu of layout options, and optional CSS limited to a safe subset.

### Fields

| Field | Type | Required | Purpose |
| --- | --- | --- | --- |
| `schema` | integer | Yes | Format version, starting at 1; the engine migrates older files |
| `id`, `name`, `author`, `version` | strings | Yes | Identity and display; `id` is a slug |
| `tier` | `free` or `pro` | Yes | Whether a Pro license is needed to apply it |
| `tokens.color` | map of colour values | Yes | Background, surface, text, muted text, accent, border |
| `tokens.type` | object | Yes | Font family (from a bundled list), base size, heading weight |
| `tokens.shape` | object | No | Corner radius, card shadow on or off, spacing scale |
| `layout.home` | `grid`, `rows` or `hero-rows` | No | How the home page is arranged |
| `layout.watch` | `default`, `cinema` or `focus` | No | Watch page arrangement |
| `layout.density` | 1 to 5 | No | Compact to roomy |
| `calm` | map of booleans | No | Default calm-mode toggles this theme turns on |
| `css` | string, max 20 KB | No | Extra styling; checked by the CSS validator below |

### Example

```json
{
  "schema": 1,
  "id": "cinema",
  "name": "Cinema",
  "author": "Cinedrape",
  "version": "1.0.0",
  "tier": "free",
  "tokens": {
    "color": { "bg": "#0b0b0f", "surface": "#16161d", "text": "#f2f2f5", "muted": "#9a9aa8", "accent": "#e8b04a", "border": "#26262f" },
    "type": { "family": "Inter", "baseSize": 14, "headingWeight": 700 },
    "shape": { "radius": 10, "shadow": true, "spacing": 3 }
  },
  "layout": { "home": "hero-rows", "watch": "cinema", "density": 3 },
  "calm": { "hideShorts": false, "hideComments": false },
  "css": ".cd-hero h1 { letter-spacing: -0.02em; }"
}
```

### CSS validator rules

- Selectors may only target Cinedrape's own class names (prefixed `cd-`) or YouTube elements listed in the selector map.
- Blocked: `@import`, `url()` pointing outside the extension, `expression()`, and `content` values over 100 characters.
- Blocked: hiding or covering YouTube's ads, sponsorship labels or the player's own controls.
- A theme that fails validation is refused with a message naming the line.

## Monetization and licensing

Free to install, one-time Pro licence, pay-per-use AI credits, and a marketplace cut later. Launch price is $19 lifetime, with a $12 early-bird price for the waitlist.

| Tier | Price | Includes |
| --- | --- | --- |
| Free | $0 | Cinema, Minimal and Classic; quick settings; basic calm mode (hide Shorts, hide home recommendations); import of free themes |
| Pro | $19 one-time ($12 early bird) | All themes and layout modes, full calm mode, theme editor, profiles and schedule, sync, 10 AI credits |
| AI credits | $4 for 20 | Extra AI theme generations; credits never expire |
| Pro+ (optional, later) | $3 a month | 30 AI credits a month plus early access to new themes |
| Marketplace | Creator sets price, $1 to $5 | Creator gets 70%, Cinedrape keeps 30% to cover payments and review |

### Licence checks

- After purchase, the payment webhook creates a licence; the user signs in once and the extension stores a signed token.
- The extension re-checks the licence weekly and works offline for up to 30 days between checks.
- Pro themes and layouts are bundled in the extension and unlocked by the token. Accept that a determined user can bypass this; don't spend time on stronger copy protection.
- One licence covers up to 3 browsers.

### Payments

- Use a merchant-of-record service so it handles VAT and sales tax worldwide.
- Confirm the provider pays out to your country and bank before building checkout.
- Offer a 14-day refund, no questions asked. It lowers purchase anxiety and costs little for a digital product.

### Revenue model at 3 scales (illustrative)

| Weekly active users | Pro buyers at 2% | Licence revenue at $19 | Plus credits (estimate) |
| --- | --- | --- | --- |
| 10,000 | 200 | $3,800 | \~$400 |
| 50,000 | 1,000 | $19,000 | \~$2,000 |
| 200,000 | 4,000 | $76,000 | \~$8,000 |

The 2% conversion rate is a rough rule of thumb for freemium extensions, not measured data. Replace it with your real rate after the paywall test.

## Non-functional requirements

Cinedrape must never make YouTube slower, less private or less usable than it was without it.

### Performance budgets

| Measure | Budget |
| --- | --- |
| Extra time before YouTube's first paint | Under 50 ms |
| Theme switch, no reload | Under 150 ms |
| Content script size | Under 150 KB compressed |
| Extra memory per YouTube tab | Under 30 MB |
| Dropped frames while scrolling rows | None visible on a mid-range laptop |

CSS is applied at document start so pages never flash the old look. Layout renderers react to page navigation events rather than polling.

### Privacy

- No account needed for free use; no data leaves the browser.
- Never collect watch history, search terms or video IDs.
- Telemetry is opt-in, anonymous and limited to error counts per selector role and theme ID.
- A short, plain privacy policy, and store disclosures that match it exactly.

### Security

- No remote code: themes are data, checked by a schema and a CSS validator.
- The selector map is signed; the extension rejects an unsigned or tampered file.
- Licence tokens are signed by the server and checked locally.
- Marketplace themes go through automated checks, plus manual review for the first 100 listings.

### Accessibility

- Every theme meets WCAG 2.2 AA colour contrast for text; the editor warns when a choice fails.
- Rows and the hero work with keyboard alone, with visible focus.
- Respect the system's reduced-motion setting.
- The popup and editor work with screen readers.

### Compliance and trademark rules

- Never use other companies' names, logos or exact layouts in themes, screenshots or listings.
- Refer to YouTube only to say what the extension works with, and state it is not affiliated with Google.
- Never hide, skip or cover ads or sponsorship disclosures.
- Marketplace terms: creators confirm they own their artwork; takedown requests handled within 72 hours.
- Follow Chrome Web Store rules: single clear purpose, minimal permissions, accurate listing.

## Roadmap and metrics

Four phases over about 8 months, each ending at a gate. Miss a gate and you fix or stop before building the next phase.

&#91;embedded content: roadmap · 4 phases, 3 gates\]

Phase 0 is where you start: a free theme and a waitlist, before building the paid product.

### Metrics to track weekly

| Metric | Target |
| --- | --- |
| Weekly active users | 10,000 by month 6 |
| Install to first theme applied | 70% or more |
| Week-4 retention | 35% or more |
| Free to Pro conversion | 2% or more of weekly active users |
| Hours from YouTube change to fix | Under 48 |
| Store rating | 4.5 or higher |
| Refund rate | Under 5% |

### Kill criteria

- Fewer than 1,000 installs and under 5% waitlist sign-ups after phase 0: rethink positioning or stop.
- Under 0.5% conversion after 8 weeks of Pro: the audience likes it but won't pay; try calm mode as the main product.
- YouTube breaks layouts more than twice a month for 3 months: drop layout modes, keep colour themes and calm mode.

### Risks

| Risk | Likelihood | Impact | Response |
| --- | --- | --- | --- |
| YouTube page changes break themes | High | High | Selector map updates, health check, fallback to default look |
| Free tools copy the best themes | High | Medium | Ship themes and editor fast; build a creator community |
| Low willingness to pay for looks | Medium | High | Lead with calm mode; test prices; early-bird pricing |
| Store rejection or takedown | Low | High | Minimal permissions, no remote code, no ad tampering, careful listing |
| Trademark complaint | Low | Medium | No other brands' names or logos; trademark search before launch |
| AI costs exceed credit revenue | Low | Medium | Charge per generation; cap retries; use a small model first |
