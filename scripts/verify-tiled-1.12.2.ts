import { spawn } from "node:child_process";

const REQUIRED_GATE_ENV = "TILEDMCP_REQUIRE_TILED_1_12_2";
const packageManagerEntry = process.env.npm_execpath;

if (packageManagerEntry === undefined || packageManagerEntry.length === 0) {
  process.stderr.write(
    "Unable to start the Tiled 1.12.2 verification gate: package manager entry point is unavailable.\n",
  );
  process.exitCode = 1;
} else {
  const exitCode = await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(code);
    };

    const child = spawn(
      process.execPath,
      [packageManagerEntry, "run", "verify"],
      {
        env: {
          ...process.env,
          [REQUIRED_GATE_ENV]: "1",
        },
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      },
    );

    child.once("error", () => {
      process.stderr.write(
        "Unable to start the Tiled 1.12.2 verification gate.\n",
      );
      finish(1);
    });
    child.once("exit", (code) => {
      finish(code ?? 1);
    });
  });

  process.exitCode = exitCode;
}
