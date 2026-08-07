'use strict';

const { expect } = require('chai');
const { extractVariable, extractVariables, extractFirmwareVersion, ParseError } = require('./parser');

describe('parser => extractVariable', () => {
	it('reads an array of rows the way devlist reports the ARP table', () => {
		const source = "arplist = [ ['192.168.1.10','AA:BB:CC:DD:EE:FF','br0','laptop'] ];";
		expect(extractVariable(source, 'arplist')).to.deep.equal([
			['192.168.1.10', 'AA:BB:CC:DD:EE:FF', 'br0', 'laptop'],
		]);
	});

	it('reads objects with bare keys and hexadecimal counters', () => {
		const source = "netdev={ 'eth0':{rx:0x10,tx:0x20} };";
		expect(extractVariable(source, 'netdev')).to.deep.equal({ eth0: { rx: 16, tx: 32 } });
	});

	it('handles the var keyword and trailing content', () => {
		const source = 'var wlnoise = [ -90,-92 ];\nsomethingElse();';
		expect(extractVariable(source, 'wlnoise')).to.deep.equal([-90, -92]);
	});

	it('keeps apostrophes inside host names intact', () => {
		const source = "arplist = [ ['10.0.0.1','AA:BB:CC:DD:EE:FF','br0','Bob\\'s Phone'] ];";
		expect(extractVariable(source, 'arplist')[0][3]).to.equal("Bob's Phone");
	});

	it('treats array holes as null instead of shifting later columns', () => {
		expect(extractVariable('x = [1,,3];', 'x')).to.deep.equal([1, null, 3]);
	});

	it('skips comments between the name and the value', () => {
		expect(extractVariable('x = /* note */ 5;', 'x')).to.equal(5);
	});

	it('reads signed hexadecimal without turning it into NaN', () => {
		// Number('-0xff') is NaN, so the sign has to be applied separately
		expect(extractVariable('x = -0xff;', 'x')).to.equal(-255);
		expect(extractVariable('x = +0x10;', 'x')).to.equal(16);
	});

	it('reads signed and fractional decimals', () => {
		expect(extractVariable('x = [-90,-1.5,.25,1e3];', 'x')).to.deep.equal([-90, -1.5, 0.25, 1000]);
	});

	it('reads booleans and null', () => {
		expect(extractVariable('x = [true,false,null];', 'x')).to.deep.equal([true, false, null]);
	});

	it('returns undefined for a variable that is not present', () => {
		expect(extractVariable('a = 1;', 'b')).to.equal(undefined);
	});

	it('does not mistake a mention inside a string for the assignment', () => {
		const source = "note = 'nvram = fake';\nnvram = {'a':'b'};";
		expect(extractVariable(source, 'nvram')).to.deep.equal({ a: 'b' });
	});

	it('throws a ParseError that names the offending position', () => {
		expect(() => extractVariable('x = @;', 'x')).to.throw(ParseError);
	});

	it('reads a dotted property assignment, not just a bare variable', () => {
		// status-data.jsx resets `stats = {};` and then assigns its fields one
		// property at a time rather than as a single object literal.
		const source = "stats = { };\nstats.wanuptime = ['11 days, 20h 01m 23s','--'];\n";
		expect(extractVariable(source, 'stats.wanuptime')).to.deep.equal(['11 days, 20h 01m 23s', '--']);
	});
});

describe('parser => extractVariables', () => {
	it('collects what it can and reports the rest instead of failing outright', () => {
		const source = 'good = [1];\nbad = @;';
		const { values, failed } = extractVariables(source, ['good', 'bad', 'absent']);
		expect(values).to.deep.equal({ good: [1] });
		expect(failed).to.have.key('bad');
	});

	it('reports a stack overflow from absurd nesting instead of crashing', () => {
		// The recursive reader gives up around depth 5000 on Node. A firmware
		// that sends something that deep must not take the adapter down.
		const deep = `x = ${'['.repeat(20000)}${']'.repeat(20000)};`;
		const { values, failed } = extractVariables(deep, ['x']);
		expect(values).to.deep.equal({});
		expect(failed).to.have.key('x');
	});
});

describe('parser => extractFirmwareVersion', () => {
	it('takes the version from the stylesheet cache busting query', () => {
		const source = '<link rel="stylesheet" href="tomato.css?rel=2026.3">';
		expect(extractFirmwareVersion(source)).to.equal('2026.3');
	});

	it('returns null when the marker is missing', () => {
		expect(extractFirmwareVersion('<html></html>')).to.equal(null);
	});
});
