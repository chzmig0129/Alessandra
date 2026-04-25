import "dotenv/config";
import { runSyncOnce } from "../src/sync/apiSportsSync.ts";

await runSyncOnce();
process.exit(0);
