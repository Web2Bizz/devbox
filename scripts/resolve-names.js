#!/usr/bin/env node
// СКОП ТОЛЬКО DOCKER — ORG/REPO/SERVICE, npm тут не существует. Другие правила.
import { readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const SANITIZE_RE = /[^a-z0-9._~\-]/g;

function resolveRepo(repo, sanitized) {
  const repoLower = repo.toLowerCase();
  const owner = repo.split("/")[0] ?? "";
  let ownerLower = owner.toLowerCase();
  if (sanitized) ownerLower = ownerLower.replace(SANITIZE_RE, "-");
  const repoName = repoLower.split("/").slice(1).join("/");
  return { repoLower, owner, ownerLower, repoName };
}

function resolveImage(registry, repoLower, ownerLower, repoName, service) {
  let imagePath = "";
  let serviceImagePath = "";
  let serviceName = "";
  if (registry) {
    const registryTrimmed = registry.replace(/\/+$/, "");
    imagePath = `${registryTrimmed}/${repoLower}`;
    if (service) {
      serviceName = service.toLowerCase().replace(SANITIZE_RE, "-");
      serviceImagePath = `${registryTrimmed}/${ownerLower}/${repoName}/${serviceName}`;
    }
  }
  return { imagePath, serviceImagePath, serviceName };
}

function discoverServices(dirs = ["apps", "services"]) {
  const out = [];
  for (const dir of dirs) {
    const abs = dir.startsWith("/") ? dir : join(process.cwd(), dir);
    try {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory()) out.push(entry.name);
      }
    } catch {}
  }
  return [...new Set(out)].sort();
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY || process.env.REPO || "";
  const registry = process.env.INPUT_REGISTRY || process.env.REGISTRY || "";
  const sanitized = (process.env.INPUT_SANITIZED || "true") === "true";
  const service = process.env.INPUT_SERVICE || "";
  const discover = (process.env.INPUT_DISCOVER_SERVICES || "false") === "true";
  const githubOutput = process.env.GITHUB_OUTPUT;

  if (!repo) {
    console.error("GITHUB_REPOSITORY not set");
    process.exit(1);
  }

  const repoRes = resolveRepo(repo, sanitized);
  const imageRes = resolveImage(registry, repoRes.repoLower, repoRes.ownerLower, repoRes.repoName, service);
  const services = discover ? discoverServices() : [];

  const outputs = {
    repo_lower: repoRes.repoLower,
    owner: repoRes.owner,
    owner_lower: repoRes.ownerLower,
    repo_name: repoRes.repoName,
    image_path: imageRes.imagePath,
    service_image_path: imageRes.serviceImagePath,
    service_name: imageRes.serviceName,
    services: JSON.stringify(services)
  };

  for (const [k, v] of Object.entries(outputs)) {
    console.log(`${k}=${v}`);
    if (githubOutput) appendFileSync(githubOutput, `${k}=${v}\n`);
  }
}

main();
