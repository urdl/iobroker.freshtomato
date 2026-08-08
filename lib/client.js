'use strict';

// undici rather than the global fetch: accepting the router's self-signed
// certificate needs a dispatcher, and an Agent built here is rejected by the
// global fetch as UND_ERR_INVALID_ARG because that is a separate undici
// instance. Using one implementation for every request keeps a single code path
// and one shape of error object.
const { fetch, Agent } = require('undici');
const { extractVariables, extractFirmwareVersion } = require('./parser');
const { createRedactor } = require('./redact');

/**
 * Raised when the router could be reached but rejected or ignored the request.
 */
class FreshTomatoError extends Error {
	/**
	 * @param {string} message - Human readable cause
	 * @param {string} [hint] - What the user can do about it
	 */
	constructor(message, hint) {
		super(hint ? `${message} — ${hint}` : message);
		this.name = 'FreshTomatoError';
		this.hint = hint;
	}
}

/** Where the user finds the CSRF token, repeated in several error messages. */
const HTTP_ID_LOCATION = 'Administration → Admin Access → Web Admin ID';

/**
 * Reports whether a host is written as an address rather than as a name.
 *
 * Deliberately coarse: anything with a colon is treated as IPv6, and only a
 * dotted quad counts as IPv4. Getting this wrong costs nothing but a slightly
 * less specific hint.
 *
 * @param {string} host - Configured host
 * @returns {boolean} True when no name lookup is involved
 */
function isAddressLiteral(host) {
	const bare = String(host).replace(/^\[|\]$/g, '');
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':');
}

/**
 * Explains a request that ran out of time.
 *
 * The timeout covers more than a router that stays silent: if the name never
 * resolves, the lookup can hang until the same deadline fires. That happened
 * with a short host name and again with a `.local` suffix, and the old wording
 * — check host, port and reachability — sent the reader towards the network
 * while the name was the problem. So the hint names that case whenever a name
 * is actually involved.
 *
 * @param {string} host - Configured host
 * @returns {string} The hint for the error
 */
function timeoutHint(host) {
	if (isAddressLiteral(host)) {
		return 'Check the address and port, and whether the web interface answers there';
	}
	return (
		`Check the address and port. This also covers a name lookup that never came back: '${host}' has to ` +
		'resolve on the ioBroker host, which often fails for a short name without a search domain, or for a ' +
		'.local suffix on a host without mDNS. Entering the IP address rules that out'
	);
}

/**
 * TLS failures that mean "the certificate was not trusted" rather than "the
 * router could not be reached". FreshTomato ships a self-signed certificate, so
 * this is what every default HTTPS setup runs into.
 */
