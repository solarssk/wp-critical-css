// Node's test runner pipes the shared TestsStream to every --test-reporter
// via .pipe() - each pipe registers its own 'end'/'unpipe' listeners, so
// three reporters (spec, lcov, junit) push the listener count past the
// default EventEmitter limit of 10, triggering a MaxListenersExceededWarning
// that looks like a leak but isn't (it scales with reporter count, not with
// any actual growth over time). Raising the process-wide default before the
// test runner constructs that stream - via --require, so this runs first -
// fixes the actual undersized limit instead of just silencing the warning.
require('node:events').EventEmitter.defaultMaxListeners = 20;
