'use strict';

/*
 * FreshTomato does not answer with JSON. Its status endpoints return a chunk of
 * JavaScript source containing top level assignments, for example:
 *
 *   arplist = [ ['192.168.1.10','AA:BB:CC:DD:EE:FF','br0','laptop'], ... ];
 *   netdev = { 'eth0':{rx:0x81d929e,tx:0x735dd93e}, ... };
 *   nvram = { 'wan_ipaddr': '203.0.113.7', ... };
 *
 * The values are JavaScript literals, not JSON: keys may be unquoted, strings
 * use single quotes, numbers may be hexadecimal and arrays may contain holes.
 *
 * Evaluating the response would be the short path, but it would also mean
 * executing whatever the other end sends. This module parses the literal subset
 * instead, so a compromised or malfunctioning router can at worst produce a
 * parse error.
 */

const { redact } = require('./redact');

/** Characters that may start a JavaScript identifier or keyword. */
const IDENT_START = /[A-Za-z_$]/;
/** Characters that may continue a JavaScript identifier or keyword. */
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Thrown when the response does not match the expected literal grammar.
 */
class ParseError extends Error {
	/**
	 * @param {string} message - What was expected
	 * @param {string} source - The source being parsed
	 * @param {number} pos - Offset at which parsing failed
	 */
	constructor(message, source, pos) {
		const line = source.slice(0, pos).split('\n').length;
		// The excerpt is a slice of the router's answer, and status-data.jsx
		// carries http_id in its nvram dump, so a parse error next to that key
		// would reproduce the CSRF token in the ioBroker log.
		//
		// Redaction has to happen before slicing, not after: a 60 character
		// window can cut through the key name itself, leaving `id':'TID…`, and
		// no pattern anchored on `http_id` would match that. Masking shifts the
		// text, so the excerpt is approximate — the offset above still refers to
		// the untouched response.
		const safe = redact(source);
		const at = Math.min(pos, safe.length);
		const excerpt = safe.slice(Math.max(0, at - 30), at + 30).replace(/\n/g, '\\n');
		super(`${message} at line ${line} (offset ${pos}): …${excerpt}…`);
		this.name = 'ParseError';
		this.pos = pos;
	}
}

/**
 * Recursive descent reader for the JavaScript literal subset FreshTomato emits.
 */
class LiteralReader {
	/**
	 * @param {string} source - Text to read from
	 * @param {number} [pos] - Offset to start at
	 */
	constructor(source, pos = 0) {
		this.source = source;
		this.pos = pos;
	}

	/**
	 * Skips whitespace and both JavaScript comment styles.
	 */
	skipTrivia() {
		const s = this.source;
		for (;;) {
			while (this.pos < s.length && /\s/.test(s[this.pos])) {
				this.pos++;
			}
			if (s.startsWith('//', this.pos)) {
				const nl = s.indexOf('\n', this.pos);
				this.pos = nl === -1 ? s.length : nl + 1;
				continue;
			}
			if (s.startsWith('/*', this.pos)) {
				const end = s.indexOf('*/', this.pos + 2);
				this.pos = end === -1 ? s.length : end + 2;
				continue;
			}
			return;
		}
	}

	/**
	 * Consumes the given literal text, or throws.
	 *
	 * @param {string} text - Expected text
	 */
	expect(text) {
		if (!this.source.startsWith(text, this.pos)) {
			throw new ParseError(`Expected '${text}'`, this.source, this.pos);
		}
		this.pos += text.length;
	}

	/**
	 * Reads any value of the supported literal grammar.
	 *
	 * @returns {unknown} The parsed value
	 */
	readValue() {
		this.skipTrivia();
		const c = this.source[this.pos];
		if (c === undefined) {
			throw new ParseError('Unexpected end of input', this.source, this.pos);
		}
		if (c === '{') {
			return this.readObject();
		}
		if (c === '[') {
			return this.readArray();
		}
		if (c === "'" || c === '"') {
			return this.readString();
		}
		if (IDENT_START.test(c)) {
			return this.readKeyword();
		}
		return this.readNumber();
	}

	/**
	 * @returns {Record<string, unknown>} The parsed object literal
	 */
	readObject() {
		this.expect('{');
		const obj = {};
		for (;;) {
			this.skipTrivia();
			if (this.source[this.pos] === '}') {
				this.pos++;
				return obj;
			}
			const key = this.readKey();
			this.skipTrivia();
			this.expect(':');
			obj[key] = this.readValue();
			this.skipTrivia();
			if (this.source[this.pos] === ',') {
				this.pos++;
			} else if (this.source[this.pos] !== '}') {
				throw new ParseError("Expected ',' or '}'", this.source, this.pos);
			}
		}
	}

	/**
	 * Reads a property name, quoted or bare.
	 *
	 * @returns {string} The property name
	 */
	readKey() {
		const c = this.source[this.pos];
		if (c === "'" || c === '"') {
			return this.readString();
		}
		const start = this.pos;
		while (this.pos < this.source.length && IDENT_PART.test(this.source[this.pos])) {
			this.pos++;
		}
		if (this.pos === start) {
			throw new ParseError('Expected property name', this.source, this.pos);
		}
		return this.source.slice(start, this.pos);
	}

