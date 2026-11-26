// Runs every test file in one process.
//
// `node --test` would spawn a child per file, which some sandboxes refuse
// (spawn EPERM) and which is slower than it needs to be for tests that share
// nothing but a fetch double. Importing the files runs them in this process and
// still exits non-zero when any test fails.

import "./quota.test.mjs";
import "./models.test.mjs";
import "./plugin.test.mjs";
