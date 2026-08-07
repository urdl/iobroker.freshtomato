'use strict';

const { expect } = require('chai');
const { classifyRequestError, FreshTomatoClient, timeoutHint, isAddressLiteral } = require('./client');

/**
 * Builds a client whose request method records instead of sending.
 *
 * The control commands cannot be exercised against the real router — switching
 * a radio disconnects every client on that band — so what is verified here is
 * that the request matches what the router's own web interface sends.
 *
 * @returns {{client: FreshTomatoClient, sent: Array<{path: string, fields: Record<string, string>}>}} Client and log
 */
function recordingClient() {
	const sent = [];
	const client = new FreshTomatoClient({
		host: 'router.invalid',
		port: 80,
		username: 'root',
		password: 'secret',
		httpId: 'TIDtest0123456789',
	});
	client.request = async (path, body) => {
		sent.push({ path, fields: Object.fromEntries(body ? body.entries() : []) });
		return '';
	};
	return { client, sent };
}

/**
 * Builds an error shaped like the one a runtime actually throws.
 *
 * @param {string} name - Error name
 * @param {string} message - Error message
 * @param {object} [cause] - Cause object
 * @returns {Error} The synthetic error
 */
function makeError(name, message, cause) {
	const error = new Error(message);
	error.name = name;
	if (cause) {
		error.cause = cause;
	}
	return error;
}

