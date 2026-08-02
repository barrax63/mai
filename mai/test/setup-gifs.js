/**
 * Chat, plus a GIPHY key, which is what makes `search_gif` exist at all.
 *
 * There is no content-file fixture here any more: GIFs come from the search and
 * nothing else, so the shipped `config/mai.yaml` is exactly what the tests want
 * to run against.
 *
 * Must be imported **before** `./setup.js`: ES module bodies run in import
 * order, `config.js` freezes the environment the first time it is loaded, and
 * `setup.js` only fills in variables that are not set yet.
 */
process.env.CHAT_ENABLED = 'true';
process.env.CHAT_HISTORY_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_MAX_RETRIES = '1';
// Moderation stays off (setup.js), so `screenInput` passes everything through:
// the screen has its own coverage in security.test.js and stubbing a classifier
// here would test it twice.
process.env.GIPHY_API_KEY = 'test-giphy-key';
