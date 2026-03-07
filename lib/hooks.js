// Hook installation for platforms that support lifecycle hooks.
// Zero dependencies.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// ─── Platform Hook Capabilities ──────────────────────────────

/**
 * Which platforms support hooks and what events they handle.
 * Returns null if the platform doesn't support hooks.
 */
function getHookCapabilities(platformId) {
  const caps = {
    "claude-code": {
      settingsPath: () => path.join(os.homedir(), ".claude", "settings.json"),
      events: ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"],
      format: "claude-code",
    },
    // Future: cursor, etc.
  };
  return caps[platformId] || null;
}

// ─── Hook Script Content ─────────────────────────────────────

/**
 * Returns hook script content keyed by filename.
 * Scripts are platform-agnostic Node.js — they read JSON from stdin and write JSON to stdout.
 */
function getHookScripts() {
  return {
    "prior-search-nudge.js": `#!/usr/bin/env node
// Prior hook: Nudge agent to search Prior after a tool failure.
// Fires on PostToolUseFailure for Bash commands.
// Injects additionalContext reminding the agent to search.

const chunks = [];
process.stdin.on("data", c => chunks.push(c));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const toolName = input.tool_name || "";
    const toolOutput = input.tool_output?.stderr || input.tool_output?.stdout || "";

    // Only nudge on Bash failures (compile errors, runtime errors, etc.)
    if (toolName !== "Bash") { process.exit(0); return; }

    // Skip trivial failures (empty output, permission prompts)
    if (!toolOutput || toolOutput.length < 20) { process.exit(0); return; }

    // Inject search reminder as additional context
    const output = {
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext: "\\u26a0\\ufe0f Error detected. Per Prior protocol: search this error before attempting a fix. Use prior_search with the exact error text. Your user has credits for this — not searching wastes their investment."
      }
    };
    process.stdout.write(JSON.stringify(output));
  } catch {
    // Never block on hook errors
    process.exit(0);
  }
});
`,

    "prior-completion-check.js": `#!/usr/bin/env node
// Prior hook: Remind agent about contribution offer at task completion.
// Fires on Stop event.
// Injects additionalContext if the agent didn't mention Prior contributions.

const chunks = [];
process.stdin.on("data", c => chunks.push(c));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const lastResponse = input.stop_response || "";

    // Check if the agent already mentioned contributions
    const hasContribution = /contribute.*prior|prior.*contribut|No contribution needed/i.test(lastResponse);
    if (hasContribution) { process.exit(0); return; }

    // Check if this looks like a task completion (not just a question/answer)
    const looksLikeTask = /fix|implement|build|debug|error|compil|test|deploy|configur|migrat|setup|install/i.test(lastResponse);
    if (!looksLikeTask) { process.exit(0); return; }

    const output = {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: "Reminder: Your completion summary should end with either (a) an offer to contribute fixes to Prior, or (b) \\"No contribution needed: all fixes were first-attempt.\\""
      }
    };
    process.stdout.write(JSON.stringify(output));
  } catch {
    process.exit(0);
  }
});
`,
  };
}

// ─── Hook Config Generation ─────────────────────────────────

/**
 * Build hooks config object for a platform.
 * @param {string} hookDir - Absolute path to directory containing hook scripts
 * @param {string} platformId - Platform id
 * @returns {object} Hooks config in the platform's format
 */
function buildHooksConfig(hookDir, platformId) {
  const caps = getHookCapabilities(platformId);
  if (!caps) return null;

  if (caps.format === "claude-code") {
    const config = {};

    if (caps.events.includes("PostToolUseFailure")) {
      config.PostToolUseFailure = [{
        matcher: "Bash",
        hooks: [{
          type: "command",
          command: `node "${path.join(hookDir, "prior-search-nudge.js")}"`,
        }],
      }];
    }

    if (caps.events.includes("Stop")) {
      config.Stop = [{
        hooks: [{
          type: "command",
          command: `node "${path.join(hookDir, "prior-completion-check.js")}"`,
        }],
      }];
    }

    return config;
  }

  return null;
}

// ─── Installation ────────────────────────────────────────────

/**
 * Install hook scripts to disk and register them in platform settings.
 * @param {object} platform - Platform object from detect()
 * @param {object} [options] - { hookDir, dryRun }
 * @returns {{ installed: boolean, scripts: string[], hookDir: string } | null}
 */
