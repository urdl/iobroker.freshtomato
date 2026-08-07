'use strict';

/*
 * Keeps the router's CSRF token out of the ioBroker log.
 *
 * The token reaches log output on two different routes, and covering only one
 * of them is not enough:
 *
 * 1. The adapter sends it itself, as `_http_id` in a query string or form body.
 *    Anything that echoes a request URL can carry it.
 * 2. The router sends it back. `status-data.jsx` includes `http_id` in its nvram
 *    dump, so a parse error whose excerpt happens to cover that key reproduces
 *    the token verbatim in the message.
 *
 * Case 2 also means redacting the *configured* value is insufficient: if the
 * configured token is wrong, the response still contains the real one, which the
 * adapter has never seen. Hence the pattern based pass in addition to the
 * literal one.
 */

/** What replaces a redacted value. */
const MASK = '***';

/**
 * Matches an http_id assignment in any of the notations that occur, and
 * captures the part before the value so it can be kept:
 *
 *   _http_id=TID123          query string and form body
 *   'http_id':'TID123'       nvram dump from status-data.jsx
 *   http_id: "TID123"        loose object notation
 */
const HTTP_ID_ASSIGNMENT = /(['"]?_?http_id['"]?\s*[:=]\s*['"]?)([A-Za-z0-9._-]+)/gi;

/** Matches an HTTP basic auth header value. */
const BASIC_AUTH = /(Basic\s+)([A-Za-z0-9+/=]{8,})/gi;

/**
 * Escapes a string so it can be used inside a regular expression.
 *
 * @param {string} text - Literal text
 * @returns {string} The escaped text
 */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a function that removes secrets from a piece of text.
 *
 * Pass the values the adapter knows about; the returned function additionally
 * scrubs anything that looks like an http_id assignment or a basic auth header,
 * which covers values the adapter never held.
 *
 * @param {Array<string|undefined|null>} [secrets] - Known secret values
 * @returns {(text: unknown) => string} A redacting function
 */
function createRedactor(secrets = []) {
	// Short values are not worth matching: a two character "secret" would turn
	// unrelated log text into a field of asterisks.
	const literals = secrets
		.filter(s => typeof s === 'string' && s.length >= 6)
		.sort((a, b) => b.length - a.length)
		.map(s => new RegExp(escapeRegExp(s), 'g'));

	return function redact(text) {
		let out = String(text ?? '');
		for (const literal of literals) {
			out = out.replace(literal, MASK);
		}
		out = out.replace(HTTP_ID_ASSIGNMENT, `$1${MASK}`);
		out = out.replace(BASIC_AUTH, `$1${MASK}`);
		return out;
	};
}

/** A redactor that knows no literal secrets, only the generic patterns. */
const redact = createRedactor();

module.exports = { createRedactor, redact, MASK };
