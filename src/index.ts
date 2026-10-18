interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * WIPO IPCPUB (International Patent Classification) MCP
 *
 * Publisher: World Intellectual Property Organization (WIPO). Dataset: the
 * International Patent Classification (IPC) scheme — the symbol hierarchy
 * every patent office uses to classify inventions by subject matter.
 *
 * Keyless. The catalog's own listed OpenAPI spec link for this service is a
 * dead 404 on wipo.int, so every operation here was discovered by reading the
 * IPCPUB front end's own JavaScript rather than any published spec.
 *
 * ── CPC is a DIFFERENT scheme ──────────────────────────────────────────────
 * The Cooperative Patent Classification (CPC, jointly maintained by EPO and
 * USPTO) extends IPC with much finer subdivisions and is what EPO/USPTO
 * actually classify most modern patents under. This pack only ever answers
 * IPC questions. CPC codes are not interchangeable with IPC ones even when
 * they look similar (e.g. CPC "A01B69/008" vs IPC "A01B 69/04" for a related
 * but distinct concept) — do not pass a CPC code here expecting an IPC
 * answer. Pipeworx has no dedicated CPC lookup pack at the time this was
 * written; `epo-ops` and `epo-publication-server` both surface CPC codes
 * verbatim on patent records without validating or classifying them.
 *
 * ── Symbol format ───────────────────────────────────────────────────────
 * Human-written IPC symbols look like "A61K 31/00" or "A01N" (section,
 * 2-digit class, subclass letter, optionally "/" + main group + subgroup).
 * IPCPUB's web service does not accept that form directly — it wants a fixed
 * 4-character subclass symbol ("A01N") or a fixed 14-character symbol with
 * the main group zero-padded to 4 digits and the subgroup zero-padded to 6
 * ("A61K" + "0031" + "000000" for "A61K 31/00"). Every tool here accepts the
 * human form and converts it; parseSymbol() is the one place that happens.
 */


const UPSTREAM = 'WIPO IPCPUB';
const WS_BASE = 'https://ipcpub.wipo.int/ws/fancy';
const VALIDITY_BASE = 'https://ipcpub.wipo.int/ws/getvalidity';
const SEARCH_BASE = 'https://ipcpub.wipo.int/search/ipccat';
const HOME_URL = 'https://ipcpub.wipo.int/?lang=en&menulang=en&notion=scheme';
const UA = 'pipeworx-mcp-wipo-ipc/1.0 (+https://pipeworx.io)';
const TIMEOUT_MS = 15_000;
// IPCPUB's tree-navigation endpoints (ancestors/children) render a subclass's
// ENTIRE nested title tree server-side on every request with no caching —
// measured live, the identical A01N subclass fetch took 1.4s once and 20.8s
// another time (414KB), and the largest subclasses (A61K) 504 outright at
// AWS API Gateway's own ~29.5s integration ceiling. 15s would cut off a slow
// but real render; this stays just under that ceiling so a genuine answer
// isn't abandoned, while a truly oversized subclass still fails within one
// bounded wait rather than hanging indefinitely.
const TREE_TIMEOUT_MS = 28_000;

async function pwFetch(url: string, timeoutMs: number = TIMEOUT_MS): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, UPSTREAM, timeoutMs);
}

// ── symbol parsing ──────────────────────────────────────────────────────

interface ParsedSymbol {
  section: string;
  cls: string; // 2-digit, zero-padded
  subclass: string;
  mainGroup: string | null; // 4-digit, zero-padded, or null for a subclass-only symbol
  subgroup: string | null; // 6-digit, zero-padded
  subclassSymbol: string; // e.g. "A01N"
  canonical: string; // the id IPCPUB's web service actually wants
  display: string; // human form, e.g. "A61K 31/00"
}

