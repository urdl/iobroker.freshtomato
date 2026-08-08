const path = require('path');
const { tests } = require('@iobroker/testing');

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
	// The default test only checks that the adapter starts, using the empty
	// native config from io-package.json. host/username/password/httpId are
	// all required, so with nothing set the adapter terminates immediately
	// (INVALID_ADAPTER_CONFIG) -- correct behaviour, but it fails the generic
	// startup check before the adapter's own logic is ever exercised. A
	// placeholder config that satisfies the required-fields check is enough:
	// the address is never meant to answer, so the poll itself is expected to
	// fail, but that happens inside main.js's own try/catch and never crashes
	// the process, which is all this test actually needs.
	defineAdditionalTests({ suite }) {
		suite('Starts with a placeholder configuration', getHarness => {
			it('does not terminate over the required fields', () => {
				return new Promise(async (resolve, reject) => {
					try {
						const harness = getHarness();
						await harness.changeAdapterConfig('freshtomato', {
							native: {
								host: '203.0.113.1',
								port: 80,
								https: false,
								username: 'root',
								password: 'placeholder',
								httpId: 'TIDplaceholder0000',
							},
						});
						await harness.startAdapterAndWait();
						resolve();
					} catch (error) {
						reject(error);
					}
				});
			}).timeout(60000);
		});
	},
});
