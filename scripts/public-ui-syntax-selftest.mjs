import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const blocks = [...html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script\\s*>/gi)]
  .map((match, index) => ({ index: index + 1, source: match[1].trim() }))
  .filter((block) => block.source.length > 0);

assert.ok(blocks.length > 0, "public/index.html must contain at least one inline JavaScript block");

for (const block of blocks) {
  try {
    new vm.Script(block.source, { filename: "public/index.html#inline-script-" + block.index });
    console.log("PASS: inline JavaScript block " + block.index + " parses");
  } catch (error) {
    console.error("FAIL: inline JavaScript block " + block.index + " has a syntax error");
    throw error;
  }
}

console.log("All public UI JavaScript syntax checks passed.");
