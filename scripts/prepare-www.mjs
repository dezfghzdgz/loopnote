// Zkopíruje web appku (app/ + config.js) do složky, kterou zabalí desktopová nebo mobilní appka.
// Použití: node scripts/prepare-www.mjs desktop/www
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, process.argv[2] || "www");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "app"), out, { recursive: true });
if (existsSync(join(root, "config.js"))) cpSync(join(root, "config.js"), join(out, "config.js"));

// v zabalené appce leží config.js vedle index.html
const idx = join(out, "index.html");
writeFileSync(idx, readFileSync(idx, "utf8").replace('src="../config.js"', 'src="config.js"'));
const sw = join(out, "sw.js");
if (existsSync(sw)) writeFileSync(sw, readFileSync(sw, "utf8").replace("'../config.js'", "'./config.js'"));
console.log("web app copied to", out);