function installHooks(platform, options = {}) {
  const caps = getHookCapabilities(platform.platform);
  if (!caps) return null;

  const hookDir = options.hookDir || path.join(os.homedir(), ".prior", "hooks");
  const dryRun = options.dryRun || false;

  // 1. Write hook scripts
  const scripts = getHookScripts();
  const installedScripts = [];

  if (!dryRun) {
    fs.mkdirSync(hookDir, { recursive: true });
  }

  for (const [filename, content] of Object.entries(scripts)) {
    const filePath = path.join(hookDir, filename);
    if (!dryRun) {
      fs.writeFileSync(filePath, content, { mode: 0o755 });
    }
    installedScripts.push(filename);
  }

  // 2. Register hooks in platform settings
  const hooksConfig = buildHooksConfig(hookDir, platform.platform);
  if (!hooksConfig) return null;

  if (!dryRun) {
    const settingsPath = caps.settingsPath();
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch { /* file doesn't exist yet */ }

    // Merge hooks — preserve existing non-Prior hooks
    if (!settings.hooks) settings.hooks = {};

    for (const [event, hookGroups] of Object.entries(hooksConfig)) {
      if (!settings.hooks[event]) {
        settings.hooks[event] = hookGroups;
      } else {
        // Remove existing Prior hooks for this event, then add new ones
        settings.hooks[event] = settings.hooks[event].filter(
          group => !group.hooks?.some(h => h.command && h.command.includes(".prior"))
        );
        settings.hooks[event].push(...hookGroups);
      }
    }

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  return { installed: true, scripts: installedScripts, hookDir };
}

/**
 * Uninstall hook scripts and remove from platform settings.
 * @param {object} platform - Platform object
 * @param {object} [options] - { hookDir, dryRun }
 * @returns {boolean} Whether anything was removed
 */
function uninstallHooks(platform, options = {}) {
  const caps = getHookCapabilities(platform.platform);
  if (!caps) return false;

  const hookDir = options.hookDir || path.join(os.homedir(), ".prior", "hooks");
  const dryRun = options.dryRun || false;
  let removed = false;

  // 1. Remove hook scripts
  const scripts = getHookScripts();
  for (const filename of Object.keys(scripts)) {
    const filePath = path.join(hookDir, filename);
    try {
      if (fs.statSync(filePath).isFile()) {
        if (!dryRun) fs.unlinkSync(filePath);
        removed = true;
      }
    } catch { /* doesn't exist */ }
  }

  // Clean up empty hooks dir
  if (!dryRun) {
    try { fs.rmdirSync(hookDir); } catch { /* not empty or doesn't exist */ }
  }

  // 2. Remove from platform settings
  if (!dryRun) {
    const settingsPath = caps.settingsPath();
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.hooks) {
        let changed = false;
        for (const event of Object.keys(settings.hooks)) {
          const before = settings.hooks[event].length;
          settings.hooks[event] = settings.hooks[event].filter(
            group => !group.hooks?.some(h => h.command && h.command.includes(".prior"))
          );
          if (settings.hooks[event].length === 0) {
            delete settings.hooks[event];
          }
          if (settings.hooks[event]?.length !== before) changed = true;
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
        if (changed) {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          removed = true;
        }
      }
    } catch { /* file doesn't exist */ }
  }

  return removed;
}

/**
 * Check if hooks are installed for a platform.
 * @param {object} platform - Platform object
 * @param {object} [options] - { hookDir }
 * @returns {boolean}
 */
function hasHooks(platform, options = {}) {
  const caps = getHookCapabilities(platform.platform);
  if (!caps) return false;

  const hookDir = options.hookDir || path.join(os.homedir(), ".prior", "hooks");

  // Check scripts exist
  const scripts = getHookScripts();
  for (const filename of Object.keys(scripts)) {
    try {
      if (!fs.statSync(path.join(hookDir, filename)).isFile()) return false;
    } catch { return false; }
  }

  // Check settings registration
  try {
    const settings = JSON.parse(fs.readFileSync(caps.settingsPath(), "utf-8"));
    if (!settings.hooks) return false;
    const hasPriorHook = Object.values(settings.hooks).some(groups =>
      groups.some(g => g.hooks?.some(h => h.command && h.command.includes(".prior")))
    );
    return hasPriorHook;
  } catch { return false; }
}

module.exports = {
  getHookCapabilities,
  getHookScripts,
  buildHooksConfig,
  installHooks,
  uninstallHooks,
  hasHooks,
};
