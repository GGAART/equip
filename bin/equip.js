#!/usr/bin/env node
// @cg3/equip CLI — universal entry point for AI tool setup.
// Usage: npx @cg3/equip <tool> [args...]
//   e.g. npx @cg3/equip prior --dry-run

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const EQUIP_VERSION = JSON.parse(
  require("fs").readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
).version;

// ─── Tool Registry ──────────────────────────────────────────

const TOOLS = {
  prior: { package: "@cg3/prior-node", command: "setup" },
  demo: { builtin: true },
};

// ─── CLI ─────────────────────────────────────────────────────

const alias = process.argv[2];
const extraArgs = process.argv.slice(3);

if (!alias || alias === "--help" || alias === "-h") {
  console.log("Usage: npx @cg3/equip <tool> [options]");
  console.log("");
  console.log("Available tools:");
  for (const [name, info] of Object.entries(TOOLS)) {
    if (info.builtin) {
      console.log(`  ${name}  →  built-in (reference example)`);
    } else {
      console.log(`  ${name}  →  ${info.package} ${info.command}`);
    }
  }
  console.log("");
  console.log("Options are forwarded to the tool (e.g. --dry-run, --platform codex)");
  process.exit(0);
}

const entry = TOOLS[alias];

// Built-in tools run from this package directly
if (entry && entry.builtin) {
  if (alias === "demo") {
    const demoPath = path.join(__dirname, "..", "demo", "setup.js");
    const child = spawn(process.execPath, [demoPath, ...extraArgs], {
      stdio: "inherit",
      env: { ...process.env, EQUIP_VERSION },
    });
    child.on("close", (code) => process.exit(code || 0));
    child.on("error", (err) => {
      console.error(`Failed to run demo: ${err.message}`);
      process.exit(1);
    });
    return;
  }
}

// No registry match — treat as a package name (e.g. "@scope/pkg setup")
if (!entry) {
  const pkg = alias;
  const command = extraArgs.shift(); // first extra arg is the command
  if (!command) {
    console.error(`Usage: npx @cg3/equip <package> <command> [options]`);
    console.error(`   or: npx @cg3/equip <shorthand> [options]`);
    console.error("");
    console.error("Registered shorthands:");
    for (const [name, info] of Object.entries(TOOLS)) {
      console.log(`  ${name}  →  ${info.package} ${info.command}`);
    }
    process.exit(1);
  }
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npxCmd, ["-y", `${pkg}@latest`, command, ...extraArgs], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, EQUIP_VERSION },
  });
  child.on("close", (code) => process.exit(code || 0));
  child.on("error", (err) => {
    console.error(`Failed to run ${pkg}: ${err.message}`);
    process.exit(1);
  });
  return;
}

// Spawn: npx -y <package> <command> [...extraArgs]
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(npxCmd, ["-y", `${entry.package}@latest`, entry.command, ...extraArgs], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, EQUIP_VERSION },
});

child.on("close", (code) => process.exit(code || 0));
child.on("error", (err) => {
  console.error(`Failed to run ${entry.package}: ${err.message}`);
  process.exit(1);
});