describe('client => classifyRequestError', () => {
	it('recognises the timeout raised by AbortSignal.timeout', () => {
		expect(classifyRequestError(makeError('TimeoutError', 'The operation was aborted'))).to.equal('timeout');
	});

	it('recognises an aborted request', () => {
		expect(classifyRequestError(makeError('AbortError', 'This operation was aborted'))).to.equal('timeout');
	});

	it("recognises Node's shape for a connection the router dropped", () => {
		// undici: TypeError('fetch failed') with a SocketError in cause
		const error = makeError('TypeError', 'fetch failed', {
			name: 'SocketError',
			code: 'UND_ERR_SOCKET',
			message: 'other side closed',
		});
		expect(classifyRequestError(error)).to.equal('connection-dropped');
	});

	it("recognises Bun's shape for the same situation", () => {
		const error = makeError('Error', 'The socket connection was closed unexpectedly.');
		expect(classifyRequestError(error)).to.equal('connection-dropped');
	});

	it("recognises the router's self-signed certificate", () => {
		// FreshTomato ships one by default, so this is the normal HTTPS case
		const error = makeError('TypeError', 'fetch failed', {
			code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
			message: 'self-signed certificate',
		});
		expect(classifyRequestError(error)).to.equal('untrusted-certificate');
	});

	it('recognises the other certificate trust failures', () => {
		for (const code of [
			'SELF_SIGNED_CERT_IN_CHAIN',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
			'CERT_HAS_EXPIRED',
			'ERR_TLS_CERT_ALTNAME_INVALID',
		]) {
			const error = makeError('TypeError', 'fetch failed', { code, message: code });
			expect(classifyRequestError(error), code).to.equal('untrusted-certificate');
		}
	});

	it('does not confuse a certificate problem with an unreachable router', () => {
		// Both arrive as TypeError('fetch failed'); only the cause tells them apart
		const cert = makeError('TypeError', 'fetch failed', { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
		const down = makeError('TypeError', 'fetch failed', { code: 'ECONNREFUSED' });
		expect(classifyRequestError(cert)).to.not.equal(classifyRequestError(down));
	});

	it('treats a refused connection as unreachable, not as a dropped one', () => {
		const error = makeError('TypeError', 'fetch failed', {
			code: 'ECONNREFUSED',
			message: 'connect ECONNREFUSED 192.0.2.1:80',
		});
		expect(classifyRequestError(error)).to.equal('unreachable');
	});

	it('treats an unknown host as unreachable', () => {
		const error = makeError('TypeError', 'fetch failed', {
			code: 'ENOTFOUND',
			message: 'getaddrinfo ENOTFOUND router.invalid',
		});
		expect(classifyRequestError(error)).to.equal('unreachable');
	});

	it('does not fall over when there is no cause at all', () => {
		expect(classifyRequestError(makeError('TypeError', 'fetch failed'))).to.equal('unreachable');
	});
});

describe('client => control commands', () => {
	it('switches a radio through wlradio.cgi, not update.cgi', async () => {
		// The project notes originally assumed update.cgi; the router's own
		// wlenable() posts to wlradio.cgi with enable and _wl_unit.
		const { client, sent } = recordingClient();
		await client.setWirelessRadio(1, true);
		expect(sent).to.have.lengthOf(1);
		expect(sent[0].path).to.equal('/wlradio.cgi');
		expect(sent[0].fields).to.include({ enable: '1', _wl_unit: '1' });
	});

	it('sends enable=0 when switching a radio off', async () => {
		const { client, sent } = recordingClient();
		await client.setWirelessRadio(0, false);
		expect(sent[0].fields).to.include({ enable: '0', _wl_unit: '0' });
	});

	it('renews a DHCP lease through dhcpc.cgi with a wan prefix', async () => {
		const { client, sent } = recordingClient();
		await client.renewDhcpLease(1);
		expect(sent[0].path).to.equal('/dhcpc.cgi');
		expect(sent[0].fields).to.include({ exec: 'renew', prefix: 'wan1' });
	});

	it('addresses additional WANs by index', async () => {
		const { client, sent } = recordingClient();
		await client.renewDhcpLease(2);
		expect(sent[0].fields.prefix).to.equal('wan2');
	});

	it('carries the CSRF token and the ajax flag on every command', async () => {
		// form.submit() in the router's tomato.js prepends _ajax=1 so the answer
		// is a status line rather than a rendered page.
		const { client, sent } = recordingClient();
		await client.setWirelessRadio(0, true);
		await client.renewDhcpLease();
		for (const call of sent) {
			expect(call.fields._ajax, call.path).to.equal('1');
			expect(call.fields._http_id, call.path).to.equal('TIDtest0123456789');
		}
	});

	it('defaults to the first WAN when no index is given', async () => {
		const { client, sent } = recordingClient();
		await client.renewDhcpLease();
		expect(sent[0].fields.prefix).to.equal('wan1');
	});
});

describe('client => reboot', () => {
	it('submits the three fields the router expects', async () => {
		// From reboot() in the router's tomato.js:
		//   form.submitHidden("tomato.cgi", {_reboot:1, _commit:0, _nvset:0})
		// This command is never executed against a real router, so matching that
		// call is the only assurance available.
		const { client, sent } = recordingClient();
		await client.reboot();
		expect(sent).to.have.lengthOf(1);
		expect(sent[0].path).to.equal('/tomato.cgi');
		expect(sent[0].fields).to.include({ _reboot: '1', _commit: '0', _nvset: '0' });
	});

	it('does not ask the router to save anything while rebooting', async () => {
		// _commit and _nvset stay 0: this is a restart, not a settings change
		const { client, sent } = recordingClient();
		await client.reboot();
		expect(sent[0].fields._commit).to.equal('0');
		expect(sent[0].fields._nvset).to.equal('0');
	});

	it('carries the CSRF token', async () => {
		const { client, sent } = recordingClient();
		await client.reboot();
		expect(sent[0].fields._http_id).to.equal('TIDtest0123456789');
	});

	it('goes to tomato.cgi, not to one of the action endpoints', async () => {
		// wlradio.cgi and dhcpc.cgi are per action; the reboot flag rides on the
		// generic endpoint instead.
		const { client, sent } = recordingClient();
		await client.reboot();
		expect(sent[0].path).to.not.equal('/wlradio.cgi');
		expect(sent[0].path).to.not.equal('/dhcpc.cgi');
	});
});

describe('client => timeoutHint', () => {
	it('recognises an address, so it does not blame a lookup that never happens', () => {
		expect(isAddressLiteral('192.168.1.101')).to.equal(true);
		expect(isAddressLiteral('fe80::1')).to.equal(true);
		expect(isAddressLiteral('[fe80::1]')).to.equal(true);
		expect(timeoutHint('192.168.1.101')).to.not.match(/resolve/);
	});

	it('recognises a name, including one that only looks numeric', () => {
		expect(isAddressLiteral('router-ap')).to.equal(false);
		expect(isAddressLiteral('router-ap.example.local')).to.equal(false);
		// Four groups, but not all numeric: still a name.
		expect(isAddressLiteral('192.168.1.host')).to.equal(false);
	});

	it('names the lookup and quotes the host, since that is the part to check', () => {
		// A timeout also fires when the name never resolves, which is what a
		// short name or a .local suffix does on a host without mDNS. The old
		// wording sent the reader to the network instead.
		const hint = timeoutHint('router-ap.example.local');
		expect(hint).to.match(/resolve/);
		expect(hint).to.include("'router-ap.example.local'");
		expect(hint).to.match(/IP address/);
	});
});