function parseSymbol(input: string): ParsedSymbol | null {
  const cleaned = String(input).replace(/ /g, ' ').trim().toUpperCase();
  const m = cleaned.match(/^([A-H])\s*(\d{1,2})\s*([A-Z])(?:\s*(\d{1,4})\s*\/\s*(\d{1,6}))?$/);
  if (!m) return null;
  const [, section, clsRaw, subclass, mgRaw, sgRaw] = m;
  const cls = clsRaw.padStart(2, '0');
  const subclassSymbol = `${section}${cls}${subclass}`;
  if (mgRaw === undefined) {
    return { section, cls, subclass, mainGroup: null, subgroup: null, subclassSymbol, canonical: subclassSymbol, display: subclassSymbol };
  }
  const mainGroup = mgRaw.padStart(4, '0');
  const subgroup = (sgRaw ?? '0').padStart(6, '0');
  const display = `${subclassSymbol} ${Number(mgRaw)}/${sgRaw ?? '00'}`;
  return { section, cls, subclass, mainGroup, subgroup, subclassSymbol, canonical: `${subclassSymbol}${mainGroup}${subgroup}`, display };
}

// ── version resolution (IPCPUB's tree-navigation calls need a date AND a
// matching internal "timestamp" string neither of which "latest" resolves
// to on their own; only getvalidity/search accept the literal word) ──────

interface VersionInfo {
  current: string;
  latest: string;
  timestamps: Record<string, string>;
}

let versionCache: { at: number; info: VersionInfo } | null = null;
const VERSION_CACHE_MS = 60 * 60 * 1000; // runtime cache only, re-fetched hourly per isolate — not baked data

async function fetchVersionInfo(): Promise<VersionInfo> {
  if (versionCache && Date.now() - versionCache.at < VERSION_CACHE_MS) return versionCache.info;
  const res = await pwFetch(HOME_URL);
  if (!res.ok) throw new Error(`${UPSTREAM}: ${res.status} fetching the IPC edition list.`);
  const html = await res.text();
  const current = html.match(/current_ipc_version:\s*"(\d{8})"/)?.[1];
  const latest = html.match(/latest_ipc_version:\s*"(\d{8})"/)?.[1];
  const tsBlock = html.match(/timestamps:\s*\{([^}]*)\}/)?.[1];
  if (!current || !latest || !tsBlock) {
    throw new Error(
      `upstream_parse: ${UPSTREAM} returned a page with no recognizable IPC edition config (${html.length} bytes) — the front-end page shape may have changed.`,
    );
  }
  const timestamps: Record<string, string> = {};
  for (const m of tsBlock.matchAll(/"(\d{8})":\s*"(\d+)"/g)) timestamps[m[1]] = m[2];
  const info = { current, latest, timestamps };
  versionCache = { at: Date.now(), info };
  return info;
}

async function resolveVersion(arg: string | undefined): Promise<{ version: string; timestamp: string }> {
  const info = await fetchVersionInfo();
  const want = !arg || arg.toLowerCase() === 'latest' ? info.latest : arg.toLowerCase() === 'current' ? info.current : arg;
  const timestamp = info.timestamps[want];
  if (!timestamp) {
    const known = Object.keys(info.timestamps).sort().slice(-8);
    throw new Error(`"version" ${JSON.stringify(arg)} is not a known IPC edition date. Recent editions: ${known.join(', ')}, or "latest"/"current".`);
  }
  return { version: want, timestamp };
}

// ── getvalidity (works for both the 4-char subclass form and the 14-char
// full symbol — NOT for 1- or 3-character partial forms, which 404 or 500) ──

interface ValidityResult {
  version: string | null;
  section: string | null;
  cls: string | null;
  subclass: string | null;
  main_group: string | null;
  subgroup: string | null;
  symbol_category: string | null;
  valid: boolean | null;
}

function tagText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  if (!m) return null;
  return m[1].length ? m[1] : null;
}

