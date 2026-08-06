/**
 * Measures what a client receives when it lists this server's tools.
 *
 * Two numbers matter and they are not the same:
 *
 * - **Model-visible**: descriptions + input schemas. This is what an agent
 *   carries in context for a whole session, before it does any work.
 * - **Wire**: the above plus output schemas. Large, but clients generally use
 *   output schemas to validate rather than handing them to a model.
 *
 * Optimising the wrong one is easy. The breakdown below exists so that a
 * change aimed at agent comprehension can be checked against the number that
 * actually reaches the agent.
 *
 * Run with: pnpm tsx scripts/measure-tool-payload.ts
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "contracts",
  "mcp-contract.v1.json",
);

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

const tokens = (chars: number): string =>
  `~${Math.round(chars / 4).toLocaleString()} tok`;

/** Bytes spent on `description` text anywhere inside a JSON Schema. */
function describedBytes(node: unknown): number {
  if (
    node === null ||
    typeof node !== "object"
  ) {
    return 0;
  }
  let total = 0;
  const record = node as Record<string, unknown>;
  if (typeof record.description === "string") {
    // The key, quoting and separators travel with the text.
    total += record.description.length + 18;
  }
  for (const value of Object.values(record)) {
    total += describedBytes(value);
  }
  return total;
}

const contract = JSON.parse(
  await readFile(CONTRACT, "utf8"),
) as { toolDefinitions: ToolDefinition[] };
const tools = contract.toolDefinitions;

let description = 0;
let input = 0;
let output = 0;
let inputPolicy = 0;
const rows: Array<{
  name: string;
  visible: number;
}> = [];

for (const tool of tools) {
  const d = (tool.description ?? "").length;
  const i = JSON.stringify(
    tool.inputSchema ?? {},
  ).length;
  description += d;
  input += i;
  output += JSON.stringify(
    tool.outputSchema ?? {},
  ).length;
  inputPolicy += describedBytes(
    tool.inputSchema,
  );
  rows.push({ name: tool.name, visible: d + i });
}

const visible = description + input;
const line = (
  label: string,
  chars: number,
): string =>
  `${label.padEnd(26)}${chars.toLocaleString().padStart(10)} chars  ${tokens(chars)}`;

process.stdout.write(
  [
    `tools: ${tools.length}`,
    "",
    line("descriptions", description),
    line("input schemas", input),
    line("  of which prose", inputPolicy),
    line(
      "  of which structure",
      input - inputPolicy,
    ),
    "",
    line("MODEL-VISIBLE", visible),
    line("output schemas", output),
    line("WIRE TOTAL", visible + output),
    "",
    "Heaviest model-visible tools:",
    ...rows
      .sort((a, b) => b.visible - a.visible)
      .slice(0, 8)
      .map(
        (row) =>
          `  ${row.name.padEnd(38)}${row.visible.toLocaleString().padStart(8)} chars`,
      ),
    "",
  ].join("\n"),
);
