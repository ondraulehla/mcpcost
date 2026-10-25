/**
 * The social preview cards: 1200x630 PNGs under public/og/, the picture that X, LinkedIn, Reddit, Slack and
 * Discord show with a shared link. scripts/og.ts draws them from this list (npm run og -w site), and the layout
 * puts the card of a page in og:image; a page with no card of its own gets the default card. The PNGs are
 * static files, served without the Worker. A card has no daily numbers, so it does not go out of date.
 */

/** The image of a page in og:image: its card, or an image that the page gives the layout. */
export interface Preview {
  /** A path of the site or an absolute URL. */
  src: string;
  /** What the image says, for og:image:alt. */
  alt: string;
  /** The size in pixels; without it, the size of a card. */
  width?: number;
  height?: number;
}

export interface Card {
  /** The page the card is for. Its address is at the foot of the card. */
  path: string;
  /** The PNG, as a path of the site. */
  src: string;
  /** What the card says, for og:image:alt. */
  alt: string;
  /** The small line in capitals above the title. */
  kicker: string;
  /** The title in the poster face, one string a line. */
  title: string[];
  /** The style of the home page: the title in ink and its last line in the accent. Without it, the whole title is in the accent, like the h1 of a page. */
  hero?: boolean;
  /** One line under the title. */
  lede?: string;
}

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/** The card of the home page, and of every page that has no card of its own. */
export const DEFAULT_CARD: Card = {
  path: '/',
  src: '/og/default.png',
  alt: 'mcpcost: Is that MCP server alive, and what does it cost your context window? mcpcost.ulehla.dev',
  kicker: 'Every server in the MCP registry, probed each day',
  title: ['Is that MCP server alive,', 'and what does it cost', 'your context window?'],
  hero: true
};

export const CARDS: Card[] = [
  DEFAULT_CARD,
  {
    path: '/report/2026-10',
    src: '/og/report-2026-10.png',
    alt: 'mcpcost report: The state of the MCP registry, October 2026',
    kicker: 'Monthly report',
    title: ['The state of', 'the MCP registry,', 'October 2026'],
    lede: 'Health, token cost, auth and protocols, with an open dataset.'
  },
  {
    path: '/compare',
    src: '/og/compare.png',
    alt: 'mcpcost: Compare MCP servers side by side',
    kicker: 'Compare',
    title: ['MCP servers', 'side by side'],
    lede: 'Two to five servers: status, access, tools, token cost, latency.'
  },
  {
    path: '/statistics',
    src: '/og/statistics.png',
    alt: 'mcpcost: MCP registry statistics',
    kicker: 'Statistics',
    title: ['MCP registry', 'statistics'],
    lede: 'Results, token costs, protocols, auth and publishers of every server.'
  }
];

/** The card of a page: its own card, else the default card. */
export function cardFor(path: string): Card {
  return CARDS.find((c) => c.path === path) ?? DEFAULT_CARD;
}
