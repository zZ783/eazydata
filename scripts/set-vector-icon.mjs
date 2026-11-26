import fs from "node:fs";

// Use the pure-shape vector SVG (assets/icon-vector.svg) as the plugin icon.
// magpie's provider-card icon renders plain SVG shapes but not an <image>
// element, so this trace — a blue circle plus the white mark as <rect> runs —
// is the form that shows, matching 100milionseek's plain-shape SVG.
const svg = fs.readFileSync("assets/icon-vector.svg", "utf8").trim();
const b64 = Buffer.from(svg, "utf8").toString("base64");

const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.version = "0.1.6";
p.magpie.icon = "data:image/svg+xml;base64," + b64;
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");

console.log("version", p.version);
console.log("icon prefix:", p.magpie.icon.slice(0, 40));
console.log("icon len:", p.magpie.icon.length);
const dec = Buffer.from(b64, "base64").toString("utf8");
console.log("is <svg?", dec.startsWith("<svg"), "| has <image>?", dec.includes("<image"), "| rects:", (dec.match(/<rect/g) || []).length);