async function getValidity(canonical: string, version: string): Promise<ValidityResult> {
  const res = await pwFetch(`${VALIDITY_BASE}/${encodeURIComponent(canonical)}/${encodeURIComponent(version)}/`);
  const body = await res.text();
  const bodyBytes = body.length;
  if (!res.ok) {
    const detail = summarizeErrorBody(body);
    throw new Error(`${UPSTREAM}: ${res.status} checking validity of "${canonical}"${detail ? ` — ${detail}` : ''}.`);
  }
  if (!body.trim().startsWith('<?xml')) {
    throw new Error(
      `upstream_parse: ${UPSTREAM} returned a non-XML body (HTTP ${res.status}, ${bodyBytes} bytes) checking validity of "${canonical}".`,
    );
  }
  return {
    version: tagText(body, 'version'),
    section: tagText(body, 'section'),
    cls: tagText(body, 'class'),
    subclass: tagText(body, 'subclass'),
    main_group: tagText(body, 'main-group'),
    subgroup: tagText(body, 'subgroup'),
    symbol_category: tagText(body, 'symbol-category'),
    valid: tagText(body, 'classification-validity') === 'V',
  };
}

// ── tree navigation (ancestors / children) — used to resolve a title and to
// list the contents of a symbol. "ancestors" takes symbol TEXT and returns a
// chain of opaque internal keys (self first, then each parent up to the
// root); "children" takes one of those KEYS (never symbol text) and returns
// the fully-expanded subtree beneath it. ─────────────────────────────────

interface TreeNode {
  key: string;
  symbol?: string;
  symbolcode?: string;
  kind?: string;
  title1?: string;
  title2?: string;
  children?: TreeNode[] | null;
}

async function fetchAncestorKeys(canonical: string, version: string, timestamp: string): Promise<string[]> {
  const res = await pwFetch(`${WS_BASE}/ancestors/ipc/scheme/l3/${version}/${timestamp}/${encodeURIComponent(canonical)}/`, TREE_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`${UPSTREAM}: ${res.status} resolving "${canonical}" in the IPC tree for edition ${version}.`);
  }
  const body = await res.text();
  const bodyBytes = body.length;
  let parsed: { key: string }[];
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`upstream_parse: ${UPSTREAM} returned a non-JSON body (${bodyBytes} bytes) resolving "${canonical}" for edition ${version}.`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`upstream_parse: ${UPSTREAM} returned an empty ancestor chain for "${canonical}" — the symbol may not exist in edition ${version}.`);
  }
  return parsed.map((p) => p.key);
}

async function fetchChildrenTree(key: string, version: string, timestamp: string): Promise<TreeNode[]> {
  const res = await pwFetch(`${WS_BASE}/children/ipc/scheme/l3/${version}/${timestamp}/${encodeURIComponent(key)}/`, TREE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`${UPSTREAM}: ${res.status} fetching the IPC tree node ${key} for edition ${version}.`);
  const body = await res.text();
  const bodyBytes = body.length;
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error(`upstream_parse: ${UPSTREAM} returned a non-JSON body (${bodyBytes} bytes) fetching IPC tree node ${key}.`);
  }
}

// IPCPUB renders its version-stamp UI as
// `<a rel="versions" data-content="1<br>2006.01<br>2018.01" href="#" ...><strong>[2018.01]</strong></a>`
// — note the LITERAL, unescaped `<br>` tags inside the `data-content`
// attribute value itself. A naive `<[^>]+>` tag-stripper treats the first
// `>` it meets as the end of the `<a ...>` tag, which is the `>` closing
// that embedded `<br>`, not the real one — so everything from
// "data-content=" onward (the rest of the real attributes, the closing `>`,
// and the visible `[2018.01]`) leaks into the title as plain text. Matched
// live on A01G 9/00: `title_en` ended in
// `...2006.01 2018.01" href="#" oncontextmenu="return false;" onclick="return false;">`.
// Removing this whole element FIRST, by matching through to its literal
// `</a>` (which is unambiguous regardless of what is nested inside, unlike
// a bare `>`), avoids the problem entirely rather than patching around it.
const VERSION_ANCHOR_RE = /<a\s+rel="versions"\s+data-content="([^"]*)"[\s\S]*?<\/a>/g;

/** The edition dates IPCPUB attaches to one node, e.g. ["2006.01", "2018.01"]
 *  for a group amended in both editions — the leading non-date token in
 *  `data-content` (seen as "1") is some internal counter, not a date, and is
 *  dropped. */
