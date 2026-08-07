'use strict';

const { expect } = require('chai');
const { createRedactor, redact, MASK } = require('./redact');

const TOKEN = 'TID1234567890abcdef';

describe('redact => pattern based', () => {
	it('masks the token in a query string the adapter sent', () => {
		const out = redact(`http://router/status-data.jsx?_http_id=${TOKEN}`);
		expect(out).to.not.contain(TOKEN);
		expect(out).to.contain(`_http_id=${MASK}`);
	});

	it('masks the token in a form body', () => {
		expect(redact(`_http_id=${TOKEN}&exec=devlist`)).to.equal(`_http_id=${MASK}&exec=devlist`);
	});

	it('masks the http_id the router returns inside its nvram dump', () => {
		// This is the dangerous one: the value comes back from the router, so
		// redacting only the configured secret would miss it.
		const out = redact(`nvram = {'lan_ipaddr':'192.168.1.1','http_id':'${TOKEN}'}`);
		expect(out).to.not.contain(TOKEN);
		expect(out).to.contain("'http_id':'***");
	});

	it('masks a basic auth header value', () => {
		const out = redact('Authorization: Basic cm9vdDpodW50ZXIy');
		expect(out).to.not.contain('cm9vdDpodW50ZXIy');
	});

	it('leaves unrelated text alone', () => {
		const text = 'Router answered with HTTP 500 for /update.cgi';
		expect(redact(text)).to.equal(text);
	});

	it('survives non-string input', () => {
		expect(redact(undefined)).to.equal('');
		expect(redact(null)).to.equal('');
		expect(redact(42)).to.equal('42');
	});
});

describe('redact => literal secrets', () => {
	it('masks a configured secret wherever it appears', () => {
		const r = createRedactor([TOKEN]);
		expect(r(`something ${TOKEN} somewhere`)).to.equal(`something ${MASK} somewhere`);
	});

	it('masks the password too', () => {
		const r = createRedactor(['sup3rs3cret']);
		expect(r('connect failed for user root with sup3rs3cret')).to.not.contain('sup3rs3cret');
	});

	it('ignores secrets too short to match safely', () => {
		// A two character secret would turn ordinary log text into asterisks
		const r = createRedactor(['ab']);
		expect(r('a stable cabbage')).to.equal('a stable cabbage');
	});

	it('prefers the longest secret when one contains another', () => {
		const r = createRedactor(['secretvalue', 'secretvaluelong']);
		expect(r('x secretvaluelong y')).to.equal(`x ${MASK} y`);
	});
});

describe('redact => parser integration', () => {
	const { extractVariables } = require('./parser');

	it('keeps the token out of a parse error excerpt', () => {
		// A syntax error next to http_id used to reproduce the token verbatim
		const body = `nvram = {'http_id':'${TOKEN}','x':@BROKEN@};`;
		const { failed } = extractVariables(body, ['nvram']);
		expect(failed.nvram).to.be.a('string');
		expect(failed.nvram).to.not.contain(TOKEN);
		expect(failed.nvram).to.not.contain('1234567890abcdef');
	});
});
