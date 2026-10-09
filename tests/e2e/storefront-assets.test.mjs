import assert from "node:assert/strict";
import { statSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const referencedAssets = [
  "docs/assets/demo/staledocs-flow-scene.png",
  "docs/assets/review-comment.png",
];
const downloadedMedia = [
  "docs/assets/demo/staledocs-flow-scene.png",
  "docs/assets/demo/staledocs-flow.gif",
  "docs/assets/review-comment.png",
];

function absolute(relativePath) {
  return path.join(root, relativePath);
}

test("referenced storefront assets exist", () => {
  for (const relativePath of referencedAssets) {
    assert.equal(existsSync(absolute(relativePath)), true, relativePath);
  }
});

test("README media stays within the download budget", () => {
  const limits = {
    "docs/assets/demo/staledocs-flow-scene.png": 2 * 1024 * 1024,
    "docs/assets/demo/staledocs-flow.gif": 2 * 1024 * 1024,
    "docs/assets/review-comment.png": 2 * 1024 * 1024,
  };
  for (const relativePath of downloadedMedia) {
    const bytes = statSync(absolute(relativePath)).size;
    assert.ok(bytes <= limits[relativePath], `${relativePath} exceeds its budget`);
  }
});