function extractVersions(html: string): string[] {
  const versions = new Set<string>();
  for (const m of html.matchAll(VERSION_ANCHOR_RE)) {
    for (const token of m[1].split('<br>')) {
      if (/^\d{4}\.\d{2}$/.test(token)) versions.add(token);
    }
  }
  return [...versions];
}

function cleanTitle(html: string | undefined): string | null {
  if (!html) return null;
  const noVersionAnchors = html.replace(VERSION_ANCHOR_RE, ' ');
  const noComments = noVersionAnchors.replace(/<!--[\s\S]*?-->/g, ' ');
  const noTags = noComments.replace(/<[^>]+>/g, ' ');
  const decoded = noTags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
  // Strip the leading bullet-dot nesting markers ("•", "• •", ...) IPCPUB's
  // own HTML embeds for deeper subgroups.
  const cleaned = decoded
    .replace(/^(?:•\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length ? cleaned : null;
}

function findNode(nodes: TreeNode[], symbolcode: string, preferKind: string[]): TreeNode | null {
  let fallback: TreeNode | null = null;
  const stack = [...nodes];
  while (stack.length) {
    const n = stack.shift()!;
    if (n.symbolcode === symbolcode && (n.title1 || n.title2)) {
      if (n.kind && preferKind.includes(n.kind)) return n;
      if (!fallback) fallback = n;
    }
    if (n.children && n.children.length) stack.push(...n.children);
  }
  return fallback;
}

/**
 * Resolve a title in at most two tree fetches, both chosen to be the
 * smallest scope that can contain the answer:
 *
 *  - A bare subclass ("A01N") has no title of its OWN subtree — its title is
 *    one level UP, at the class level, where it appears as a `kind:"u"` row
 *    alongside its sibling subclasses (that class-level fetch is always
 *    small and fast: it lists subclasses as lazy stubs, never expanding
 *    into any of their content).
 *  - A group/subgroup ("A61K 31/00") needs the SUBCLASS's own fully-expanded
 *    tree searched for the exact match.
 *
 * The subclass-level fetch is the one real risk: IPCPUB expands it fully,
 * and for an unusually large subclass that can exceed the upstream's own
 * ~29s gateway timeout — measured live and reproduced on A61K specifically
 * (one of the biggest IPC subclasses by subgroup count): every key inside
 * it — its own, its immediate group's, even a single large group's own
 * self-key — 504s at ~29.5s with `{"message":"Endpoint request timed out"}`.
 * That is a real size limit in IPCPUB's own tree service, not a bug here, so
 * it is bounded to exactly ONE such call (never retried at another level)
 * and reported as a plain, honest title_error rather than silently empty.
 */
interface TitleResult {
  title_en: string | null;
  title_fr: string | null;
  versions: string[];
}
const EMPTY_TITLE: TitleResult = { title_en: null, title_fr: null, versions: [] };

function titleFromNode(node: TreeNode): TitleResult {
  return {
    title_en: cleanTitle(node.title1),
    title_fr: cleanTitle(node.title2),
    versions: extractVersions(node.title1 ?? node.title2 ?? ''),
  };
}

async function resolveTitle(parsed: ParsedSymbol, version: string, timestamp: string): Promise<TitleResult> {
  const keys = await fetchAncestorKeys(parsed.subclassSymbol, version, timestamp);
  if (keys.length < 2) return EMPTY_TITLE;
  const [subclassKey, classKey] = keys;

  if (!parsed.mainGroup) {
    const classTree = await fetchChildrenTree(classKey, version, timestamp);
    const node = findNode(classTree, parsed.subclassSymbol, ['u']);
    return node ? titleFromNode(node) : EMPTY_TITLE;
  }

  const subclassTree = await fetchChildrenTree(subclassKey, version, timestamp);
  const node = findNode(subclassTree, parsed.canonical, ['g', 'm']);
  return node ? titleFromNode(node) : EMPTY_TITLE;
}

// ── tools ────────────────────────────────────────────────────────────────

async function ipcLookup(args: Record<string, unknown>) {
  const symbolArg = args.symbol;
  if (!symbolArg || typeof symbolArg !== 'string') {
    throw new Error('"symbol" is required, e.g. "A61K 31/00" (a main group) or "A01N" (a subclass).');
  }
  const parsed = parseSymbol(symbolArg);
  if (!parsed) {
    return {
      found: false,
      symbol: symbolArg,
      reason: 'invalid_format',
      note: 'Not a recognizable IPC symbol. Expected a section letter A-H, a 1-2 digit class, a subclass letter, and optionally "/" + main group + subgroup, e.g. "A61K 31/00" or "A01N".',
    };
  }
  const { version: versionArg } = args as { version?: string };
  const { version, timestamp } = await resolveVersion(typeof versionArg === 'string' ? versionArg : undefined);
  const validity = await getValidity(parsed.canonical, version);

  let title: TitleResult | null = null;
  let titleError: string | null = null;
  try {
    title = await resolveTitle(parsed, version, timestamp);
  } catch (err) {
    titleError = err instanceof Error ? err.message : String(err);
  }

  return {
    found: true,
    symbol: parsed.display,
    canonical_id: parsed.canonical,
    version,
    valid: validity.valid,
    structure: {
      section: validity.section,
      class: validity.cls,
      subclass: validity.subclass,
      main_group: validity.main_group,
      subgroup: validity.subgroup,
    },
    parents: parsed.mainGroup
      ? [parsed.subclassSymbol, `${parsed.subclassSymbol} ${Number(parsed.mainGroup)}/00`].filter((v, i, a) => a.indexOf(v) === i)
      : [],
    title_en: title?.title_en ?? null,
    title_fr: title?.title_fr ?? null,
    versions: title?.versions ?? [],
    ...(title && !title.title_en && !title.title_fr
      ? { title_note: `IPCPUB's tree service did not have this exact symbol under the expected node — this can happen for a symbol that validates structurally (valid=${validity.valid}) but is a pure index/heading entry rather than a titled classification.` }
      : {}),
    ...(titleError ? { title_error: titleError } : {}),
  };
}

async function ipcChildren(args: Record<string, unknown>) {
  const symbolArg = args.symbol;
  if (!symbolArg || typeof symbolArg !== 'string') {
    throw new Error('"symbol" is required, e.g. "A01N" (lists its main groups) or "A61K 31/00" (lists its subgroups).');
  }
  const parsed = parseSymbol(symbolArg);
  if (!parsed) {
    throw new Error(`"${symbolArg}" is not a recognizable IPC symbol. Expected e.g. "A61K 31/00" or "A01N".`);
  }
  const { version: versionArg } = args as { version?: string };
  const { version, timestamp } = await resolveVersion(typeof versionArg === 'string' ? versionArg : undefined);

  const keys = await fetchAncestorKeys(parsed.canonical, version, timestamp);
  const tree = await fetchChildrenTree(keys[0], version, timestamp);

  // The direct children array mixes administrative rows (notes, definitions,
  // the printed index, warnings) with real classification entries. Keep the
  // real ones — groups ('g') and the handful of other symbol-bearing kinds —
  // and report what was filtered out rather than silently dropping it.
  const ADMIN_KINDS = new Set(['n', 'f', 'i', 'w']);
  const all = tree;
  const real = all.filter((n) => n.symbolcode && !ADMIN_KINDS.has(n.kind ?? ''));
  const children = real.map((n) => ({
    symbol: n.symbol?.replace(/ /g, ' ').trim() || n.symbolcode,
    canonical_id: n.symbolcode,
    kind: n.kind ?? null,
    title_en: cleanTitle(n.title1),
    title_fr: cleanTitle(n.title2),
    versions: extractVersions(n.title1 ?? n.title2 ?? ''),
  }));

  return {
    found: true,
    symbol: parsed.display,
    canonical_id: parsed.canonical,
    version,
    total_rows: all.length,
    administrative_rows_excluded: all.length - real.length,
    returned: children.length,
    children,
  };
}

async function ipcSearch(args: Record<string, unknown>) {
  const queryArg = args.query;
  if (!queryArg || typeof queryArg !== 'string' || !queryArg.trim()) {
    throw new Error('"query" is required, e.g. "vaccine".');
  }
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
  const { version: versionArg } = args as { version?: string };
  const version = !versionArg || versionArg.toLowerCase() === 'latest' || versionArg.toLowerCase() === 'current' ? 'latest' : versionArg;

  const res = await pwFetch(`${SEARCH_BASE}/${encodeURIComponent(version)}/en/subgroup/3/${encodeURIComponent(queryArg.trim())}/`);
  if (!res.ok) throw new Error(`${UPSTREAM}: ${res.status} searching IPC titles for "${queryArg}".`);
  const body = await res.text();
  const bodyBytes = body.length;
  const rows: { symbol: string; canonical_id: string }[] = [];
  for (const m of body.matchAll(/href="#[^/]+\/en\/([A-Z0-9]+)\/">([^<]+)<\/a>/g)) {
    rows.push({ canonical_id: m[1], symbol: m[2].replace(/ /g, ' ').trim() });
  }
  if (rows.length === 0 && body.trim().length > 0 && !/srchres/.test(body)) {
    throw new Error(
      `upstream_parse: ${UPSTREAM} returned an unrecognized body (${bodyBytes} bytes) searching for "${queryArg}" — expected an HTML fragment with class "srchres".`,
    );
  }
  return {
    query: queryArg,
    version,
    total_results: rows.length,
    returned: Math.min(rows.length, limit),
    results: rows.slice(0, limit),
    note: rows.length === 0 ? 'No IPC symbol titles matched this query in this edition. Try a broader or differently-worded term.' : undefined,
  };
}

async function ipcVersions() {
  const info = await fetchVersionInfo();
  const dates = Object.keys(info.timestamps).sort();
  return {
    current_edition: info.current,
    latest_edition: info.latest,
    total_editions: dates.length,
    oldest_edition: dates[0] ?? null,
    newest_edition: dates[dates.length - 1] ?? null,
    editions: dates,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ipc_lookup',
    description:
      'Look up one International Patent Classification (IPC) symbol via WIPO IPCPUB — its English/French title, structural breakdown (section/class/subclass/group/subgroup) and whether it is a currently valid classification. Give "symbol" as a subclass ("A01N") or a full group/subgroup ("A61K 31/00"). IPC only — the related-but-different CPC scheme (EPO/USPTO) is not covered here.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'IPC symbol, e.g. "A61K 31/00" or "A01N".' },
        version: { type: 'string', description: 'IPC edition date (YYYYMMDD), or "latest" (default) / "current".' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'ipc_children',
    description:
      'List the IPC symbols directly classified under one IPC symbol — the main groups under a subclass, or the subgroups under a group — with each child\'s title. Give "symbol" as a subclass ("A01N") or a group ("A61K 31/00").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'IPC symbol to list the children of, e.g. "A01N" or "A61K 31/00".' },
        version: { type: 'string', description: 'IPC edition date (YYYYMMDD), or "latest" (default) / "current".' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'ipc_search',
    description:
      'Find IPC symbols whose title text matches a keyword, e.g. "vaccine" or "solar cell". Returns matching symbols with their canonical ids — call ipc_lookup on a hit for its full title and validity.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keyword or short phrase to search IPC titles for, e.g. "vaccine".' },
        version: { type: 'string', description: 'IPC edition date (YYYYMMDD), or "latest" (default) / "current".' },
        limit: { type: 'number', description: 'Max results to return (default 25, max 100).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ipc_versions',
    description: 'List International Patent Classification (IPC) edition dates WIPO currently publishes, with the current (in-force) and latest (published, may be future-dated) editions named.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ipc_lookup':
      return ipcLookup(args);
    case 'ipc_children':
      return ipcChildren(args);
    case 'ipc_search':
      return ipcSearch(args);
    case 'ipc_versions':
      return ipcVersions();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
