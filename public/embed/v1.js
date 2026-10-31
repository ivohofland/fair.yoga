const ELEMENT_NAME = 'fair-yoga-schedule';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const START_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LIMIT_PATTERN = /^[1-9]\d*$/;
const LOAD_EVENT = 'fair-yoga-schedule:load';
const ERROR_EVENT = 'fair-yoga-schedule:error';
const SR_ONLY = 'position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;';
const HOST_CSS = `
:host { display: block; }
:host([data-state="loading"]) { min-height: 6rem; }
`;
const CSS = `${HOST_CSS}
.fy {
  --fy-a: var(--fy-accent, #1A5653);
  --fy-ink: #2D2D2D; --fy-muted: #71645A; --fy-card: #F0E9DC; --fy-line: #D4C9B8;
  --fy-wait: #7A6739; --fy-wait-line: #C4A96A; --fy-wait-bg: #F3ECDC;
  font-family: var(--fy-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 15px; line-height: 1.45; color: var(--fy-muted);
}
.fy[data-scheme="dark"] {
  --fy-a: var(--fy-accent, #8cc5c0);
  --fy-ink: #efe9df; --fy-muted: #b4aa9e; --fy-card: #28302f; --fy-line: #3a4544;
  --fy-wait: #d8c08a; --fy-wait-line: #d8c08a; --fy-wait-bg: transparent;
}
@media (prefers-color-scheme: dark) {
  .fy[data-scheme="auto"] {
    --fy-a: var(--fy-accent, #8cc5c0);
    --fy-ink: #efe9df; --fy-muted: #b4aa9e; --fy-card: #28302f; --fy-line: #3a4544;
    --fy-wait: #d8c08a; --fy-wait-line: #d8c08a; --fy-wait-bg: transparent;
  }
}
.fy ol { list-style: none; margin: 0; padding: 0; }
.fy-day-heading { font-family: Georgia, serif; font-weight: bold; color: var(--fy-ink); font-size: 15px; margin: 14px 0 6px; }
.fy-day:first-child .fy-day-heading { margin-top: 0; }
.fy-class { display: flex; align-items: center; gap: 12px; background: var(--fy-card); border: 1px solid var(--fy-line); border-radius: 14px; padding: 12px 14px; margin-bottom: 8px; }
.fy-class.fy-studio { background: transparent; border-style: dashed; }
.fy-time { font-variant-numeric: tabular-nums; color: var(--fy-a); font-weight: 600; white-space: nowrap; flex: none; }
.fy-main { flex: 1; min-width: 0; }
.fy-type { display: block; color: var(--fy-ink); font-weight: 600; overflow-wrap: anywhere; }
.fy-meta { display: block; font-size: 12.5px; color: var(--fy-muted); overflow-wrap: anywhere; }
.fy-cta { flex: none; font-size: 13px; font-weight: 600; color: var(--fy-a); border: 1px solid var(--fy-a); border-radius: 10px; padding: 6px 10px; white-space: nowrap; text-decoration: none; }
.fy-cta.fy-wait { color: var(--fy-wait); border-color: var(--fy-wait-line); background: var(--fy-wait-bg); }
.fy-studio .fy-cta { border-style: dashed; }
.fy-cta:focus-visible, .fy-footer a:focus-visible { outline: 2px solid var(--fy-a); outline-offset: 2px; }
.fy-empty { margin: 0; color: var(--fy-muted); }
.fy-footer { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4px 14px; margin: 10px 0 0; font-size: 11.5px; color: var(--fy-muted); }
.fy-footer a { color: inherit; }
.fy-credit { text-decoration: none; }
.fy-wordmark { font-family: Georgia, serif; font-size: 12.5px; }
.fy-dot { color: var(--fy-a); font-size: 15px; font-weight: bold; }
.fy-sr { ${SR_ONLY} }
`;
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
function linkable(url, origin) {
    if (url === null)
        return null;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return null;
    }
    if (parsed.protocol === 'https:' || parsed.origin === origin)
        return parsed.href;
    return null;
}
function newTabLink(href, className) {
    const a = el('a', className);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
}
function appendNewTabNote(a) {
    const note = el('span', 'fy-sr fy-new-tab', ' (opens in a new tab)');
    note.style.cssText = SR_ONLY;
    a.append(note);
}
function dayHeading(start) {
    const [y, m, d] = start.slice(0, 10).split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}