	/**
	 * Reads an array literal. Holes (`[1,,2]`) become null, matching how the
	 * router's own UI treats missing columns.
	 *
	 * @returns {Array<unknown>} The parsed array
	 */
	readArray() {
		this.expect('[');
		const arr = [];
		for (;;) {
			this.skipTrivia();
			if (this.source[this.pos] === ']') {
				this.pos++;
				return arr;
			}
			if (this.source[this.pos] === ',') {
				this.pos++;
				arr.push(null);
				continue;
			}
			arr.push(this.readValue());
			this.skipTrivia();
			if (this.source[this.pos] === ',') {
				this.pos++;
			} else if (this.source[this.pos] !== ']') {
				throw new ParseError("Expected ',' or ']'", this.source, this.pos);
			}
		}
	}

	/**
	 * Reads a single or double quoted string, honouring backslash escapes.
	 *
	 * @returns {string} The unescaped string
	 */
	readString() {
		const quote = this.source[this.pos++];
		let out = '';
		while (this.pos < this.source.length) {
			const c = this.source[this.pos++];
			if (c === quote) {
				return out;
			}
			if (c !== '\\') {
				out += c;
				continue;
			}
			const esc = this.source[this.pos++];
			switch (esc) {
				case 'n':
					out += '\n';
					break;
				case 'r':
					out += '\r';
					break;
				case 't':
					out += '\t';
					break;
				case 'b':
					out += '\b';
					break;
				case 'f':
					out += '\f';
					break;
				case 'v':
					out += '\v';
					break;
				case '0':
					out += '\0';
					break;
				case 'x':
					out += String.fromCharCode(parseInt(this.source.substr(this.pos, 2), 16));
					this.pos += 2;
					break;
				case 'u':
					out += String.fromCharCode(parseInt(this.source.substr(this.pos, 4), 16));
					this.pos += 4;
					break;
				default:
					out += esc;
			}
		}
		throw new ParseError('Unterminated string', this.source, this.pos);
	}

	/**
	 * Reads a decimal or hexadecimal number. Byte counters arrive as hex.
	 *
	 * @returns {number} The parsed number
	 */
	readNumber() {
		const rest = this.source.slice(this.pos);
		const match = rest.match(/^([+-]?)(0[xX][0-9a-fA-F]+|\d+\.?\d*([eE][+-]?\d+)?|\.\d+)/);
		if (!match) {
			throw new ParseError('Expected a number', this.source, this.pos);
		}
		this.pos += match[0].length;
		// Number('-0xff') is NaN: the constructor accepts a hex literal but not a
		// signed one. Applying the sign afterwards keeps signed hex working
		// instead of letting a silent NaN travel all the way into a state.
		const magnitude = Number(match[2]);
		if (!Number.isFinite(magnitude)) {
			throw new ParseError(`Unreadable number '${match[0]}'`, this.source, this.pos - match[0].length);
		}
		return match[1] === '-' ? -magnitude : magnitude;
	}

	/**
	 * Reads true, false, null or undefined.
	 *
	 * @returns {boolean|null|undefined} The keyword value
	 */
	readKeyword() {
		const start = this.pos;
		while (this.pos < this.source.length && IDENT_PART.test(this.source[this.pos])) {
			this.pos++;
		}
		const word = this.source.slice(start, this.pos);
		switch (word) {
			case 'true':
				return true;
			case 'false':
				return false;
			case 'null':
				return null;
			case 'undefined':
				return undefined;
			default:
				throw new ParseError(`Unsupported keyword '${word}'`, this.source, start);
		}
	}
}

/**
 * Reads a single top level assignment out of a FreshTomato response.
 *
 * Only assignments at the start of a line are considered, so an occurrence of
 * the name inside a string or a nested expression cannot be mistaken for the
 * variable itself.
 *
 * @param {string} source - The raw response body
 * @param {string} name - Name of the variable to extract
 * @returns {unknown} The parsed value, or undefined if the variable is absent
 */
function extractVariable(source, name) {
	const re = new RegExp(`^[ \\t]*(?:var[ \\t]+)?${name}[ \\t]*=[ \\t]*`, 'm');
	const match = re.exec(source);
	if (!match) {
		return undefined;
	}
	const reader = new LiteralReader(source, match.index + match[0].length);
	return reader.readValue();
}

/**
 * Reads several variables at once.
 *
 * A variable that fails to parse does not abort the whole response: the router
 * mixes data we care about with UI helper code, and a future firmware may add
 * constructs this parser does not cover. Names that could not be read are
 * reported so the caller can log them once instead of losing everything.
 *
 * @param {string} source - The raw response body
 * @param {Array<string>} names - Variable names to extract
 * @returns {{values: Record<string, unknown>, failed: Record<string, string>}} Parsed values and per-name error messages
 */
function extractVariables(source, names) {
	const values = {};
	const failed = {};
	for (const name of names) {
		try {
			const value = extractVariable(source, name);
			if (value !== undefined) {
				values[name] = value;
			}
		} catch (error) {
			failed[name] = error.message;
		}
	}
	return { values, failed };
}

/**
 * Extracts the firmware version from about.asp.
 *
 * The version is not exposed through nvram. The page references its stylesheet
 * with a cache busting query (`tomato.css?rel=2026.3`) and that query is the
 * only place the running version appears.
 *
 * @param {string} source - Body of about.asp
 * @returns {string|null} The version string, or null if the marker is missing
 */
function extractFirmwareVersion(source) {
	const match = source.match(/tomato\.css\?rel=([^"'&\s>]+)/);
	return match ? match[1] : null;
}

module.exports = { extractVariable, extractVariables, extractFirmwareVersion, ParseError };
