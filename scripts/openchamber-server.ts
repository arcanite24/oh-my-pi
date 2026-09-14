import * as path from "node:path";
import { startOpenChamberServer } from "../packages/coding-agent/src/web/openchamber-server";
import { parseLegacySessionGuard } from "../packages/coding-agent/src/web/openchamber-host";

const password = process.env.OPENCODE_SERVER_PASSWORD;
if (!password) throw new Error("OPENCODE_SERVER_PASSWORD is required");
const port = Number(process.env.OMP_WEB_PORT ?? 4097);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid OMP_WEB_PORT");
const executable = process.env.OMP_EXECUTABLE;
const command = executable
	? [executable]
	: [process.execPath, path.resolve(import.meta.dir, "../packages/coding-agent/src/cli.ts")];
const runtime = await startOpenChamberServer({
	port,
	password,
	command,
	dataDir: process.env.OMP_WEB_DATA_DIR,
	authDbPath: process.env.OMP_WEB_AUTH_DB,
	browserOrigin: process.env.OMP_WEB_BROWSER_ORIGIN,
	modelLock: process.env.OMP_WEB_MODEL_LOCK,
	legacySessionGuard: process.env.OMP_WEB_LEGACY_GUARD
		? parseLegacySessionGuard(JSON.parse(process.env.OMP_WEB_LEGACY_GUARD))
		: undefined,
});
process.stdout.write(`OMP browser backend listening on 127.0.0.1:${runtime.server.port}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		void runtime.close().then(() => process.exit(0));
	});
