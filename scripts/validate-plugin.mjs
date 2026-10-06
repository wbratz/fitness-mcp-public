#!/usr/bin/env node
/**
 * Static validation of the fitness-tracker plugin package (v3 addendum §G item 8).
 * Checks structure and manifests without needing the live ChatGPT directory:
 *   - .codex-plugin/plugin.json present, valid, kebab-case name, has version/description
 *   - apps points at .app.json, which exists and references an MCP connection
 *   - at least one skills/<name>/SKILL.md with a non-empty `description` frontmatter
 * Exits non-zero on any failure. Warns (does not fail) on the .app.json placeholder,
 * which is filled after ChatGPT developer-mode registration (§D).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'fitness-tracker';
const errors = [];
const warnings = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// --- plugin.json ---
const manifestPath = join(ROOT, '.codex-plugin', 'plugin.json');
let manifest;
if (!existsSync(manifestPath)) {
  errors.push(`missing manifest: ${manifestPath}`);
} else {
  try {
    manifest = readJson(manifestPath);
  } catch (e) {
    errors.push(`plugin.json is not valid JSON: ${e.message}`);
  }
}

if (manifest) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name ?? '')) {
    errors.push(`name must be kebab-case, got ${JSON.stringify(manifest.name)}`);
  }
  if (!manifest.version) errors.push('plugin.json is missing "version"');
  if (!manifest.description?.trim()) errors.push('plugin.json is missing a non-empty "description"');

  // --- .app.json (registered MCP connection reference) ---
  const appsRel = manifest.apps ?? './.app.json';
  const appsPath = join(ROOT, appsRel);
  if (!existsSync(appsPath)) {
    errors.push(`apps points at ${appsRel} but ${appsPath} does not exist`);
  } else {
    let app;
    try {
      app = readJson(appsPath);
    } catch (e) {
      errors.push(`.app.json is not valid JSON: ${e.message}`);
    }
    if (app) {
      if (!app.server_url) errors.push('.app.json is missing "server_url"');
      if (!app.app_id) errors.push('.app.json is missing "app_id"');
      else if (/REPLACE_AFTER|REPLACE_ME|placeholder/i.test(app.app_id)) {
        warnings.push('.app.json app_id is still the placeholder — register the MCP connection in ChatGPT developer mode (§D) and replace it before publishing.');
      }
    }
  }
}

// --- skills ---
const skillsDir = join(ROOT, 'skills');
let skillCount = 0;
if (!existsSync(skillsDir)) {
  errors.push('missing skills/ directory');
} else {
  for (const entry of readdirSync(skillsDir)) {
    const dir = join(skillsDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const skillPath = join(dir, 'SKILL.md');
    if (!existsSync(skillPath)) {
      errors.push(`skill ${entry} has no SKILL.md`);
      continue;
    }
    const text = readFileSync(skillPath, 'utf8');
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text);
    if (!fm) {
      errors.push(`${skillPath} has no frontmatter block`);
      continue;
    }
    const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(fm[1])?.[1]?.trim();
    if (!name) errors.push(`${skillPath} frontmatter missing name`);
    if (!description) errors.push(`${skillPath} frontmatter missing a non-empty description`);
    skillCount++;
  }
  if (skillCount === 0) errors.push('no skills found under skills/');
}

for (const w of warnings) console.log(`warn: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`FAIL: ${e}`);
  process.exit(1);
}
console.log(`plugin package OK: ${manifest?.name} v${manifest?.version}, ${skillCount} skill(s).`);