const TLS_TRUST_CODES = new Set([
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'CERT_HAS_EXPIRED',
	'CERT_NOT_YET_VALID',
	'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Classifies why a fetch call failed before any response arrived.
 *
 * The interesting case is a connection that was established and then dropped by
 * the router, which is what a rejected CSRF token looks like. Runtimes disagree
 * on how they report it: Node's undici throws `TypeError: fetch failed` and puts
 * a `SocketError` with code `UND_ERR_SOCKET` in `cause`, while Bun puts the
 * description straight into the message. Both shapes are recognised so the
 * diagnosis does not depend on which runtime the adapter happens to run under.
 *
 * @param {Error} error - The error thrown by fetch
 * @returns {'timeout'|'connection-dropped'|'untrusted-certificate'|'unreachable'} What went wrong
 */
function classifyRequestError(error) {
	if (error.name === 'TimeoutError' || error.name === 'AbortError') {
		return 'timeout';
	}
	const cause = error.cause || {};
	const text = `${error.message ?? ''} ${cause.message ?? ''}`.toLowerCase();
	// A rejected certificate is not an unreachable router. Reporting it as one
	// sends the user to check the network, which is the same trap the CSRF token
	// used to set.
	if (TLS_TRUST_CODES.has(cause.code) || text.includes('self-signed certificate')) {
		return 'untrusted-certificate';
	}
	if (
		cause.code === 'UND_ERR_SOCKET' ||
		text.includes('other side closed') ||
		text.includes('socket connection was closed')
	) {
		return 'connection-dropped';
	}
	return 'unreachable';
}

/**
 * HTTP client for the FreshTomato web interface.
 *
 * Two things are required on every request: HTTP basic auth and the `_http_id`
 * CSRF token. Measured against FreshTomato 2026.3, a wrong or missing token
 * makes the router close the TCP connection without answering at all, which
 * surfaces as a generic network failure rather than an HTTP status.
 *
 * A Referer header is sent as well. It is *not* required by this firmware — the
 * same requests succeed without it — but it costs nothing, matches what a
 * browser would send, and other builds are reported to check it.
 */
class FreshTomatoClient {
	/**
	 * @param {object} options - Connection options
	 * @param {string} options.host - Router hostname or IP
	 * @param {number} options.port - Router web interface port
	 * @param {boolean} [options.https] - Use TLS
	 * @param {string} options.username - Web interface user
	 * @param {string} options.password - Web interface password
	 * @param {string} options.httpId - CSRF token from Administration → Admin Access → Web Admin ID
	 * @param {boolean} [options.allowSelfSigned] - Accept a TLS certificate that does not verify
	 * @param {number} [options.timeout] - Per request timeout in milliseconds
	 */
	constructor({ host, port, https = false, username, password, httpId, allowSelfSigned = false, timeout = 15000 }) {
		this.baseUrl = `${https ? 'https' : 'http'}://${host}:${port}`;
		// Kept apart from baseUrl so a timeout can tell a name from an address.
		this.host = host;
		this.httpId = httpId;
		this.timeout = timeout;
		this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
		// Only built when the user asked for it, and only for TLS. Without a
		// dispatcher undici applies its normal verification, so the opt-in is
		// what actually decides whether an untrusted certificate is accepted.
		this.dispatcher = https && allowSelfSigned ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
		// Everything that ends up in a thrown message passes through this, so a
		// request URL or a runtime error quoting one cannot carry the CSRF token
		// or the credentials into the ioBroker log.
		this.redact = createRedactor([httpId, password, this.authorization]);
	}

	/**
	 * Performs a request against the router and returns the raw body.
	 *
	 * @param {string} path - Path below the base URL
	 * @param {URLSearchParams} [body] - Form body; when given the request is a POST
	 * @param {object} [options] - Extra options
	 * @param {boolean} [options.allowEmpty] - Treat an empty body as a valid answer instead of a likely wrong HTTP ID
	 * @returns {Promise<string>} The response body
	 */
	async request(path, body, { allowEmpty = false } = {}) {
		const url = new URL(path, this.baseUrl);
		if (!body) {
			url.searchParams.set('_http_id', this.httpId);
		}

		let response;
		try {
			response = await fetch(url, {
				method: body ? 'POST' : 'GET',
				headers: {
					Authorization: this.authorization,
					// Not enforced by FreshTomato 2026.3, sent for the benefit of
					// builds that do check it. See the note on the class.
					Referer: `${this.baseUrl}/status-overview.asp`,
					...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
				},
				body: body ? body.toString() : undefined,
				signal: AbortSignal.timeout(this.timeout),
				...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
			});
		} catch (error) {
			switch (classifyRequestError(error)) {
				case 'timeout':
					throw new FreshTomatoError(
						`No answer from ${this.baseUrl} within ${this.timeout} ms`,
						timeoutHint(this.host),
					);
				case 'untrusted-certificate':
					throw new FreshTomatoError(
						`Router certificate not trusted (${this.baseUrl})`,
						'FreshTomato ships a self-signed certificate. Enable "Accept a self-signed certificate" in the instance settings, or switch the connection back to HTTP',
					);
				case 'connection-dropped':
					// A rejected CSRF token does not produce an HTTP error: the
					// router just drops the connection. Reporting that as "cannot
					// reach the router" would send the user looking at the network
					// instead of at the one setting that is actually wrong.
					throw new FreshTomatoError(
						`Router closed the connection without answering (${path})`,
						`The HTTP ID is most likely wrong; it is shown under ${HTTP_ID_LOCATION}`,
					);
				default:
					// error.message can quote the request URL, which for GET calls
					// carries _http_id in its query string.
					throw new FreshTomatoError(`Cannot reach ${this.baseUrl}: ${this.redact(error.message)}`);
			}
		}

		if (response.status === 401 || response.status === 403) {
			throw new FreshTomatoError(
				`Router rejected the credentials (HTTP ${response.status})`,
				'Check user name and password',
			);
		}
		if (!response.ok) {
			throw new FreshTomatoError(`Router answered with HTTP ${response.status} for ${path}`);
		}

		const text = await response.text();
		if (text.trim() === '' && !allowEmpty) {
			// Not observed on 2026.3, which closes the connection instead, but
			// reported for other builds. Same cause, so same hint.
			throw new FreshTomatoError(
				`Router returned an empty body for ${path}`,
				`The HTTP ID is most likely wrong; it is shown under ${HTTP_ID_LOCATION}`,
			);
		}
		return text;
	}

	/**
	 * Calls one of the `update.cgi` actions.
	 *
	 * @param {string} exec - Name of the action, e.g. `devlist` or `netdev`
	 * @param {object} [options] - Extra options
	 * @param {boolean} [options.allowEmpty] - Treat an empty body as a valid answer instead of a likely wrong HTTP ID
	 * @returns {Promise<string>} The response body
	 */
	async exec(exec, options) {
		const body = new URLSearchParams({ _http_id: this.httpId, exec });
		return this.request('/update.cgi', body, options);
	}

	/**
	 * Submits one of the router's action endpoints.
	 *
	 * The web interface posts its `t_fom` form to a per action CGI, and its
	 * helper prepends `_ajax=1` so the answer is a short status line instead of
	 * a rendered page. Reproducing that here keeps the responses small and
	 * avoids following the UI's page redirects.
	 *
	 * @param {string} cgi - Endpoint, e.g. `wlradio.cgi`
	 * @param {Record<string, string>} fields - Form fields for this action
	 * @returns {Promise<string>} The response body
	 */
	async command(cgi, fields) {
		const body = new URLSearchParams({ _ajax: '1', _http_id: this.httpId, ...fields });
		return this.request(`/${cgi}`, body);
	}

	/**
	 * Turns one wireless radio on or off.
	 *
	 * Taken from the router's own `wlenable()`, which sets `enable` and
	 * `_wl_unit` and posts to `wlradio.cgi` — not to `update.cgi`, which is what
	 * the endpoint list in the project notes had assumed.
	 *
	 * @param {number} unit - Radio index, 0 for the first band
	 * @param {boolean} enabled - Whether the radio should be on
	 * @returns {Promise<string>} The response body
	 */
	async setWirelessRadio(unit, enabled) {
		return this.command('wlradio.cgi', { enable: enabled ? '1' : '0', _wl_unit: String(unit) });
	}

	/**
	 * Renews the DHCP lease of one WAN interface.
	 *
	 * From the router's `dhcpc(what, unit)`, which sends `exec` and a `prefix`
	 * built as `'wan' + unit` with a one based index. Note that nvram names the
	 * first WAN `wan` rather than `wan1`; the UI still passes `wan1`, so that is
	 * what is reproduced here.
	 *
	 * @param {number} [wanIndex] - One based WAN index
	 * @returns {Promise<string>} The response body
	 */
	async renewDhcpLease(wanIndex = 1) {
		return this.command('dhcpc.cgi', { exec: 'renew', prefix: `wan${wanIndex}` });
	}

	/**
	 * Reboots the router.
	 *
	 * From `reboot()` in the router's tomato.js, which submits three fields to
	 * tomato.cgi behind a confirmation dialog:
	 *
	 *     form.submitHidden("tomato.cgi", {_reboot:1, _commit:0, _nvset:0})
	 *
	 * `_commit` and `_nvset` are zero because nothing is being saved — this is a
	 * plain restart, not a settings change that needs one.
	 *
	 * This method has never been executed against a router and cannot be, since
	 * the device is the household's only internet connection. What is verified
	 * is that the request matches the one above; whether the router obeys is
	 * established the first time somebody deliberately uses it.
	 *
	 * @returns {Promise<string>} The response body, if one arrives before the reboot
	 */
	async reboot() {
		return this.command('tomato.cgi', { _reboot: '1', _commit: '0', _nvset: '0' });
	}

	/**
	 * Connected clients, DHCP leases and wireless link quality.
	 *
	 * @returns {Promise<{arplist: Array<Array<unknown>>, wldev: Array<Array<unknown>>, dhcpd_lease: Array<Array<unknown>>, failed: Record<string, string>}>} Parsed device data
	 */
	async getDeviceList() {
		const body = await this.exec('devlist');
		// devlist also carries wlnoise, but it duplicates wlstats[].noise from
		// status-data.jsx, which the model already uses. Parsing it here would
		// only produce a value nobody reads.
		const { values, failed } = extractVariables(body, ['arplist', 'wldev', 'dhcpd_lease']);
		return {
			arplist: values.arplist ?? [],
			wldev: values.wldev ?? [],
			dhcpd_lease: values.dhcpd_lease ?? [],
			failed,
		};
	}

	/**
	 * Cumulative traffic counters per LAN address.
	 *
	 * @returns {Promise<{iptraffic: Array<Array<unknown>>, failed: Record<string, string>}>} Parsed counters
	 */
	async getIpTraffic() {
		const body = await this.exec('iptraffic');
		const { values, failed } = extractVariables(body, ['iptraffic']);
		return { iptraffic: values.iptraffic ?? [], failed };
	}

	/**
	 * Attached USB storage devices, their disks and mounted partitions.
	 *
	 * Reads the same `exec=usbdevices` call the NAS -> USB Support page polls
	 * every 5 s for its live refresh, rather than the full asp page it renders.
	 *
	 * A router without USB/NAS support answers with an empty body rather than
	 * an empty `usbdev = [];` — measured on a WNR3500L, consistently, alone and
	 * without any other request in flight, so it is the router's normal answer
	 * for this call and not the sign of a wrong HTTP ID that an empty body
	 * otherwise is. `allowEmpty` opts this one call out of that check.
	 *
	 * @returns {Promise<{usbdev: Array<unknown>, failed: Record<string, string>}>} Parsed USB device tree
	 */
	async getUsbDevices() {
		const body = await this.exec('usbdevices', { allowEmpty: true });
		const { values, failed } = extractVariables(body, ['usbdev']);
		return { usbdev: values.usbdev ?? [], failed };
	}

	/**
	 * Byte counters per network interface.
	 *
	 * @returns {Promise<{netdev: Record<string, {rx: number, tx: number}>, failed: Record<string, string>}>} Parsed counters
	 */
	async getNetDev() {
		const body = await this.exec('netdev');
		const { values, failed } = extractVariables(body, ['netdev']);
		return { netdev: values.netdev ?? {}, failed };
	}

	/**
	 * Configuration and runtime status: nvram, system info, wireless per band.
	 *
	 * @returns {Promise<{nvram: Record<string, unknown>, sysinfo: Record<string, unknown>, wlstats: Array<Record<string, unknown>>, nvstat: Record<string, unknown>, etherstates: Record<string, unknown>, wanUptime: Array<string>, wanLease: Array<string>, failed: Record<string, string>}>} Parsed status data
	 */
	async getStatusData() {
		const body = await this.request('/status-data.jsx');
		const { values, failed } = extractVariables(body, [
			'nvram',
			'sysinfo',
			'wlstats',
			'nvstat',
			'etherstates',
			'stats.wanuptime',
			'stats.wanlease',
		]);
		return {
			nvram: values.nvram ?? {},
			sysinfo: values.sysinfo ?? {},
			wlstats: values.wlstats ?? [],
			nvstat: values.nvstat ?? {},
			etherstates: values.etherstates ?? {},
			// One entry per WAN slot (index 0 = wan, 1 = wan2, ...), formatted by
			// the router itself rather than left as raw seconds — it already
			// spells out "11 days, 20h 01m 23s", and reformatting risks getting
			// the router's own rounding wrong for no benefit.
			wanUptime: values['stats.wanuptime'] ?? [],
			wanLease: values['stats.wanlease'] ?? [],
			failed,
		};
	}

	/**
	 * Running firmware version.
	 *
	 * @returns {Promise<string|null>} Version string, or null if it could not be found
	 */
	async getFirmwareVersion() {
		return extractFirmwareVersion(await this.request('/about.asp'));
	}

	/**
	 * Releases the TLS dispatcher, if one was created.
	 *
	 * An Agent keeps sockets alive, which would hold the adapter open on unload.
	 *
	 * @returns {Promise<void>} Resolves once the dispatcher is closed
	 */
	async close() {
		if (this.dispatcher) {
			await this.dispatcher.close();
			this.dispatcher = undefined;
		}
	}
}

module.exports = { FreshTomatoClient, FreshTomatoError, classifyRequestError, timeoutHint, isAddressLiteral };
