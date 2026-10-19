// 二进制版本与协议 schema 一致性检查：不匹配时阻止发送真实输入。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export function binaryVersion(bin) {
  const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
  return out.trim().split("\n").pop().trim();
}

export function schemaManifest(schemaDir) {
  const file = path.join(schemaDir, "manifest.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function fileDigest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function checkBinaryAgainstSchema(bin, schemaDir) {
  const manifest = schemaManifest(schemaDir);
  const version = binaryVersion(bin);
  const expected = manifest.binaryVersion;
  const issues = [];
  if (version !== expected) issues.push(`version mismatch: binary=${version} schema=${expected}`);
  const schemas = manifest.schemas ?? (manifest.clientRequestSha256
    ? { "ClientRequest.json": manifest.clientRequestSha256 }
    : {});
  const verified = [];
  for (const [file, digest] of Object.entries(schemas)) {
    const actual = fileDigest(path.join(schemaDir, file));
    verified.push(file);
    if (actual !== digest) issues.push(`${file} digest mismatch: schema files were modified or regenerated`);
  }
  if (verified.length === 0) issues.push("manifest has no schema digests");
  return { ok: issues.length === 0, version, expected, issues, verified };
}
