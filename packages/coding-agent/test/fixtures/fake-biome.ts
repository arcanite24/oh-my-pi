import * as path from "node:path";

const [command, flag, file] = process.argv.slice(2);
if (command === "lint") {
	await Bun.sleep(60_000);
	process.exit(0);
}
if (command !== "format" || flag !== "--write" || file !== path.join(process.cwd(), "example.ts")) {
	process.exit(7);
}
const expected = Bun.file("expected-input.ts");
if (!(await expected.exists())) process.exit(1);
if ((await Bun.file(file).text()) !== (await expected.text())) process.exit(9);
await Bun.write(file, Bun.file("formatted-output.ts"));
