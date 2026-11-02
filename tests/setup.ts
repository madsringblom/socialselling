import { tmpdir } from "node:os";
import { join } from "node:path";

// Loaded before every test file (bunfig.toml). config.ts reads DB_PATH once at import, so this guard
// guarantees nothing opens data/social.db; each test still opens its own temp DB via tempDb().
process.env.DB_PATH = join(tmpdir(), `ss-guard-${process.pid}`, "social.db");