function timeRange(c) {
    const start = c.start.slice(11, 16);
    const minutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)) + c.durationMinutes;
    if (!Number.isFinite(minutes))
        throw new Error('Malformed duration in schedule data');
    const end = ((Math.round(minutes) % 1440) + 1440) % 1440;
    const pad = (n) => String(n).padStart(2, '0');
    return `${start}\u00a0–\u00a0${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
}
const PRICING_HOOK = { tiered: 'income-based', donation: 'pay-what-you-can' };
function metaLine(c) {
    const parts = [];
    if (c.location.format === 'online')
        parts.push('Online');
    else if (c.location.name)
        parts.push(c.kind === 'studio' ? `at ${c.location.name}` : c.location.name);
    parts.push(`${c.durationMinutes} min`);
    if (c.pricing === 'tiered')
        parts.push('Income-based');
    else if (c.pricing === 'donation')
        parts.push('Pay what you can');
    return parts.join(' · ');
}
function classRow(c, origin) {
    const li = el('li', c.kind === 'studio' ? 'fy-class fy-studio' : 'fy-class');
    li.setAttribute('data-kind', c.kind);
    if (c.kind === 'class') {
        if (c.availability !== null)
            li.setAttribute('data-availability', c.availability);
        if (c.pricing !== null)
            li.setAttribute('data-pricing', PRICING_HOOK[c.pricing]);
    }
    const time = el('time', undefined, timeRange(c));
    time.dateTime = c.start;
    const timeCell = el('span', 'fy-time');
    timeCell.append(time);
    li.append(timeCell, ' ');
    const main = el('span', 'fy-main');
    main.append(el('span', 'fy-type', c.classType), ' ', el('span', 'fy-meta', metaLine(c)));
    li.append(main);
    const href = linkable(c.bookingUrl, origin);
    if (href !== null) {
        const waitlist = c.availability === 'waitlist';
        const a = newTabLink(href, waitlist ? 'fy-cta fy-wait' : 'fy-cta');
        const arrow = el('span', undefined, '↗');
        arrow.setAttribute('aria-hidden', 'true');
        a.append(waitlist ? 'Waitlist ' : 'Book ', arrow);
        appendNewTabNote(a);
        li.append(' ', a);
    }
    return li;
}
function footer(opts) {
    const p = el('p', 'fy-footer');
    const credit = newTabLink(opts.origin, 'fy-credit');
    const mark = el('span', 'fy-wordmark');
    mark.append('fair', el('span', 'fy-dot', '.'), 'yoga');
    credit.append('Schedule by ', mark);
    appendNewTabNote(credit);
    const feed = el('a', 'fy-feed', 'Add this schedule to your calendar');
    feed.href = opts.feedUrl;
    p.append(credit, ' ', feed);
    return p;
}
export function renderSchedule(root, data, opts) {
    const frame = document.createDocumentFragment();
    let container = frame;
    if (opts.theme === 'themed') {
        const style = el('style');
        style.textContent = CSS;
        const wrap = el('div', 'fy');
        wrap.setAttribute('data-scheme', opts.colorScheme ?? 'light');
        frame.append(style, wrap);
        container = wrap;
    }
    const limit = opts.limit;
    const capped = limit !== undefined && Number.isInteger(limit) && limit > 0;
    const shown = capped ? data.classes.slice(0, limit) : data.classes;
    if (data.classes.length === 0) {
        container.append(el('p', 'fy-empty', 'No upcoming classes right now.'));
    }
    else {
        const themed = opts.theme === 'themed';
        const schedule = el('ol', 'fy-schedule');
        if (themed)
            schedule.setAttribute('role', 'list');
        let day = null;
        for (const c of shown) {
            if (!START_PATTERN.test(c.start))
                throw new Error('Malformed start in schedule data');
            const date = c.start.slice(0, 10);
            if (day === null || day.date !== date) {
                const li = el('li', 'fy-day');
                const list = el('ol', 'fy-classes');
                if (themed)
                    list.setAttribute('role', 'list');
                li.append(el('h3', 'fy-day-heading', dayHeading(c.start)), list);
                schedule.append(li);
                day = { date, list };
            }
            day.list.append(classRow(c, opts.origin));
        }
        container.append(schedule);
    }
    container.append(footer(opts));
    root.replaceChildren(frame);
    return shown.length;
}
function schemeOf(value) {
    return value === 'dark' || value === 'auto' ? value : 'light';
}
function limitOf(value) {
    return value !== null && LIMIT_PATTERN.test(value) ? Number(value) : undefined;
}
function validKey(value) {
    return value !== null && KEY_PATTERN.test(value);
}
export function defineScheduleElement(opts) {
    if (customElements.get(ELEMENT_NAME))
        return;
    const origin = opts.origin;
    class FairYogaSchedule extends HTMLElement {
        constructor() {
            super(...arguments);
            this.started = false;
            this.key = null;
            this.loads = 0;
            this.cache = opts.cache;
        }
        connectedCallback() {
            const key = this.getAttribute('schedule-key');
            if (!this.started) {
                this.started = true;
                this.begin(key);
            }
            else if (validKey(key) && key !== this.key) {
                this.begin(key);
            }
        }
        attributeChangedCallback(_name, _old, value) {
            if (!this.started || !this.isConnected)
                return;
            if (value !== this.key)
                this.begin(value);
        }
        begin(key) {
            const load = ++this.loads;
            this.key = key;
            if (!validKey(key)) {
                this.setAttribute('data-state', 'error');
                queueMicrotask(() => {
                    if (load === this.loads)
                        this.fail({ reason: 'invalid-key' });
                });
                return;
            }
            this.setAttribute('data-state', 'loading');
            void this.load(key, load);
        }
        fail(detail) {
            this.setAttribute('data-state', 'error');
            this.dispatchEvent(new CustomEvent(ERROR_EVENT, { detail, bubbles: true, composed: true }));
        }
        async load(key, load) {
            const themed = this.getAttribute('theme') !== 'unstyled';
            if (themed && this.shadowRoot === null) {
                const style = el('style');
                style.textContent = HOST_CSS;
                this.attachShadow({ mode: 'open' }).replaceChildren(style, el('slot'));
            }
            else if (!themed && this.shadowRoot !== null) {
                this.shadowRoot.replaceChildren(el('slot'));
            }
            const encoded = encodeURIComponent(key);
            let data;
            try {
                let res;
                try {
                    res = await fetch(`${origin}/api/public/v1/schedule/${encoded}`, {
                        credentials: 'omit',
                        referrerPolicy: 'no-referrer',
                        ...(this.cache === undefined ? {} : { cache: this.cache }),
                    });
                }
                catch {
                    if (load === this.loads)
                        this.fail({ reason: 'network' });
                    return;
                }
                if (load !== this.loads)
                    return;
                if (!res.ok) {
                    this.fail({ reason: 'http', status: res.status });
                    return;
                }
                data = (await res.json());
            }
            catch {
                if (load === this.loads)
                    this.fail({ reason: 'data' });
                return;
            }
            if (load !== this.loads)
                return;
            const renderOpts = {
                theme: themed ? 'themed' : 'unstyled',
                feedUrl: `webcal://${new URL(origin).host}/feed/${encoded}.ics`,
                origin,
                colorScheme: schemeOf(this.getAttribute('color-scheme')),
                limit: limitOf(this.getAttribute('limit')),
            };
            const target = themed ? document.createElement('div') : this;
            let count;
            try {
                count = renderSchedule(target, data, renderOpts);
            }
            catch {
                this.fail({ reason: 'data' });
                return;
            }
            if (themed && this.shadowRoot !== null) {
                this.shadowRoot.replaceChildren(...target.childNodes);
                this.replaceChildren();
            }
            this.setAttribute('data-state', 'ready');
            const detail = { count };
            this.dispatchEvent(new CustomEvent(LOAD_EVENT, { detail, bubbles: true, composed: true }));
        }
    }
    FairYogaSchedule.observedAttributes = ['schedule-key'];
    customElements.define(ELEMENT_NAME, FairYogaSchedule);
}
defineScheduleElement({ origin: new URL(import.meta.url).origin });
