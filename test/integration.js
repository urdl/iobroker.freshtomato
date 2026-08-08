const path = require('path');
const { tests } = require('@iobroker/testing');

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
	// The built-in "adapter starts" test always runs, on the empty native
	// config from io-package.json. host/username/password/httpId are all
	// required, so with nothing set the adapter correctly terminates right
	// away with INVALID_ADAPTER_CONFIG (exit code 2) -- exactly what it
	// should do, but the generic test otherwise reads that exit as a
	// failure. allowedExitCodes tells it this one is expected.
	allowedExitCodes: [2],
	// Exercising the adapter's own logic instead needs a config that clears
	// the required-fields check. The address is never meant to answer, so
	// the poll itself is expected to fail, but that happens inside main.js's
	// own try/catch and never crashes the process, which is what this test
	// actually checks.
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
