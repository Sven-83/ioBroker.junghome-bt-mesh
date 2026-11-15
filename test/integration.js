const assert = require('node:assert/strict');
const path = require('path');
const { tests } = require('@iobroker/testing');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Without configuration', getHarness => {
            let harness;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                await harness.startAdapterAndWait();
            });

            it('stays running, reports the missing configuration and is not connected', async function () {
                this.timeout(30_000);
                let state;
                for (let i = 0; i < 40; i++) {
                    state = await harness.states.getStateAsync('junghome-bt-mesh.0.info.connection');
                    if (state && harness.hasLog(/no ESPHome Bluetooth proxy is configured/, 'error')) {
                        break;
                    }
                    await sleep(500);
                }
                assert.ok(harness.hasLog(/no ESPHome Bluetooth proxy is configured/, 'error'), 'config error not logged');
                assert.ok(harness.hasLog(/the JUNG HOME project export is missing/, 'error'), 'export error not logged');
                assert.equal(state?.val, false);
                assert.equal(state?.ack, true);
                assert.ok(harness.isAdapterRunning(), 'adapter stopped');
            });
        });
    },
});
