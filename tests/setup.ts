import { tmpdir } from "node:os";
import { join } from "node:path";

// Loaded before every test file (bunfig.toml). config.ts reads DB_PATH once at import, so this guard
// guarantees nothing opens data/social.db; each test still opens its own temp DB via tempDb().
process.env.DB_PATH = join(tmpdir(), `ss-guard-${process.pid}`, "social.db");
// Same for Salgsro CSV exports: never write into data/salgsro from tests.
process.env.SALGSRO_DIR = join(tmpdir(), `ss-guard-${process.pid}`, "salgsro");
// And the Gmail token file: never read or write data/gmail-token.json from tests.
process.env.GMAIL_TOKEN_PATH = join(tmpdir(), `ss-guard-${process.pid}`, "gmail-token.json");
// Bun loads .env for tests too: start every run without the developer's Google client and mail settings.
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "MAIL_LABEL", "MAIL_MAX_PER_RUN"]) {
  delete process.env[k];
}
